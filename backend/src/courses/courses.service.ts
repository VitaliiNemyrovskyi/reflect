import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';

/**
 * Skill-path "courses": the learn → practice → feedback loop. A course is a
 * SkillPath of ordered steps; lessons render markdown, practice steps launch a
 * real session with a named patient and are checkpoint-graded off the feedback
 * signals the supervisor already emits (e.g. `riskScreened`). Progress is
 * derived from UserStepCompletion; completing every step awards a milestone.
 *
 * One track ("Інтейк і рапорт") is seeded create-only on boot. Content is
 * AI-drafted and SHOULD be reviewed by a licensed clinician before a public
 * launch — flip a track's `published` to control visibility.
 */
@Injectable()
export class CoursesService implements OnModuleInit {
  private readonly logger = new Logger(CoursesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seed();
    } catch (err) {
      this.logger.error('course seed failed', err as Error);
    }
  }

  // ─── Read ────────────────────────────────────────────────────────────────

  /** Published tracks + this user's done/total step counts. */
  async listForUser(userId: number) {
    const paths = await this.prisma.skillPath.findMany({
      where: { published: true },
      orderBy: { order: 'asc' },
      include: { steps: { select: { id: true } } },
    });
    const done = await this.doneStepIds(userId);
    return paths.map((p) => ({
      key: p.key,
      titleUk: p.titleUk,
      titleEn: p.titleEn,
      descUk: p.descUk,
      descEn: p.descEn,
      totalSteps: p.steps.length,
      doneSteps: p.steps.filter((s) => done.has(s.id)).length,
    }));
  }

  /** Full track with per-step status (lazily completing practice checkpoints). */
  async getDetail(userId: number, key: string) {
    const path = await this.prisma.skillPath.findFirst({
      where: { key, published: true },
      include: { steps: { orderBy: { order: 'asc' } } },
    });
    if (!path) throw new NotFoundException('course not found');

    const completions = await this.prisma.userStepCompletion.findMany({
      where: { userId, stepId: { in: path.steps.map((s) => s.id) } },
    });
    const byStep = new Map(completions.map((c) => [c.stepId, c]));

    // Resolve practice patients (displayName → {displayName, avatarUrl}).
    const refs = [...new Set(path.steps.map((s) => s.characterRef).filter(Boolean))] as string[];
    const chars = refs.length
      ? await this.prisma.character.findMany({
          where: { displayName: { in: refs } },
          select: { displayName: true, avatarUrl: true },
        })
      : [];
    const charByName = new Map(chars.map((c) => [c.displayName, c]));

    let completedAll = true;
    let prevDone = true; // first step is always available
    const steps = [];
    for (const s of path.steps) {
      let c = byStep.get(s.id);
      // Lazy checkpoint: a practice session whose feedback now satisfies the
      // step's criterion flips it to done.
      if (s.kind === 'practice' && c && !c.completedAt && c.sessionId != null) {
        c = (await this.evaluatePractice(userId, s, c)) ?? c;
      }
      const isDone = !!c?.completedAt;
      if (!isDone) completedAll = false;
      const patient = s.characterRef ? charByName.get(s.characterRef) ?? null : null;
      steps.push({
        id: s.id,
        order: s.order,
        kind: s.kind,
        titleUk: s.titleUk,
        titleEn: s.titleEn,
        bodyUk: s.bodyUk,
        bodyEn: s.bodyEn,
        techniqueKey: s.techniqueKey,
        patient: patient ? { displayName: patient.displayName, avatarUrl: patient.avatarUrl } : null,
        sessionId: c?.sessionId ?? null,
        done: isDone,
        available: prevDone, // sequential unlock
      });
      prevDone = isDone;
    }

    return {
      key: path.key,
      titleUk: path.titleUk,
      titleEn: path.titleEn,
      descUk: path.descUk,
      descEn: path.descEn,
      completed: completedAll && path.steps.length > 0,
      steps,
    };
  }

  // ─── Write ───────────────────────────────────────────────────────────────

  /** Acknowledge a lesson step (mark it done). */
  async completeLesson(userId: number, stepId: number) {
    const step = await this.loadPublishedStep(stepId);
    if (step.kind !== 'lesson') throw new BadRequestException('not a lesson step');
    await this.prisma.userStepCompletion.upsert({
      where: { userId_stepId: { userId, stepId } },
      create: { userId, stepId, completedAt: new Date() },
      update: { completedAt: new Date() },
    });
    await this.maybeAwardCompletion(userId, step.pathId);
    return { ok: true };
  }

  /** Launch a practice session for a step; link it for checkpoint grading. */
  async startPractice(userId: number, stepId: number): Promise<{ sessionId: number }> {
    const step = await this.loadPublishedStep(stepId);
    if (step.kind !== 'practice' || !step.characterRef) {
      throw new BadRequestException('not a practice step');
    }
    const character = await this.prisma.character.findFirst({
      where: { displayName: step.characterRef },
      select: { id: true },
    });
    if (!character) throw new BadRequestException('practice patient unavailable');

    // Reuse the normal session pipeline (billing gate + opening message).
    const created = await this.sessions.create(userId, character.id);
    const sessionId = (created as { sessionId: number }).sessionId;

    await this.prisma.userStepCompletion.upsert({
      where: { userId_stepId: { userId, stepId } },
      create: { userId, stepId, sessionId },
      update: { sessionId, completedAt: null, startedAt: new Date() },
    });
    return { sessionId };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async doneStepIds(userId: number): Promise<Set<number>> {
    const rows = await this.prisma.userStepCompletion.findMany({
      where: { userId, completedAt: { not: null } },
      select: { stepId: true },
    });
    return new Set(rows.map((r) => r.stepId));
  }

  private async loadPublishedStep(stepId: number) {
    const step = await this.prisma.skillPathStep.findUnique({
      where: { id: stepId },
      include: { path: { select: { published: true } } },
    });
    if (!step || !step.path.published) throw new NotFoundException('step not found');
    return step;
  }

  /**
   * If the practice session has feedback and meets the step's checkpoint
   * (passSignal true, or no signal required), mark the step complete.
   * Returns the updated completion row, or null if nothing changed.
   */
  private async evaluatePractice(
    userId: number,
    step: { id: number; pathId: number; passSignal: string | null },
    completion: { id: number; sessionId: number | null },
  ) {
    if (completion.sessionId == null) return null;
    const session = await this.prisma.session.findUnique({
      where: { id: completion.sessionId },
      select: { feedbackJson: true },
    });
    if (!session?.feedbackJson) return null; // no feedback yet

    let pass = true;
    if (step.passSignal) {
      try {
        const j = JSON.parse(session.feedbackJson) as {
          signals?: Record<string, unknown>;
        };
        pass = j?.signals?.[step.passSignal] === true;
      } catch {
        pass = false;
      }
    }
    if (!pass) return null;

    const updated = await this.prisma.userStepCompletion.update({
      where: { id: completion.id },
      data: { completedAt: new Date() },
    });
    await this.maybeAwardCompletion(userId, step.pathId);
    return updated;
  }

  /** Award the course-completion milestone once every step in the path is done. */
  private async maybeAwardCompletion(userId: number, pathId: number) {
    const steps = await this.prisma.skillPathStep.findMany({
      where: { pathId },
      select: { id: true },
    });
    if (steps.length === 0) return;
    const done = await this.prisma.userStepCompletion.count({
      where: { userId, completedAt: { not: null }, stepId: { in: steps.map((s) => s.id) } },
    });
    if (done < steps.length) return;
    const path = await this.prisma.skillPath.findUnique({
      where: { id: pathId },
      select: { key: true },
    });
    if (!path) return;
    try {
      await this.prisma.userMilestone.create({
        data: { userId, key: `course.${path.key}.completed` },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
  }

  // ─── Seed ───────────────────────────────────────────────────────────────

  private async seed(): Promise<void> {
    for (const track of SEED_TRACKS) {
      const exists = await this.prisma.skillPath.findUnique({
        where: { key: track.key },
        select: { id: true },
      });
      if (exists) continue;
      await this.prisma.skillPath.create({
        data: {
          key: track.key,
          titleUk: track.titleUk,
          titleEn: track.titleEn,
          descUk: track.descUk,
          descEn: track.descEn,
          order: track.order,
          published: track.published,
          steps: {
            create: track.steps.map((s, i) => ({
              order: i,
              kind: s.kind,
              titleUk: s.titleUk,
              titleEn: s.titleEn,
              bodyUk: s.bodyUk ?? null,
              bodyEn: s.bodyEn ?? null,
              characterRef: s.characterRef ?? null,
              techniqueKey: s.techniqueKey ?? null,
              passSignal: s.passSignal ?? null,
            })),
          },
        },
      });
      this.logger.log(`course seeded: ${track.key} (${track.steps.length} steps)`);
    }
  }
}

interface SeedStep {
  kind: 'lesson' | 'practice';
  titleUk: string;
  titleEn: string;
  bodyUk?: string;
  bodyEn?: string;
  characterRef?: string;
  techniqueKey?: string;
  passSignal?: string;
}

const SEED_TRACKS: Array<{
  key: string;
  titleUk: string;
  titleEn: string;
  descUk: string;
  descEn: string;
  order: number;
  published: boolean;
  steps: SeedStep[];
}> = [
  {
    key: 'intake-rapport',
    titleUk: 'Інтейк і рапорт',
    titleEn: 'Intake & rapport',
    descUk:
      'Перший трек: як відкрити сесію, побудувати робочий альянс і делікатно перевірити ризик. 3 уроки + 2 практики з фідбеком.',
    descEn:
      'The first track: how to open a session, build the working alliance, and screen risk gently. 3 lessons + 2 practices with feedback.',
    order: 1,
    published: true,
    steps: [
      {
        kind: 'lesson',
        titleUk: 'Рамка першої сесії',
        titleEn: 'Framing the first session',
        bodyUk:
          '## Навіщо рамка\nПерша сесія — це не допит і не миттєве втручання. Її завдання — **створити безпеку, зібрати орієнтовну картину й домовитися про роботу**.\n\n## Що варто пройти\n- **Запит** — з чим прийшов клієнт *його словами* («Що привело вас сьогодні?»).\n- **Контекст** — коли почалося, як впливає на життя, що вже пробували.\n- **Ризик** — коротко, але прямо (детальніше в окремому уроці).\n- **Контракт** — тривалість, конфіденційність, чого очікувати.\n\n## Орієнтир\nБіопсихосоціальна модель: біологічне (сон, апетит) · психологічне (думки, емоції, копінг) · соціальне (стосунки, робота, підтримка).\n\n> Не намагайся «вирішити» все на першій зустрічі. Слухай більше, ніж говориш.',
        bodyEn:
          "## Why a frame\nThe first session isn't an interrogation or a rush to intervene. Its job is to **create safety, gather a rough picture, and agree how you'll work**.\n\n## What to cover\n- **Presenting concern** — why now, in the client's *own words* (\"What brings you in today?\").\n- **Context** — when it started, how it affects life, what they've tried.\n- **Risk** — briefly but directly (covered in a later lesson).\n- **Contract** — length, confidentiality, what to expect.\n\n## A map\nThe biopsychosocial model: biological (sleep, appetite) · psychological (thoughts, emotions, coping) · social (relationships, work, support).\n\n> Don't try to 'fix' everything in the first meeting. Listen more than you speak.",
      },
      {
        kind: 'lesson',
        titleUk: 'Робочий альянс',
        titleEn: 'The working alliance',
        bodyUk:
          '## Альянс важливіший за техніку\nНайсильніший предиктор результату терапії — **робочий альянс**, а не конкретний метод.\n\n## Три складові (Бордін)\n- **Звʼязок** — довіра й тепло між вами.\n- **Цілі** — спільне розуміння, куди йдемо.\n- **Завдання** — згода щодо того, *як* туди дійти.\n\n## Ядрові умови (Роджерс)\n- **Емпатія** — точне відчуття світу клієнта.\n- **Безумовне прийняття** — без осуду.\n- **Конгруентність** — щирість, без «маски експерта».\n\n> Рапорт будується не словами «довіртеся мені», а тим, що клієнт почувається почутим.',
        bodyEn:
          '## Alliance beats technique\nThe strongest predictor of therapy outcome is the **working alliance**, not the specific method.\n\n## Three parts (Bordin)\n- **Bond** — trust and warmth between you.\n- **Goals** — a shared sense of where you are headed.\n- **Tasks** — agreement on *how* to get there.\n\n## Core conditions (Rogers)\n- **Empathy** — accurately sensing the client’s world.\n- **Unconditional positive regard** — no judgement.\n- **Congruence** — being genuine, no “expert mask”.\n\n> Rapport is built not by saying “trust me” but by the client feeling heard.',
      },
      {
        kind: 'practice',
        titleUk: 'Перша зустріч',
        titleEn: 'First contact',
        characterRef: 'Анна',
        techniqueKey: 'rapport',
        bodyUk:
          '**Завдання:** проведи перші хвилини першої сесії з Анною. Фокус — рапорт: відкриті питання, віддзеркалення почуттів, без поспіху з порадами. Заверши сесію й отримай фідбек, щоб зарахувати крок.',
        bodyEn:
          '**Task:** run the opening minutes of a first session with Anna. Focus on rapport: open questions, reflecting feelings, no rush to advice. End the session and get feedback to complete the step.',
      },
      {
        kind: 'lesson',
        titleUk: 'Скринінг ризику — делікатно',
        titleEn: 'Screening risk, gently',
        bodyUk:
          '## Питати про ризик — обовʼязково\nУникати теми суїциду небезпечніше, ніж спитати. Пряме питання **не «підштовхує»** — воно дає полегшення й точність.\n\n## Як спитати, не зруйнувавши контакт\n1. **Нормалізуй**: «Коли людям так важко, інколи зʼявляються думки, що не хочеться жити. Чи бувають такі у вас?»\n2. **Уточни** (логіка C-SSRS): думки → план → засоби → намір.\n3. **Залишайся спокійним і теплим** — твоя реакція вчить клієнта, що про це *можна* говорити.\n\n## Чого не робити\n- Не питай «Ви ж не думаєте про щось погане?» (закрите, осудливе).\n- Не міняй тему одразу після відповіді.\n\n> У наступній практиці крок зарахується, коли фідбек покаже сигнал «ризик перевірено».',
        bodyEn:
          '## Asking about risk is mandatory\nAvoiding the topic of suicide is riskier than asking. A direct question does **not** “plant the idea” — it brings relief and clarity.\n\n## How to ask without breaking contact\n1. **Normalise**: “When things are this hard, people sometimes have thoughts that they don’t want to be alive. Do you ever have those?”\n2. **Clarify** (C-SSRS logic): thoughts → plan → means → intent.\n3. **Stay calm and warm** — your reaction teaches the client this *can* be talked about.\n\n## What not to do\n- Don’t ask “You’re not thinking of anything bad, are you?” (closed, judgemental).\n- Don’t change the subject right after the answer.\n\n> In the next practice the step passes once the feedback shows the “risk screened” signal.',
      },
      {
        kind: 'practice',
        titleUk: 'Скринінг ризику',
        titleEn: 'Risk screening',
        characterRef: 'Олеся',
        techniqueKey: 'risk_screening',
        passSignal: 'riskScreened',
        bodyUk:
          '**Завдання:** у розмові з Олесею делікатно, але прямо перевір ризик суїциду (нормалізуй → уточни). Крок зарахується, коли фідбек покаже сигнал «ризик перевірено».',
        bodyEn:
          "**Task:** during the session with Olesia, screen for suicide risk gently but directly (normalise → clarify). This step passes when the feedback shows the 'risk screened' signal.",
      },
    ],
  },
];
