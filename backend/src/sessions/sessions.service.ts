import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromptsService } from '../prompts/prompts.service';
import { LlmService, ChatMessage } from '../llm/llm.service';

export type HintKind =
  | 'open-question'
  | 'reflection'
  | 'summary'
  | 'screening'
  | 'here-and-now'
  | 'psychoeducation'
  | 'closing'
  | 'other';

export interface HintSuggestion {
  text: string;
  rationale: string;
  kind: HintKind;
}

export interface HintResult {
  suggestions: HintSuggestion[];
}

/**
 * Pull the JSON payload out of the LLM response (raw or fenced) and
 * normalize into HintResult. Tolerant — if the model adds prose around the
 * JSON, we extract the first balanced { ... } block. If parsing fails
 * entirely, returns a single suggestion holding the raw text so the
 * frontend has something to show instead of an error.
 */
function parseHintResult(raw: string): HintResult {
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  const candidate = fence ? fence[1] : raw;
  // Find first { ... } block — handles preamble before/after JSON.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return fallbackHint(raw);
  }
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
      suggestions?: { text?: unknown; rationale?: unknown; kind?: unknown }[];
    };
    const out: HintSuggestion[] = [];
    for (const s of parsed.suggestions ?? []) {
      const text = typeof s.text === 'string' ? s.text.trim() : '';
      const rationale = typeof s.rationale === 'string' ? s.rationale.trim() : '';
      const kind = (typeof s.kind === 'string' ? s.kind : 'other') as HintKind;
      if (text) out.push({ text, rationale, kind });
    }
    if (out.length === 0) return fallbackHint(raw);
    return { suggestions: out.slice(0, 3) };
  } catch {
    return fallbackHint(raw);
  }
}

function safeParseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function fallbackHint(raw: string): HintResult {
  const text = raw.trim().slice(0, 400);
  return {
    suggestions: [
      {
        text: text || 'Не вдалось розпарсити підказку. Спробуй ще раз.',
        rationale: 'Модель не повернула очікуваний JSON; це сирий текст.',
        kind: 'other',
      },
    ],
  };
}

const SEED_OPENING =
  '[Сесія розпочалася. Терапевт сидить навпроти і чекає, поки ви заговорите.]';

const FEEDBACK_USER_PROMPT =
  'Будь ласка, дай структурований фідбек згідно інструкції вище.\n\n' +
  '**ПОВТОРНО**: кожне твердження про конкретний момент сесії — підкріплюй посиланням `[L<n>]` на номер рядка транскрипту. Цитати у `«…»` мають бути verbatim з зазначеного рядка. Сервер автоматично перевіряє це і виносить галюцинації у червону плашку — не псуй собі довіру вигадуванням.\n\n' +
  'У КІНЦІ відповіді (ПІСЛЯ всього markdown-фідбеку) додай блок із машиночитаною оцінкою сесії у форматі:\n\n```json\n{\n  "patient": {\n    "symptomSeverity": <1-10>,\n    "insight": <1-10>,\n    "alliance": <1-10>,\n    "defensiveness": <1-10>,\n    "hopefulness": <1-10>\n  },\n  "therapist": {\n    "empathy": <0-6>,\n    "collaboration": <0-6>,\n    "guidedDiscovery": <0-6>,\n    "strategyForChange": <0-6>\n  },\n  "patientMemory": "<5-10 речень від першої особи клієнтки про те, що відбулось на сесії і як вона почувається. Це буде показано клієнтці на початку наступної сесії, тому пиши природньо її голосом, не клінічно.>"\n}\n```\n\nЦифри ставлять реалістично з опорою на транскрипт. Якщо вимір неможливо оцінити (наприклад, не було скрінінгу) — постав null. У JSON-блоці `[L<n>]` посилання НЕ потрібні.';

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
      character.modality,
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

  /**
   * Coach mode — student in the middle of a session asks "what should I say
   * next?" Returns 3 strategic suggestions (open question / reflection /
   * here-and-now / screening / etc.) anchored on the transcript so far.
   *
   * Output is the parsed JSON the LLM emits per hint_system.md. If parsing
   * fails (e.g. model wrapped JSON in extra prose), we fall back to a single
   * synthetic suggestion containing the raw text — better than throwing.
   */
  async generateHints(userId: number, sessionId: number): Promise<HintResult> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { character: true },
    });
    if (!session || session.userId !== userId) throw new NotFoundException('session not found');
    if (session.endedAt) throw new BadRequestException('session ended');

    const history = await this.loadHistory(sessionId);
    const transcript = history
      .map((m, i) => {
        const speaker = m.role === 'user' ? 'Терапевт' : session.character.displayName;
        return `[L${i + 1}] ${speaker}: ${m.content}`;
      })
      .join('\n\n');

    // Multi-block cache: hint_system + PROFILE is stable across the whole
    // session (and across many sessions for the same character), so cache
    // it; TRANSCRIPT grows each turn and must stay uncached.
    const tpl = this.prompts.hintSystem;
    const transcriptIdx = tpl.indexOf('{{TRANSCRIPT}}');
    const systemBlocks = transcriptIdx >= 0
      ? [
          {
            text: tpl
              .substring(0, transcriptIdx)
              .replaceAll('{{PROFILE}}', session.character.profileText),
            cache: true,
          },
          {
            text: tpl
              .substring(transcriptIdx)
              .replaceAll('{{TRANSCRIPT}}', transcript),
          },
        ]
      : [
          {
            text: this.prompts.fill(tpl, {
              PROFILE: session.character.profileText,
              TRANSCRIPT: transcript,
            }),
          },
        ];

    const raw = await this.llm.chat({
      systemBlocks,
      history: [
        {
          role: 'user',
          content: 'Дай 3 варіанти моєї наступної репліки. Тільки JSON у форматі з system prompt-у.',
        },
      ],
      // Hints come from the same provider but we use the chat model — feedback
      // model is heavier and slower. Speed matters here, the student is mid-session.
      model: this.llm.modelChat,
      maxTokens: 800,
    });

    return parseHintResult(raw);
  }

  /**
   * Hard-delete a session ("як така що не розпочиналась") — removes the
   * session row and (via cascade) all its messages and notes. Cross-session
   * patient memory captured on this session disappears with it, so the
   * patient won't reference it on future sessions.
   *
   * Allowed regardless of whether the session has been ended — useful both
   * mid-session ("I want to throw this practice away") and post-feedback
   * ("retroactively scrub this run from my history").
   */
  async discard(userId: number, sessionId: number): Promise<{ deleted: true }> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true },
    });
    if (!session || session.userId !== userId) {
      throw new NotFoundException('session not found');
    }
    // Cascade delete handles messages + notes (see schema.prisma onDelete).
    await this.prisma.session.delete({ where: { id: sessionId } });
    return { deleted: true };
  }

  /**
   * Read-only fetch of a full session — for the session-view UI. Allows
   * either the session's owner OR any admin to see it. Returns transcript,
   * feedback, JSON assessment, and notes.
   */
  async getForView(viewerUserId: number, sessionId: number) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        character: { select: { id: true, displayName: true, slug: true, avatarUrl: true } },
        messages: { orderBy: { id: 'asc' } },
        notes: { orderBy: { id: 'asc' } },
      },
    });
    if (!session) throw new NotFoundException('session not found');

    if (session.userId !== viewerUserId) {
      // Not owner — must be admin.
      const viewer = await this.prisma.user.findUnique({
        where: { id: viewerUserId },
        select: { isAdmin: true },
      });
      if (!viewer?.isAdmin) {
        throw new NotFoundException('session not found');
      }
    }

    return {
      ...session,
      assessment: session.feedbackJson ? safeParseJson(session.feedbackJson) : null,
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
    const priorMemories = await this.loadPriorMemories(userId, session.characterId);
    const reply = await this.respondAsCharacter(
      session.character.profileText,
      session.character.displayName,
      history,
      priorMemories,
      session.character.difficulty,
      session.character.modality,
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
      systemBlocks: ctx.systemBlocks,
      history: [{ role: 'user', content: FEEDBACK_USER_PROMPT }],
      model: this.llm.modelFeedback,
      // Capped at 2048 — supervisor brevity instruction targets
      // 800-1500 words narrative + ~200 tokens JSON assessment. 2048
      // gives headroom without paying for monologue-style outputs.
      maxTokens: 2048,
    });

    const { narrative, json } = this.splitFeedback(rawFeedback);
    const feedback = this.auditFeedback(narrative, ctx.lineMap);

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
    | { type: 'cached'; data: { feedback: string; assessment: unknown } }
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
      // Replay both the markdown narrative AND the machine-readable
      // assessment for cached/already-ended sessions so the competency
      // rubric UI can render without a separate viewSession() fetch.
      const assessment = session.feedbackJson ? safeParseJson(session.feedbackJson) : null;
      yield { type: 'cached', data: { feedback: session.feedback, assessment } };
      return;
    }

    const ctx = await this.buildFeedbackContext(session, sessionId);

    let raw = '';
    for await (const chunk of this.llm.chatStream({
      systemBlocks: ctx.systemBlocks,
      history: [{ role: 'user', content: FEEDBACK_USER_PROMPT }],
      model: this.llm.modelFeedback,
      // Capped at 2048 — supervisor brevity instruction targets
      // 800-1500 words narrative + ~200 tokens JSON assessment. 2048
      // gives headroom without paying for monologue-style outputs.
      maxTokens: 2048,
    })) {
      raw += chunk;
      yield { type: 'chunk', data: { text: chunk } };
    }

    const { narrative, json } = this.splitFeedback(raw);
    const feedback = this.auditFeedback(narrative, ctx.lineMap);

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
    session: { character: { profileText: string; displayName: string; modality?: string | null } },
    sessionId: number,
  ): Promise<{
    systemBlocks: { text: string; cache?: boolean }[];
    transcript: string;
    lineMap: Map<number, string>;
  }> {
    const history = await this.loadHistory(sessionId);
    if (history.length === 0) throw new BadRequestException('no messages in session');

    // Number every utterance — supervisor MUST cite [L<n>] for any claim
    // about specific session moments. The lineMap is what we audit against
    // afterwards: ref'd line exists? quote actually appears in that line?
    const lineMap = new Map<number, string>();
    const transcript = history
      .map((m, i) => {
        const n = i + 1;
        const speaker = m.role === 'user' ? 'Терапевт' : session.character.displayName;
        const line = `${speaker}: ${m.content}`;
        lineMap.set(n, line);
        return `[L${n}] ${line}`;
      })
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

    // Split the supervisor template at the placeholder boundaries so we
    // can layer prompt-cache breakpoints for maximum reuse:
    //
    //   [A] start … {{PROTOCOL}} … (text before {{PROFILE}})
    //       — stable across ALL sessions of ALL users → cache=true.
    //   [B] {{PROFILE}} … (text before {{TRANSCRIPT}})
    //       — stable PER CHARACTER, varies across patients → cache=true.
    //   [C] {{TRANSCRIPT}} … {{NOTES}} … (rest)
    //       — unique per session, never reusable → cache=false.
    //
    // Anthropic matches the longest cached prefix on each request. So
    // two consecutive feedbacks for the same character within the 5-min
    // ephemeral TTL get both [A] and [B] from cache; for different
    // characters, only [A] is shared.
    const tpl = this.prompts.supervisorSystem;
    const profileIdx = tpl.indexOf('{{PROFILE}}');
    const transcriptIdx = tpl.indexOf('{{TRANSCRIPT}}');
    if (profileIdx < 0 || transcriptIdx < 0 || profileIdx >= transcriptIdx) {
      // Template structure changed — fall back to a single uncached block
      // rather than mis-cutting the prompt.
      const flat = this.prompts.fill(tpl, {
        PROTOCOL: this.prompts.supervisorProtocol,
        PROFILE: session.character.profileText,
        TRANSCRIPT: transcript,
        NOTES: notesText,
      });
      return { systemBlocks: [{ text: flat }], transcript, lineMap };
    }

    const supervisorAndProtocol =
      tpl
        .substring(0, profileIdx)
        .replaceAll('{{PROTOCOL}}', this.prompts.supervisorProtocol)
      // Append the supervisor brevity instruction to block A — it's
      // stable across ALL sessions, so it stays cache-friendly. Caps
      // narrative at 800-1500 words and forbids generic truisms.
      + this.prompts.getSupervisorBrevityInstruction();
    // Modality modulator goes INTO the profile section — it's a per-
    // character constant (every session for that character uses the
    // same modality), so it doesn't break per-character cache reuse.
    // Empty string for 'individual'/null, so non-modality patients
    // see the same profile block as before this change.
    const modalitySupervisor = this.prompts.getModalitySupervisorModulator(
      session.character.modality ?? null,
    );
    const profileSection = tpl
      .substring(profileIdx, transcriptIdx)
      .replaceAll('{{PROFILE}}', session.character.profileText)
      + modalitySupervisor;
    const sessionSpecific = tpl
      .substring(transcriptIdx)
      .replaceAll('{{TRANSCRIPT}}', transcript)
      .replaceAll('{{NOTES}}', notesText);

    return {
      systemBlocks: [
        { text: supervisorAndProtocol, cache: true },
        { text: profileSection, cache: true },
        { text: sessionSpecific, cache: false },
      ],
      transcript,
      lineMap,
    };
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

  /**
   * Validates supervisor feedback against the numbered transcript and flags
   * three classes of likely hallucination:
   *
   *   1. invalid_ref     — `[L42]` cites a line that doesn't exist
   *   2. quote_mismatch  — `«...»` followed by `[Ln]` whose text isn't in
   *                        line N (LLM made up content for a real line)
   *   3. orphan_quote    — `«...»` of meaningful length without any `[Ln]`
   *                        AND not found verbatim anywhere in transcript
   *
   * If all three classes pass, the feedback is returned untouched. Otherwise
   * an audit section listing the flagged fragments is appended at the bottom.
   */
  private auditFeedback(feedback: string, lineMap: Map<number, string>): string {
    const issues: string[] = [];
    const normalize = (s: string) =>
      s.replace(/\s+/g, ' ').replace(/[«»"'`]/g, '').toLowerCase().trim();

    // 1. Find every [L<n>] reference, verify the line exists.
    const refRe = /\[L(\d+)\]/g;
    let m: RegExpExecArray | null;
    const seenInvalidRefs = new Set<number>();
    while ((m = refRe.exec(feedback)) !== null) {
      const n = parseInt(m[1], 10);
      if (!lineMap.has(n) && !seenInvalidRefs.has(n)) {
        seenInvalidRefs.add(n);
        issues.push(
          `🔢 **Неіснуюче посилання \`[L${n}]\`** — у транскрипті лише L1-L${lineMap.size}.`,
        );
      }
    }

    // 2. For each «quote» followed by [L<n>], verify quote ⊂ line N.
    const quotedRefRe = /[«"]([^»"]{4,500})[»"]\s*\(?\s*\[L(\d+)\]\s*\)?/g;
    while ((m = quotedRefRe.exec(feedback)) !== null) {
      const quote = m[1].trim();
      const n = parseInt(m[2], 10);
      const line = lineMap.get(n);
      if (!line) continue; // already flagged above
      if (!normalize(line).includes(normalize(quote))) {
        issues.push(
          `📝 **Цитата не співпадає з \`[L${n}]\`** — фрагмент «${this.shortQuote(quote)}» в тому рядку відсутній. Рядок насправді: «${this.shortQuote(line)}».`,
        );
      }
    }

    // 3. Quotes WITHOUT any nearby [L<n>] — must appear in transcript verbatim.
    const transcript = Array.from(lineMap.values()).join('\n');
    const tNorm = normalize(transcript);
    const allQuoteRe = /[«"]([^»"]{20,500})[»"]/g;
    const reportedOrphans = new Set<string>();
    while ((m = allQuoteRe.exec(feedback)) !== null) {
      const quote = m[1].trim();
      // Skip if followed (within ~30 chars) by [L<n>] — handled above.
      const tail = feedback.slice(m.index + m[0].length, m.index + m[0].length + 30);
      if (/^\s*\(?\s*\[L\d+\]/.test(tail)) continue;
      if (reportedOrphans.has(quote)) continue;
      if (!tNorm.includes(normalize(quote))) {
        reportedOrphans.add(quote);
        issues.push(
          `🔍 **Цитата без посилання** — «${this.shortQuote(quote)}» у транскрипті дослівно не знайдено. Додай \`[L<n>]\` або переформулюй.`,
        );
      }
    }

    if (issues.length === 0) return feedback;

    // Wrap the audit list in a native <details> block so the feedback page
    // shows a single compact "⚠ N цитат не пройшли перевірку" line that
    // expands on click. Without this, 8+ warnings looked like the entire
    // feedback was suspect — overwhelming for the student. The narrative
    // above is unaffected; this section is purely a "trust score" footer.
    //
    // markdown allows raw HTML, and marked passes <details> through verbatim
    // so the frontend doesn't need a custom renderer.
    const summaryWord =
      issues.length === 1 ? 'цитата' : issues.length < 5 ? 'цитати' : 'цитат';
    const summaryLabel = `⚠️ ${issues.length} ${summaryWord} не пройшли автоматичну перевірку`;

    const items = issues.map((s) => `<li>${s}</li>`).join('\n');

    return (
      feedback +
      '\n\n' +
      '<details class="audit-block">\n' +
      `  <summary><strong>${summaryLabel}</strong></summary>\n\n` +
      'Ці фрагменти у фідбеку не звіряються з транскриптом — можлива галюцинація моделі. ' +
      'Текст вище у фідбеку — структурований розбір — довіряй. А цитати у лапках, ' +
      'які попали сюди, — перевір вручну або ігноруй.\n\n' +
      `<ul class="audit-issues">\n${items}\n</ul>\n` +
      '</details>'
    );
  }

  private shortQuote(s: string): string {
    const t = s.trim();
    return t.length > 100 ? t.slice(0, 97) + '…' : t;
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
    modality: string | null = null,
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
    // Modality modulator goes LAST so it's the strongest steering — the
    // model sees baseline persona → difficulty → modality framing right
    // before generating its reply. Empty string for 'individual'.
    const modalityModulator = this.prompts.getModalityChatModulator(modality);
    // Brevity instruction caps the reply length to the soft limit based
    // on difficulty + modality. Cuts output cost AND shrinks history for
    // subsequent turns — double-savings on long sessions.
    const brevityInstruction = this.prompts.getBrevityInstruction(difficulty, modality);
    return this.llm.chat({
      systemPrompt: filled + warning + memorySection + difficultyModulator + modalityModulator + brevityInstruction,
      history,
      cacheSystem: true,
    });
  }
}
