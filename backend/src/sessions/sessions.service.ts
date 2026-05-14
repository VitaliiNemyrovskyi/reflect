import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromptsService } from '../prompts/prompts.service';
import { LlmService, ChatMessage } from '../llm/llm.service';
import { TestsService } from '../tests/tests.service';
import { cleanFeedback } from './feedback-cleaner';

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
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prompts: PromptsService,
    private readonly llm: LlmService,
    private readonly tests: TestsService,
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
        // Tests admin'd during this session — same shape as the
        // active-chat fetch so the result card can render identically
        // in past-session view.
        tests: { orderBy: { id: 'asc' } },
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

    // Parse answersJson on each test up-front so the frontend doesn't
    // have to JSON.parse() in the template loop.
    const tests = session.tests.map((t) => ({
      ...t,
      answers: t.answersJson ? this.safeParseJsonArray(t.answersJson) : null,
    }));

    return {
      ...session,
      tests,
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

  /**
   * Administers a psychological test mid-session. Therapist clicks
   * "запропонувати тест" → backend asks the AI patient to "fill it
   * in" staying in character (profile + difficulty + alliance state
   * all influence the answers). Result is scored server-side and
   * returned as a single record the frontend renders as a result card
   * inline in the chat.
   *
   * Flow:
   *   1. Verify ownership.
   *   2. Create SessionTest row with status=pending (so a failed AI
   *      call leaves an auditable trace).
   *   3. Build the test-taking prompt: profile + transcript context +
   *      items + options + brevity/realism guidance.
   *   4. Call LLM, parse JSON answers, validate.
   *   5. Score via TestsService, persist.
   *   6. Return the populated row.
   */
  async administerTest(userId: number, sessionId: number, testKey: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { character: true },
    });
    if (!session || session.userId !== userId) {
      throw new NotFoundException('session not found');
    }
    const test = this.tests.getOrThrow(testKey);
    const sessionTest = await this.prisma.sessionTest.create({
      data: { sessionId, testKey, status: 'pending' },
    });

    try {
      const history = await this.loadHistory(sessionId);
      const transcript = history
        .map(
          (m) =>
            `${m.role === 'user' ? 'Терапевт' : session.character.displayName}: ${m.content}`,
        )
        .join('\n\n');

      const itemsText = test.items
        .map((it) => {
          const opts = it.options ?? test.options;
          const optsText = opts
            .map((o) => `    ${o.value} — ${o.labelUa}`)
            .join('\n');
          return `${it.id}. ${it.constructUa}\n${optsText}`;
        })
        .join('\n\n');

      const systemPrompt = [
        `Терапевт попросив тебе пройти тест «${test.name}» (${test.fullNameUa}).`,
        '',
        `Профіль персонажа:`,
        session.character.profileText,
        '',
        `Транскрипт сесії до цього моменту:`,
        transcript || '(сесія щойно почалась)',
        '',
        `Інструкція тесту: ${test.instructionUa}`,
        '',
        `Пункти і варіанти відповідей:`,
        itemsText,
        '',
        `ВАЖЛИВО:`,
        `- Відповідай у персоні. Відповіді мають узгоджуватись з профілем, поточним станом, твоїми захистами і мірою розкриття перед терапевтом.`,
        `- Реальні пацієнти НЕ дають "ідеальну" клінічну картку. Бувають мінімізації, заперечення, перебільшення.`,
        `- Якщо у тебе високий defensiveness — деякі пункти знижуй на 1.`,
        `- Якщо alliance ще не встановлений — недовірливі відповіді.`,
        `- Не оцінюй сам себе клінічно — ти просто відповідаєш як людина.`,
        '',
        `Поверни ТІЛЬКИ JSON без markdown-фенсів і без коментарів:`,
        `{"answers":[{"itemId":1,"value":2},{"itemId":2,"value":1},...]}`,
        '',
        `Усього пунктів: ${test.items.length}. Кожен має бути у відповіді.`,
      ].join('\n');

      const raw = await this.llm.chat({
        systemPrompt,
        history: [{ role: 'user', content: 'Пройди тест.' }],
        maxTokens: 1024,
      });

      const parsed = this.parseTestAnswers(raw);
      const result = this.tests.score(test, parsed.answers);

      // Enrich answers with the option label for the result card —
      // saves the frontend an extra lookup against the test catalog.
      const answersWithLabels = parsed.answers.map((a) => {
        const item = test.items.find((i) => i.id === a.itemId)!;
        const opts = item.options ?? test.options;
        const opt = opts.find((o) => o.value === a.value);
        return {
          itemId: a.itemId,
          value: a.value,
          optionLabel: opt?.labelUa ?? '',
          constructUa: item.constructUa,
        };
      });

      return this.prisma.sessionTest.update({
        where: { id: sessionTest.id },
        data: {
          status: 'completed',
          answersJson: JSON.stringify(answersWithLabels),
          rawScore: result.rawScore,
          scaledScore: result.scaledScore,
          severity: result.severity,
          severityLabel: result.severityLabel,
          completedAt: new Date(),
        },
      });
    } catch (e) {
      // Mark the row failed so the audit trail keeps it but the
      // frontend can show an error state.
      await this.prisma.sessionTest
        .update({ where: { id: sessionTest.id }, data: { status: 'failed' } })
        .catch(() => undefined);
      throw e;
    }
  }

  /**
   * Robust JSON extractor for the AI's test answers. Tolerates:
   *   - clean JSON (preferred)
   *   - markdown-fenced JSON (```json ... ```)
   *   - JSON embedded in extra prose
   * Throws BadGateway with a clear message if nothing parseable.
   */
  private parseTestAnswers(raw: string): {
    answers: Array<{ itemId: number; value: number }>;
  } {
    const tryParse = (s: string) => {
      try {
        const parsed = JSON.parse(s);
        if (parsed && Array.isArray(parsed.answers)) {
          // Validate each entry has itemId + value as numbers.
          for (const a of parsed.answers) {
            if (typeof a.itemId !== 'number' || typeof a.value !== 'number') return null;
          }
          return parsed as { answers: Array<{ itemId: number; value: number }> };
        }
      } catch {
        /* fall through */
      }
      return null;
    };

    const direct = tryParse(raw.trim());
    if (direct) return direct;

    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      const fenced = tryParse(fenceMatch[1].trim());
      if (fenced) return fenced;
    }

    const braceMatch = raw.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      const brace = tryParse(braceMatch[0]);
      if (brace) return brace;
    }

    throw new BadGatewayException(
      'AI повернув відповідь у форматі що не парсітся як JSON з полем answers',
    );
  }

  /**
   * Returns all tests administered in a session, with their answers
   * parsed back from JSON. Used by the session view to re-display
   * past tests inline in the transcript.
   */
  async listSessionTests(userId: number, sessionId: number) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true, tests: { orderBy: { id: 'asc' } } },
    });
    if (!session || session.userId !== userId) {
      throw new NotFoundException('session not found');
    }
    return session.tests.map((t) => ({
      ...t,
      answers: t.answersJson ? this.safeParseJsonArray(t.answersJson) : null,
    }));
  }

  private safeParseJsonArray(s: string): unknown[] | null {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
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
      // Capped at 3072 — supervisor brevity instruction targets
      // 800-1500 words narrative + ~200 tokens JSON assessment. The
      // earlier 2048 limit was clipping reviewer output mid-sentence
      // for 5+ dimension feedback; 3072 lets the reviewer add a new
      // block or two without overshoot. Output cost is ~$0.003 per
      // session on Haiku, negligible vs total ~$0.15.
      maxTokens: 3072,
    });

    const { narrative, json } = this.splitFeedback(rawFeedback);
    const feedback = this.repairAndAudit(narrative, ctx.lineMap);

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
    | { type: 'progress'; data: { stage: string; message: string } }
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

    // TWO-PASS mode: first supervisor drafts (non-streaming, blocking),
    // then a reviewer agent receives the draft + transcript + profile
    // and streams an improved final version. The reviewer's job is to
    // catch misses, prune truisms, and calibrate tone — not rewrite
    // from scratch. ~2× total cost but noticeably better feedback
    // quality in our domain.
    if (this.llm.feedbackMode === 'two-pass') {
      yield {
        type: 'progress',
        data: {
          stage: 'drafting',
          message: 'Перший супервізор готує чернетку розбору…',
        },
      };
      const draft = await this.llm.chat({
        systemBlocks: ctx.systemBlocks,
        history: [{ role: 'user', content: FEEDBACK_USER_PROMPT }],
        model: this.llm.modelFeedback,
        // 3072: lets Pass-1 produce a complete draft; reviewer then
        // polishes/extends rather than receiving a truncated input.
        maxTokens: 3072,
      });

      yield {
        type: 'progress',
        data: {
          stage: 'reviewing',
          message: 'Другий супервізор перевіряє і покращує…',
        },
      };

      const reviewerBlocks = await this.buildReviewerContext(session, sessionId, draft, ctx.transcript);
      // Pass 2 = REVIEWER → use stronger model (Opus by default) for deep
      // critique + pattern detection. If it stalls before first chunk,
      // fall back to the cheaper draft model so the student still gets
      // SOMETHING (downgraded review but functional) instead of a 504.
      for await (const chunk of this.streamFeedbackWithFallback(
        reviewerBlocks,
        this.llm.modelFeedbackReviewer,
        this.llm.modelFeedback,
      )) {
        raw += chunk;
        yield { type: 'chunk', data: { text: chunk } };
      }
    } else {
      // SINGLE-PASS mode (legacy): one supervisor streams direct to
      // client. Faster, cheaper, marginally less polished.
      for await (const chunk of this.streamFeedbackWithFallback(ctx.systemBlocks)) {
        raw += chunk;
        yield { type: 'chunk', data: { text: chunk } };
      }
    }

    const { narrative, json } = this.splitFeedback(raw);
    const feedback = this.repairAndAudit(narrative, ctx.lineMap);

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

  /**
   * Stream feedback from the LLM with one-shot fallback to the
   * configured secondary model. The primary model's stream is consumed
   * chunk-by-chunk and re-yielded; if it dies BEFORE the first chunk
   * (timeout / 5xx / empty-stream), we retry once with
   * modelFeedbackFallback. Mid-stream errors bubble up because the
   * caller has already emitted partial output to the client and a
   * retry would duplicate it.
   *
   * Used by BOTH single-pass and two-pass feedback flows. In two-pass
   * mode the REVIEWER (Pass 2) calls this with the dedicated reviewer
   * model (Opus by default); in single-pass it drives the supervisor
   * with `modelFeedback` (Haiku) directly.
   *
   * @param primaryModel  the model to try first
   * @param fallbackModel the model to retry with if `primaryModel`
   *                      yields no output. null/undefined disables
   *                      fallback. Same as primary ≡ disabled too.
   */
  private async *streamFeedbackWithFallback(
    systemBlocks: { text: string; cache?: boolean }[],
    primaryModel: string = this.llm.modelFeedback,
    fallbackModel: string | null = this.llm.modelFeedbackFallback,
  ): AsyncGenerator<string, void, unknown> {
    const tryModel = async function* (this: SessionsService, model: string) {
      let gotAny = false;
      for await (const chunk of this.llm.chatStream({
        systemBlocks,
        history: [{ role: 'user', content: FEEDBACK_USER_PROMPT }],
        model,
        // 3072 covers the brevity target of 800-1500 words narrative
        // + ~200 tokens of JSON assessment, with headroom for the
        // reviewer to add a new block or two. The earlier 2048 cap
        // was clipping output mid-sentence on richer sessions.
        maxTokens: 3072,
      })) {
        gotAny = true;
        yield chunk;
      }
      if (!gotAny) {
        throw new BadGatewayException('empty feedback stream');
      }
    };

    let gotAnyBeforeError = false;
    try {
      for await (const chunk of tryModel.call(this, primaryModel)) {
        gotAnyBeforeError = true;
        yield chunk;
      }
    } catch (primaryErr) {
      if (gotAnyBeforeError) throw primaryErr;
      if (!fallbackModel || fallbackModel === primaryModel) throw primaryErr;
      yield `\n_[Перший виклик завис; переключаюсь на резервну модель ${fallbackModel}…]_\n\n`;
      for await (const chunk of tryModel.call(this, fallbackModel)) {
        yield chunk;
      }
    }
  }

  /**
   * Assemble system-prompt blocks for the second-pass reviewer agent.
   * The critic_reviewer template fills with: profile, transcript,
   * notes, and the Pass-1 draft. Single block — the prompt is large
   * but uncacheable across sessions anyway because of the draft.
   */
  private async buildReviewerContext(
    session: { character: { profileText: string } },
    sessionId: number,
    draft: string,
    transcript: string,
  ): Promise<{ text: string; cache?: boolean }[]> {
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

    const filled = this.prompts.fill(this.prompts.criticReviewer, {
      PROFILE: session.character.profileText,
      TRANSCRIPT: transcript,
      NOTES: notesText,
      DRAFT: draft,
    });
    return [{ text: filled }];
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

    // Tests administered during this session — feed concise scores
    // to the supervisor so the feedback can reference real numbers
    // ("PHQ-9 = 9, легка депресія") rather than guess.
    const tests = await this.prisma.sessionTest.findMany({
      where: { sessionId, status: 'completed' },
      orderBy: { id: 'asc' },
    });
    const testsSummary = tests.length
      ? tests
          .map((t) => {
            const catalogEntry = this.tests
              .list()
              .find((c) => c.key === t.testKey);
            const name = catalogEntry?.name ?? t.testKey;
            const score = t.scaledScore ?? t.rawScore ?? '?';
            const max =
              catalogEntry?.scoreRange?.[1] !== undefined
                ? `/${catalogEntry.scoreRange[1]}`
                : '';
            return `- **${name}** = ${score}${max} — ${t.severityLabel ?? '?'}`;
          })
          .join('\n')
      : null;

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
    // Slim the profile for feedback to keep us under OpenRouter's
    // free-tier 24K prompt-token cap. Full profile (sections 1-8) runs
    // ~5-8K tokens per character; we only need diagnosis + presenting
    // problem + current situation to grade the therapist's technique.
    // Sections 5-8 (chat persona, hidden layer, behavior cues) are
    // useful for in-session roleplay but redundant for supervisor.
    const slimProfile = this.slimProfileForFeedback(session.character.profileText);
    const profileSection = tpl
      .substring(profileIdx, transcriptIdx)
      .replaceAll('{{PROFILE}}', slimProfile)
      + modalitySupervisor;
    // Append a brief tests block after the standard NOTES section so
    // the supervisor can reference scores ("PHQ-9 був 9 — легка
    // депресія") without us bolting test placeholders into the
    // template file itself. Empty omitted entirely.
    const testsBlock = testsSummary
      ? `\n\n## Пройдені психологічні тести\n\n${testsSummary}\n\nТести проведено в процесі сесії за пропозицією терапевта. Згадай їх у відповідних розділах розбору — особливо якщо клініцист обрав правильно/неправильно вимір, не діяв за результатом, або проґавив сигнал.`
      : '';
    const sessionSpecific =
      tpl
        .substring(transcriptIdx)
        .replaceAll('{{TRANSCRIPT}}', transcript)
        .replaceAll('{{NOTES}}', notesText) + testsBlock;

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

  /**
   * Reduce the character profile to the parts a supervisor actually
   * needs to grade interview technique:
   *   - the HTML/MD comment header (diagnosis, severity codes)
   *   - the leading paragraph if any (the composite disclaimer)
   *   - sections 1 ("Базові відомості") through 4 ("Що її привело на
   *     сесію") — these carry the clinical baseline + presenting issue
   *
   * Sections 5-8 (how she speaks, hidden layer, first-session
   * behavior, what Anna doesn't do) are persona/chat hints — useful
   * for the role-playing model but redundant for grading. Dropping
   * them halves the profile and keeps us well under the free-tier
   * 24817-token cap that OpenRouter enforces for shared-credit
   * accounts.
   *
   * If the profile doesn't follow the expected "## N." structure, we
   * fall back to the full text (better verbose than missing data).
   */
  private slimProfileForFeedback(profileText: string): string {
    // Match header (## N. heading) where N is the section number we
    // want to drop FROM. We keep everything BEFORE "## 5."
    const cutMarker = profileText.search(/^##\s*5\.\s/m);
    if (cutMarker < 0) return profileText;
    return profileText.slice(0, cutMarker).trimEnd();
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
  /**
   * Repair the supervisor's feedback narrative in place, then attach
   * an audit footer ONLY for problems that couldn't be auto-fixed
   * (invalid `[L<n>]` line references, mostly).
   *
   * Algorithm (delegated to feedback-cleaner.ts):
   *   1. Every «...» [L<n>] anchored quote: verbatim or fuzzy-fixed
   *      against line N; if neither, strip the « » but keep [L<n>].
   *   2. Every «...» without [L<n>]: skipped if it's a proposed
   *      therapist wording ("можна було спитати: «...»"); otherwise
   *      try to locate in transcript & add [L<n>], or strip quotes.
   *   3. Any [L<n>] where N > lineMap.size: surfaces as audit issue.
   *
   * Telemetry: repair count is logged per session so we can monitor
   * how many quotes the LLM gets wrong on average.
   */
  private repairAndAudit(feedback: string, lineMap: Map<number, string>): string {
    const { cleaned, repairs, issues } = cleanFeedback(feedback, lineMap);
    if (repairs > 0 || issues.length > 0) {
      this.logger.log(
        `feedback cleaner: ${repairs} repairs, ${issues.length} residual issues`,
      );
    }
    if (issues.length === 0) return cleaned;

    // Same details/summary HTML wrapper as before — but now triggered
    // only for residual problems (invalid line refs). The user-facing
    // count should normally be 0; if it's non-zero we want it visible
    // so the student knows to double-check those specific points.
    const summaryWord =
      issues.length === 1 ? 'проблема' : issues.length < 5 ? 'проблеми' : 'проблем';
    const summaryLabel = `⚠️ ${issues.length} ${summaryWord} у посиланнях на транскрипт`;
    const items = issues.map((s) => `<li>${s}</li>`).join('\n');
    return (
      cleaned +
      '\n\n' +
      '<details class="audit-block">\n' +
      `  <summary><strong>${summaryLabel}</strong></summary>\n\n` +
      'Ці посилання у фідбеку вище не звіряються з транскриптом — можлива помилка моделі. ' +
      'Більшість некоректних цитат уже автоматично виправлено в тексті; те, що тут — це не вдалося.\n\n' +
      `<ul class="audit-issues">\n${items}\n</ul>\n` +
      '</details>'
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
