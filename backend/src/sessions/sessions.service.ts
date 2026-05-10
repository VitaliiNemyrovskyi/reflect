import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromptsService } from '../prompts/prompts.service';
import { LlmService, ChatMessage } from '../llm/llm.service';

const SEED_OPENING =
  '[Сесія розпочалася. Терапевт сидить навпроти і чекає, поки ви заговорите.]';

const FEEDBACK_USER_PROMPT =
  'Будь ласка, дай структурований фідбек згідно інструкції вище. У КІНЦІ відповіді (ПІСЛЯ всього markdown-фідбеку) додай блок із машиночитаною оцінкою сесії у форматі:\n\n```json\n{\n  "patient": {\n    "symptomSeverity": <1-10>,\n    "insight": <1-10>,\n    "alliance": <1-10>,\n    "defensiveness": <1-10>,\n    "hopefulness": <1-10>\n  },\n  "therapist": {\n    "empathy": <0-6>,\n    "collaboration": <0-6>,\n    "guidedDiscovery": <0-6>,\n    "strategyForChange": <0-6>\n  },\n  "patientMemory": "<5-10 речень від першої особи клієнтки про те, що відбулось на сесії і як вона почувається. Це буде показано клієнтці на початку наступної сесії, тому пиши природньо її голосом, не клінічно.>"\n}\n```\n\nЦифри ставлять реалістично з опорою на транскрипт. Якщо вимір неможливо оцінити (наприклад, не було скрінінгу) — постав null.';

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly prompts: PromptsService,
    private readonly llm: LlmService,
  ) {}

  async create(userId: number, characterId?: number) {
    const character = characterId
      ? await this.prisma.character.findUnique({ where: { id: characterId } })
      : await this.prisma.character.findFirst({ orderBy: { id: 'asc' } });
    if (!character) throw new NotFoundException('character not found');

    // Pull prior session memories for this user-character pair (most recent 5)
    const priorMemories = await this.loadPriorMemories(userId, character.id);

    const session = await this.prisma.session.create({
      data: { characterId: character.id, userId },
    });

    await this.prisma.message.create({
      data: { sessionId: session.id, role: 'user', content: SEED_OPENING },
    });

    const reply = await this.respondAsCharacter(
      character.profileText,
      character.displayName,
      [{ role: 'user', content: SEED_OPENING }],
      priorMemories,
      character.difficulty,
    );

    await this.prisma.message.create({
      data: { sessionId: session.id, role: 'assistant', content: reply },
    });

    return {
      sessionId: session.id,
      character: { id: character.id, displayName: character.displayName },
      firstMessage: reply,
      priorSessionCount: priorMemories.length,
    };
  }

  private async loadPriorMemories(userId: number, characterId: number): Promise<string[]> {
    const sessions = await this.prisma.session.findMany({
      where: {
        userId,
        characterId,
        endedAt: { not: null },
        patientMemory: { not: null },
      },
      orderBy: { startedAt: 'asc' },
      select: { patientMemory: true },
    });
    return sessions
      .map((s) => s.patientMemory)
      .filter((m): m is string => !!m && m.trim().length > 0)
      .slice(-5); // last 5 prior sessions max
  }

  async sendMessage(userId: number, sessionId: number, content: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { character: true },
    });
    if (!session || session.userId !== userId) throw new NotFoundException('session not found');
    if (session.endedAt) throw new BadRequestException('session ended');

    await this.prisma.message.create({
      data: { sessionId, role: 'user', content },
    });

    const history = await this.loadHistory(sessionId);
    const priorMemories = await this.loadPriorMemories(userId, session.characterId);
    const reply = await this.respondAsCharacter(
      session.character.profileText,
      session.character.displayName,
      history,
      priorMemories,
      session.character.difficulty,
    );

    await this.prisma.message.create({
      data: { sessionId, role: 'assistant', content: reply },
    });

    return { reply };
  }

  async end(userId: number, sessionId: number) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { character: true },
    });
    if (!session || session.userId !== userId) throw new NotFoundException('session not found');
    if (session.endedAt && session.feedback) return { feedback: session.feedback };

    const ctx = await this.buildFeedbackContext(session, sessionId);
    const rawFeedback = await this.llm.chat({
      systemPrompt: ctx.systemPrompt,
      history: [{ role: 'user', content: FEEDBACK_USER_PROMPT }],
      model: this.llm.modelFeedback,
      maxTokens: 3072,
    });

    const { narrative, json } = this.splitFeedback(rawFeedback);
    const feedback = this.appendQuoteAudit(narrative, ctx.transcript);

    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        endedAt: new Date(),
        feedback,
        feedbackJson: json ? JSON.stringify(json) : null,
        patientMemory: json?.patientMemory ?? null,
      },
    });

    return { feedback, assessment: json };
  }

  /**
   * Streaming variant of end(). Yields SSE-style events:
   *  - { type: 'cached', data: { feedback } }    — session already ended, return saved
   *  - { type: 'chunk',  data: { text } }        — incremental text delta from supervisor
   *  - { type: 'done',   data: { feedback, assessment } } — final, post-quote-audit, JSON parsed
   *
   * The accumulated raw text is split (narrative + JSON), quote-audited, then persisted.
   */
  async *endStream(
    userId: number,
    sessionId: number,
  ): AsyncGenerator<
    | { type: 'cached'; data: { feedback: string } }
    | { type: 'chunk'; data: { text: string } }
    | { type: 'done'; data: { feedback: string; assessment: unknown } },
    void,
    unknown
  > {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { character: true },
    });
    if (!session || session.userId !== userId) throw new NotFoundException('session not found');
    if (session.endedAt && session.feedback) {
      yield { type: 'cached', data: { feedback: session.feedback } };
      return;
    }

    const ctx = await this.buildFeedbackContext(session, sessionId);

    let raw = '';
    for await (const chunk of this.llm.chatStream({
      systemPrompt: ctx.systemPrompt,
      history: [{ role: 'user', content: FEEDBACK_USER_PROMPT }],
      model: this.llm.modelFeedback,
      maxTokens: 3072,
    })) {
      raw += chunk;
      yield { type: 'chunk', data: { text: chunk } };
    }

    const { narrative, json } = this.splitFeedback(raw);
    const feedback = this.appendQuoteAudit(narrative, ctx.transcript);

    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        endedAt: new Date(),
        feedback,
        feedbackJson: json ? JSON.stringify(json) : null,
        patientMemory: json?.patientMemory ?? null,
      },
    });

    yield { type: 'done', data: { feedback, assessment: json } };
  }

  private async buildFeedbackContext(
    session: { character: { profileText: string; displayName: string } },
    sessionId: number,
  ): Promise<{ systemPrompt: string; transcript: string }> {
    const history = await this.loadHistory(sessionId);
    if (history.length === 0) throw new BadRequestException('no messages in session');

    const transcript = history
      .map((m) =>
        `${m.role === 'user' ? 'Терапевт' : session.character.displayName}: ${m.content}`,
      )
      .join('\n\n');

    const notes = await this.prisma.note.findMany({
      where: { sessionId },
      orderBy: { id: 'asc' },
    });
    const notesText = notes.length
      ? notes
          .map((n) =>
            n.anchorText
              ? `- (про репліку «${n.anchorText}») ${n.noteText}`
              : `- ${n.noteText}`,
          )
          .join('\n')
      : '_(нотаток терапевта на цій сесії немає)_';

    const systemPrompt = this.prompts.fill(this.prompts.supervisorSystem, {
      PROTOCOL: this.prompts.supervisorProtocol,
      PROFILE: session.character.profileText,
      TRANSCRIPT: transcript,
      NOTES: notesText,
    });

    return { systemPrompt, transcript };
  }

  private splitFeedback(raw: string): {
    narrative: string;
    json: {
      patient?: Record<string, number | null>;
      therapist?: Record<string, number | null>;
      patientMemory?: string;
    } | null;
  } {
    // Find the last ```json ... ``` block
    const re = /```json\s*\n([\s\S]*?)\n```/gi;
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) lastMatch = m;
    if (!lastMatch) return { narrative: raw, json: null };
    try {
      const parsed = JSON.parse(lastMatch[1]);
      const before = raw.slice(0, lastMatch.index).trim();
      return { narrative: before, json: parsed };
    } catch {
      return { narrative: raw, json: null };
    }
  }

  private appendQuoteAudit(feedback: string, transcript: string): string {
    // Extract quoted spans (Ukrainian guillemets «…», straight quotes "…")
    const patterns = [/«([^»]{4,400})»/g, /"([^"]{4,400})"/g];
    const quotes = new Set<string>();
    for (const p of patterns) {
      for (const m of feedback.matchAll(p)) quotes.add(m[1].trim());
    }
    if (quotes.size === 0) return feedback;
    const normalize = (s: string) =>
      s.replace(/[\s ]+/g, ' ').replace(/[«»"'']/g, '').toLowerCase().trim();
    const tNorm = normalize(transcript);
    const unverified: string[] = [];
    for (const q of quotes) {
      if (!tNorm.includes(normalize(q))) unverified.push(q);
    }
    if (unverified.length === 0) return feedback;
    const list = unverified.map((q) => `- «${q}»`).join('\n');
    return (
      feedback +
      `\n\n---\n\n⚠️ **Авто-перевірка цитат**\n\nНаступні цитати у фідбеку не знайдено verbatim у транскрипті — це може бути перефразування моделлю або галюцинація. Перевір їх перед тим, як приймати на віру:\n\n${list}`
    );
  }

  private async loadHistory(sessionId: number): Promise<ChatMessage[]> {
    const rows = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { id: 'asc' },
      select: { role: true, content: true },
    });
    return rows.map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
  }

  private async respondAsCharacter(
    profileText: string,
    displayName: string,
    history: ChatMessage[],
    priorMemories: string[] = [],
    difficulty: number | null = null,
  ): Promise<string> {
    const filled = this.prompts.fill(this.prompts.annaSystem, {
      CHARACTER_NAME: displayName,
      PROFILE: profileText,
    });
    const warning = this.prompts.profileLooksUnfilled(profileText)
      ? '\n\n[УВАГА: профіль персонажа не заповнений — звучатиме як шаблон.]'
      : '';
    const memorySection = priorMemories.length
      ? `\n\n# Що ти пам'ятаєш про попередні сесії з цим терапевтом\n\nЦе твоя пам'ять, від першої особи. Не озвучуй усе — лише природно посилайся на минуле, якщо це доречно у моменті.\n\n${priorMemories
          .map((m, i) => `**Сесія ${i + 1}:** ${m}`)
          .join('\n\n')}\n\nНа першій репліці нової сесії ти можеш (але не зобов'язана) згадати щось із минулого — як зробила б реальна людина, що повертається до знайомого терапевта.`
      : '';
    const difficultyModulator = this.prompts.getDifficultyModulator(difficulty);
    return this.llm.chat({
      systemPrompt: filled + warning + memorySection + difficultyModulator,
      history,
      cacheSystem: true,
    });
  }
}
