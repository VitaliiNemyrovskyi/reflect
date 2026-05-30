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
        contentUk: this.parseBlocks(s.bodyUk),
        contentEn: this.parseBlocks(s.bodyEn),
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

  /** Parse a step's stored JSON content into typed blocks (empty if none). */
  private parseBlocks(raw: string | null): LessonBlock[] {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? (v as LessonBlock[]) : [];
    } catch {
      return [];
    }
  }

  // ─── Seed ───────────────────────────────────────────────────────────────

  private async seed(): Promise<void> {
    for (const track of SEED_TRACKS) {
      // Upsert the path + each step by (pathId, order) so content edits
      // propagate on deploy while step ids — and the UserStepCompletion links
      // that reference them — survive.
      const meta = {
        titleUk: track.titleUk,
        titleEn: track.titleEn,
        descUk: track.descUk,
        descEn: track.descEn,
        order: track.order,
        published: track.published,
      };
      const path = await this.prisma.skillPath.upsert({
        where: { key: track.key },
        create: { key: track.key, ...meta },
        update: meta,
      });
      for (let i = 0; i < track.steps.length; i++) {
        const s = track.steps[i];
        const data = {
          kind: s.kind,
          titleUk: s.titleUk,
          titleEn: s.titleEn,
          bodyUk: s.bodyUk ? JSON.stringify(s.bodyUk) : null,
          bodyEn: s.bodyEn ? JSON.stringify(s.bodyEn) : null,
          characterRef: s.characterRef ?? null,
          techniqueKey: s.techniqueKey ?? null,
          passSignal: s.passSignal ?? null,
        };
        await this.prisma.skillPathStep.upsert({
          where: { pathId_order: { pathId: path.id, order: i } },
          create: { pathId: path.id, order: i, ...data },
          update: data,
        });
      }
      this.logger.log(`course seeded/updated: ${track.key} (${track.steps.length} steps)`);
    }
  }
}

/** Structured lesson content block — rendered natively on the client (no markdown). */
export type LessonBlock =
  | { type: 'h'; text: string }
  | { type: 'p'; text: string }
  | { type: 'list'; ordered?: boolean; items: { term?: string; text: string }[] }
  | { type: 'quote'; text: string };

interface SeedStep {
  kind: 'lesson' | 'practice';
  titleUk: string;
  titleEn: string;
  bodyUk?: LessonBlock[];
  bodyEn?: LessonBlock[];
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
        bodyUk: [
          { type: 'h', text: 'Навіщо рамка' },
          { type: 'p', text: 'Перша сесія — це не допит і не миттєве втручання. Її завдання — створити безпеку, зібрати орієнтовну картину й домовитися про роботу.' },
          { type: 'h', text: 'Що варто пройти' },
          { type: 'list', items: [
            { term: 'Запит', text: 'з чим прийшов клієнт його словами.' },
            { term: 'Контекст', text: 'коли почалося, як впливає на життя, що вже пробували.' },
            { term: 'Ризик', text: 'коротко, але прямо (детальніше — окремий урок).' },
            { term: 'Контракт', text: 'тривалість, конфіденційність, чого очікувати.' },
          ] },
          { type: 'h', text: 'Орієнтир' },
          { type: 'p', text: 'Біопсихосоціальна модель: біологічне (сон, апетит) · психологічне (думки, емоції, копінг) · соціальне (стосунки, робота, підтримка).' },
          { type: 'quote', text: 'Не намагайся вирішити все на першій зустрічі. Слухай більше, ніж говориш.' },
        ],
        bodyEn: [
          { type: 'h', text: 'Why a frame' },
          { type: 'p', text: 'The first session is not an interrogation or a rush to intervene. Its job is to create safety, gather a rough picture, and agree how you will work.' },
          { type: 'h', text: 'What to cover' },
          { type: 'list', items: [
            { term: 'Presenting concern', text: 'why now, in the client own words.' },
            { term: 'Context', text: 'when it started, how it affects life, what they tried.' },
            { term: 'Risk', text: 'briefly but directly (its own lesson later).' },
            { term: 'Contract', text: 'length, confidentiality, what to expect.' },
          ] },
          { type: 'h', text: 'A map' },
          { type: 'p', text: 'The biopsychosocial model: biological (sleep, appetite) · psychological (thoughts, emotions, coping) · social (relationships, work, support).' },
          { type: 'quote', text: 'Do not try to fix everything in the first meeting. Listen more than you speak.' },
        ],
      },
      {
        kind: 'lesson',
        titleUk: 'Робочий альянс',
        titleEn: 'The working alliance',
        bodyUk: [
          { type: 'h', text: 'Альянс важливіший за техніку' },
          { type: 'p', text: 'Найсильніший предиктор результату терапії — робочий альянс, а не конкретний метод.' },
          { type: 'h', text: 'Три складові (Бордін)' },
          { type: 'list', items: [
            { term: 'Звʼязок', text: 'довіра й тепло між вами.' },
            { term: 'Цілі', text: 'спільне розуміння, куди йдемо.' },
            { term: 'Завдання', text: 'згода щодо того, як туди дійти.' },
          ] },
          { type: 'h', text: 'Ядрові умови (Роджерс)' },
          { type: 'list', items: [
            { term: 'Емпатія', text: 'точне відчуття світу клієнта.' },
            { term: 'Безумовне прийняття', text: 'без осуду.' },
            { term: 'Конгруентність', text: 'щирість, без маски експерта.' },
          ] },
          { type: 'quote', text: 'Рапорт будується не словами довіртеся мені, а тим, що клієнт почувається почутим.' },
        ],
        bodyEn: [
          { type: 'h', text: 'Alliance beats technique' },
          { type: 'p', text: 'The strongest predictor of therapy outcome is the working alliance, not the specific method.' },
          { type: 'h', text: 'Three parts (Bordin)' },
          { type: 'list', items: [
            { term: 'Bond', text: 'trust and warmth between you.' },
            { term: 'Goals', text: 'a shared sense of where you are headed.' },
            { term: 'Tasks', text: 'agreement on how to get there.' },
          ] },
          { type: 'h', text: 'Core conditions (Rogers)' },
          { type: 'list', items: [
            { term: 'Empathy', text: 'accurately sensing the client world.' },
            { term: 'Unconditional positive regard', text: 'no judgement.' },
            { term: 'Congruence', text: 'being genuine, no expert mask.' },
          ] },
          { type: 'quote', text: 'Rapport is built not by saying trust me but by the client feeling heard.' },
        ],
      },
      {
        kind: 'practice',
        titleUk: 'Перша зустріч',
        titleEn: 'First contact',
        characterRef: 'Анна',
        techniqueKey: 'rapport',
        bodyUk: [
          { type: 'p', text: 'Завдання: проведи перші хвилини першої сесії з Анною. Фокус — рапорт: відкриті питання, віддзеркалення почуттів, без поспіху з порадами. Заверши сесію й отримай фідбек, щоб зарахувати крок.' },
        ],
        bodyEn: [
          { type: 'p', text: 'Task: run the opening minutes of a first session with Anna. Focus on rapport: open questions, reflecting feelings, no rush to advice. End the session and get feedback to complete the step.' },
        ],
      },
      {
        kind: 'lesson',
        titleUk: 'Скринінг ризику — делікатно',
        titleEn: 'Screening risk, gently',
        bodyUk: [
          { type: 'p', text: 'Уникати теми суїциду небезпечніше, ніж спитати. Пряме питання не підштовхує — воно дає полегшення й точність.' },
          { type: 'h', text: 'Як спитати, не зруйнувавши контакт' },
          { type: 'list', ordered: true, items: [
            { term: 'Нормалізуй', text: 'коли людям так важко, інколи бувають думки, що не хочеться жити — чи є такі у вас?' },
            { term: 'Уточни', text: 'логіка C-SSRS: думки → план → засоби → намір.' },
            { term: 'Будь спокійним і теплим', text: 'твоя реакція вчить клієнта, що про це можна говорити.' },
          ] },
          { type: 'h', text: 'Чого не робити' },
          { type: 'list', items: [
            { text: 'Не питай закрито й осудливо.' },
            { text: 'Не міняй тему одразу після відповіді.' },
          ] },
          { type: 'quote', text: 'У наступній практиці крок зарахується, коли фідбек покаже сигнал ризик перевірено.' },
        ],
        bodyEn: [
          { type: 'p', text: 'Avoiding the topic of suicide is riskier than asking. A direct question does not plant the idea — it brings relief and clarity.' },
          { type: 'h', text: 'How to ask without breaking contact' },
          { type: 'list', ordered: true, items: [
            { term: 'Normalise', text: 'when things are this hard, people sometimes have thoughts that they do not want to be alive — do you ever have those?' },
            { term: 'Clarify', text: 'C-SSRS logic: thoughts → plan → means → intent.' },
            { term: 'Stay calm and warm', text: 'your reaction teaches the client this can be talked about.' },
          ] },
          { type: 'h', text: 'What not to do' },
          { type: 'list', items: [
            { text: 'Do not ask in a closed, judgemental way.' },
            { text: 'Do not change the subject right after the answer.' },
          ] },
          { type: 'quote', text: 'In the next practice the step passes once the feedback shows the risk screened signal.' },
        ],
      },
      {
        kind: 'practice',
        titleUk: 'Скринінг ризику',
        titleEn: 'Risk screening',
        characterRef: 'Олеся',
        techniqueKey: 'risk_screening',
        passSignal: 'riskScreened',
        bodyUk: [
          { type: 'p', text: 'Завдання: у розмові з Олесею делікатно, але прямо перевір ризик суїциду (нормалізуй → уточни). Крок зарахується, коли фідбек покаже сигнал ризик перевірено.' },
        ],
        bodyEn: [
          { type: 'p', text: 'Task: during the session with Olesia, screen for suicide risk gently but directly (normalise then clarify). This step passes when the feedback shows the risk screened signal.' },
        ],
      },
    ],
  },
];
