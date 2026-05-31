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
import { GlossaryService } from '../glossary/glossary.service';

/**
 * Skill-path "courses": Course → Modules → Steps, closing the
 * learn → practice → feedback loop. Steps are lessons (structured blocks),
 * quizzes (MCQs), or practice (a real session with a named patient, graded off
 * the supervisor feedback signals — e.g. `riskScreened`). Progress is derived
 * from UserStepCompletion across the whole course; finishing every step awards
 * a milestone.
 *
 * One course is seeded/upserted on boot. Content is AI-drafted and SHOULD be
 * reviewed by a licensed clinician before a public launch — flip `published`.
 */
@Injectable()
export class CoursesService implements OnModuleInit {
  private readonly logger = new Logger(CoursesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly glossary: GlossaryService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seed();
    } catch (err) {
      this.logger.error('course seed failed', err as Error);
    }
  }

  // ─── Read ────────────────────────────────────────────────────────────────

  /** Published courses + this user's done/total step counts. */
  async listForUser(userId: number) {
    const paths = await this.prisma.skillPath.findMany({
      where: { published: true },
      orderBy: { order: 'asc' },
      include: { modules: { include: { steps: { select: { id: true } } } } },
    });
    const done = await this.doneStepIds(userId);
    return paths.map((p) => {
      const stepIds = p.modules.flatMap((m) => m.steps.map((s) => s.id));
      return {
        key: p.key,
        titleUk: p.titleUk,
        titleEn: p.titleEn,
        descUk: p.descUk,
        descEn: p.descEn,
        moduleCount: p.modules.length,
        totalSteps: stepIds.length,
        doneSteps: stepIds.filter((id) => done.has(id)).length,
      };
    });
  }

  /** Full course: modules (+ objectives) and per-step status, with sequential
   *  unlock across the whole course and lazy practice-checkpoint evaluation. */
  async getDetail(userId: number, key: string) {
    const path = await this.prisma.skillPath.findFirst({
      where: { key, published: true },
      include: {
        modules: {
          orderBy: { order: 'asc' },
          include: { steps: { orderBy: { order: 'asc' } } },
        },
      },
    });
    if (!path) throw new NotFoundException('course not found');

    const allStepIds = path.modules.flatMap((m) => m.steps.map((s) => s.id));
    const completions = await this.prisma.userStepCompletion.findMany({
      where: { userId, stepId: { in: allStepIds } },
    });
    const byStep = new Map(completions.map((c) => [c.stepId, c]));

    // Resolve practice patients once.
    const refs = [
      ...new Set(
        path.modules.flatMap((m) => m.steps.map((s) => s.characterRef)).filter(Boolean) as string[],
      ),
    ];
    const chars = refs.length
      ? await this.prisma.character.findMany({
          where: { displayName: { in: refs } },
          select: { displayName: true, avatarUrl: true },
        })
      : [];
    const charByName = new Map(chars.map((c) => [c.displayName, c]));

    let completedAll = true;
    let prevDone = true; // first step of the course is always available
    const modules = [];
    for (const m of path.modules) {
      const steps = [];
      for (const s of m.steps) {
        let c = byStep.get(s.id);
        if (s.kind === 'practice' && c && !c.completedAt && c.sessionId != null) {
          c = (await this.evaluatePractice(userId, s, path.id)) ?? c;
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
          contentUk: this.parseJson(s.bodyUk),
          contentEn: this.parseJson(s.bodyEn),
          quizUk: this.parseJson(s.quizUk),
          quizEn: this.parseJson(s.quizEn),
          techniqueKey: s.techniqueKey,
          patient: patient ? { displayName: patient.displayName, avatarUrl: patient.avatarUrl } : null,
          sessionId: c?.sessionId ?? null,
          done: isDone,
          available: prevDone,
        });
        prevDone = isDone;
      }
      modules.push({
        id: m.id,
        order: m.order,
        titleUk: m.titleUk,
        titleEn: m.titleEn,
        objectivesUk: this.parseJson(m.objectivesUk),
        objectivesEn: this.parseJson(m.objectivesEn),
        steps,
      });
    }

    return {
      key: path.key,
      titleUk: path.titleUk,
      titleEn: path.titleEn,
      descUk: path.descUk,
      descEn: path.descEn,
      completed: completedAll && allStepIds.length > 0,
      modules,
      glossary: await this.glossary.listForCourse(path.key),
    };
  }

  // ─── Write ───────────────────────────────────────────────────────────────

  /** Mark a lesson or quiz step done. */
  async completeStep(userId: number, stepId: number) {
    const step = await this.loadPublishedStep(stepId);
    if (step.kind === 'practice') throw new BadRequestException('practice steps complete via feedback');
    await this.prisma.userStepCompletion.upsert({
      where: { userId_stepId: { userId, stepId } },
      create: { userId, stepId, completedAt: new Date() },
      update: { completedAt: new Date() },
    });
    await this.maybeAwardCompletion(userId, step.module.pathId);
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

  private parseJson(raw: string | null): unknown[] {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

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
      include: { module: { include: { path: { select: { id: true, published: true } } } } },
    });
    if (!step || !step.module.path.published) throw new NotFoundException('step not found');
    return step;
  }

  private async evaluatePractice(
    userId: number,
    step: { id: number; passSignal: string | null },
    pathId: number,
  ) {
    const completion = await this.prisma.userStepCompletion.findUnique({
      where: { userId_stepId: { userId, stepId: step.id } },
    });
    if (!completion || completion.completedAt || completion.sessionId == null) return null;
    const session = await this.prisma.session.findUnique({
      where: { id: completion.sessionId },
      select: { feedbackJson: true },
    });
    if (!session?.feedbackJson) return null;

    let pass = true;
    if (step.passSignal) {
      try {
        const j = JSON.parse(session.feedbackJson) as { signals?: Record<string, unknown> };
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
    await this.maybeAwardCompletion(userId, pathId);
    return updated;
  }

  /** Award the course-completion milestone once every step in the course is done. */
  private async maybeAwardCompletion(userId: number, pathId: number) {
    const modules = await this.prisma.skillPathModule.findMany({
      where: { pathId },
      select: { steps: { select: { id: true } } },
    });
    const stepIds = modules.flatMap((m) => m.steps.map((s) => s.id));
    if (stepIds.length === 0) return;
    const done = await this.prisma.userStepCompletion.count({
      where: { userId, completedAt: { not: null }, stepId: { in: stepIds } },
    });
    if (done < stepIds.length) return;
    const path = await this.prisma.skillPath.findUnique({ where: { id: pathId }, select: { key: true } });
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
    for (const course of SEED_COURSES) {
      const meta = {
        titleUk: course.titleUk,
        titleEn: course.titleEn,
        descUk: course.descUk,
        descEn: course.descEn,
        order: course.order,
        published: course.published,
      };
      const path = await this.prisma.skillPath.upsert({
        where: { key: course.key },
        create: { key: course.key, ...meta },
        update: meta,
      });
      for (let mi = 0; mi < course.modules.length; mi++) {
        const m = course.modules[mi];
        const mMeta = {
          titleUk: m.titleUk,
          titleEn: m.titleEn,
          objectivesUk: m.objectivesUk ? JSON.stringify(m.objectivesUk) : null,
          objectivesEn: m.objectivesEn ? JSON.stringify(m.objectivesEn) : null,
        };
        const mod = await this.prisma.skillPathModule.upsert({
          where: { pathId_order: { pathId: path.id, order: mi } },
          create: { pathId: path.id, order: mi, ...mMeta },
          update: mMeta,
        });
        for (let si = 0; si < m.steps.length; si++) {
          const s = m.steps[si];
          const data = {
            kind: s.kind,
            titleUk: s.titleUk,
            titleEn: s.titleEn,
            bodyUk: s.bodyUk ? JSON.stringify(s.bodyUk) : null,
            bodyEn: s.bodyEn ? JSON.stringify(s.bodyEn) : null,
            quizUk: s.quizUk ? JSON.stringify(s.quizUk) : null,
            quizEn: s.quizEn ? JSON.stringify(s.quizEn) : null,
            characterRef: s.characterRef ?? null,
            techniqueKey: s.techniqueKey ?? null,
            passSignal: s.passSignal ?? null,
          };
          await this.prisma.skillPathStep.upsert({
            where: { moduleId_order: { moduleId: mod.id, order: si } },
            create: { moduleId: mod.id, order: si, ...data },
            update: data,
          });
        }
      }
      this.logger.log(`course seeded/updated: ${course.key} (${course.modules.length} modules)`);
    }
  }
}

type LessonBlock =
  | { type: 'h'; text: string }
  | { type: 'p'; text: string }
  | { type: 'list'; items: { term?: string; text: string }[] }
  | { type: 'dialogue'; lines: { who: string; text: string }[] }
  | { type: 'quote'; text: string };

interface QuizQuestion {
  q: string;
  options: string[];
  correct: number;
  explain?: string;
}

interface SeedStep {
  kind: 'lesson' | 'practice' | 'quiz';
  titleUk: string;
  titleEn: string;
  bodyUk?: LessonBlock[];
  bodyEn?: LessonBlock[];
  quizUk?: QuizQuestion[];
  quizEn?: QuizQuestion[];
  characterRef?: string;
  techniqueKey?: string;
  passSignal?: string;
}

interface SeedModule {
  titleUk: string;
  titleEn: string;
  objectivesUk?: string[];
  objectivesEn?: string[];
  steps: SeedStep[];
}

const SEED_COURSES: Array<{
  key: string;
  titleUk: string;
  titleEn: string;
  descUk: string;
  descEn: string;
  order: number;
  published: boolean;
  modules: SeedModule[];
}> = [
  {
    key: 'intake-rapport',
    titleUk: 'Інтейк, рапорт і ризик',
    titleEn: 'Intake, rapport and risk',
    descUk:
      'Базовий курс: як відкрити першу сесію, побудувати робочий альянс, активно слухати й делікатно перевірити ризик. 3 модулі — теорія, квізи та практика з фідбеком.',
    descEn:
      'The foundation course: opening a first session, building the working alliance, active listening, and gently screening risk. 3 modules — theory, quizzes and practice with feedback.',
    order: 1,
    published: true,
    modules: [
      {
        titleUk: 'Рамка та робочий альянс',
        titleEn: 'Frame and working alliance',
        objectivesUk: [
          'Розуміти завдання першої сесії та її структуру.',
          'Будувати робочий альянс через ядрові умови.',
          'Відпрацювати рапорт у живій сесії.',
        ],
        objectivesEn: [
          'Understand the goals and structure of a first session.',
          'Build the working alliance through the core conditions.',
          'Practise rapport in a live session.',
        ],
        steps: [
          {
            kind: 'lesson',
            titleUk: 'Рамка першої сесії',
            titleEn: 'Framing the first session',
            bodyUk: [
              { type: 'p', text: 'Перша сесія — це не допит і не миттєве втручання. Її завдання — створити безпеку, зібрати орієнтовну картину й домовитися про спільну роботу. Якщо клієнт виходить із відчуттям, що його почули, — сесія вдала, навіть якщо ви «нічого не вирішили».' },
              { type: 'h', text: 'Що варто пройти' },
              { type: 'list', items: [
                { term: 'Запит', text: 'з чим прийшов клієнт — його словами. Починайте відкрито: «Що привело вас сьогодні?»' },
                { term: 'Контекст', text: 'коли почалося, як впливає на життя (сон, робота, стосунки), що вже пробували.' },
                { term: 'Ризик', text: 'коротко, але прямо — думки про самоушкодження (детально — у третьому модулі).' },
                { term: 'Контракт', text: 'тривалість, конфіденційність та її межі, чого очікувати від терапії.' },
              ] },
              { type: 'h', text: 'Орієнтир: біопсихосоціальна модель' },
              { type: 'p', text: 'Тримайте в голові три рівні: біологічне (сон, апетит, здоровʼя, речовини), психологічне (думки, емоції, копінг, переконання) і соціальне (стосунки, робота, підтримка, культура).' },
              { type: 'h', text: 'Типові помилки новачка' },
              { type: 'list', items: [
                { text: 'Засипати клієнта анкетними питаннями замість слухати.' },
                { text: 'Кидатися «лагодити» проблему на першій же зустрічі.' },
                { text: 'Уникати теми меж і конфіденційності, бо «незручно».' },
              ] },
              { type: 'quote', text: 'Слухай більше, ніж говориш. На першій сесії співвідношення приблизно 80/20 на користь клієнта.' },
            ],
            bodyEn: [
              { type: 'p', text: 'A first session is not an interrogation or a rush to intervene. Its job is to create safety, gather a rough picture, and agree on working together. If the client leaves feeling heard, the session worked — even if you "solved" nothing.' },
              { type: 'h', text: 'What to cover' },
              { type: 'list', items: [
                { term: 'Presenting concern', text: 'why they came, in their own words. Open wide: "What brings you in today?"' },
                { term: 'Context', text: 'when it started, how it affects life (sleep, work, relationships), what they have tried.' },
                { term: 'Risk', text: 'briefly but directly — thoughts of self-harm (covered fully in module 3).' },
                { term: 'Contract', text: 'length, confidentiality and its limits, what to expect from therapy.' },
              ] },
              { type: 'h', text: 'A map: the biopsychosocial model' },
              { type: 'p', text: 'Hold three levels in mind: biological (sleep, appetite, health, substances), psychological (thoughts, emotions, coping, beliefs), and social (relationships, work, support, culture).' },
              { type: 'h', text: 'Common beginner mistakes' },
              { type: 'list', items: [
                { text: 'Burying the client in intake questions instead of listening.' },
                { text: 'Rushing to "fix" the problem in the first meeting.' },
                { text: 'Avoiding boundaries and confidentiality because it feels awkward.' },
              ] },
              { type: 'quote', text: 'Listen more than you speak. On a first session aim for roughly 80/20 in the client favour.' },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Робочий альянс',
            titleEn: 'The working alliance',
            bodyUk: [
              { type: 'p', text: 'Найсильніший предиктор результату терапії — це робочий альянс, а не конкретний метод. Якщо альянсу немає, найкраща техніка не спрацює.' },
              { type: 'h', text: 'Три складові (Бордін)' },
              { type: 'list', items: [
                { term: 'Звʼязок', text: 'довіра й тепло між вами.' },
                { term: 'Цілі', text: 'спільне розуміння, куди ви рухаєтесь.' },
                { term: 'Завдання', text: 'згода щодо того, як саме туди дійти.' },
              ] },
              { type: 'h', text: 'Ядрові умови (Роджерс)' },
              { type: 'list', items: [
                { term: 'Емпатія', text: 'точне відчуття світу клієнта зсередини.' },
                { term: 'Безумовне прийняття', text: 'повага без осуду.' },
                { term: 'Конгруентність', text: 'щирість, без «маски експерта».' },
              ] },
              { type: 'h', text: 'Як це звучить' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Не знаю, чи це взагалі варте вашого часу…' },
                { who: 'Терапевт', text: 'Схоже, вам трохи незручно про це говорити. Те, що для вас важливо, — варте часу. З чого вам легше почати?' },
              ] },
              { type: 'quote', text: 'Рапорт будується не словами «довіртеся мені», а тим, що клієнт відчуває: його почули.' },
            ],
            bodyEn: [
              { type: 'p', text: 'The strongest predictor of therapy outcome is the working alliance, not the specific method. Without an alliance, even the best technique falls flat.' },
              { type: 'h', text: 'Three parts (Bordin)' },
              { type: 'list', items: [
                { term: 'Bond', text: 'trust and warmth between you.' },
                { term: 'Goals', text: 'a shared sense of where you are heading.' },
                { term: 'Tasks', text: 'agreement on how to get there.' },
              ] },
              { type: 'h', text: 'Core conditions (Rogers)' },
              { type: 'list', items: [
                { term: 'Empathy', text: 'accurately sensing the client world from the inside.' },
                { term: 'Unconditional positive regard', text: 'respect without judgement.' },
                { term: 'Congruence', text: 'being genuine, no "expert mask".' },
              ] },
              { type: 'h', text: 'What it sounds like' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'I am not sure this is even worth your time…' },
                { who: 'Therapist', text: 'It sounds a little uncomfortable to bring up. What matters to you is worth the time. Where is it easiest to start?' },
              ] },
              { type: 'quote', text: 'Rapport is built not by saying "trust me" but by the client feeling heard.' },
            ],
          },
          {
            kind: 'quiz',
            titleUk: 'Перевірка: рамка та альянс',
            titleEn: 'Check: frame and alliance',
            quizUk: [
              {
                q: 'Що є найсильнішим предиктором результату терапії?',
                options: ['Конкретний метод (КПТ, ПДТ тощо)', 'Робочий альянс', 'Кількість сесій', 'Досвід терапевта в роках'],
                correct: 1,
                explain: 'Альянс послідовно випереджає вибір методу як предиктор результату.',
              },
              {
                q: 'Які три складові робочого альянсу за Бордіном?',
                options: ['Звʼязок, цілі, завдання', 'Емпатія, повага, щирість', 'Запит, контекст, контракт', 'Біологічне, психологічне, соціальне'],
                correct: 0,
                explain: 'Бордін: звʼязок (bond), цілі (goals), завдання (tasks).',
              },
            ],
            quizEn: [
              {
                q: 'What is the strongest predictor of therapy outcome?',
                options: ['The specific method (CBT, psychodynamic, etc.)', 'The working alliance', 'The number of sessions', 'The therapist years of experience'],
                correct: 1,
                explain: 'The alliance consistently outpredicts the choice of method.',
              },
              {
                q: 'What are Bordin three components of the working alliance?',
                options: ['Bond, goals, tasks', 'Empathy, regard, genuineness', 'Concern, context, contract', 'Biological, psychological, social'],
                correct: 0,
                explain: 'Bordin: bond, goals, tasks.',
              },
            ],
          },
          {
            kind: 'practice',
            titleUk: 'Практика: перша зустріч',
            titleEn: 'Practice: first contact',
            characterRef: 'Анна',
            techniqueKey: 'rapport',
            bodyUk: [
              { type: 'p', text: 'Завдання: проведи перші хвилини першої сесії з Анною. Фокус — рапорт: відкриті питання, віддзеркалення почуттів, без поспіху з порадами. Заверши сесію й отримай фідбек, щоб зарахувати крок.' },
            ],
            bodyEn: [
              { type: 'p', text: 'Task: run the opening minutes of a first session with Anna. Focus on rapport: open questions, reflecting feelings, no rush to advice. End the session and get feedback to complete the step.' },
            ],
          },
        ],
      },
      {
        titleUk: 'Активне слухання (OARS)',
        titleEn: 'Active listening (OARS)',
        objectivesUk: [
          'Володіти чотирма навичками OARS.',
          'Відрізняти відкриті питання від закритих.',
          'Будувати рефлексії замість порад.',
        ],
        objectivesEn: [
          'Command the four OARS skills.',
          'Tell open questions from closed ones.',
          'Build reflections instead of giving advice.',
        ],
        steps: [
          {
            kind: 'lesson',
            titleUk: 'Відкриті питання й рефлексії',
            titleEn: 'Open questions and reflections',
            bodyUk: [
              { type: 'p', text: 'OARS — чотири базові навички слухання з мотиваційного інтервʼю: Open questions (відкриті питання), Affirmations (підтримки), Reflections (рефлексії), Summaries (резюме). Цей урок — про перші дві найпотужніші.' },
              { type: 'h', text: 'Відкриті vs закриті' },
              { type: 'list', items: [
                { term: 'Закрите', text: '«Ви спите погано?» — відповідь «так/ні», розмова глухне.' },
                { term: 'Відкрите', text: '«Розкажіть, як виглядають ваші ночі?» — клієнт розгортає історію.' },
              ] },
              { type: 'h', text: 'Рефлексія замість поради' },
              { type: 'p', text: 'Рефлексія — це коли ви повертаєте клієнту суть почутого своїми словами. Вона показує, що ви слухаєте, і запрошує заглибитись. Проста рефлексія повторює зміст; складна — додає здогад про почуття чи значення.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Я просто роблю, що маю, і не думаю про це.' },
                { who: 'Терапевт', text: 'Тримаєтесь на автоматі — бо зупинитись і відчути зараз надто важко.' },
              ] },
              { type: 'h', text: 'Чого не робити' },
              { type: 'list', items: [
                { text: 'Серія закритих питань поспіль (ефект допиту).' },
                { text: 'Поради до того, як клієнт відчув себе почутим.' },
              ] },
              { type: 'quote', text: 'Орієнтир: щонайменше одна рефлексія на кожне питання.' },
            ],
            bodyEn: [
              { type: 'p', text: 'OARS are the four core listening skills from motivational interviewing: Open questions, Affirmations, Reflections, Summaries. This lesson covers the two most powerful.' },
              { type: 'h', text: 'Open vs closed' },
              { type: 'list', items: [
                { term: 'Closed', text: '"Do you sleep badly?" — a yes/no, the conversation stalls.' },
                { term: 'Open', text: '"Tell me what your nights look like?" — the client unfolds a story.' },
              ] },
              { type: 'h', text: 'Reflection instead of advice' },
              { type: 'p', text: 'A reflection hands back the essence of what you heard, in your words. It shows you are listening and invites depth. A simple reflection restates content; a complex one adds a guess about feeling or meaning.' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'I just do what I have to and do not think about it.' },
                { who: 'Therapist', text: 'You keep going on autopilot — because stopping to feel it right now is too much.' },
              ] },
              { type: 'h', text: 'What not to do' },
              { type: 'list', items: [
                { text: 'A run of closed questions back to back (the interrogation effect).' },
                { text: 'Advice before the client feels heard.' },
              ] },
              { type: 'quote', text: 'Aim for at least one reflection per question.' },
            ],
          },
          {
            kind: 'quiz',
            titleUk: 'Перевірка: OARS',
            titleEn: 'Check: OARS',
            quizUk: [
              {
                q: 'Яке з цих питань відкрите?',
                options: ['Вам стало гірше цього тижня?', 'Ви приймаєте ліки?', 'Як ви переживали цей тиждень?', 'Ви спали вночі?'],
                correct: 2,
                explain: 'Відкрите питання запрошує розгорнуту відповідь, а не «так/ні».',
              },
              {
                q: 'Що таке рефлексія?',
                options: ['Порада, що робити далі', 'Повернення клієнту суті почутого своїми словами', 'Закрите уточнювальне питання', 'Інтерпретація з позиції експерта'],
                correct: 1,
                explain: 'Рефлексія повертає зміст/почуття, показуючи, що ви слухаєте.',
              },
            ],
            quizEn: [
              {
                q: 'Which of these is an open question?',
                options: ['Did it get worse this week?', 'Do you take medication?', 'How did you get through this week?', 'Did you sleep last night?'],
                correct: 2,
                explain: 'An open question invites an unfolding answer, not yes/no.',
              },
              {
                q: 'What is a reflection?',
                options: ['Advice on what to do next', 'Handing back the essence of what was said, in your words', 'A closed clarifying question', 'An expert interpretation'],
                correct: 1,
                explain: 'A reflection mirrors content/feeling, showing you are listening.',
              },
            ],
          },
          {
            kind: 'practice',
            titleUk: 'Практика: активне слухання',
            titleEn: 'Practice: active listening',
            characterRef: 'Максим',
            techniqueKey: 'oars',
            bodyUk: [
              { type: 'p', text: 'Завдання: у розмові з Максимом тримай баланс OARS — більше відкритих питань і рефлексій, ніж порад. Заверши сесію й отримай фідбек, щоб зарахувати крок.' },
            ],
            bodyEn: [
              { type: 'p', text: 'Task: in the session with Maksym keep the OARS balance — more open questions and reflections than advice. End the session and get feedback to complete the step.' },
            ],
          },
        ],
      },
      {
        titleUk: 'Скринінг ризику',
        titleEn: 'Risk screening',
        objectivesUk: [
          'Розуміти, чому уникати теми ризику небезпечніше, ніж питати.',
          'Знати послідовність уточнення (логіка C-SSRS).',
          'Перевірити ризик у практиці, не зруйнувавши контакт.',
        ],
        objectivesEn: [
          'Understand why avoiding the risk topic is more dangerous than asking.',
          'Know the clarifying sequence (C-SSRS logic).',
          'Screen risk in practice without breaking contact.',
        ],
        steps: [
          {
            kind: 'lesson',
            titleUk: 'Як питати про ризик',
            titleEn: 'How to ask about risk',
            bodyUk: [
              { type: 'p', text: 'Уникати теми суїциду небезпечніше, ніж спитати. Пряме питання не «підштовхує» — воно дає полегшення й точність. Більшість клієнтів відчувають полегшення, що про це нарешті можна сказати вголос.' },
              { type: 'h', text: 'Як спитати, не зруйнувавши контакт' },
              { type: 'list', items: [
                { term: 'Нормалізуй', text: 'коли людям так важко, інколи бувають думки, що не хочеться жити — чи є такі у вас?' },
                { term: 'Уточни (логіка C-SSRS)', text: 'думки → план → засоби → намір. Кожен наступний рівень підвищує гостроту.' },
                { term: 'Будь спокійним і теплим', text: 'твоя реакція вчить клієнта, що про це можна говорити.' },
              ] },
              { type: 'h', text: 'Чого не робити' },
              { type: 'list', items: [
                { text: 'Питати закрито й осудливо: «Ви ж не думаєте про щось погане?»' },
                { text: 'Міняти тему одразу після відповіді — це сигнал «про це не можна».' },
                { text: 'Давати фальшиві обіцянки замість плану безпеки.' },
              ] },
              { type: 'quote', text: 'У практиці цього модуля крок зарахується, коли фідбек покаже сигнал «ризик перевірено».' },
            ],
            bodyEn: [
              { type: 'p', text: 'Avoiding the topic of suicide is more dangerous than asking. A direct question does not "plant the idea" — it brings relief and clarity. Most clients feel relieved it can finally be said out loud.' },
              { type: 'h', text: 'How to ask without breaking contact' },
              { type: 'list', items: [
                { term: 'Normalise', text: 'when things are this hard, people sometimes have thoughts that they do not want to be alive — do you ever have those?' },
                { term: 'Clarify (C-SSRS logic)', text: 'thoughts → plan → means → intent. Each level raises the acuity.' },
                { term: 'Stay calm and warm', text: 'your reaction teaches the client this can be talked about.' },
              ] },
              { type: 'h', text: 'What not to do' },
              { type: 'list', items: [
                { text: 'Ask in a closed, judgemental way: "You are not thinking of anything bad, are you?"' },
                { text: 'Change the subject right after the answer — it signals "we do not discuss this".' },
                { text: 'Give false reassurance instead of a safety plan.' },
              ] },
              { type: 'quote', text: 'In this module practice, the step passes when the feedback shows the "risk screened" signal.' },
            ],
          },
          {
            kind: 'quiz',
            titleUk: 'Перевірка: ризик',
            titleEn: 'Check: risk',
            quizUk: [
              {
                q: 'Чи може пряме питання про суїцид «підштовхнути» клієнта до думок?',
                options: ['Так, тому краще не питати', 'Ні — пряме питання радше дає полегшення й точність', 'Лише якщо клієнт молодий', 'Тільки в кризі'],
                correct: 1,
                explain: 'Докази свідчать: прямі питання не підвищують ризик, а допомагають.',
              },
              {
                q: 'Яка послідовність уточнення ризику (логіка C-SSRS)?',
                options: ['План → думки → намір → засоби', 'Думки → план → засоби → намір', 'Намір → засоби → думки → план', 'Засоби → намір → план → думки'],
                correct: 1,
                explain: 'Думки → план → засоби → намір: кожен рівень підвищує гостроту.',
              },
            ],
            quizEn: [
              {
                q: 'Can a direct question about suicide "plant" the idea?',
                options: ['Yes, so it is better not to ask', 'No — a direct question tends to bring relief and clarity', 'Only with young clients', 'Only in a crisis'],
                correct: 1,
                explain: 'Evidence shows direct questions do not raise risk; they help.',
              },
              {
                q: 'What is the risk-clarifying sequence (C-SSRS logic)?',
                options: ['Plan → thoughts → intent → means', 'Thoughts → plan → means → intent', 'Intent → means → thoughts → plan', 'Means → intent → plan → thoughts'],
                correct: 1,
                explain: 'Thoughts → plan → means → intent: each level raises acuity.',
              },
            ],
          },
          {
            kind: 'practice',
            titleUk: 'Практика: скринінг ризику',
            titleEn: 'Practice: risk screening',
            characterRef: 'Олеся',
            techniqueKey: 'risk_screening',
            passSignal: 'riskScreened',
            bodyUk: [
              { type: 'p', text: 'Завдання: у розмові з Олесею делікатно, але прямо перевір ризик суїциду (нормалізуй → уточни). Крок зарахується, коли фідбек покаже сигнал «ризик перевірено».' },
            ],
            bodyEn: [
              { type: 'p', text: 'Task: during the session with Olesia, screen for suicide risk gently but directly (normalise then clarify). This step passes when the feedback shows the "risk screened" signal.' },
            ],
          },
        ],
      },
    ],
  },
];
