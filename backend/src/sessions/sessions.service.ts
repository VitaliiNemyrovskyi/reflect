import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromptsService } from '../prompts/prompts.service';
import { LlmService, ChatMessage } from '../llm/llm.service';

const SEED_OPENING =
  '[Сесія розпочалася. Терапевт сидить навпроти і чекає, поки ви заговорите.]';

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

    const session = await this.prisma.session.create({
      data: { characterId: character.id, userId },
    });

    await this.prisma.message.create({
      data: { sessionId: session.id, role: 'user', content: SEED_OPENING },
    });

    const reply = await this.respondAsCharacter(character.profileText, character.displayName, [
      { role: 'user', content: SEED_OPENING },
    ]);

    await this.prisma.message.create({
      data: { sessionId: session.id, role: 'assistant', content: reply },
    });

    return {
      sessionId: session.id,
      character: { id: character.id, displayName: character.displayName },
      firstMessage: reply,
    };
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
    const reply = await this.respondAsCharacter(
      session.character.profileText,
      session.character.displayName,
      history,
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

    const rawFeedback = await this.llm.chat({
      systemPrompt,
      history: [
        {
          role: 'user',
          content: 'Будь ласка, дай структурований фідбек згідно інструкції вище.',
        },
      ],
      model: this.llm.modelFeedback,
      maxTokens: 2048,
    });

    const feedback = this.appendQuoteAudit(rawFeedback, transcript);

    await this.prisma.session.update({
      where: { id: sessionId },
      data: { endedAt: new Date(), feedback },
    });

    return { feedback };
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
  ): Promise<string> {
    const filled = this.prompts.fill(this.prompts.annaSystem, {
      CHARACTER_NAME: displayName,
      PROFILE: profileText,
    });
    const warning = this.prompts.profileLooksUnfilled(profileText)
      ? '\n\n[УВАГА: профіль персонажа не заповнений — звучатиме як шаблон.]'
      : '';
    return this.llm.chat({
      systemPrompt: filled + warning,
      history,
      cacheSystem: true,
    });
  }
}
