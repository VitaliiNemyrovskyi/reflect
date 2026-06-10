import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromptsService } from '../prompts/prompts.service';
import { LlmService, ChatMessage } from '../llm/llm.service';
import { TestsService } from '../tests/tests.service';
import { cleanFeedback } from './feedback-cleaner';
import { FeatureGateService, GateReason } from '../billing/feature-gate.service';
import { SubscriptionsService } from '../billing/subscriptions.service';
import { CityService } from '../city/city.service';
import { MemoryService } from '../memory/memory.service';
import { NpcService } from '../npc/npc.service';
import { PushService } from '../push/push.service';
import { parseHintResult, type HintResult } from './hint-parse';

function safeParseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const SEED_OPENING =
  '[Сесія розпочалася. Терапевт сидить навпроти і чекає, поки ви заговорите.]';

// Per-turn chat replies only need recent context (the patient profile and
// cross-session memory are injected separately), so we cap how many prior
// messages we resend to the model each turn. Without a cap a long session
// resends its entire growing transcript every turn, eventually blowing past the
// model's prompt-token budget (mid-session 400s on cheaper tiers). Feedback
// generation deliberately does NOT use this cap — the supervisor must see the
// whole transcript with stable [L<n>] line numbers.
const MAX_CHAT_HISTORY_MESSAGES = 40;

const FEEDBACK_USER_PROMPT =
  'Будь ласка, дай структурований фідбек згідно інструкції вище.\n\n' +
  '**ПОВТОРНО**: кожне твердження про конкретний момент сесії — підкріплюй посиланням `[L<n>]` на номер рядка транскрипту. Цитати у `«…»` мають бути verbatim з зазначеного рядка. Сервер автоматично перевіряє це і виносить галюцинації у червону плашку — не псуй собі довіру вигадуванням.\n\n' +
  'У КІНЦІ відповіді (ПІСЛЯ всього markdown-фідбеку) додай блок із машиночитаною оцінкою сесії у форматі:\n\n```json\n{\n  "patient": {\n    "symptomSeverity": <1-10>,\n    "insight": <1-10>,\n    "alliance": <1-10>,\n    "defensiveness": <1-10>,\n    "hopefulness": <1-10>\n  },\n  "therapist": {\n    "empathy": <0-6>,\n    "collaboration": <0-6>,\n    "guidedDiscovery": <0-6>,\n    "strategyForChange": <0-6>,\n    "structure": <0-6: структурування / порядок денний / фокус>,\n    "pacing": <0-6: темп і час>,\n    "formulation": <0-6: спільне формулювання випадку>,\n    "homework": <0-6: закріплення / план між сесіями; null якщо не застосовно>\n  },\n  "signals": {\n    "riskScreened": <true якщо були сигнали суїцидального ризику І терапевт провів скринінг; інакше false>,\n    "hiddenLayerReached": <true якщо терапевт витягнув прихований між-сесійний матеріал, який клієнт уникав; інакше false>,\n    "ruptureRepaired": <true якщо стався розрив альянсу І терапевт його помітив і відновив; інакше false>,\n    "traumaGrounded": <true якщо опрацьовувався травматичний матеріал із заземленням, без ретравматизації; інакше false>\n  },\n  "patientMemory": "<5-10 речень від першої особи клієнтки про те, що відбулось на сесії і як вона почувається. Це буде показано клієнтці на початку наступної сесії, тому пиши природньо її голосом, не клінічно.>"\n}\n```\n\nЦифри ставлять реалістично з опорою на транскрипт. Якщо вимір неможливо оцінити (наприклад, не було скрінінгу) — постав null. У `signals` лише true/false (не null). У JSON-блоці `[L<n>]` посилання НЕ потрібні.';

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prompts: PromptsService,
    private readonly llm: LlmService,
    private readonly tests: TestsService,
    private readonly featureGate: FeatureGateService,
    private readonly subscriptions: SubscriptionsService,
    private readonly city: CityService,
    private readonly memory: MemoryService,
    private readonly npcs: NpcService,
    private readonly push: PushService,
  ) {}

  /** Notify the trainee that supervisor feedback is ready for a session
   *  (in-app feed + push). Fire-and-forget; localised from the user's lang. */
  private async notifyFeedbackReady(userId: number | null, sessionId: number): Promise<void> {
    if (!userId) return;
    try {
      const lang = await this.push.resolveLang(userId);
      const body =
        lang === 'en'
          ? 'Supervisor feedback is ready — review your session.'
          : lang === 'fr'
            ? 'Le retour du superviseur est prêt — revoyez votre séance.'
            : 'Фідбек супервізора готовий — переглянь розбір сесії.';
      await this.push.sendToUser(userId, {
        title: 'Reflect',
        body,
        url: `/session/${sessionId}/view`,
        tag: `feedback-${sessionId}`,
        type: 'feedback',
      });
    } catch (e) {
      this.logger.warn(`feedback notify failed: ${(e as Error).message}`);
    }
  }

  async create(userId: number, characterId?: number) {
    // Billing gate: BEFORE we touch character or DB. Throws 402-ish
    // BadRequest with a structured `reason` so the frontend can render
    // the right upgrade nudge.
    const gate = await this.featureGate.canStartSession(userId);
    if (!gate.ok) {
      throw new BadRequestException({
        message: this.gateReasonMessage(gate.reason ?? 'expired'),
        reason: gate.reason,
        billingBlocked: true,
      });
    }

    const character = characterId
      ? await this.prisma.character.findUnique({ where: { id: characterId } })
      : await this.prisma.character.findFirst({ orderBy: { id: 'asc' } });
    if (!character) throw new NotFoundException('character not found');

    // Plan-aware character access — trial sees first N system
    // characters only. Owner-created + shared characters bypass this.
    const charGate = await this.featureGate.canAccessCharacter(userId, {
      id: character.id,
      createdById: character.createdById,
    });
    if (!charGate.ok) {
      throw new BadRequestException({
        message: 'Цей персонаж доступний з тарифу Lite. Оновись на /pricing.',
        reason: charGate.reason,
        requiredPlan: charGate.requiredPlan,
        billingBlocked: true,
      });
    }

    // Modality gate — couples/family/crisis/adolescent need Pro+.
    const modGate = await this.featureGate.canUseModality(userId, character.modality);
    if (!modGate.ok) {
      throw new BadRequestException({
        message: `Модальність "${character.modality}" доступна з тарифу Pro.`,
        reason: modGate.reason,
        requiredPlan: modGate.requiredPlan,
        billingBlocked: true,
      });
    }

    // Pull prior session memories for this user-character pair (most recent 5)
    const priorMemories = await this.loadPriorMemories(userId, character.id);

    // stateBias (§12): how long since this trainee last saw this patient? A
    // long gap means they come back more withdrawn (bounded — never crisis).
    const lastScored = await this.prisma.session.findFirst({
      where: { userId, characterId: character.id, endedAt: { not: null } },
      orderBy: { endedAt: 'desc' },
      select: { endedAt: true },
    });
    const absenceContext = lastScored?.endedAt
      ? this.buildAbsenceContext(
          (Date.now() - lastScored.endedAt.getTime()) / (7 * 24 * 60 * 60 * 1000),
          character.lang,
        )
      : '';

    const session = await this.prisma.session.create({
      data: { characterId: character.id, userId },
    });

    // Increment counter AFTER session row exists — we charge for the
    // slot the moment it's created, not refunded on early abandon.
    // (Power-users abandoning to game the counter is a future problem.)
    await this.subscriptions.incrementSessions(userId);

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
      character.cityId,
      character.lang,
      character.id,
      userId,
      absenceContext,
    );

    await this.prisma.message.create({
      data: { sessionId: session.id, role: 'assistant', content: reply },
    });

    return {
      sessionId: session.id,
      character: {
        id: character.id,
        displayName: character.displayName,
        avatarUrl: character.avatarUrl,
      },
      firstMessage: reply,
      priorSessionCount: priorMemories.length,
    };
  }

  /**
   * Pull recent session memories for prompt injection into the next
   * chat. Delegates to MemoryService which now reads from the granular
   * CharacterMemory table — Phase 2 of the memory overhaul. The legacy
   * `Session.patientMemory` field is kept in sync as a denormalized
   * backup so the patient-detail UI keeps rendering without changes,
   * but it's no longer the source of truth.
   */
  private async loadPriorMemories(userId: number, characterId: number): Promise<string[]> {
    return this.memory.loadSessionMemoryStrings(userId, characterId, 5);
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
      // 1400 (was 800): three Ukrainian suggestions + rationales overflowed
      // 800 and got truncated mid-JSON, which used to surface as a raw blob.
      // The parser now salvages truncated output too, but more headroom means
      // it rarely needs to.
      maxTokens: 1400,
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
        // `gender` flows to the frontend voice.service so TTS picks
        // the right voice (male → Ostap/Ryan/Henri, female → Polina/
        // Sonia/Denise). Nullable for legacy rows; sidecar defaults to
        // female when missing.
        character: { select: { id: true, displayName: true, slug: true, avatarUrl: true, gender: true } },
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

    // Build the prompt history WITHOUT persisting the user message yet, capped
    // to the most recent turns. We persist the user message and the reply
    // together in a single transaction only AFTER the LLM succeeds — so a
    // failed/timed-out turn leaves no orphaned user message in the DB, and the
    // client's retry can't create a duplicate user turn.
    const prior = await this.loadHistory(sessionId, MAX_CHAT_HISTORY_MESSAGES);
    const history: ChatMessage[] = [...prior, { role: 'user', content }];
    const priorMemories = await this.loadPriorMemories(userId, session.characterId);
    const reply = await this.respondAsCharacter(
      session.character.profileText,
      session.character.displayName,
      history,
      priorMemories,
      session.character.difficulty,
      session.character.modality,
      session.character.cityId,
      session.character.lang,
      session.character.id,
      userId,
    );

    // Sequential inside the transaction → user row gets the lower id, so the
    // [L<n>] ordering (by id asc) stays correct.
    await this.prisma.$transaction([
      this.prisma.message.create({ data: { sessionId, role: 'user', content } }),
      this.prisma.message.create({ data: { sessionId, role: 'assistant', content: reply } }),
    ]);

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

    void this.notifyFeedbackReady(session.userId, sessionId);

    // Persist as a granular memory entry too (Phase 2) — same content,
    // but now retrievable alongside diary/world/social memories. The
    // legacy Session.patientMemory above stays as a denormalized
    // backup for the patient-detail UI.
    if (json?.patientMemory && session.userId) {
      await this.memory.add({
        characterId: session.characterId,
        userId: session.userId,
        sessionId,
        kind: 'session',
        content: json.patientMemory,
      });
    }

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
    /** Per-request locale. Falls back to server default (REFLECT_LANG). */
    lang: string = this.prompts.lang,
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
    if (!session) throw new NotFoundException('session not found');

    // Permission model: owner can do everything. Admins can READ cached
    // feedback (same rule as getForView) so they can review another
    // user's completed session — but CANNOT initiate a fresh feedback
    // generation for someone else (LLM cost + intent should belong to
    // the owner). Non-owner non-admin → 404.
    const isOwner = session.userId === userId;
    let isAdminViewer = false;
    if (!isOwner) {
      const viewer = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { isAdmin: true },
      });
      if (!viewer?.isAdmin) {
        throw new NotFoundException('session not found');
      }
      isAdminViewer = true;
    }

    if (session.endedAt && session.feedback) {
      // Replay both the markdown narrative AND the machine-readable
      // assessment for cached/already-ended sessions so the competency
      // rubric UI can render without a separate viewSession() fetch.
      const assessment = session.feedbackJson ? safeParseJson(session.feedbackJson) : null;
      yield { type: 'cached', data: { feedback: session.feedback, assessment } };
      return;
    }

    // No cached feedback → would have to GENERATE. Admins viewing
    // someone else's session aren't allowed to spend LLM budget on it.
    if (isAdminViewer) {
      throw new NotFoundException('session has no feedback yet — only owner can generate');
    }

    const ctx = await this.buildFeedbackContext(session, sessionId, lang);

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

      const reviewerCfg = await this.featureGate.getReviewerConfig(userId);

      if (reviewerCfg.secondary) {
        // ── ENSEMBLE (3-pass) ────────────────────────────────────────────
        // Pass 2: primary reviewer (DeepSeek R1) — non-streaming, blocking.
        //   DeepSeek is excellent at catching clinical-signal misses (7/8
        //   in blind tests) and is 5× cheaper than Opus. We don't stream
        //   it because its output feeds Pass 3 as context, so we need the
        //   full text before starting the next call.
        const r1Blocks = await this.buildReviewerContext(session, sessionId, draft, ctx.transcript, lang);
        this.logger.log(`ensemble pass-2: ${reviewerCfg.primary}`);
        // Non-streaming — we need the full output before starting pass-3.
        // If DeepSeek R1 times out or fails, degrade gracefully: pass-3
        // (Qwen) will review the Haiku draft directly instead of DeepSeek's
        // analysis. Still 2-pass quality, not 3-pass, but no 504 for the user.
        let review1 = draft;
        try {
          review1 = await this.llm.chat({
            systemBlocks: r1Blocks,
            history: [{ role: 'user', content: FEEDBACK_USER_PROMPT }],
            model: reviewerCfg.primary,
            maxTokens: 3072,
          });
        } catch (passErr) {
          this.logger.warn(
            `ensemble pass-2 (${reviewerCfg.primary}) failed — using draft for pass-3: ${passErr}`,
          );
        }

        yield {
          type: 'progress',
          data: {
            stage: 'refining',
            message: 'Третій супервізор шліфує і перевіряє цитати…',
          },
        };

        // Pass 3: secondary reviewer (Qwen 3.7 Max) — streams to client.
        //   Qwen sees DeepSeek's full review as the "draft" and refines it:
        //   adds verbatim «quote» [L<n>] citations (DeepSeek uses paraphrase
        //   style), catches any remaining missed signals, tightens tone.
        //   Together they cover 8/8 clinical signals empirically.
        const r2Blocks = await this.buildReviewerContext(session, sessionId, review1, ctx.transcript, lang);
        this.logger.log(`ensemble pass-3: ${reviewerCfg.secondary}`);
        for await (const chunk of this.streamFeedbackWithFallback(
          r2Blocks,
          reviewerCfg.secondary,
          reviewerCfg.primary, // fallback to primary if secondary stalls
        )) {
          raw += chunk;
          yield { type: 'chunk', data: { text: chunk } };
        }
      } else {
        // ── TWO-PASS (standard) ──────────────────────────────────────────
        // Pass 2 = reviewer → use the user's plan-tier model.
        // Falls back to Haiku draft model if reviewer stalls before first
        // chunk so the student still gets SOMETHING instead of a 504.
        const reviewerBlocks = await this.buildReviewerContext(session, sessionId, draft, ctx.transcript, lang);
        this.logger.log(`two-pass reviewer: ${reviewerCfg.primary}`);
        for await (const chunk of this.streamFeedbackWithFallback(
          reviewerBlocks,
          reviewerCfg.primary,
          this.llm.modelFeedback,
        )) {
          raw += chunk;
          yield { type: 'chunk', data: { text: chunk } };
        }
      }
    } else if (this.llm.feedbackMode === 'skills') {
      // ── SKILLS mode ────────────────────────────────────────────────────
      // Three-stage pipeline using specialised skill agents:
      //   Pass 1: Haiku draft (same as two-pass; $0.005)
      //   Pass 2: 6 parallel skill checks using Haiku (each ~$0.003, run
      //           in parallel → total time = slowest skill ~6s)
      //   Pass 3: Qwen 3.7 Max synthesis — receives draft + skill JSON
      //           → final feedback (streaming to client; ~$0.02)
      //
      // Each skill targets ONE clinical dimension and returns JSON:
      //   risk_screening, defenses, affect, alliance, ddx, technique.
      // Total cost: ~$0.03/session. Quality goal: 8/8 clinical signals
      // (suicidality skill catches passive SI that monolithic reviewers miss).

      yield {
        type: 'progress',
        data: {
          stage: 'skills',
          message: lang === 'en'
            ? `Draft + ${this.prompts.bundle(lang).skills.size} specialist agents in parallel…`
            : `Чернетка + ${this.prompts.bundle(lang).skills.size} спеціалізованих агентів паралельно…`,
        },
      };

      // Build slim profile + notes text for skill calls.
      const notes = await this.prisma.note.findMany({
        where: { sessionId },
        orderBy: { id: 'asc' },
      });
      const notesText = notes.length
        ? notes.map(n => n.anchorText ? `- («${n.anchorText}») ${n.noteText}` : `- ${n.noteText}`).join('\n')
        : '_(нотаток немає)_';
      const slimProf = this.slimProfileForFeedback(session.character.profileText);

      // Session-stage context for skill calibration. First session = this is
      // the only session for the (user, character) pair. Cheap count query.
      const pairSessionCount = session.userId != null
        ? await this.prisma.session.count({
            where: { userId: session.userId, characterId: session.characterId },
          })
        : 0;
      const skillSessionCtx = {
        modality: session.character.modality,
        isFirstSession: pairSessionCount <= 1,
      };

      // ── KEY OPTIMISATION: draft + all skill checks run IN PARALLEL ──
      // Skill agents only need the transcript (not the draft), so we
      // fire them at the same time as the Haiku draft call. Total
      // wait = max(draft_time, slowest_skill) ≈ draft_time (~36s).
      // Sequential would add the skill wall-clock (~8s) on top.
      const [skillDraft, skillResults] = await Promise.all([
        this.llm.chat({
          systemBlocks: ctx.systemBlocks,
          history: [{ role: 'user', content: FEEDBACK_USER_PROMPT }],
          model: this.llm.modelFeedback,
          maxTokens: 3072,
        }),
        this.runSkillChecks(ctx.transcript, slimProf, notesText, lang, skillSessionCtx),
      ]);

      yield {
        type: 'progress',
        data: {
          stage: 'synthesizing',
          message: 'Синтезую знахідки агентів у фінальний фідбек…',
        },
      };

      // World Tick loop-closer: if a hidden between-session layer was active
      // going into this session (an 'avoided' memory the patient was
      // guarding, which the trainee was never told), hand it to the
      // synthesizer so the feedback can assess whether the trainee drew it
      // out — that surfacing was the skill being trained. Prepended to the
      // skill results as a priority teaching point.
      let hiddenLayerBlock = '';
      if (session.userId != null) {
        const avoided = await this.memory.loadRecent(session.userId, session.characterId, {
          limit: 1,
          kinds: ['avoided'],
        });
        if (avoided.length > 0) {
          hiddenLayerBlock = lang === 'en'
            ? `## Hidden between-session layer active this session\n\nThe patient arrived guarding this (the trainee was NOT told it): "${avoided[0].content}"\n\nAssess in the feedback: did the trainee notice and gently draw it out? If the patient never disclosed it, what specifically could the therapist have done to surface it? Make this a priority teaching point.\n\n---\n\n`
            : `## Прихований шар між сесіями (активний цю сесію)\n\nПацієнт прийшов, оберігаючи це (стажеру цього НЕ казали): «${avoided[0].content}»\n\nОціни у фідбеку: чи помітив і м'яко витягнув це стажер? Якщо пацієнт так і не розкрив — що конкретно терапевт міг зробити, щоб це випливло? Винеси це як пріоритетний навчальний момент.\n\n---\n\n`;
        }
      }

      // Pass 3: synthesis — modelSkillsSynthesizer (Qwen 3.7 Max on
      // OpenRouter, Sonnet on Anthropic-native) reads the draft + all
      // skill JSONs → final coherent feedback streaming to client.
      // Uses a dedicated synthesizer model (not the tier-based reviewer)
      // so ALL users get the same quality regardless of plan tier.
      const synthesisFilled = this.prompts.fill(this.prompts.bundle(lang).skillsSynthesis, {
        PROFILE: slimProf,
        TRANSCRIPT: ctx.transcript,
        NOTES: notesText,
        DRAFT: skillDraft,
        SKILL_RESULTS: hiddenLayerBlock + skillResults,
      });
      for await (const chunk of this.streamFeedbackWithFallback(
        [{ text: synthesisFilled }],
        this.llm.modelSkillsSynthesizer,
        this.llm.modelFeedback, // Haiku fallback if synthesizer stalls
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

    void this.notifyFeedbackReady(session.userId, sessionId);

    // Mirror to the granular memory store (Phase 2) — same content,
    // but now joinable with future Phase-3/4 memories (NPC, diary).
    if (json?.patientMemory && session.userId) {
      await this.memory.add({
        characterId: session.characterId,
        userId: session.userId,
        sessionId,
        kind: 'session',
        content: json.patientMemory,
      });
    }

    yield { type: 'done', data: { feedback, assessment: json } };
  }

  /**
   * Build the modality + session-stage calibration preamble prepended to
   * every skill prompt. Tells each skill what approach the trainee is
   * practising and whether this is an intake or a follow-up, so it doesn't
   * flag the absence of things that are correct to omit in that context.
   * Returns '' when no context is available (e.g. eval), preserving the
   * skills' original behaviour.
   */
  private buildSkillContext(
    lang: string,
    ctx?: { modality?: string; isFirstSession?: boolean },
  ): string {
    if (!ctx || (!ctx.modality && ctx.isFirstSession === undefined)) return '';
    const isUk = lang !== 'en';
    const labels: Record<string, { uk: string; en: string }> = {
      individual: { uk: 'Індивідуальна', en: 'Individual' },
      couples: { uk: 'Парна', en: 'Couples' },
      family: { uk: 'Сімейна', en: 'Family' },
      adolescent: { uk: 'Підліткова', en: 'Adolescent' },
      crisis: { uk: 'Кризова', en: 'Crisis' },
    };
    const modKey = ctx.modality ?? 'individual';
    const modLabel = (labels[modKey] ?? labels['individual'])[isUk ? 'uk' : 'en'];
    const stage = ctx.isFirstSession
      ? (isUk ? 'Перша (інтейкова) сесія' : 'First (intake) session')
      : (isUk ? 'Продовження терапії (не перша сесія)' : 'Ongoing therapy (not the first session)');

    if (isUk) {
      return [
        '## Контекст сесії (враховуй при оцінці)',
        `- Модальність терапії: ${modLabel}`,
        `- Етап: ${stage}`,
        '',
        'Калібруй під це: НЕ позначай як помилку те, що доречно або очікувано',
        'для цієї модальності/етапу — напр. відсутність сократичного діалогу чи',
        'домашнього завдання поза CBT-підходом; відсутність повного збору анамнезу',
        'чи контрактування на продовженні (не першій) сесії; директивніший стиль у',
        'кризовій модальності. Оцінюй у межах підходу, який практикує терапевт, а не',
        'за універсальним CBT-шаблоном.',
        '',
        '---',
        '',
      ].join('\n');
    }
    return [
      '## Session context (factor this into your assessment)',
      `- Therapy modality: ${modLabel}`,
      `- Stage: ${stage}`,
      '',
      'Calibrate to this: do NOT flag as an error something that is appropriate or',
      'expected for this modality/stage — e.g. no Socratic dialogue or homework',
      'outside a CBT approach; no full history-taking or intake contracting on a',
      'follow-up (non-first) session; a more directive style in crisis work. Judge',
      "within the approach the therapist is practising, not against a universal CBT",
      'template.',
      '',
      '---',
      '',
    ].join('\n');
  }

  /**
   * Run all loaded skill agents in PARALLEL against the transcript.
   * Each skill targets a single clinical dimension (suicidality, defenses,
   * affect, alliance, ddx, technique) and returns a JSON analysis.
   * Cheap Haiku calls — each is 300-400 tokens output, takes ~5-8s.
   * Parallelism means total latency = slowest skill, not sum.
   *
   * Returns a formatted string summarising all results for injection
   * into the synthesis prompt. Failures are caught individually so
   * one flaky skill never blocks the others.
   */
  private async runSkillChecks(
    transcript: string,
    slimProfile: string,
    notesText: string,
    lang: string = this.prompts.lang,
    sessionCtx?: { modality?: string; isFirstSession?: boolean },
  ): Promise<string> {
    const bundle = this.prompts.bundle(lang);
    const skills = [...bundle.skills.entries()];
    if (skills.length === 0) return '_(skill prompts not loaded)_';

    const analyseInstruction = lang === 'en'
      ? 'Analyse the transcript according to the instructions above. Return only JSON.'
      : 'Проаналізуй транскрипт згідно інструкції вище. Поверни тільки JSON.';

    // Shared calibration preamble prepended to EVERY skill. Fixes a whole
    // class of false positives: several skills are CBT/intake-shaped
    // (cognitive_distortions wants Socratic dialogue, technique wants
    // homework, history_taking/session_structure/alliance want intake
    // contracting + full history). Without knowing the modality + session
    // stage they'd penalise approaches that are correct to omit (e.g. no
    // homework in person-centred work, no full history on a follow-up).
    // One orchestration-level block beats editing 16 prompt files.
    const contextPreamble = this.buildSkillContext(lang, sessionCtx);

    const results = await Promise.allSettled(
      skills.map(async ([name, template]) => {
        const filled = contextPreamble + this.prompts.fill(template, {
          TRANSCRIPT: transcript,
          PROFILE: slimProfile,
          NOTES: notesText,
        });
        const raw = await this.llm.chat({
          systemPrompt: filled,
          history: [{ role: 'user', content: analyseInstruction }],
          model: this.llm.modelFeedback, // cheap draft model — focused single-dimension tasks
          // 800 tokens: Gemini Flash needs 436 avg (max 757 observed).
          // Haiku needs 1200+ and still truncates 4/14 skills — Gemini
          // is the right model here (set via LLM_MODEL_FEEDBACK env var).
          maxTokens: 800,
        });
        return { name, raw };
      }),
    );

    // Programmatically extract critical misses and pin them to the TOP
    // of the skill results block so the synthesis model sees them
    // FIRST regardless of how many skills ran. Without this, attention
    // dilutes across 14+ JSON blocks and Qwen can miss a criticalMiss
    // signal buried in the middle. We check for both spellings because
    // models sometimes write the key with slightly different casing.
    const criticals: string[] = [];
    const allBlocks: string[] = [];

    for (const r of results) {
      if (r.status === 'fulfilled') {
        const { name, raw } = r.value;
        const block = `### Skill: ${name}\n\`\`\`json\n${raw.trim()}\n\`\`\``;
        allBlocks.push(block);
        if (/"criticalMiss"\s*:\s*true/i.test(raw)) {
          // Extract the recommendation string if present; otherwise just tag the skill name.
          // No upper length bound: on real transcripts the model writes
          // recommendations anywhere from ~150 to 650+ chars, and any fixed
          // cap ({10,300} then {10,600}) silently failed to match the longer
          // ones — dropping the actual recommendation from the critical-miss
          // header (the feedback eval kept catching this). `[^"]{10,}` is
          // safe: the negated-quote class can't cross the value's closing
          // quote, so it captures the whole string regardless of length. We
          // truncate to ~320 below purely for header tidiness.
          const recMatch = raw.match(/"recommendation"\s*:\s*"([^"]{10,})"/i);
          const rec = recMatch
            ? (recMatch[1].length > 320 ? recMatch[1].slice(0, 317) + '…' : recMatch[1])
            : `${name} flagged a critical miss — see skill result below.`;
          criticals.push(`- **${name}**: ${rec}`);
          this.logger.warn(`skill ${name}: criticalMiss=true`);
        }
      } else {
        this.logger.warn(`skill failed: ${(r as PromiseRejectedResult).reason}`);
        allBlocks.push(`### Skill: (error — ${String((r as PromiseRejectedResult).reason).slice(0, 80)})`);
      }
    }

    const priorityHeader =
      criticals.length > 0
        ? `## ⚠️ КРИТИЧНІ ПРОПУСКИ — ОБОВ'ЯЗКОВО ПЕРШИМИ У ФІДБЕКУ\n\n${criticals.join('\n')}\n\n---\n\n`
        : '';

    return priorityHeader + allBlocks.join('\n\n');
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
    lang: string = this.prompts.lang,
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

    const filled = this.prompts.fill(this.prompts.bundle(lang).criticReviewer, {
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
    lang: string = this.prompts.lang,
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
    const b   = this.prompts.bundle(lang);
    const tpl = b.supervisorSystem;
    const profileIdx = tpl.indexOf('{{PROFILE}}');
    const transcriptIdx = tpl.indexOf('{{TRANSCRIPT}}');
    if (profileIdx < 0 || transcriptIdx < 0 || profileIdx >= transcriptIdx) {
      // Template structure changed — fall back to a single uncached block
      // rather than mis-cutting the prompt.
      const flat = this.prompts.fill(tpl, {
        PROTOCOL: b.supervisorProtocol,
        PROFILE: session.character.profileText,
        TRANSCRIPT: transcript,
        NOTES: notesText,
      });
      return { systemBlocks: [{ text: flat }], transcript, lineMap };
    }

    const supervisorAndProtocol =
      tpl
        .substring(0, profileIdx)
        .replaceAll('{{PROTOCOL}}', b.supervisorProtocol)
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
      signals?: Record<string, boolean>;
      patientMemory?: string;
    } | null;
  } {
    // Find the last ```json ... ``` block
    const re = /```json\s*\n([\s\S]*?)\n```/gi;
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) lastMatch = m;
    if (!lastMatch) return { narrative: raw, json: null };

    const content = lastMatch[1];
    const before = raw.slice(0, lastMatch.index).trim();

    // Happy path: strict JSON.parse succeeds.
    try {
      return { narrative: before, json: JSON.parse(content) };
    } catch {
      // Fall through to lenient extractor.
    }

    // Lenient extractor — handles the LLM's common failure mode of
    // leaving inner double-quotes unescaped in string values (esp.
    // patientMemory: «у своїй "сірій" коробці» breaks JSON because
    // the inner `"` closes the string early). Rather than losing the
    // whole assessment, we pull out the fields we care about via
    // regex / span-anchored substring extraction.
    const lenient = this.extractLenient(content);
    if (lenient) {
      this.logger.warn(
        `splitFeedback: strict JSON.parse failed, used lenient extractor (likely unescaped inner quotes)`,
      );
      return { narrative: before, json: lenient };
    }
    return { narrative: raw, json: null };
  }

  /**
   * Tolerant assessment-block extractor. Pulls numeric metrics under
   * `patient` and `therapist` via key-anchored regex (skipping the
   * surrounding JSON structure), then grabs `patientMemory` as the
   * substring between its first opening quote and the last quote
   * before the final closing brace — which is correct even when the
   * value itself contains unescaped `"` characters.
   */
  private extractLenient(content: string): {
    patient?: Record<string, number | null>;
    therapist?: Record<string, number | null>;
    signals?: Record<string, boolean>;
    patientMemory?: string;
  } | null {
    const num = (key: string): number | null | undefined => {
      const re = new RegExp(`"${key}"\\s*:\\s*(\\d+(?:\\.\\d+)?|null)`);
      const m = content.match(re);
      if (!m) return undefined;
      return m[1] === 'null' ? null : Number(m[1]);
    };
    const bool = (key: string): boolean | undefined => {
      const m = content.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`));
      return m ? m[1] === 'true' : undefined;
    };
    const patientKeys = ['symptomSeverity', 'insight', 'alliance', 'defensiveness', 'hopefulness'];
    const therapistKeys = [
      'empathy', 'collaboration', 'guidedDiscovery', 'strategyForChange',
      'structure', 'pacing', 'formulation', 'homework',
    ];
    const signalKeys = ['riskScreened', 'hiddenLayerReached', 'ruptureRepaired', 'traumaGrounded'];

    const patient: Record<string, number | null> = {};
    for (const k of patientKeys) {
      const v = num(k);
      if (v !== undefined) patient[k] = v;
    }
    const therapist: Record<string, number | null> = {};
    for (const k of therapistKeys) {
      const v = num(k);
      if (v !== undefined) therapist[k] = v;
    }
    const signals: Record<string, boolean> = {};
    for (const k of signalKeys) {
      const v = bool(k);
      if (v !== undefined) signals[k] = v;
    }

    let patientMemory: string | undefined;
    const pmIdx = content.indexOf('"patientMemory"');
    if (pmIdx >= 0) {
      const colon = content.indexOf(':', pmIdx);
      const openQuote = content.indexOf('"', colon + 1);
      if (openQuote > 0) {
        // Find the last `"` before the final `}` of the block — that
        // robustly closes off the patientMemory string even when the
        // body has stray unescaped quotes.
        const lastBrace = content.lastIndexOf('}');
        const closeQuote = content.lastIndexOf('"', lastBrace - 1);
        if (closeQuote > openQuote) {
          patientMemory = content
            .slice(openQuote + 1, closeQuote)
            // Best-effort: unescape any actually-escaped quotes the
            // LLM did manage to write. Other escapes (newlines etc)
            // probably weren't present in the original anyway.
            .replace(/\\"/g, '"')
            .trim();
        }
      }
    }

    const anyField =
      Object.keys(patient).length > 0 ||
      Object.keys(therapist).length > 0 ||
      Object.keys(signals).length > 0 ||
      !!patientMemory;
    if (!anyField) return null;

    const out: {
      patient?: Record<string, number | null>;
      therapist?: Record<string, number | null>;
      signals?: Record<string, boolean>;
      patientMemory?: string;
    } = {};
    if (Object.keys(patient).length) out.patient = patient;
    if (Object.keys(therapist).length) out.therapist = therapist;
    if (Object.keys(signals).length) out.signals = signals;
    if (patientMemory) out.patientMemory = patientMemory;
    return out;
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

  /** Translate a billing-gate reason code into a user-facing Ukrainian
   *  sentence. Frontend ALSO has its own translation (so it can
   *  reformat with links/buttons), but having a server-side fallback
   *  means non-JS clients (curl, retry scripts) get readable errors. */
  private gateReasonMessage(reason: GateReason): string {
    switch (reason) {
      case 'paused':
        return 'Підписка призупинена. Відновіть її в /account/billing щоб продовжити.';
      case 'expired':
        return 'Підписка завершилась. Оновіть план на /pricing.';
      case 'trial-expired':
        return '14-денний trial закінчився. Оберіть тариф на /pricing щоб продовжити.';
      case 'session-limit-reached':
        return 'Ви досягли ліміту сесій на цьому тарифі. Оновіть до Pro для необмеженого доступу.';
      case 'feature-not-included':
        return 'Ця функція не входить у поточний тариф.';
      case 'modality-not-included':
        return 'Ця модальність терапії доступна з тарифу Pro.';
      case 'character-not-accessible':
        return 'Цей персонаж недоступний на trial. Оновіть до Lite або вище.';
      default:
        return 'Доступ заборонений політикою тарифу.';
    }
  }

  /**
   * Load a session's messages in chronological order. With `limit`, returns
   * only the most recent `limit` messages (still chronological) — used by the
   * per-turn chat path to bound prompt tokens. Without `limit` returns the full
   * transcript — required by feedback/hint generation, which numbers every line
   * as [L<n>] and must not drop any.
   */
  private async loadHistory(sessionId: number, limit?: number): Promise<ChatMessage[]> {
    const rows = await this.prisma.message.findMany({
      where: { sessionId },
      // When capping, fetch newest-first + take, then restore chronological
      // order below; otherwise read straight through oldest-first.
      orderBy: { id: limit ? 'desc' : 'asc' },
      ...(limit ? { take: limit } : {}),
      select: { role: true, content: true },
    });
    if (limit) rows.reverse();
    return rows.map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
  }

  /**
   * stateBias (gamification §12): a long gap since the trainee last saw this
   * patient bleeds into how the patient shows up today — more withdrawn the
   * longer the absence. HARD-BOUNDED to detachment / flatness / mild skepticism;
   * a neglected patient goes COLD, never into crisis. We explicitly forbid
   * crisis/self-harm escalation so the away-time can never manufacture a
   * clinical emergency (clinically grotesque + a dark pattern). Empty under 2
   * weeks (normal cadence triggers nothing). Stage-direction, not patient text.
   */
  private buildAbsenceContext(weeksIdle: number, lang: string): string {
    if (weeksIdle < 2) return '';
    const w = Math.round(weeksIdle);
    const uk = lang === 'uk';
    if (weeksIdle >= 6) {
      return uk
        ? `\n\n## Довга перерва (${w} тиж.)\nВи майже припинили ходити на сесії. Сьогодні приходите закрито, втомлено, з відстороненістю й тихим скепсисом «чи це взагалі допомагає». Тепло не з'являється одразу — рапорт ніби треба будувати заново. ВАЖЛИВО: це лише відстороненість і млявість, БЕЗ кризи, суїцидальних думок чи самоушкодження — не загострюйте стан через паузу.\n`
        : `\n\n## Long absence (${w} wks)\nYou'd nearly stopped coming. Today you arrive guarded, tired, detached, with a quiet "does this even help?" skepticism. Warmth doesn't return at once — rapport must be rebuilt. IMPORTANT: detachment and flatness ONLY — NO crisis, suicidal ideation, or self-harm because of the gap. Do not escalate.\n`;
    }
    if (weeksIdle >= 4) {
      return uk
        ? `\n\n## Помітна перерва (${w} тиж.)\nМинуло більше часу, ніж зазвичай. Ви трохи насторожені й відсторонені, з ноткою сумніву щодо терапії. Теплоту варто відновити поступово. Без кризи — просто стриманіше, ніж раніше.\n`
        : `\n\n## Notable gap (${w} wks)\nMore time than usual has passed. You're a bit guarded and detached, with a hint of doubt about therapy. Warmth should return gradually. No crisis — just more reserved than before.\n`;
    }
    return uk
      ? `\n\n## Невелика перерва (${w} тиж.)\nМинуло трохи більше часу між сесіями. Ви заходите трохи стриманіше, ніж зазвичай; теплота повертається протягом розмови.\n`
      : `\n\n## Short gap (${w} wks)\nA little more time than usual has passed. You come in slightly more reserved than usual; warmth returns over the conversation.\n`;
  }

  private async respondAsCharacter(
    profileText: string,
    displayName: string,
    history: ChatMessage[],
    priorMemories: string[] = [],
    difficulty: number | null = null,
    modality: string | null = null,
    cityId: number | null = null,
    lang: string = 'uk',
    characterId: number | null = null,
    userId: number | null = null,
    absenceContext: string = '',
  ): Promise<string> {
    const filled = this.prompts.fill(this.prompts.annaSystem, {
      CHARACTER_NAME: displayName,
      PROFILE: profileText,
    });
    const warning = this.prompts.profileLooksUnfilled(profileText)
      ? '\n\n[УВАГА: профіль персонажа не заповнений — звучатиме як шаблон.]'
      : '';
    // Phase 2: pull richer memory (session + diary + world + social +
    // seed) from MemoryService when we have userId+characterId. Falls
    // back to the legacy priorMemories array (session-only strings)
    // when these aren't passed — keeps the function callable from any
    // context without a regression.
    const memorySection =
      userId && characterId
        ? await this.buildMemorySection(userId, characterId, lang)
        : this.buildLegacyMemorySection(priorMemories);
    // Phase 3: close-people section listing each NPC with their
    // relation, bio, and current emotional tension. The model
    // organically references these in replies — "мама знов дзвонила",
    // "Денис не озвався три дні" — without us prompting per turn.
    const npcSection = characterId
      ? await this.buildNpcSection(characterId, lang)
      : '';

    // World context: a paragraph about what's happening in the
    // character's city this week. The character may or may not bring it
    // up — instructed to weave it in only if naturally relevant, not as
    // a forced segue. Sourced from City.weeklyDigest (cron-generated).
    const citySection = await this.buildCitySection(cityId, lang);

    const difficultyModulator = this.prompts.getDifficultyModulator(difficulty);
    // Modality modulator goes LAST so it's the strongest steering — the
    // model sees baseline persona → difficulty → modality framing right
    // before generating its reply. Empty string for 'individual'.
    const modalityModulator = this.prompts.getModalityChatModulator(modality);
    // Brevity instruction caps the reply length to the soft limit based
    // on difficulty + modality. Cuts output cost AND shrinks history for
    // subsequent turns — double-savings on long sessions.
    const brevityInstruction = this.prompts.getBrevityInstruction(difficulty, modality);
    // Output-language directive — placed LAST (strongest steering) so an
    // en/fr character replies in English/French even though the persona
    // template (anna_system.md) is authored in Ukrainian. Without this the
    // model mirrored the prompt's language and London/Paris patients spoke
    // Ukrainian.
    const languageDirective =
      lang === 'en'
        ? '\n\n## LANGUAGE (override — critical)\nYou are an English-speaking patient. Reply ONLY in natural, conversational English. Do NOT reply in Ukrainian or Russian, even though parts of these instructions are written in Ukrainian.'
        : lang === 'fr'
          ? '\n\n## LANGUE (impératif)\nTu es un patient francophone. Réponds UNIQUEMENT en français naturel et courant. Ne réponds jamais en ukrainien ni en russe, même si une partie de ces instructions est rédigée en ukrainien.'
          : '\n\n## Мова\nВідповідай природною розмовною українською.';
    return this.llm.chat({
      // absenceContext (stage-direction about a long gap since last session)
      // goes right after the persona + memories so the model factors it into
      // HOW the patient shows up today, before difficulty/modality steering.
      systemPrompt: filled + warning + memorySection + absenceContext + npcSection + citySection + difficultyModulator + modalityModulator + brevityInstruction + languageDirective,
      history,
      cacheSystem: true,
    });
  }

  /**
   * Build the "people close to you" section listing the character's
   * NPCs (mother, partner, etc) with relation + bio + current tension.
   * Sorted by tension DESC so high-stress relationships lead — that's
   * what a patient is most likely to bring up first. Empty string if
   * no NPCs are seeded for this character so callers stay simple.
   */
  private async buildNpcSection(characterId: number, lang: string): Promise<string> {
    const npcs = await this.npcs.listForCharacter(characterId);
    if (npcs.length === 0) return '';

    const isUk = lang === 'uk';
    const labelUk: Record<string, string> = {
      mother: 'мама',
      father: 'батько',
      partner: 'партнер/партнерка',
      ex: 'колишній/колишня',
      sibling: 'сестра/брат',
      child: 'дитина',
      friend: 'друг/подруга',
      colleague: 'колега',
      boss: 'керівник',
      neighbor: 'сусід/сусідка',
      therapist_prev: 'попередній терапевт',
      other: 'знайома людина',
    };
    const labelEn: Record<string, string> = {
      mother: 'mother',
      father: 'father',
      partner: 'partner',
      ex: 'ex',
      sibling: 'sibling',
      child: 'child',
      friend: 'friend',
      colleague: 'colleague',
      boss: 'boss',
      neighbor: 'neighbor',
      therapist_prev: 'previous therapist',
      other: 'someone you know',
    };
    const labels = isUk ? labelUk : labelEn;

    const lines = npcs.map((n) => {
      const rel = labels[n.relation] ?? n.relation;
      // Tension hint inline so the model knows whether to bring this
      // NPC up positively, neutrally, or as a source of stress.
      const tone = n.tension >= 7 ? (isUk ? ' (напружено)' : ' (tense)')
        : n.tension <= 3 ? (isUk ? ' (підтримка)' : ' (supportive)')
        : '';
      const bio = n.bio ? ` — ${n.bio}` : '';
      return `- **${n.name}** (${rel}${tone})${bio}`;
    });

    const header = isUk
      ? '\n\n# Близькі люди у твоєму житті'
      : '\n\n# People close to you';
    const instruction = isUk
      ? '\n\nЦе твоє соціальне коло. Згадуй їх природно — як справжня людина: "вчора мама дзвонила", "Денис знов мовчить". Не озвучуй цей список — лише вплети у репліку коли доречно (терапевт спитав про стосунки, як справи дома, з ким говориш про це).'
      : '\n\nThis is your social circle. Reference them naturally — like a real person: "mum called yesterday", "James went quiet again". Don\'t recite this list — weave it into replies only when relevant (therapist asks about relationships, how things are at home, who you talk to about this).';

    return `${header}\n\n${lines.join('\n')}${instruction}`;
  }

  /**
   * Build the "what you remember" section from the granular memory
   * store. Groups by kind so the LLM gets a coherent picture: therapy
   * memories together, between-session diary together, world reactions
   * separate. Returns empty string if no memories — the prompt simply
   * skips this section.
   *
   * Ranking comes from MemoryService.loadRecent which uses weight ×
   * recency. We pull top-10 across all kinds, then group for display.
   */
  private async buildMemorySection(
    userId: number,
    characterId: number,
    lang: string,
  ): Promise<string> {
    const memories = await this.memory.loadRecent(userId, characterId, { limit: 10 });
    if (memories.length === 0) return '';

    const isUk = lang === 'uk';
    const grouped = new Map<string, string[]>();
    for (const m of memories) {
      if (!grouped.has(m.kind)) grouped.set(m.kind, []);
      grouped.get(m.kind)!.push(m.content);
    }

    // 'avoided' memories (consequential between-session events the patient
    // is NOT ready to talk about) are pulled OUT of the normal recited
    // bullet list and rendered separately below as an avoidance directive —
    // otherwise the patient would just narrate them, defeating the point
    // (the trainee is supposed to draw them out).
    const avoidedItems = grouped.get('avoided') ?? [];
    grouped.delete('avoided');

    const labelsUk: Record<string, string> = {
      seed: 'З життя:',
      session: 'Про роботу з цим терапевтом:',
      social: 'Зі стосунків з близькими:',
      diary: 'Між зустрічами:',
      world: 'Із подій навколо:',
    };
    const labelsEn: Record<string, string> = {
      seed: 'From your life:',
      session: 'About work with this therapist:',
      social: 'From your close relationships:',
      diary: 'Between sessions:',
      world: 'From events around you:',
    };
    const labels = isUk ? labelsUk : labelsEn;
    // Stable kind order — therapy comes first because it's the core of
    // the relationship. seed is biographical background.
    const kindOrder = ['session', 'diary', 'social', 'world', 'seed'];

    const sections = kindOrder
      .filter((k) => grouped.has(k))
      .map((k) => {
        const items = grouped.get(k)!.map((c) => `- ${c}`).join('\n');
        return `*${labels[k] ?? k}*\n${items}`;
      })
      .join('\n\n');

    const header = isUk ? "\n\n# Що ти пам'ятаєш" : '\n\n# What you remember';
    const closing = isUk
      ? "\n\nЦе твоя пам'ять від першої особи. Не озвучуй усе підряд — згадуй природно, тільки коли це доречно у моменті. На першій репліці нової сесії можеш (але не мусиш) посилатися на минуле — як справжня людина повертається до знайомого терапевта."
      : "\n\nThis is your first-person memory. Don't recite it all — bring it up naturally only when relevant in the moment. On the first line of a new session, you may (but don't have to) reference the past — as a real person reconnecting with a familiar therapist.";

    // Avoidance directive for 'avoided' events — something heavy happened
    // since last session, but the patient guards it. The model must NOT
    // volunteer it; it surfaces only if the therapist asks directly AND
    // with enough warmth. This is exactly the skill the session trains.
    const avoidedBlock = avoidedItems.length
      ? isUk
        ? `\n\n# Те, про що тобі важко говорити\n\n${avoidedItems
            .map((c) => `- ${c}`)
            .join('\n')}\n\nЦе сталося нещодавно і зачіпає тебе глибше, ніж ти готова/-ий показати. САМ цю тему НЕ піднімай. Якщо терапевт прямо, м'яко і вчасно спитає — відкривайся поступово, неохоче, не все одразу. Якщо тисне грубо чи невчасно — закрийся ще більше: зміни тему, дай коротку відповідь, відмовчись. Уникнення має бути живим, а не демонстративним.`
        : `\n\n# What's hard for you to talk about\n\n${avoidedItems
            .map((c) => `- ${c}`)
            .join('\n')}\n\nThis happened recently and cuts deeper than you're ready to show. Do NOT raise it yourself. If the therapist asks directly, gently, and at the right moment — open up gradually, reluctantly, not all at once. If they push bluntly or too soon — close down further: change the subject, give a short answer, go quiet. The avoidance should feel real, not performative.`
      : '';

    return `${header}\n\n${sections}${closing}${avoidedBlock}`;
  }

  /** Fallback memory formatter used only when the new MemoryService
   *  path isn't available (no userId/characterId passed). Keeps the old
   *  layout so existing call paths don't regress. */
  private buildLegacyMemorySection(priorMemories: string[]): string {
    if (priorMemories.length === 0) return '';
    return `\n\n# Що ти пам'ятаєш про попередні сесії з цим терапевтом\n\nЦе твоя пам'ять, від першої особи. Не озвучуй усе — лише природно посилайся на минуле, якщо це доречно у моменті.\n\n${priorMemories
      .map((m, i) => `**Сесія ${i + 1}:** ${m}`)
      .join('\n\n')}\n\nНа першій репліці нової сесії ти можеш (але не зобов'язана) згадати щось із минулого — як зробила б реальна людина, що повертається до знайомого терапевта.`;
  }

  /**
   * Build the "world around you" section for a character's chat prompt.
   * Returns empty string if no cityId or no fresh digest — never throws,
   * because city context is enhancement-not-required: a missing digest
   * shouldn't break the chat. Wrapped with a clear instruction so the
   * model doesn't dump the digest verbatim; it's a background awareness.
   */
  private async buildCitySection(cityId: number | null, lang: string): Promise<string> {
    let city: { displayName: string; weeklyDigest: string | null; weatherSummary: string | null; lang?: string } | null = null;
    if (cityId) {
      city = await this.prisma.city.findUnique({
        where: { id: cityId },
        select: { displayName: true, weeklyDigest: true, weatherSummary: true, lang: true },
      });
    } else {
      // Legacy character without cityId — fall back to lang lookup.
      city = await this.city.getForLang(lang);
    }
    if (!city?.weeklyDigest) return '';

    const isUk = (city.lang ?? lang) === 'uk';
    const header = isUk
      ? `\n\n# Світ навколо тебе цього тижня (${city.displayName})`
      : `\n\n# The world around you this week (${city.displayName})`;
    const instruction = isUk
      ? '\n\nЦе фон твого щоденного життя. Не переказуй цей блок — лише органічно вплети у репліку, ЯКЩО це доречно (наприклад, терапевт спитав про настрій, погоду, як справи). Не починай з "цього тижня у нас було..." — це сухо. Лише природне зерно: "ой, ще й це блекаут вчора", "та й погода ця доконує".'
      : '\n\nThis is the everyday backdrop of your life. Don\'t recite this — weave it in naturally ONLY when relevant (e.g. therapist asks about mood, the week, how you are). No "this week we had..." openers — it\'s flat. Just natural grains: "and that blackout yesterday on top of it", "this weather is wearing me down".';
    const weather = city.weatherSummary
      ? `\n\n*Погода:* ${city.weatherSummary}`
      : '';
    return `${header}\n\n${city.weeklyDigest}${weather}${instruction}`;
  }
}
