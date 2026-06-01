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
      aboutUk: this.parseJson(path.aboutUk),
      aboutEn: this.parseJson(path.aboutEn),
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
        aboutUk: course.aboutUk ? JSON.stringify(course.aboutUk) : null,
        aboutEn: course.aboutEn ? JSON.stringify(course.aboutEn) : null,
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
  | { type: 'quote'; text: string }
  | { type: 'figure'; figure: string; caption?: string }
  | { type: 'sources'; sources: { label: string; url: string }[] };

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
  aboutUk?: LessonBlock[];
  aboutEn?: LessonBlock[];
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
    aboutUk: [
      { type: 'p', text: '«Інтейк, рапорт і ризик» — базовий курс про те, як провести першу зустріч із клієнтом: від першого «Що вас привело?» до делікатної перевірки ризику й домовленості про спільну роботу.' },
      { type: 'h', text: 'Чого ти навчишся' },
      { type: 'list', items: [
        { text: 'Впевнено відкривати першу сесію й тримати рамку.' },
        { text: 'Будувати робочий альянс через емпатію, прийняття й щирість.' },
        { text: 'Активно слухати за моделлю OARS — питання, рефлексії, підтримки, резюме.' },
        { text: 'Делікатно, але прямо перевіряти суїцидальний ризик і складати план безпеки.' },
      ] },
      { type: 'h', text: 'Як влаштовано курс' },
      { type: 'p', text: '3 модулі. У кожному — кілька коротких уроків (теорія з прикладами-діалогами), квіз на закріплення і практика з AI-пацієнтом, де ти застосовуєш навичку наживо й отримуєш фідбек від AI-супервізора.' },
      { type: 'p', text: 'Орієнтовно 30–40 хвилин теорії плюс практичні сесії у твоєму темпі. Кроки відкриваються послідовно — від простого до складнішого.' },
    ],
    aboutEn: [
      { type: 'p', text: '"Intake, rapport and risk" is the foundation course on running a first meeting with a client: from the first "What brings you in?" to a gentle risk check and agreeing on working together.' },
      { type: 'h', text: 'What you will learn' },
      { type: 'list', items: [
        { text: 'Open a first session with confidence and hold the frame.' },
        { text: 'Build the working alliance through empathy, regard and genuineness.' },
        { text: 'Listen actively with OARS — questions, reflections, affirmations, summaries.' },
        { text: 'Screen suicide risk gently but directly, and build a safety plan.' },
      ] },
      { type: 'h', text: 'How the course works' },
      { type: 'p', text: '3 modules. Each has a few short lessons (theory with dialogue examples), a quiz to consolidate, and practice with an AI patient where you apply the skill live and get feedback from an AI supervisor.' },
      { type: 'p', text: 'Roughly 30–40 minutes of theory plus practice sessions at your own pace. Steps unlock in order — from simpler to harder.' },
    ],
    order: 1,
    published: true,
    modules: [
      {
        titleUk: 'Рамка та робочий альянс',
        titleEn: 'Frame and working alliance',
        objectivesUk: [
          'Розуміти завдання першої сесії та її структуру.',
          'Будувати робочий альянс через ядрові умови.',
          'Помічати й відновлювати розриви альянсу.',
          'Відпрацювати рапорт і відновлення розриву в живій сесії.',
        ],
        objectivesEn: [
          'Understand the goals and structure of a first session.',
          'Build the working alliance through the core conditions.',
          'Notice and repair alliance ruptures.',
          'Practise rapport and rupture repair in a live session.',
        ],
        steps: [
          {
            kind: 'lesson',
            titleUk: 'Рамка першої сесії',
            titleEn: 'Framing the first session',
            bodyUk: [
              { type: 'p', text: 'Уяви першу зустріч із боку клієнта. Людина пів години чекала в коридорі, прокручувала в голові, з чого почати — можливо, вперше в житті зважилася прийти. Вона сідає навпроти, дивиться на тебе й замовкає. І саме тут новачок часто тягнеться до бланка: «Розкажіть, коли почалося, що приймаєте, як спите…». Здається логічним — треба ж зібрати анамнез. Насправді це найгірший можливий старт.' },
              { type: 'p', text: 'Чому? Бо людина прийшла не заповнювати анкету. Вона прийшла з надією, що її нарешті почують — і саме це відчуття вирішує, чи буде друга сесія. Робочий альянс, тобто звʼязок між вами, — найсильніший відомий предиктор результату терапії (r ≈ 0.28; метааналіз Flückiger, 2018, 295 досліджень), сильніший за вибір методу. А закладається він не колись потім, а в ці перші хвилини. Анамнез нікуди не втече; довіра, зруйнована допитом на старті, повертається важко.' },
              { type: 'h', text: 'То яке ж завдання першої сесії?' },
              { type: 'p', text: 'Не «поставити діагноз» і не «почати лікувати». Три простіші речі: створити безпеку, скласти орієнтовну картину й домовитися про спільну роботу. Парадокс у тому, що якщо клієнт вийшов із відчуттям, що його почули, — сесія вже вдала, навіть якщо ви формально «нічого не вирішили». Тому й орієнтир: слухати більше, ніж говорити, — приблизно 80/20 на користь клієнта.' },
              { type: 'p', text: 'Це не означає, що факти не потрібні. До кінця зустрічі ти хочеш приблизно розуміти чотири речі — але здобуваєш їх у живій розмові, а не опитувальником:' },
              { type: 'list', items: [
                { term: 'Запит', text: 'з чим прийшов клієнт — його словами. Звідси й починаєш: «Що привело вас сьогодні?»' },
                { term: 'Контекст', text: 'коли почалося, як впливає на життя (сон, робота, стосунки), що вже пробували.' },
                { term: 'Ризик', text: 'коротко, але прямо — чи є думки про самоушкодження (детально — у третьому модулі).' },
                { term: 'Контракт', text: 'тривалість, конфіденційність та її межі, чого взагалі очікувати від терапії.' },
              ] },
              { type: 'h', text: 'Як це вкладається в 50 хвилин' },
              { type: 'p', text: 'Сесія — це близько 50 хвилин. Ось грубий орієнтир, як їх розподілити, щоб не загрузнути на старті й не забути про головне під кінець:' },
              { type: 'figure', figure: 'session-arc' },
              { type: 'p', text: 'Перші ~5 хвилин — контакт і відкрите запрошення. Основна частина, близько 30 хвилин, — дослідження запиту й контексту, де ти переважно слухаєш. Ближче до кінця — коротка, але пряма перевірка ризику. Останні ~10 хвилин — рамка й завершення. Це не жорсткий протокол, а страховка: новачки зазвичай застрягають у першій третині, а ризик і контракт лишають «на потім» — коли часу вже немає.' },
              { type: 'h', text: 'Щоб не проґавити цілого пласта життя' },
              { type: 'p', text: 'Новачок легко зациклюється на тому, з чим клієнт прийшов («погано сплю»), і не помічає решти. Біопсихосоціальна модель (Енгель, 1977) — проста страховка від такого тунельного зору: тримай у голові три рівні й перевір подумки, чи не лишився котрийсь порожнім.' },
              { type: 'figure', figure: 'biopsychosocial' },
              { type: 'p', text: 'Біологічне (сон, апетит, здоровʼя, речовини), психологічне (думки, емоції, копінг) і соціальне (стосунки, робота, підтримка, культура). Корінь часто не там, де болить: «погано сплю» виявляється не про сон, а про тривогу через борги — і ти побачиш це, лише якщо переведеш погляд на соціальний рівень.' },
              { type: 'h', text: 'Як це звучить на старті' },
              { type: 'dialogue', lines: [
                { who: 'Терапевт', text: 'Що привело вас сьогодні? Розкажіть своїми словами — з чого вам зручніше почати.' },
                { who: 'Клієнт', text: 'Навіть не знаю… все якось навалилось одразу.' },
                { who: 'Терапевт', text: 'Тоді почнімо з «усього». Що з цього найважче саме зараз?' },
              ] },
              { type: 'h', text: 'Рамка — це межі, що дають безпеку' },
              { type: 'p', text: 'Слово «рамка» тут не випадкове. Це домовленості, що тримають терапію: час і тривалість, конфіденційність, ролі, що відбувається між зустрічами. Здається формальністю — але парадокс у тому, що саме передбачувані межі дають клієнту змогу почуватися безпечно й говорити відверто. Кабінет без меж тривожить так само, як ігровий майданчик без огорожі біля дороги.' },
              { type: 'p', text: 'Найважливіше проговорити — конфіденційність та її межі. Скажи прямо й по-людськи: усе, що тут звучить, лишається між вами — окрім ситуацій, коли є реальна загроза життю (клієнта чи інших). Це не залякування, а чесність: людина має право знати правила наперед. І, знову ж таки, ясно названа межа радше зміцнює довіру, ніж підриває її.' },
              { type: 'p', text: 'Сюди ж — практичне: скільки триває сесія, як часто зустрічаєтесь, що робити при скасуванні, чи пишеш ти між сесіями. Дрібниці — але вони знімають тривогу невизначеності, особливо якщо для людини це перший досвід терапії.' },
              { type: 'h', text: 'Як завершити першу сесію' },
              { type: 'p', text: 'Кінець важить майже стільки ж, скільки початок. За кілька хвилин до завершення стисло віддзеркаль почуте: «Якщо підсумувати, найбільше вас виснажує…». Це показує, що ти слухав, і впорядковує кашу в голові клієнта.' },
              { type: 'p', text: 'І те, що часто недооцінюють, — дай реалістичну надію. Дослідження загальних чинників (common factors) показують: віра клієнта, що йому можна допомогти, — не «приємний бонус», а один із активних механізмів зміни. Не обіцяй швидкого чуда; чесно скажи, що з тим, із чим він прийшов, працюють — і це має сенс.' },
              { type: 'p', text: 'Наостанок домовтесь про наступний крок — чи буде друга зустріч і коли. Людина має вийти не з порожнім «і що тепер?», а з відчуттям, що шлях уже почався.' },
              { type: 'p', text: 'Найчастіша помилка новачка — не сказати щось «не те», а перетворити зустріч на допит. Поруч є ще дві. Перша — кидатися «лагодити» проблему вже на першій зустрічі: це передчасно, бо ти ще не бачиш картини, і клієнт відчуває, що його не дослухали. Друга — оминати тему меж і конфіденційності, бо «незручно». Парадокс: саме ясні межі й дають клієнту безпеку говорити відверто.' },
              { type: 'quote', text: 'Перша сесія — це не збір даних. Це момент, коли людина вирішує, чи варто вам довіряти. Усе інше — потім.' },
              { type: 'sources', sources: [
                { label: 'Norcross & Lambert (ред., 2019). Psychotherapy Relationships That Work, 3-тє вид. — сучасний доказовий консенсус щодо терапевтичних стосунків.', url: 'https://pubmed.ncbi.nlm.nih.gov/30335448/' },
                { label: 'Bolton & Gillett (2023). Оновлена біопсихосоціальна модель. Psychological Medicine.', url: 'https://doi.org/10.1017/S0033291723002660' },
                { label: 'Flückiger та ін. (2018). Альянс у дорослій психотерапії: метааналіз (r≈0.28). Psychotherapy, 55, 316–340.', url: 'https://doi.org/10.1037/pst0000172' },
                { label: 'Wampold (2015). Наскільки важливі загальні чинники в психотерапії. World Psychiatry, 14, 270–277.', url: 'https://doi.org/10.1002/wps.20238' },
                { label: 'Bordin (1979). Поняття робочого альянсу — першоджерело. Psychotherapy, 16, 252–260.', url: 'https://doi.org/10.1037/h0085885' },
                { label: 'Engel (1977). Біопсихосоціальна модель — першоджерело. Science, 196, 129–136.', url: 'https://www.science.org/doi/10.1126/science.847460' },
                { label: 'Rogers (1957). Ядрові умови — першоджерело. J. of Consulting Psychology, 21, 95–103.', url: 'https://pubmed.ncbi.nlm.nih.gov/13416422/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: "Picture the first meeting from the client's side. They waited half an hour in the corridor, rehearsing where to start — maybe they worked up the courage to come for the first time in their life. They sit down, look at you, and go quiet. And this is exactly where a beginner reaches for the form: \"Tell me when it started, what you take, how you sleep…\". It feels logical — you have to take a history, right? In fact it is the worst possible start." },
              { type: 'p', text: 'Why? Because the person did not come to fill in a questionnaire. They came hoping to finally be heard — and that feeling is what decides whether there is a second session. The working alliance, the bond between you, is the strongest known predictor of therapy outcome (r ≈ 0.28; Flückiger 2018 meta-analysis, 295 studies), stronger than the choice of method. And it is laid down not later but in these first minutes. The history is not going anywhere; trust broken by an interrogation at the start is hard to win back.' },
              { type: 'h', text: 'So what is the first session for?' },
              { type: 'p', text: 'Not to "diagnose" or to "start treating". Three simpler things: create safety, sketch a rough picture, and agree on working together. The paradox: if the client leaves feeling heard, the session already worked — even if you formally "solved" nothing. Hence the guide: listen more than you speak — roughly 80/20 in the client\'s favour.' },
              { type: 'p', text: 'That does not mean facts are irrelevant. By the end you want a rough sense of four things — but you get them in a live conversation, not via a questionnaire:' },
              { type: 'list', items: [
                { term: 'Presenting concern', text: 'why they came, in their own words. That is where you start: "What brings you in today?"' },
                { term: 'Context', text: 'when it started, how it affects life (sleep, work, relationships), what they have tried.' },
                { term: 'Risk', text: 'briefly but directly — any thoughts of self-harm (covered fully in module 3).' },
                { term: 'Contract', text: 'length, confidentiality and its limits, what to expect from therapy at all.' },
              ] },
              { type: 'h', text: 'How it fits into 50 minutes' },
              { type: 'p', text: 'A session is about 50 minutes. Here is a rough guide to dividing them, so you neither get stuck at the start nor forget the essentials near the end:' },
              { type: 'figure', figure: 'session-arc' },
              { type: 'p', text: 'The first ~5 minutes — contact and an open invitation. The bulk, about 30 minutes — exploring the concern and context, where you mostly listen. Towards the end — a brief but direct risk check. The last ~10 minutes — the frame and closing. This is not a rigid protocol but insurance: beginners tend to get stuck in the first third and leave risk and the contract "for later" — when there is no time left.' },
              { type: 'h', text: 'So you do not miss a whole layer of life' },
              { type: 'p', text: 'A beginner easily fixates on the presenting complaint ("I sleep badly") and misses the rest. The biopsychosocial model (Engel, 1977) is a simple insurance against that tunnel vision: hold three levels in mind and mentally check that none is left blank.' },
              { type: 'figure', figure: 'biopsychosocial' },
              { type: 'p', text: 'Biological (sleep, appetite, health, substances), psychological (thoughts, emotions, coping), and social (relationships, work, support, culture). The root is often not where it hurts: "I sleep badly" turns out to be not about sleep but about anxiety over debt — and you only see it if you shift your gaze to the social level.' },
              { type: 'h', text: 'What it sounds like at the start' },
              { type: 'dialogue', lines: [
                { who: 'Therapist', text: 'What brings you in today? Tell me in your own words — wherever it is easiest to begin.' },
                { who: 'Client', text: "I don't even know… everything piled up at once." },
                { who: 'Therapist', text: 'Then let\'s start with "everything". Which part of it is hardest right now?' },
              ] },
              { type: 'h', text: 'The frame is the boundaries that create safety' },
              { type: 'p', text: 'The word "frame" is not accidental. It is the agreements that hold therapy: time and length, confidentiality, roles, what happens between meetings. It looks like a formality — but the paradox is that predictable boundaries are exactly what let the client feel safe enough to be open. A room without boundaries is as unsettling as a playground with no fence beside a road.' },
              { type: 'p', text: "The most important thing to spell out is confidentiality and its limits. Say it plainly and humanly: everything said here stays between you — except where there is a real threat to life (the client's or others'). This is not a scare tactic but honesty: a person has the right to know the rules in advance. And again, a clearly named limit tends to strengthen trust rather than undermine it." },
              { type: 'p', text: "The practical side belongs here too: how long a session lasts, how often you meet, what to do about cancellations, whether you write between sessions. Small things — but they remove the anxiety of uncertainty, especially if this is the person's first experience of therapy." },
              { type: 'h', text: 'How to end the first session' },
              { type: 'p', text: 'The ending matters almost as much as the start. A few minutes before the end, briefly reflect what you heard: "To sum up, what drains you most is…". This shows you listened and orders the mush in the client\'s head.' },
              { type: 'p', text: "And the thing most often underrated — give realistic hope. Common-factors research shows the client's belief that help is possible is not a \"nice bonus\" but one of the active mechanisms of change. Don't promise a quick miracle; honestly say that what they came with is workable, and that this makes sense." },
              { type: 'p', text: 'Finally, agree on the next step — whether there will be a second meeting and when. The person should leave not with an empty "now what?" but with a sense that a path has already begun.' },
              { type: 'p', text: "The commonest beginner mistake is not saying the wrong thing — it is turning the meeting into an interrogation. Two more sit beside it. First, rushing to \"fix\" the problem in the first session: it is premature, because you can't yet see the picture, and the client feels unheard. Second, dodging boundaries and confidentiality because it feels awkward. The paradox: it is precisely clear boundaries that give the client the safety to speak openly." },
              { type: 'quote', text: 'A first session is not data collection. It is the moment a person decides whether you are worth trusting. Everything else comes after.' },
              { type: 'sources', sources: [
                { label: 'Norcross & Lambert (eds., 2019). Psychotherapy Relationships That Work, 3rd ed. — the current evidence-based consensus on the therapy relationship.', url: 'https://pubmed.ncbi.nlm.nih.gov/30335448/' },
                { label: 'Bolton & Gillett (2023). A revitalized biopsychosocial model. Psychological Medicine.', url: 'https://doi.org/10.1017/S0033291723002660' },
                { label: 'Flückiger et al. (2018). The alliance in adult psychotherapy: a meta-analytic synthesis (r≈0.28). Psychotherapy, 55, 316–340.', url: 'https://doi.org/10.1037/pst0000172' },
                { label: 'Wampold (2015). How important are the common factors in psychotherapy? An update. World Psychiatry, 14, 270–277.', url: 'https://doi.org/10.1002/wps.20238' },
                { label: 'Bordin (1979). The working alliance concept — original source. Psychotherapy, 16, 252–260.', url: 'https://doi.org/10.1037/h0085885' },
                { label: 'Engel (1977). The biopsychosocial model — original source. Science, 196, 129–136.', url: 'https://www.science.org/doi/10.1126/science.847460' },
                { label: 'Rogers (1957). Core conditions — original source. J. Consulting Psychology, 21, 95–103.', url: 'https://pubmed.ncbi.nlm.nih.gov/13416422/' },
              ] },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Робочий альянс',
            titleEn: 'The working alliance',
            bodyUk: [
              { type: 'p', text: 'Робочий альянс — це робочий звʼязок, у якому ви з клієнтом тягнете в один бік. Це найстабільніший предиктор результату в усіх підходах: метааналіз Flückiger і колег (2018; 295 досліджень, понад 30 000 клієнтів) показав звʼязок альянсу з результатом r ≈ 0.28. Це більший внесок, ніж дає вибір конкретного методу.' },
              { type: 'h', text: 'Три складові (Бордін, 1979)' },
              { type: 'figure', figure: 'alliance-triangle' },
              { type: 'list', items: [
                { term: 'Звʼязок (bond)', text: 'довіра, тепло й повага між вами.' },
                { term: 'Цілі (goals)', text: 'спільне бачення, куди рухається терапія.' },
                { term: 'Завдання (tasks)', text: 'згода щодо того, як саме туди йти — техніки, формат, домашнє.' },
              ] },
              { type: 'p', text: 'Бордін наголошував: це не ієрархія, а взаємний звʼязок. Розмиті цілі підривають звʼязок; слабкий звʼязок зриває завдання. І навпаки — домовитись про ціль і пояснити сенс техніки само собою зміцнює довіру.' },
              { type: 'h', text: 'Чому це працює' },
              { type: 'p', text: 'Альянс дає дві речі: відчуття безпеки, щоб клієнт ризикнув бути відвертим, і спільну рамку, у якій його зусилля мають сенс. Без цього навіть доказова техніка сприймається як щось, що «роблять над тобою», а не «разом із тобою».' },
              { type: 'h', text: 'Ядрові умови (Роджерс, 1957)' },
              { type: 'p', text: 'Роджерс описав шість «необхідних і достатніх» умов зміни; три з них — ядро будь-яких стосунків допомоги:' },
              { type: 'list', items: [
                { term: 'Емпатія', text: 'точно відчути світ клієнта зсередини — і повернути це словами, щоб він почув, що його зрозуміли.' },
                { term: 'Безумовне прийняття', text: 'повага без осуду. Приймаєш людину — не обовʼязково схвалюєш кожен вчинок.' },
                { term: 'Конгруентність', text: 'щирість: те, що показуєш, збігається з тим, що відчуваєш. Без «маски експерта».' },
              ] },
              { type: 'p', text: 'Це не просто гуманістична риторика. Оновлений метааналіз Elliott і колег (2018; 82 вибірки, понад 6000 клієнтів) показав, що сприйнята клієнтом емпатія повʼязана з результатом на рівні r ≈ 0.28 — приблизно стільки ж, скільки дає сам альянс. Ядрові умови — це робочі інгредієнти зміни, а не приємне тло.' },
              { type: 'h', text: 'Як зміцнювати альянс із перших хвилин' },
              { type: 'list', items: [
                { text: 'Проговори спільну ціль уголос: «Якщо я правильно розумію, ви хочете…?»' },
                { text: 'Пояснюй «навіщо» перед технікою — це і є згода щодо завдань.' },
                { text: 'Періодично звіряйся: «Ми йдемо туди, куди вам потрібно?»' },
                { text: 'Більше відкритих питань і віддзеркалень почуттів, ніж порад.' },
                { text: 'Визнавай зусилля клієнта, а не лише результат.' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Не знаю, чи це взагалі варте вашого часу…' },
                { who: 'Терапевт', text: 'Схоже, трохи незручно про це говорити — і ви все одно прийшли. Те, що важливо для вас, варте часу. З чого вам легше почати?' },
              ] },
              { type: 'h', text: 'Приклад: згода щодо завдання' },
              { type: 'dialogue', lines: [
                { who: 'Терапевт', text: 'Пропоную наступні 10 хвилин виписати думки, що крутяться вночі. Ідея — побачити патерн, а не лишати їх кашею в голові. Як вам такий план?' },
                { who: 'Клієнт', text: 'Окей, спробуймо.' },
              ] },
              { type: 'h', text: 'Слабко → сильно' },
              { type: 'list', items: [
                { term: '❌ Слабко', text: '«Не варто так думати, давайте раціональніше» — знецінює й тисне.' },
                { term: '✅ Сильно', text: '«Схоже, ця думка справді лякає. Розкажете про неї докладніше?» — валідує й відкриває.' },
              ] },
              { type: 'h', text: 'Чого не робити' },
              { type: 'list', items: [
                { text: 'Не «продавай» довіру словами «довіртеся мені» — її дає досвід, що тебе почули.' },
                { text: 'Не навʼязуй власну ціль замість клієнтової.' },
                { text: 'Не запускай техніку без згоди щодо завдань — це найчастіша причина «опору».' },
              ] },
              { type: 'quote', text: 'Альянс — це не передумова роботи, це і є робота. Метод лягає на нього, а не навпаки.' },
              { type: 'sources', sources: [
                { label: 'Norcross & Lambert (ред., 2019). Psychotherapy Relationships That Work, 3-тє вид. — доказовий консенсус щодо терапевтичних стосунків.', url: 'https://pubmed.ncbi.nlm.nih.gov/30335448/' },
                { label: 'Flückiger та ін. (2018). Альянс у дорослій психотерапії: метааналіз (r≈0.28; 295 досліджень).', url: 'https://doi.org/10.1037/pst0000172' },
                { label: 'Elliott та ін. (2018). Емпатія терапевта й результат: оновлений метааналіз (r≈0.28).', url: 'https://pubmed.ncbi.nlm.nih.gov/30335453/' },
                { label: 'Bordin (1979). Поняття робочого альянсу (звʼязок–цілі–завдання) — першоджерело.', url: 'https://doi.org/10.1037/h0085885' },
                { label: 'Rogers (1957). Необхідні й достатні умови зміни (ядрові умови) — першоджерело.', url: 'https://pubmed.ncbi.nlm.nih.gov/13416422/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'The working alliance is a working bond in which you and the client pull in the same direction. It is the most robust predictor of outcome across every approach: the Flückiger et al. (2018) meta-analysis (295 studies, 30,000+ clients) found an alliance–outcome correlation of r ≈ 0.28 — a larger contribution than the choice of method.' },
              { type: 'h', text: 'Three parts (Bordin, 1979)' },
              { type: 'figure', figure: 'alliance-triangle' },
              { type: 'list', items: [
                { term: 'Bond', text: 'trust, warmth and respect between you.' },
                { term: 'Goals', text: 'a shared sense of where therapy is heading.' },
                { term: 'Tasks', text: 'agreement on how to get there — techniques, format, homework.' },
              ] },
              { type: 'p', text: 'Bordin stressed this is not a hierarchy but a mutual, multidirectional link: vague goals erode the bond; a weak bond derails the tasks. Conversely, agreeing a goal and explaining the rationale of a technique itself strengthens trust.' },
              { type: 'h', text: 'Why it works' },
              { type: 'p', text: 'The alliance gives two things: enough safety for the client to risk being honest, and a shared frame in which their effort makes sense. Without it, even an evidence-based technique feels like something done *to* you rather than *with* you.' },
              { type: 'h', text: 'Core conditions (Rogers, 1957)' },
              { type: 'p', text: 'Rogers described six "necessary and sufficient" conditions for change; three are the core of any helping relationship:' },
              { type: 'list', items: [
                { term: 'Empathy', text: "accurately sensing the client's world from the inside — and reflecting it back so they feel understood." },
                { term: 'Unconditional positive regard', text: 'respect without judgement. You accept the person — not necessarily every action.' },
                { term: 'Congruence', text: 'genuineness: what you show matches what you feel. No "expert mask".' },
              ] },
              { type: 'p', text: "This is not just humanistic rhetoric. Elliott and colleagues' updated meta-analysis (2018; 82 samples, 6,000+ clients) found client-perceived empathy relates to outcome at r ≈ 0.28 — about as much as the alliance itself. The core conditions are working ingredients of change, not pleasant background." },
              { type: 'h', text: 'Strengthening the alliance from the first minutes' },
              { type: 'list', items: [
                { text: 'Say the shared goal out loud: "If I understand right, you want…?"' },
                { text: 'Explain the "why" before a technique — that is task agreement.' },
                { text: 'Check in periodically: "Are we heading where you need to go?"' },
                { text: 'More open questions and reflections of feeling than advice.' },
                { text: "Affirm the client's effort, not just the outcome." },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'I am not sure this is even worth your time…' },
                { who: 'Therapist', text: "It sounds a little uncomfortable to bring up — and you came anyway. What matters to you is worth the time. Where is it easiest to start?" },
              ] },
              { type: 'h', text: 'Example: agreeing on the task' },
              { type: 'dialogue', lines: [
                { who: 'Therapist', text: "I suggest we spend the next 10 minutes writing down the thoughts that spin at night. The idea is to see the pattern, not leave it as mush in your head. How does that plan sound?" },
                { who: 'Client', text: "Okay, let's try." },
              ] },
              { type: 'h', text: 'Weak → strong' },
              { type: 'list', items: [
                { term: '❌ Weak', text: '"You shouldn\'t think like that, let\'s be rational" — dismisses and pushes.' },
                { term: '✅ Strong', text: '"It sounds like that thought really frightens you. Tell me more about it?" — validates and opens.' },
              ] },
              { type: 'h', text: 'What not to do' },
              { type: 'list', items: [
                { text: 'Do not "sell" trust with "trust me" — it comes from the experience of being heard.' },
                { text: "Do not impose your goal over the client's." },
                { text: 'Do not launch a technique without task agreement — the commonest cause of "resistance".' },
              ] },
              { type: 'quote', text: 'The alliance is not a precondition for the work — it is the work. The method rests on it, not the other way round.' },
              { type: 'sources', sources: [
                { label: 'Norcross & Lambert (eds., 2019). Psychotherapy Relationships That Work, 3rd ed. — the evidence-based consensus on the therapy relationship.', url: 'https://pubmed.ncbi.nlm.nih.gov/30335448/' },
                { label: 'Flückiger et al. (2018). The alliance in adult psychotherapy: a meta-analysis (r≈0.28; 295 studies).', url: 'https://doi.org/10.1037/pst0000172' },
                { label: 'Elliott et al. (2018). Therapist empathy and client outcome: an updated meta-analysis (r≈0.28).', url: 'https://pubmed.ncbi.nlm.nih.gov/30335453/' },
                { label: 'Bordin (1979). The working alliance concept (bond–goals–tasks) — original source.', url: 'https://doi.org/10.1037/h0085885' },
                { label: 'Rogers (1957). The necessary and sufficient conditions of change (core conditions) — original source.', url: 'https://pubmed.ncbi.nlm.nih.gov/13416422/' },
              ] },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Перші хвилини: як відкрити розмову',
            titleEn: 'The first minutes: opening the conversation',
            bodyUk: [
              { type: 'p', text: 'Перша сесія часто вирішується в перші пʼять хвилин — саме тоді клієнт несвідомо вирішує, чи тут безпечно. Ось як їх провести.' },
              { type: 'p', text: 'Чому початок важить так багато? Бо те, що відбувається в перші хвилини, задає дві речі, які доказово повʼязані з результатом: ранню згоду щодо цілей і відчуття співпраці (метааналізи Tryon та ін., 2018) та оптимістичні очікування клієнта щодо терапії (Constantino та ін., 2018). Відкриття розмови — це не формальність, а перша інвестиція в робочий альянс.' },
              { type: 'h', text: 'Привітання й коротка рамка' },
              { type: 'p', text: 'Тепло привітайся й одним-двома реченнями познач формат: «У нас близько 50 хвилин. Сьогодні я хочу здебільшого слухати й зрозуміти, що відбувається. Усе сказане лишається між нами, окрім ситуацій загрози життю. Гаразд?»' },
              { type: 'h', text: 'Перше відкрите питання' },
              { type: 'list', items: [
                { term: '«Що привело вас сьогодні?»', text: 'найкласичніший, нейтральний старт.' },
                { term: '«З чого вам хотілося б почати?»', text: 'віддає контроль клієнту.' },
                { term: 'Уникай «Чим можу допомогти?»', text: 'звучить як сервіс, а не як терапія.' },
              ] },
              { type: 'h', text: 'Тиша — це нормально' },
              { type: 'p', text: 'Після питання витримай паузу. Новачки квапляться заповнити тишу. 3–5 секунд мовчання дають клієнту простір зібратися. Якщо мовчання затягується й людина напружена — мʼяко: «Не поспішайте. Можна з чого завгодно.»' },
              { type: 'dialogue', lines: [
                { who: 'Терапевт', text: 'Що привело вас сьогодні?' },
                { who: 'Клієнт', text: '(пауза) …Навіть не знаю, з чого почати.' },
                { who: 'Терапевт', text: 'Це нормально — часто найважче саме почати. Що спадає на думку першим?' },
              ] },
              { type: 'h', text: 'Чого не робити' },
              { type: 'list', items: [
                { text: 'Не починай з анкети й паперів — спершу контакт.' },
                { text: 'Не став подумки діагноз у перші хвилини й не кидайся «лагодити».' },
                { text: 'Не перебивай перший розгорнутий монолог клієнта.' },
              ] },
              { type: 'quote', text: 'Перші пʼять хвилин — це не збір даних, а сигнал клієнту: «тут тебе почують».' },
              { type: 'sources', sources: [
                { label: 'Norcross & Lambert (ред., 2019). Psychotherapy Relationships That Work, 3-тє вид.', url: 'https://pubmed.ncbi.nlm.nih.gov/30335448/' },
                { label: 'Tryon та ін. (2018). Згода щодо цілей і співпраця: метааналізи (співпраця r≈0.29).', url: 'https://pubmed.ncbi.nlm.nih.gov/30335451/' },
                { label: 'Constantino та ін. (2018). Ранні очікування клієнта й результат терапії: метааналіз.', url: 'https://pubmed.ncbi.nlm.nih.gov/30335459/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'A first session is often decided in the first five minutes — that is when the client unconsciously decides whether this is safe. Here is how to run them.' },
              { type: 'p', text: "Why do the first minutes matter so much? Because what happens in them sets two things that are evidentially linked to outcome: early agreement on goals and a sense of collaboration (Tryon et al., 2018, meta-analyses) and the client's optimistic expectations about therapy (Constantino et al., 2018). Opening the conversation is not a formality — it is the first investment in the working alliance." },
              { type: 'h', text: 'Greeting and a brief frame' },
              { type: 'p', text: 'Greet warmly and name the format in a sentence or two: "We have about 50 minutes. Today I mostly want to listen and understand what is going on. What is said stays between us, except where there is a threat to life. Okay?"' },
              { type: 'h', text: 'The first open question' },
              { type: 'list', items: [
                { term: '"What brings you in today?"', text: 'the classic, neutral start.' },
                { term: '"Where would you like to start?"', text: 'hands control to the client.' },
                { term: 'Avoid "How can I help?"', text: 'sounds like a service desk, not therapy.' },
              ] },
              { type: 'h', text: 'Silence is fine' },
              { type: 'p', text: 'Hold a pause after the question. Beginners rush to fill silence. 3–5 seconds gives the client room to gather themselves. If the silence drags and they look tense, gently: "Take your time. Anywhere is fine."' },
              { type: 'dialogue', lines: [
                { who: 'Therapist', text: 'What brings you in today?' },
                { who: 'Client', text: '(pause) …I don\'t even know where to start.' },
                { who: 'Therapist', text: 'That\'s normal — starting is often the hardest part. What comes to mind first?' },
              ] },
              { type: 'h', text: 'What not to do' },
              { type: 'list', items: [
                { text: 'Do not open with an intake form — contact first.' },
                { text: 'Do not silently diagnose in the first minutes or rush to "fix".' },
                { text: "Do not interrupt the client's first extended monologue." },
              ] },
              { type: 'quote', text: 'The first five minutes are not data collection — they signal to the client: "you will be heard here".' },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Розриви альянсу та відновлення',
            titleEn: 'Alliance ruptures and repair',
            bodyUk: [
              { type: 'p', text: 'Навіть у добрих стосунках альянс часом рветься: клієнт замовкає, погоджується «для галочки», спізнюється або раптом сперечається. Це не провал. Метааналіз Eubanks, Muran і Safran (2018; 11 досліджень, 1314 клієнтів) показав протилежне: помічені й успішно відновлені розриви повʼязані з кращим результатом (r ≈ 0.29) — інколи кращим, ніж у терапії, де розривів наче й не було.' },
              { type: 'h', text: 'Два типи розривів' },
              { type: 'figure', figure: 'rupture-repair' },
              { type: 'list', items: [
                { term: 'Відсторонення', text: 'клієнт віддаляється: відповідає коротко, змінює тему, «усе нормально», замовкає.' },
                { term: 'Конфронтація', text: 'клієнт іде проти: невдоволення, критика, сумнів у методі чи в тобі.' },
              ] },
              { type: 'h', text: 'Як помітити' },
              { type: 'list', items: [
                { text: 'Раптова зміна тону чи темпу; «так, але…»; згода без енергії.' },
                { text: 'Пропуски, спізнення, «забув» домашнє.' },
                { text: 'Твоя власна напруга чи бажання захищатися — теж маркер (контрперенесення).' },
              ] },
              { type: 'h', text: 'Як відновити — 4 кроки' },
              { type: 'list', items: [
                { term: '1. Пригальмуй і назви', text: 'м’яко познач, що щось змінилось: «Я помітив, що ми наче віддалились».' },
                { term: '2. Запроси й прийми', text: 'без захисту: «Схоже, моє питання зачепило. Розкажете?»' },
                { term: '3. Визнай свою частину', text: 'якщо вона є: «Справді, я поквапився з висновком».' },
                { term: '4. Перепогодьте', text: 'поверніться до спільної цілі чи завдання.' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Ви весь час питаєте про дитинство, а мені треба вирішити тут і зараз.' },
                { who: 'Терапевт', text: 'Дякую, що сказали прямо. Схоже, я пішов не туди, куди вам потрібно. Повернімось до того, що горить зараз — з чого почнемо?' },
              ] },
              { type: 'h', text: 'Те саме при відстороненні' },
              { type: 'dialogue', lines: [
                { who: 'Терапевт', text: 'Ви сьогодні небагатослівні — і це нормально. Я помітив, що після питання про маму ви наче відсторонились.' },
                { who: 'Клієнт', text: 'Та ні, все гаразд… просто втомився.' },
                { who: 'Терапевт', text: 'Можливо. А може, я зачепив щось болюче. Скажіть, якщо так — і ми сповільнимось.' },
              ] },
              { type: 'h', text: 'Чого не робити' },
              { type: 'list', items: [
                { text: 'Не захищатися й не доводити свою правоту.' },
                { text: 'Не ігнорувати відсторонення («мовчить — значить думає»).' },
                { text: 'Не сприймати розрив як особисту образу.' },
              ] },
              { type: 'quote', text: 'Розрив — не кінець альянсу, а нагода його поглибити. Лікує саме те, як ви лагодите.' },
              { type: 'sources', sources: [
                { label: 'Eubanks, Muran & Safran (2018). Відновлення розривів альянсу: метааналіз (r≈0.29; 11 досліджень, 1314 клієнтів).', url: 'https://pubmed.ncbi.nlm.nih.gov/30335462/' },
                { label: 'Norcross & Lambert (ред., 2019). Psychotherapy Relationships That Work, 3-тє вид.', url: 'https://pubmed.ncbi.nlm.nih.gov/30335448/' },
                { label: 'Safran & Muran (2000). Negotiating the Therapeutic Alliance — першоджерело моделі розривів і відновлення.', url: 'https://www.guilford.com/books/Negotiating-the-Therapeutic-Alliance/Safran-Muran/9781572306127' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'Even in a good relationship the alliance sometimes tears: the client goes quiet, agrees just to comply, comes late, or suddenly argues. This is not a failure. The meta-analysis by Eubanks, Muran and Safran (2018; 11 studies, 1,314 clients) shows the opposite: ruptures that are noticed and successfully repaired relate to better outcomes (r ≈ 0.29) — sometimes better than therapy that appears rupture-free.' },
              { type: 'h', text: 'Two kinds of rupture' },
              { type: 'figure', figure: 'rupture-repair' },
              { type: 'list', items: [
                { term: 'Withdrawal', text: 'the client moves away: short answers, changes the subject, "I\'m fine", falls silent.' },
                { term: 'Confrontation', text: 'the client moves against: dissatisfaction, criticism, doubting the method or you.' },
              ] },
              { type: 'h', text: 'How to notice' },
              { type: 'list', items: [
                { text: 'A sudden change in tone or pace; "yes, but…"; agreement with no energy.' },
                { text: 'No-shows, lateness, "forgot" the homework.' },
                { text: 'Your own tension or urge to defend — also a marker (countertransference).' },
              ] },
              { type: 'h', text: 'How to repair — 4 steps' },
              { type: 'list', items: [
                { term: '1. Slow down and name it', text: 'gently flag the shift: "I noticed we seem to have drifted apart".' },
                { term: '2. Invite and accept', text: 'without defending: "It seems my question touched something. Tell me?"' },
                { term: '3. Own your part', text: 'where there is one: "You\'re right, I jumped ahead".' },
                { term: '4. Re-negotiate', text: 'return to the shared goal or task.' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'You keep asking about my childhood, but I need to sort out the here and now.' },
                { who: 'Therapist', text: "Thank you for saying it straight. It sounds like I went somewhere you didn't need. Let's go back to what's urgent now — where shall we start?" },
              ] },
              { type: 'h', text: 'The same with withdrawal' },
              { type: 'dialogue', lines: [
                { who: 'Therapist', text: "You're quiet today — and that's okay. I noticed that after my question about your mother you seemed to pull back." },
                { who: 'Client', text: "No, it's fine… just tired." },
                { who: 'Therapist', text: "Maybe. Or maybe I touched something tender. Tell me if so — and we'll slow down." },
              ] },
              { type: 'h', text: 'What not to do' },
              { type: 'list', items: [
                { text: 'Don\'t defend or prove you were right.' },
                { text: 'Don\'t ignore withdrawal ("silence means they\'re thinking").' },
                { text: 'Don\'t take a rupture as a personal insult.' },
              ] },
              { type: 'quote', text: 'A rupture is not the end of the alliance but a chance to deepen it. It is the repair itself that heals.' },
              { type: 'sources', sources: [
                { label: 'Eubanks, Muran & Safran (2018). Alliance rupture repair: a meta-analysis (r≈0.29; 11 studies, 1,314 clients).', url: 'https://pubmed.ncbi.nlm.nih.gov/30335462/' },
                { label: 'Norcross & Lambert (eds., 2019). Psychotherapy Relationships That Work, 3rd ed.', url: 'https://pubmed.ncbi.nlm.nih.gov/30335448/' },
                { label: 'Safran & Muran (2000). Negotiating the Therapeutic Alliance — original source of the rupture–repair model.', url: 'https://www.guilford.com/books/Negotiating-the-Therapeutic-Alliance/Safran-Muran/9781572306127' },
              ] },
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
              {
                q: 'Клієнт раптом каже: «Ми весь час говоримо не про те». Найкраща перша реакція?',
                options: ['Пояснити, чому ваш план правильний', 'Пригальмувати, прийняти й розпитати, куди клієнту потрібно', 'Змінити тему, щоб зняти напругу', 'Запропонувати завершити сесію'],
                correct: 1,
                explain: 'Це конфронтаційний розрив. Відновлення: не захищатися, прийняти, перепогодити ціль.',
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
              {
                q: 'A client suddenly says "we keep talking about the wrong thing". Best first response?',
                options: ['Explain why your plan is right', 'Slow down, accept it, and ask where the client needs to go', 'Change the subject to ease the tension', 'Suggest ending the session'],
                correct: 1,
                explain: "This is a confrontation rupture. Repair: don't defend, accept, re-negotiate the goal.",
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
          {
            kind: 'practice',
            titleUk: 'Практика: помітити й відновити розрив',
            titleEn: 'Practice: notice and repair a rupture',
            characterRef: 'Максим',
            techniqueKey: 'rupture_repair',
            passSignal: 'ruptureRepaired',
            bodyUk: [
              { type: 'p', text: 'Завдання: у розмові з Максимом, який може віддалятися чи сперечатися, поміть розрив альянсу й віднови його за 4 кроками (пригальмуй → прийми → визнай свою частину → перепогодь). Крок зарахується, коли фідбек покаже сигнал «розрив відновлено».' },
            ],
            bodyEn: [
              { type: 'p', text: 'Task: with Maksym, who may withdraw or push back, notice an alliance rupture and repair it with the 4 steps (slow down → accept → own your part → re-negotiate). The step passes when the feedback shows the "rupture repaired" signal.' },
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
              { type: 'p', text: 'Уяви двох терапевтів. Перший засипає клієнта питаннями: «Спите погано? Апетит є? Ліки приймаєте? Сварки вдома?» Клієнт відповідає «так… ні… іноді» — і замикається, бо це схоже на анкету в реєстратурі. Другий ставить одне питання: «Розкажіть, як виглядають ваші вечори?» — і слухає. Клієнт говорить пʼять хвилин і сам доходить: «Мабуть, я просто боюся лишатися наодинці з думками». Тема та сама. Різниця — у тому, ЯК запитали й що зробили з відповіддю.' },
              { type: 'h', text: 'OARS: чотири навички слухання' },
              { type: 'p', text: 'OARS — це чотири базові навички активного слухання з мотиваційного інтервʼю (Miller & Rollnick, 4-те вид., 2023): Open questions (відкриті питання), Affirmations (підтримки), Reflections (рефлексії), Summaries (резюме). Це не «прийоми на показ», а спосіб вести розмову так, щоб людина сама рухалася до зміни. Цей урок — про дві найпотужніші: O і R.' },
              { type: 'h', text: 'Чому це працює, а не просто «ввічливо»' },
              { type: 'p', text: 'Метааналіз процесу МІ (Magill та ін., 2018; 36 досліджень) показав конкретний механізм. Коли терапевт користується відкритими питаннями й рефлексіями, клієнт частіше промовляє «мову зміни» — власні аргументи на користь того, щоб щось змінити (звʼязок r ≈ 0.55). А більше мови зміни → менше ризикованої поведінки згодом. Тобто рефлексія — не «мʼяка навичка»: це спосіб дати людині почути власну мотивацію твоїми вустами. Сюди ж лягає емпатія: за метааналізом Elliott і колег (2018) сприйнята клієнтом емпатія повʼязана з результатом (r ≈ 0.28), а рефлексія — це і є емпатія в дії.' },
              { type: 'h', text: 'Відкриті проти закритих питань' },
              { type: 'figure', figure: 'oars' },
              { type: 'p', text: 'Закрите питання просить «так/ні» або один факт. Відкрите запрошує розгорнути історію. Закриті потрібні точково (наприклад, прямо запитати про ризик), але якщо їх багато поспіль — розмова стає допитом.' },
              { type: 'list', items: [
                { term: 'Закрите', text: '«Ви спите погано?» — відповідь «так/ні», і нитка обривається.' },
                { term: 'Відкрите', text: '«Розкажіть, як виглядають ваші ночі?» — клієнт розгортає історію, і ти бачиш деталі, про які не здогадався б запитати.' },
                { term: 'Перетворення', text: 'майже будь-яке закрите можна відкрити: «Допомагає?» → «Що саме змінюється, коли це допомагає?»' },
              ] },
              { type: 'h', text: 'Рефлексія: повернути почуте, а не дати пораду' },
              { type: 'p', text: 'Рефлексія — це коли ти своїми словами повертаєш клієнту суть почутого. Проста рефлексія повторює зміст («Вам важко вночі»). Складна — додає обережний здогад про почуття чи значення («Тримаєтесь на автоматі, бо зупинитися й відчути зараз надто страшно»). Складні рефлексії зазвичай рухають розмову глибше.' },
              { type: 'list', items: [
                { term: 'Це твердження, а не питання', text: 'рефлексія звучить як крапка, а не знак питання: «Вам самотньо.», а не «Вам самотньо?». Питання трохи тисне, твердження — запрошує.' },
                { term: 'Здогадуйся вголос', text: 'навіть неточна рефлексія корисна: клієнт сам виправить і уточнить.' },
                { term: 'Орієнтир МІ', text: 'щонайменше одна рефлексія на кожне відкрите питання; з досвідом — дві.' },
              ] },
              { type: 'h', text: 'Як це звучить' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Я просто роблю, що маю, і не думаю про це.' },
                { who: 'Терапевт', text: 'Тримаєтесь на автоматі — бо зупинитись і відчути зараз надто важко.' },
                { who: 'Клієнт', text: '(пауза) Так… якщо зупинюся, накриє.' },
              ] },
              { type: 'h', text: 'Чому рефлексія, а не ще одне питання' },
              { type: 'p', text: 'Почувши паузу, новачок інстинктивно ставить наступне питання. Але низка питань змушує клієнта виправдовуватися й віддає йому пасивну роль: «мене допитують — я відповідаю». Рефлексія натомість лишає мʼяч у клієнта: показує, що ти почув, і запрошує піти глибше без тиску. Тому орієнтир — більше рефлексій, ніж питань.' },
              { type: 'h', text: 'Типові помилки' },
              { type: 'list', items: [
                { text: 'Серія закритих питань поспіль — ефект допиту.' },
                { text: 'Поради до того, як клієнт відчув себе почутим (так званий «рефлекс лагодити»).' },
                { text: 'Рефлексія з питальною інтонацією — знецінює її до простого уточнення.' },
                { text: 'Дослівне папугування замість переказу своїми словами.' },
              ] },
              { type: 'quote', text: 'Питання змушує клієнта відповідати. Рефлексія дає йому почути самого себе.' },
              { type: 'sources', sources: [
                { label: 'Miller & Rollnick (2023). Motivational Interviewing: Helping People Change and Grow, 4-те вид. — джерело моделі OARS.', url: 'https://www.guilford.com/books/Motivational-Interviewing/Miller-Rollnick/9781462552795' },
                { label: 'Magill та ін. (2018). Метааналіз процесу МІ: навички терапевта → «мова зміни» клієнта (r≈0.55) → результат. J Consult Clin Psychol.', url: 'https://pubmed.ncbi.nlm.nih.gov/29265832/' },
                { label: 'Elliott та ін. (2018). Емпатія терапевта й результат: оновлений метааналіз (r≈0.28).', url: 'https://pubmed.ncbi.nlm.nih.gov/30335453/' },
                { label: 'Miller (1983). Motivational interviewing with problem drinkers — першоджерело підходу.', url: 'https://doi.org/10.1017/S0141347300006583' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: "Picture two therapists. The first fires off questions: \"Sleeping badly? Eating? Taking your meds? Rows at home?\" The client answers \"yes… no… sometimes\" and shuts down — it feels like a form at a reception desk. The second asks one question — \"Tell me what your evenings look like?\" — and listens. The client talks for five minutes and arrives, on their own, at: \"Maybe I'm just afraid of being alone with my thoughts.\" Same topic. The difference is HOW you asked and what you did with the answer." },
              { type: 'h', text: 'OARS: four listening skills' },
              { type: 'p', text: 'OARS are the four core active-listening skills from motivational interviewing (Miller & Rollnick, 4th ed., 2023): Open questions, Affirmations, Reflections, Summaries. They are not techniques for show but a way of running the conversation so the person moves toward change themselves. This lesson covers the two most powerful: O and R.' },
              { type: 'h', text: 'Why it works — not just "being polite"' },
              { type: 'p', text: "A meta-analysis of the MI process (Magill et al., 2018; 36 studies) showed the actual mechanism. When the therapist uses open questions and reflections, the client voices more \"change talk\" — their own arguments for changing something (r ≈ 0.55). And more change talk → less risky behaviour later. So a reflection is not a \"soft skill\": it lets the person hear their own motivation in your voice. Empathy belongs here too: Elliott et al.'s meta-analysis (2018) found client-perceived empathy relates to outcome (r ≈ 0.28), and a reflection is empathy in action." },
              { type: 'h', text: 'Open vs closed questions' },
              { type: 'figure', figure: 'oars' },
              { type: 'p', text: 'A closed question asks for a yes/no or a single fact. An open one invites a story. Closed questions have their place (for instance, asking about risk directly), but a run of them turns the session into an interrogation.' },
              { type: 'list', items: [
                { term: 'Closed', text: '"Do you sleep badly?" — a yes/no, and the thread snaps.' },
                { term: 'Open', text: '"Tell me what your nights look like?" — the client unfolds a story, and you see details you would never have known to ask about.' },
                { term: 'Turn it open', text: 'almost any closed question can be opened: "Does it help?" → "What changes when it helps?"' },
              ] },
              { type: 'h', text: 'Reflection: hand back what you heard, do not advise' },
              { type: 'p', text: 'A reflection hands back the essence of what you heard, in your words. A simple reflection restates content ("Nights are hard for you"). A complex one adds a careful guess about feeling or meaning ("You keep going on autopilot, because stopping to feel it right now is too frightening"). Complex reflections usually move the conversation deeper.' },
              { type: 'list', items: [
                { term: 'A statement, not a question', text: 'a reflection ends like a full stop, not a question mark: "You feel alone.", not "You feel alone?". A question pushes a little; a statement invites.' },
                { term: 'Guess out loud', text: 'even an inaccurate reflection helps — the client corrects and refines it themselves.' },
                { term: 'MI rule of thumb', text: 'at least one reflection per open question; with practice, two.' },
              ] },
              { type: 'h', text: 'How it sounds' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'I just do what I have to and do not think about it.' },
                { who: 'Therapist', text: 'You keep going on autopilot — because stopping to feel it right now is too much.' },
                { who: 'Client', text: '(pause) Yes… if I stop, it floods in.' },
              ] },
              { type: 'h', text: 'Why a reflection, not another question' },
              { type: 'p', text: 'Hearing a pause, a beginner instinctively asks the next question. But a string of questions makes the client justify themselves and casts them in a passive role: "I am being interrogated — I answer." A reflection instead leaves the ball with the client: it shows you heard, and invites them deeper without pressure. That is why the aim is more reflections than questions.' },
              { type: 'h', text: 'Common mistakes' },
              { type: 'list', items: [
                { text: 'A run of closed questions back to back — the interrogation effect.' },
                { text: 'Advice before the client feels heard (the "righting reflex").' },
                { text: 'A reflection with a questioning intonation — it shrinks to a mere clarification.' },
                { text: 'Parroting word-for-word instead of restating in your own words.' },
              ] },
              { type: 'quote', text: 'A question makes the client answer. A reflection lets them hear themselves.' },
              { type: 'sources', sources: [
                { label: 'Miller & Rollnick (2023). Motivational Interviewing: Helping People Change and Grow, 4th ed. — the source of the OARS model.', url: 'https://www.guilford.com/books/Motivational-Interviewing/Miller-Rollnick/9781462552795' },
                { label: 'Magill et al. (2018). Meta-analysis of MI process: therapist skills → client change talk (r≈0.55) → outcome. J Consult Clin Psychol.', url: 'https://pubmed.ncbi.nlm.nih.gov/29265832/' },
                { label: 'Elliott et al. (2018). Therapist empathy and client outcome: an updated meta-analysis (r≈0.28).', url: 'https://pubmed.ncbi.nlm.nih.gov/30335453/' },
                { label: 'Miller (1983). Motivational interviewing with problem drinkers — the original source of the approach.', url: 'https://doi.org/10.1017/S0141347300006583' },
              ] },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Підтримки та резюмування (A і S)',
            titleEn: 'Affirmations and summaries (A & S)',
            bodyUk: [
              { type: 'p', text: 'Клієнтка пів години розповідала, як попри виснаження щоранку збирає дітей до школи. Перший терапевт каже: «Ви молодець!» — і вона ледь помітно знизує плечима: порожньо. Другий каже: «Ви тримаєте весь дім на собі, виснажена, і жодного ранку не пропустили. Це не просто «нормально» — це сила». Вона вперше за сесію плаче. Одна й та сама мить, два різні інструменти — і це різниця між порожньою похвалою й підтримкою.' },
              { type: 'p', text: 'Ти вже знаєш O і R — відкриті питання й рефлексії. Лишаються A (Affirmations — підтримки) і S (Summaries — резюме). O і R відкривають і поглиблюють; A і S утримують і структурують. Разом це повне, кероване слухання (Miller & Rollnick, 2023).' },
              { type: 'h', text: 'Підтримки (A): помітити силу, а не похвалити' },
              { type: 'p', text: 'Підтримка визнає конкретну сильну сторону, зусилля чи цінність клієнта. Це не оцінка згори («молодець») і не лестощі — це чесне свідчення того, що ти побачив. У 4-му виданні Miller і Rollnick розрізняють прості підтримки (назвати вчинок) і складні (назвати рису чи цінність за вчинком).' },
              { type: 'list', items: [
                { term: 'Порожньо', text: '«Ви молодець.» — оцінка, яку легко відмахнути.' },
                { term: 'Проста підтримка', text: '«Ви прийшли, попри те що говорити про це страшно.» — називає конкретний вчинок.' },
                { term: 'Складна підтримка', text: '«Прийти попри страх — це сміливість, якої у вас явно не бракує.» — називає рису за вчинком.' },
              ] },
              { type: 'h', text: 'Чому підтримки працюють' },
              { type: 'p', text: 'Підтримки годують самоефективність — віру людини, що вона здатна на зміну. А ще гасять «рефлекс захисту»: коли клієнт відчуває, що його бачать у доброму світлі, він менше виправдовується й сміливіше говорить про складне. У моделі МІ це частина того ж механізму: безпека й автономія → більше «мови зміни» (Magill та ін., 2018).' },
              { type: 'h', text: 'Резюмування (S): дзеркало для всієї розмови' },
              { type: 'p', text: 'Резюме збирає докупи кілька речей, які сказав клієнт, і повертає їх одним блоком. Воно показує, що ти тримаєш нитку, дає клієнту почути свою історію цілісно й допомагає перейти далі. У МІ розрізняють три типи:' },
              { type: 'list', items: [
                { term: 'Збиральне', text: 'підсумувати кілька пунктів поспіль: «Отже, ви згадали А, Б і В…».' },
                { term: 'Звʼязувальне', text: 'поєднати теперішнє з раніше сказаним: «Це перегукується з тим, про що ви казали минулого разу…».' },
                { term: 'Перехідне', text: 'закрити тему й відкрити нову: «Якщо нічого не пропустив — пропоную перейти до…».' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Терапевт', text: 'Дозвольте підсумую, щоб переконатися, що правильно зрозумів. Ви виснажені на роботі, ночами не спите, і найбільше лякає, що це впливає на доньку. Я нічого не пропустив?' },
                { who: 'Клієнт', text: 'Так… саме за доньку найбільше.' },
              ] },
              { type: 'p', text: 'Зверни увагу на хвіст: «Я нічого не пропустив?». Резюме завжди лишає клієнту право виправити — це утримує його в ролі експерта з власного життя.' },
              { type: 'h', text: 'Підтримка проти похвали, резюме проти переказу' },
              { type: 'p', text: 'Похвала оцінює («добре зробили») і ставить тебе згори; підтримка свідчить («я бачу, чого вам це коштувало») і лишає вас на рівних. Так само резюме — не сухий переказ протоколу, а вибір саме тих ниток, що мають значення для клієнта. Тому воно звучить як розуміння, а не як звіт.' },
              { type: 'h', text: 'Типові помилки' },
              { type: 'list', items: [
                { text: 'Загальне «молодець» замість конкретики — звучить як відмашка.' },
                { text: 'Підтримка «щоб підбадьорити», у яку сам не віриш, — клієнт чує фальш.' },
                { text: 'Резюме, що переказує лише факти й губить почуття.' },
                { text: 'Резюме без запрошення виправити — перетворюється на діагноз згори.' },
              ] },
              { type: 'quote', text: 'Підтримка каже клієнту «я бачу твою силу». Резюме каже «я тримаю всю твою історію разом». Обидва — про те, що його почули.' },
              { type: 'sources', sources: [
                { label: 'Miller & Rollnick (2023). Motivational Interviewing, 4-те вид. — прості/складні підтримки й типи резюме.', url: 'https://www.guilford.com/books/Motivational-Interviewing/Miller-Rollnick/9781462552795' },
                { label: 'Magill та ін. (2018). Метааналіз процесу МІ: механізм «мови зміни». J Consult Clin Psychol.', url: 'https://pubmed.ncbi.nlm.nih.gov/29265832/' },
                { label: 'Miller (1983). Motivational interviewing with problem drinkers — першоджерело підходу.', url: 'https://doi.org/10.1017/S0141347300006583' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: "A client spent half an hour describing how, exhausted as she is, she gets the children to school every morning. The first therapist says, \"Well done!\" — and she gives a barely visible shrug: empty. The second says, \"You carry the whole house, worn out, and you have not missed a single morning. That is not just 'coping' — that is strength.\" For the first time in the session, she cries. The same moment, two different tools — and that is the difference between empty praise and an affirmation." },
              { type: 'p', text: 'You already have O and R — open questions and reflections. That leaves A (Affirmations) and S (Summaries). O and R open and deepen; A and S hold and structure. Together they make listening complete and guided (Miller & Rollnick, 2023).' },
              { type: 'h', text: 'Affirmations (A): name the strength, do not praise' },
              { type: 'p', text: 'An affirmation names a specific strength, effort or value in the client. It is not a judgement from above ("well done") and not flattery — it is honest testimony to what you saw. In the 4th edition Miller and Rollnick distinguish simple affirmations (naming an action) from complex ones (naming the trait or value behind the action).' },
              { type: 'list', items: [
                { term: 'Empty', text: '"You\'re doing great." — a verdict that is easy to wave away.' },
                { term: 'Simple affirmation', text: '"You came even though talking about this is frightening." — names a concrete action.' },
                { term: 'Complex affirmation', text: '"Coming despite the fear takes courage — and you clearly have plenty of it." — names the trait behind the action.' },
              ] },
              { type: 'h', text: 'Why affirmations work' },
              { type: 'p', text: 'Affirmations feed self-efficacy — a person\'s belief that they are capable of change. They also defuse the "defence reflex": when clients feel seen in a good light, they justify themselves less and speak about hard things more bravely. In the MI model this is part of the same mechanism: safety and autonomy → more "change talk" (Magill et al., 2018).' },
              { type: 'h', text: 'Summaries (S): a mirror for the whole conversation' },
              { type: 'p', text: 'A summary pulls several things the client said together and hands them back as one block. It shows you are holding the thread, lets the client hear their story whole, and helps move on. MI distinguishes three types:' },
              { type: 'list', items: [
                { term: 'Collecting', text: 'recap several points in a row: "So you have mentioned A, B and C…".' },
                { term: 'Linking', text: 'tie the present to something said earlier: "That echoes what you said last time…".' },
                { term: 'Transitional', text: 'close a topic and open a new one: "If I have not missed anything, shall we move to…".' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Therapist', text: 'Let me summarise to make sure I got it right. You are exhausted at work, not sleeping at night, and what scares you most is the effect on your daughter. Did I miss anything?' },
                { who: 'Client', text: "Yes… it's the daughter that worries me most." },
              ] },
              { type: 'p', text: 'Notice the tail: "Did I miss anything?" A summary always leaves the client the right to correct you — that keeps them in the role of expert on their own life.' },
              { type: 'h', text: 'Affirmation vs praise, summary vs recap' },
              { type: 'p', text: 'Praise evaluates ("good job") and puts you above; an affirmation testifies ("I see what this cost you") and keeps you level. Likewise a summary is not a dry recap of the record but a choice of exactly the threads that matter to the client — which is why it sounds like understanding, not a report.' },
              { type: 'h', text: 'Common mistakes' },
              { type: 'list', items: [
                { text: 'A generic "well done" instead of specifics — it sounds like a brush-off.' },
                { text: 'An affirmation "to cheer them up" that you do not believe — the client hears the falseness.' },
                { text: 'A summary that recaps only facts and loses the feeling.' },
                { text: 'A summary with no invitation to correct — it becomes a diagnosis from above.' },
              ] },
              { type: 'quote', text: 'An affirmation tells the client "I see your strength". A summary says "I hold your whole story together". Both say: you were heard.' },
              { type: 'sources', sources: [
                { label: 'Miller & Rollnick (2023). Motivational Interviewing, 4th ed. — simple/complex affirmations and summary types.', url: 'https://www.guilford.com/books/Motivational-Interviewing/Miller-Rollnick/9781462552795' },
                { label: 'Magill et al. (2018). Meta-analysis of MI process: the change-talk mechanism. J Consult Clin Psychol.', url: 'https://pubmed.ncbi.nlm.nih.gov/29265832/' },
                { label: 'Miller (1983). Motivational interviewing with problem drinkers — the original source of the approach.', url: 'https://doi.org/10.1017/S0141347300006583' },
              ] },
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
              {
                q: 'Клієнт уперше за місяць прийшов на сесію, хоч дуже боявся. Яка відповідь — найсильніша підтримка (а не похвала)?',
                options: ['«Ви молодець, що прийшли.»', '«Прийти попри страх — це сміливість; ви явно вмієте робити важке навіть коли лячно.»', '«Бачите, нічого страшного не сталося.»', '«Більшість людей теж нервують перед першою сесією.»'],
                correct: 1,
                explain: 'Складна підтримка називає рису за вчинком («сміливість»), а не дає загальну оцінку згори чи заспокоєння.',
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
              {
                q: 'A client came to session for the first time in a month, despite being very afraid. Which reply is the strongest affirmation (not praise)?',
                options: ['"Well done for coming."', '"Coming despite the fear takes courage — you clearly can do hard things even when scared."', '"See, nothing bad happened."', '"Most people are nervous before a first session too."'],
                correct: 1,
                explain: 'A complex affirmation names the trait behind the action ("courage"), not a generic verdict or reassurance.',
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
              { type: 'p', text: 'Клієнт натякає: «Іноді думаю, що краще б усе це просто скінчилося». Терапевт-початківець лякається й мʼяко переводить тему: «Давайте про щось світліше — розкажіть про доньку». Здавалося б, дбайливо. Але клієнт читає це однозначно: «про це тут не можна». І більше до теми не повертається. Парадокс роботи з ризиком у тому, що уникання небезпечніше за пряме запитання.' },
              { type: 'h', text: 'Міф, який коштує життів' },
              { type: 'p', text: 'Найпоширеніший страх новачка: «Якщо я спитаю про суїцид прямо — я наштовхну на цю думку». Це не так. Огляд доказів (Dazzi та ін., 2014) показав: пряме запитання про суїцидальні думки НЕ підвищує їх — а часто навпаки приносить полегшення, бо людина нарешті може сказати вголос те, що носила сама. Тобто мовчання захищає не клієнта, а твою власну тривогу.' },
              { type: 'h', text: 'Питаємо, щоб зрозуміти, — а не щоб «оцінити ризик»' },
              { type: 'p', text: 'Тут важлива зміна, яку закріпили сучасні настанови (NICE NG225, 2022). Раніше вчили «виміряти» ризик і поставити людину в категорію низький/середній/високий. Сьогодні цього не рекомендують: шкали погано передбачають, хто саме завдасть собі шкоди, і не повинні вирішувати, кому надати допомогу. Ми питаємо не заради бала, а щоб разом із клієнтом зрозуміти, що відбувається, і скласти план. Запитання — це початок співпраці, а не сортування.' },
              { type: 'h', text: 'Як спитати, не зруйнувавши контакт' },
              { type: 'figure', figure: 'risk-ladder', caption: 'Лійка запитань: від загального дистресу — до думок, плану, засобів і наміру. Це послідовність питань, а не шкала передбачення.' },
              { type: 'list', items: [
                { term: '1. Нормалізуй', text: '«Коли людині так важко, інколи зʼявляються думки, що не хочеться жити. Чи бувають такі у вас?» — рамка, у якій зізнатися не соромно.' },
                { term: '2. Запитай прямо', text: 'без евфемізмів: «Чи думали ви про те, щоб покінчити з життям?» Прямота дає клієнту дозвіл бути чесним.' },
                { term: '3. Уточнюй за логікою C-SSRS', text: 'думки → план → доступ до засобів → намір. Кожен наступний рівень підвищує гостроту й конкретику.' },
                { term: '4. Лишайся спокійним і теплим', text: 'твоя незворушна, але небайдужа реакція сама вчить клієнта, що про це можна говорити.' },
              ] },
              { type: 'h', text: 'Як це звучить' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Останнім часом усе якось безнадійно.' },
                { who: 'Терапевт', text: 'Коли настає така безнадія, у людей часом зʼявляються думки, що не хочеться жити. Чи бувають такі думки у вас?' },
                { who: 'Клієнт', text: '(тихо) Буває. Не щодня, але буває.' },
                { who: 'Терапевт', text: 'Дякую, що сказали — це важливо. Можна я розпитаю трохи докладніше, щоб зрозуміти, як вам зараз?' },
              ] },
              { type: 'h', text: 'Чому пряме й нормалізоване питання, а не натяки' },
              { type: 'p', text: 'Закрите чи осудливе питання («Ви ж не думаєте про дурниці?») фактично просить відповісти «ні» й зачиняє тему. Евфемізм («щось погане») лишає неясність — і ти, і клієнт можете говорити про різне. Пряме, спокійне питання в нормалізованій рамці робить протилежне: воно показує, що ти витримаєш будь-яку відповідь, тож казати правду безпечно.' },
              { type: 'h', text: 'Типові помилки' },
              { type: 'list', items: [
                { text: 'Закрите чи осудливе питання: «Ви ж не думаєте про щось погане?»' },
                { text: 'Евфемізми замість слів «суїцид» / «покінчити з життям» — лишають небезпечну неясність.' },
                { text: 'Змінити тему одразу після відповіді — це сигнал «про це не можна».' },
                { text: 'Питати лише «для галочки», щоб поставити бал, — замість того, щоб зрозуміти й допомогти.' },
              ] },
              { type: 'quote', text: 'Питання про суїцид не садить зерно — воно відчиняє двері. Найнебезпечніше — не спитати.' },
              { type: 'sources', sources: [
                { label: 'NICE (2022). Self-harm: assessment, management and preventing recurrence (NG225) — сучасні настанови: не стратифікувати ризик шкалами, а досліджувати спільно.', url: 'https://www.nice.org.uk/guidance/ng225' },
                { label: 'Posner та ін. (2011). Columbia Suicide Severity Rating Scale (C-SSRS): валідизація. Am J Psychiatry, 168, 1266–1277.', url: 'https://pubmed.ncbi.nlm.nih.gov/22193671/' },
                { label: 'Dazzi та ін. (2014). Чи провокує запитання про суїцид суїцидальні думки? Огляд доказів — ні. Psychological Medicine, 44, 3361–3363.', url: 'https://pubmed.ncbi.nlm.nih.gov/24998511/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: "A client hints: \"Sometimes I think it would be better if all of this just ended.\" The beginner gets frightened and gently changes the subject: \"Let's talk about something lighter — tell me about your daughter.\" It looks caring. But the client reads it unambiguously: \"this can't be spoken about here.\" And never returns to it. The paradox of risk work is that avoidance is more dangerous than a direct question." },
              { type: 'h', text: 'The myth that costs lives' },
              { type: 'p', text: "The commonest beginner fear: \"If I ask about suicide directly, I'll plant the idea.\" Not so. A review of the evidence (Dazzi et al., 2014) found that asking directly about suicidal thoughts does NOT increase them — and often brings relief, because the person can finally say aloud what they carried alone. Silence protects not the client but your own anxiety." },
              { type: 'h', text: 'We ask to understand — not to "score risk"' },
              { type: 'p', text: 'A key shift is now embedded in modern guidance (NICE NG225, 2022). Clinicians used to be taught to "measure" risk and place a person in a low/medium/high category. That is no longer recommended: scales predict poorly who will actually self-harm, and must not decide who gets care. We ask not for a score but to understand, with the client, what is happening — and to build a plan. The question is the start of collaboration, not triage.' },
              { type: 'h', text: 'How to ask without breaking contact' },
              { type: 'figure', figure: 'risk-ladder', caption: 'A funnel of questions: from general distress to thoughts, plan, means and intent. It is a sequence of questions, not a prediction scale.' },
              { type: 'list', items: [
                { term: '1. Normalise', text: '"When someone is having this hard a time, thoughts that you do not want to be alive sometimes come up. Do you ever have those?" — a frame in which admitting it is not shameful.' },
                { term: '2. Ask directly', text: 'no euphemisms: "Have you thought about ending your life?" Directness gives the client permission to be honest.' },
                { term: '3. Clarify with C-SSRS logic', text: 'thoughts → plan → access to means → intent. Each level raises the acuity and the specificity.' },
                { term: '4. Stay calm and warm', text: 'your unflustered but caring reaction itself teaches the client that this can be talked about.' },
              ] },
              { type: 'h', text: 'How it sounds' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'Lately everything just feels hopeless.' },
                { who: 'Therapist', text: 'When that kind of hopelessness sets in, people sometimes have thoughts that they do not want to be alive. Do you ever have those?' },
                { who: 'Client', text: '(quietly) Sometimes. Not every day, but sometimes.' },
                { who: 'Therapist', text: 'Thank you for telling me — that matters. May I ask a little more, to understand how you are right now?' },
              ] },
              { type: 'h', text: 'Why a direct, normalised question, not hints' },
              { type: 'p', text: "A closed or judgemental question (\"You're not thinking anything silly, are you?\") effectively asks for a \"no\" and shuts the topic. A euphemism (\"something bad\") leaves ambiguity — you and the client may mean different things. A direct, calm question inside a normalising frame does the opposite: it shows you can withstand any answer, so telling the truth is safe." },
              { type: 'h', text: 'Common mistakes' },
              { type: 'list', items: [
                { text: 'A closed or judgemental question: "You\'re not thinking of anything bad, are you?"' },
                { text: 'Euphemisms instead of the words "suicide" / "ending your life" — they leave dangerous ambiguity.' },
                { text: 'Changing the subject right after the answer — it signals "we don\'t discuss this".' },
                { text: 'Asking only to tick a box / assign a score — instead of to understand and help.' },
              ] },
              { type: 'quote', text: 'A question about suicide does not plant a seed — it opens a door. The most dangerous thing is not to ask.' },
              { type: 'sources', sources: [
                { label: 'NICE (2022). Self-harm: assessment, management and preventing recurrence (NG225) — current guidance: do not stratify risk with scales; explore it collaboratively.', url: 'https://www.nice.org.uk/guidance/ng225' },
                { label: 'Posner et al. (2011). The Columbia Suicide Severity Rating Scale (C-SSRS): validation. Am J Psychiatry, 168, 1266–1277.', url: 'https://pubmed.ncbi.nlm.nih.gov/22193671/' },
                { label: 'Dazzi et al. (2014). Does asking about suicide induce suicidal ideation? A review — no. Psychological Medicine, 44, 3361–3363.', url: 'https://pubmed.ncbi.nlm.nih.gov/24998511/' },
              ] },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Після відповіді: план безпеки',
            titleEn: 'After the answer: the safety plan',
            bodyUk: [
              { type: 'p', text: 'Клієнтка зізнається: «Іноді думаю, що всім було б легше без мене». Терапевт, не витримавши власної тривоги, випалює: «Ну що ви, у вас же діти, все буде добре!» — і швидко веде далі. Намір добрий, ефект протилежний: клієнтка чує, що її страх злякав навіть терапевта, і лишається з ним сама. Спитати про ризик — лише половина справи. Друга половина — що ти робиш із відповіддю.' },
              { type: 'h', text: 'Відповідь — це план, а не передбачення' },
              { type: 'p', text: 'Сучасні настанови (NICE NG225, 2022) чіткі: коли ризик є, користь не в тому, щоб «вгадати» ймовірність, а в тому, щоб разом із клієнтом скласти конкретний план безпеки. Це не формальність і не папірець для звіту — це доказова інтервенція.' },
              { type: 'h', text: 'Чому план безпеки працює' },
              { type: 'p', text: 'Дослідження Stanley і колег (2018, JAMA Psychiatry) показало: пацієнти, що отримали план безпеки з подальшим контактом, мали на 45% менше суїцидальних дій протягом пів року й удвічі частіше доходили до лікування, ніж ті, хто отримав звичайну допомогу. Метааналіз Nuij і колег (2021) підтвердив: інтервенції типу «план безпеки» зменшують суїцидальну поведінку. Тобто план — це чи не найкорисніше, що ти можеш зробити в кабінеті.' },
              { type: 'h', text: 'План безпеки Стенлі–Брауна: 6 кроків' },
              { type: 'figure', figure: 'safety-plan', caption: 'Сходинки від самодопомоги до зовнішньої допомоги: що далі вниз по списку, то більше залучаємо інших.' },
              { type: 'list', items: [
                { term: '1. Сигнали тривоги', text: 'думки, відчуття, ситуації, що передують загостренню, — щоб помітити хвилю на підйомі.' },
                { term: '2. Внутрішні навички', text: 'що клієнт може зробити сам, щоб перечекати: дихання, прогулянка, музика — відволікання без інших людей.' },
                { term: '3. Люди й місця для відволікання', text: 'до кого чи куди піти, щоб відвернутися (навіть без розмови про кризу).' },
                { term: '4. Кого можна попросити про допомогу', text: 'близькі, кому можна прямо сказати, що зараз важко.' },
                { term: '5. Фахівці й кризові служби', text: 'терапевт, лінія довіри, екстрена допомога — з конкретними номерами.' },
                { term: '6. Безпека засобів', text: 'разом зменшити доступ до того, чим людина могла б завдати собі шкоди.' },
              ] },
              { type: 'h', text: 'Найважливіший крок — безпека засобів' },
              { type: 'p', text: 'Обмеження доступу до засобів — компонент із найсильнішою доказовою базою. Криза часто минуща, а доступ до летального засобу саме в ці хвилини може все вирішити. Тому домовитися прибрати чи віддати засіб на час кризи — не дрібниця наприкінці, а серцевина плану.' },
              { type: 'h', text: 'Коли ескалувати' },
              { type: 'p', text: 'Якщо є конкретний план, доступ до засобів і намір діяти найближчим часом — це гостра ситуація. Не залишай людину саму, залучай кризові служби чи екстрену допомогу й дій за протоколом установи. У тренажері це навчальна вправа, а не реальна криза.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Іноді думаю, що всім було б легше без мене.' },
                { who: 'Терапевт', text: 'Дякую, що сказали — це важливо й сміливо. Можна я розпитаю трохи докладніше, щоб зрозуміти, наскільки вам зараз небезпечно? І давайте разом продумаємо, що робити, коли накриває.' },
              ] },
              { type: 'h', text: 'Чому спільний план, а не «контракт про несамогубство»' },
              { type: 'p', text: 'Колись поширені «контракти про несамогубство» («пообіцяйте, що нічого з собою не зробите») не працюють і можуть нашкодити: вони радше заспокоюють терапевта, ніж захищають клієнта, і підштовхують приховувати правду. Працює протилежне — план, складений РАЗОМ, із конкретними кроками й безпекою засобів, де клієнт є співавтором, а не підписантом.' },
              { type: 'h', text: 'Типові помилки' },
              { type: 'list', items: [
                { text: 'Фальшиве заспокоєння («все буде добре») замість конкретних кроків.' },
                { text: '«Контракт про несамогубство» замість спільного плану.' },
                { text: 'Скласти план ЗА клієнта, а не РАЗОМ із ним — такий не працюватиме.' },
                { text: 'Оминути безпеку засобів — найсильніший компонент.' },
                { text: 'Лишити без подальшого контакту: саме контакт після кризи знижує ризик.' },
              ] },
              { type: 'quote', text: 'План безпеки — це конкретні кроки на випадок темної ночі, складені завчасно, при світлі — і складені разом.' },
              { type: 'sources', sources: [
                { label: 'Nuij та ін. (2021). Інтервенції типу «план безпеки» для запобігання суїциду: метааналіз. Br J Psychiatry, 219, 419–426.', url: 'https://pubmed.ncbi.nlm.nih.gov/35048835/' },
                { label: 'Stanley та ін. (2018). План безпеки з подальшим контактом проти звичайної допомоги: −45% суїцидальної поведінки. JAMA Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/29998307/' },
                { label: 'NICE (2022). Self-harm (NG225) — спільне складання плану безпеки замість стратифікації ризику.', url: 'https://www.nice.org.uk/guidance/ng225' },
                { label: 'Stanley & Brown (2012). Safety Planning Intervention — першоджерело 6-крокового плану. Cognitive and Behavioral Practice, 19, 256–264.', url: 'https://doi.org/10.1016/j.cbpra.2011.01.001' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: "A client admits: \"Sometimes I think everyone would be better off without me.\" The therapist, unable to hold their own anxiety, blurts: \"Come on, you have children, it'll all be fine!\" and quickly moves on. The intent is kind, the effect the opposite: she hears that her fear frightened even the therapist, and is left alone with it. Asking about risk is only half the job. The other half is what you do with the answer." },
              { type: 'h', text: 'The answer is a plan, not a prediction' },
              { type: 'p', text: 'Modern guidance (NICE NG225, 2022) is clear: when there is risk, the value is not in "guessing" the probability but in building a concrete safety plan together with the client. This is not a formality or a form for the file — it is an evidence-based intervention.' },
              { type: 'h', text: 'Why a safety plan works' },
              { type: 'p', text: 'Stanley and colleagues (2018, JAMA Psychiatry) showed that patients who received a safety plan with follow-up contact had 45% fewer suicidal behaviours over six months and were twice as likely to engage in treatment than those who got usual care. The meta-analysis by Nuij and colleagues (2021) confirmed that safety-planning-type interventions reduce suicidal behaviour. So the plan is about the most useful thing you can do in the room.' },
              { type: 'h', text: 'The Stanley–Brown safety plan: 6 steps' },
              { type: 'figure', figure: 'safety-plan', caption: 'Steps from self-help to outside help: the further down the list, the more others are involved.' },
              { type: 'list', items: [
                { term: '1. Warning signs', text: 'thoughts, sensations, situations that precede a crisis — to catch the wave as it rises.' },
                { term: '2. Internal coping', text: 'what the client can do alone to ride it out: breathing, a walk, music — distraction without other people.' },
                { term: '3. People and places for distraction', text: 'who or where to go to take their mind off it (even without discussing the crisis).' },
                { term: '4. People to ask for help', text: 'those close to whom they can say directly that things are hard right now.' },
                { term: '5. Professionals and crisis services', text: 'therapist, helpline, emergency care — with concrete numbers.' },
                { term: '6. Means safety', text: 'together, reduce access to whatever the person could use to harm themselves.' },
              ] },
              { type: 'h', text: 'The most important step — means safety' },
              { type: 'p', text: 'Restricting access to means is the component with the strongest evidence base. A crisis is often transient, and access to a lethal means in those very minutes can decide everything. So agreeing to remove or hand over a means for the duration of the crisis is not a footnote at the end — it is the heart of the plan.' },
              { type: 'h', text: 'When to escalate' },
              { type: 'p', text: "If there is a concrete plan, access to means and intent to act in the near future — this is acute. Do not leave the person alone, involve crisis services or emergency care, and follow your setting's protocol. In the simulator this is a training exercise, not a real crisis." },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'Sometimes I think everyone would be better off without me.' },
                { who: 'Therapist', text: "Thank you for telling me — that matters and it's brave. May I ask a bit more, to understand how unsafe you feel right now? And let's think together about what to do when it floods in." },
              ] },
              { type: 'h', text: 'Why a shared plan, not a "no-suicide contract"' },
              { type: 'p', text: 'The once-common "no-suicide contracts" ("promise me you won\'t do anything") do not work and may harm: they reassure the therapist more than they protect the client, and they push the client to hide the truth. The opposite works — a plan built TOGETHER, with concrete steps and means safety, where the client is a co-author, not a signatory.' },
              { type: 'h', text: 'Common mistakes' },
              { type: 'list', items: [
                { text: 'False reassurance ("it\'ll all be fine") instead of concrete steps.' },
                { text: 'A "no-suicide contract" instead of a shared plan.' },
                { text: 'Writing the plan FOR the client rather than WITH them — it won\'t work.' },
                { text: 'Skipping means safety — the strongest component.' },
                { text: 'Leaving them with no follow-up: contact after the crisis is itself what lowers risk.' },
              ] },
              { type: 'quote', text: 'A safety plan is concrete steps for the dark night, written in advance, in the light — and written together.' },
              { type: 'sources', sources: [
                { label: 'Nuij et al. (2021). Safety planning-type interventions for suicide prevention: meta-analysis. Br J Psychiatry, 219, 419–426.', url: 'https://pubmed.ncbi.nlm.nih.gov/35048835/' },
                { label: 'Stanley et al. (2018). Safety Planning Intervention with follow-up vs usual care: 45% fewer suicidal behaviours. JAMA Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/29998307/' },
                { label: 'NICE (2022). Self-harm (NG225) — co-produce a safety plan rather than stratify risk.', url: 'https://www.nice.org.uk/guidance/ng225' },
                { label: 'Stanley & Brown (2012). Safety Planning Intervention — original source of the 6-step plan. Cognitive and Behavioral Practice, 19, 256–264.', url: 'https://doi.org/10.1016/j.cbpra.2011.01.001' },
              ] },
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
  {
    key: 'anxiety-basics',
    titleUk: 'Робота з тривогою: основи',
    titleEn: 'Working with anxiety: foundations',
    descUk:
      'Як пояснити клієнту тривогу, навчити навичок регуляції й обережно почати експозицію. 3 модулі — психоедукація, навички та наближення до страху, з квізами й практикою.',
    descEn:
      'How to explain anxiety to a client, teach regulation skills, and gently begin exposure. 3 modules — psychoeducation, skills, and approaching fear, with quizzes and practice.',
    aboutUk: [
      { type: 'p', text: '«Робота з тривогою: основи» — практичний курс про те, як допомогти клієнту з тривогою: пояснити, що з ним відбувається, дати навички регуляції й обережно почати наближення до страху.' },
      { type: 'h', text: 'Чого ти навчишся' },
      { type: 'list', items: [
        { text: 'Пояснювати клієнту природу тривоги й цикл уникання простими словами.' },
        { text: 'Навчати навичок регуляції — дихання та заземлення.' },
        { text: 'Працювати з тривожними думками: перевірка, а не суперечка.' },
        { text: 'Закладати основи експозиції — ієрархія, шкала SUDS, поступове наближення.' },
      ] },
      { type: 'h', text: 'Як влаштовано курс' },
      { type: 'p', text: '3 модулі: психоедукація → навички регуляції → експозиція. У кожному — уроки з прикладами, квіз і практика з AI-пацієнтом із фідбеком.' },
      { type: 'p', text: 'Базований на відкритих КПТ-рамках. Контент навчальний — не заміна супервізії чи терапії.' },
    ],
    aboutEn: [
      { type: 'p', text: '"Working with anxiety: foundations" is a practical course on helping an anxious client: explaining what is happening to them, teaching regulation skills, and gently beginning to approach fear.' },
      { type: 'h', text: 'What you will learn' },
      { type: 'list', items: [
        { text: "Explain the nature of anxiety and the avoidance loop in plain words." },
        { text: 'Teach regulation skills — breathing and grounding.' },
        { text: 'Work with anxious thoughts: testing, not arguing.' },
        { text: 'Lay the basics of exposure — a hierarchy, the SUDS scale, gradual approach.' },
      ] },
      { type: 'h', text: 'How the course works' },
      { type: 'p', text: '3 modules: psychoeducation → regulation skills → exposure. Each has lessons with examples, a quiz, and practice with an AI patient with feedback.' },
      { type: 'p', text: 'Based on public CBT frameworks. The content is educational — not a substitute for supervision or therapy.' },
    ],
    order: 2,
    published: true,
    modules: [
      {
        titleUk: 'Що таке тривога',
        titleEn: 'What anxiety is',
        objectivesUk: [
          'Пояснити тривогу як систему сигналізації, а не ваду.',
          'Розуміти цикл «тривога → уникання → ще більша тривога».',
          'Відпрацювати психоедукацію в сесії.',
        ],
        objectivesEn: [
          'Explain anxiety as an alarm system, not a defect.',
          'Understand the "anxiety → avoidance → more anxiety" loop.',
          'Practise psychoeducation in a session.',
        ],
        steps: [
          {
            kind: 'lesson',
            titleUk: 'Тривога як система сигналізації',
            titleEn: 'Anxiety as an alarm system',
            bodyUk: [
              { type: 'p', text: 'Тривога — не ворог і не поломка. Це давня система сигналізації тіла, що готує до загрози: мозок оцінює ситуацію як небезпечну й запускає реакцію «бий–біжи–завмри». Та сама система рятувала наших предків від хижака. Проблема не в тривозі як такій, а в хибних спрацюваннях — коли сигналізація виє, хоча реальної небезпеки немає.' },
              { type: 'h', text: 'Що відбувається в тілі' },
              { type: 'list', items: [
                { text: 'Серце бʼється швидше — більше кисню до мʼязів.' },
                { text: 'Дихання прискорюється, мʼязи напружені, долоні пітніють.' },
                { text: 'Увага звужується на загрозі — важко думати про щось інше.' },
                { text: 'Усе це рятує перед реальною небезпекою — і виснажує, коли її немає.' },
              ] },
              { type: 'h', text: 'Де проходить межа норми й розладу' },
              { type: 'p', text: 'Тривога сама по собі нормальна й корисна. Про тривожний розлад говорять, коли вона надмірна щодо реальної загрози, триває довго, і людина починає уникати — через що страждають робота, стосунки, життя (логіка DSM-5-TR). Тобто діагноз — не про «забагато відчуттів», а про ціну, яку людина платить, аби їх уникати.' },
              { type: 'h', text: 'Чому це варто пояснити клієнту' },
              { type: 'p', text: 'Психоедукація знижує «страх страху». Коли людина розуміє, що калатання серця — це адреналін, а не інфаркт, паніка втрачає частину сили. І це не дрібниця: тривожні розлади — одні з найпоширеніших, і водночас одні з тих, що найкраще піддаються психотерапії (Craske та ін., 2017).' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Мені здається, я божеволію, коли це накочує.' },
                { who: 'Терапевт', text: 'Те, що ви описуєте, дуже схоже на роботу системи тривоги — неприємно, але безпечно. Розповісти, що відбувається в тілі?' },
              ] },
              { type: 'h', text: 'Чому не «прибрати тривогу»' },
              { type: 'p', text: 'Ціль терапії — не вимкнути сигналізацію назавжди (це й неможливо, і небезпечно), а перекалібрувати її й змінити стосунки з тривогою: помічати, розуміти, не тікати. Саме на цьому будуються наступні модулі — навички регуляції та експозиція.' },
              { type: 'quote', text: 'Мета не «прибрати тривогу», а змінити стосунки з нею.' },
              { type: 'sources', sources: [
                { label: 'Craske та ін. (2017). Anxiety disorders. Nature Reviews Disease Primers — сучасний огляд механізмів, діагностики й лікування.', url: 'https://pubmed.ncbi.nlm.nih.gov/28470168/' },
                { label: 'American Psychiatric Association (2022). DSM-5-TR — критерії тривожних розладів (межа норми й розладу).', url: 'https://www.psychiatry.org/psychiatrists/practice/dsm' },
                { label: 'Carpenter та ін. (2018). КПТ при тривожних розладах: метааналіз плацебо-контрольованих РКД (g≈0.56). Depression and Anxiety.', url: 'https://doi.org/10.1002/da.22728' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: "Anxiety is not an enemy or a malfunction. It is the body's ancient alarm system preparing for threat: the brain reads a situation as dangerous and fires the fight–flight–freeze response. The same system saved our ancestors from a predator. The problem is not anxiety as such but false alarms — when the siren wails though there is no real danger." },
              { type: 'h', text: 'What happens in the body' },
              { type: 'list', items: [
                { text: 'The heart beats faster — more oxygen to the muscles.' },
                { text: 'Breathing speeds up, muscles tense, palms sweat.' },
                { text: 'Attention narrows onto the threat — hard to think of anything else.' },
                { text: 'All life-saving before real danger — and exhausting when there is none.' },
              ] },
              { type: 'h', text: 'Where normal ends and a disorder begins' },
              { type: 'p', text: 'Anxiety itself is normal and useful. We speak of an anxiety disorder when it is excessive relative to the real threat, lasts a long time, and the person starts to avoid — so that work, relationships and life suffer (the logic of DSM-5-TR). The diagnosis is not about "feeling too much" but about the price a person pays to avoid feeling it.' },
              { type: 'h', text: 'Why explain this to the client' },
              { type: 'p', text: 'Psychoeducation lowers the "fear of fear". When a person understands that a pounding heart is adrenaline, not a heart attack, panic loses some of its grip. And that is no small thing: anxiety disorders are among the most common — and among the most treatable with psychotherapy (Craske et al., 2017).' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "I feel like I'm going crazy when it hits." },
                { who: 'Therapist', text: 'What you describe sounds a lot like the alarm system firing — unpleasant, but safe. Shall I explain what happens in the body?' },
              ] },
              { type: 'h', text: 'Why not just "remove the anxiety"' },
              { type: 'p', text: "The goal of therapy is not to switch the alarm off forever (that is both impossible and unsafe) but to recalibrate it and change your relationship with anxiety: notice it, understand it, don't flee. The next modules build on exactly this — regulation skills and exposure." },
              { type: 'quote', text: 'The goal is not to "remove" anxiety but to change your relationship with it.' },
              { type: 'sources', sources: [
                { label: 'Craske et al. (2017). Anxiety disorders. Nature Reviews Disease Primers — a current review of mechanisms, diagnosis and treatment.', url: 'https://pubmed.ncbi.nlm.nih.gov/28470168/' },
                { label: 'American Psychiatric Association (2022). DSM-5-TR — criteria for anxiety disorders (the normal–disorder line).', url: 'https://www.psychiatry.org/psychiatrists/practice/dsm' },
                { label: 'Carpenter et al. (2018). CBT for anxiety disorders: meta-analysis of placebo-controlled RCTs (g≈0.56). Depression and Anxiety.', url: 'https://doi.org/10.1002/da.22728' },
              ] },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Цикл тривоги й уникання',
            titleEn: 'The anxiety–avoidance loop',
            bodyUk: [
              { type: 'p', text: 'Уникання дає миттєве полегшення — і саме тому підтримує тривогу. Кожне уникання «вчить» мозок, що ситуація справді була небезпечною, а порятунком став відступ. Коротка вигода — довга ціна.' },
              { type: 'h', text: 'Як працює цикл' },
              { type: 'figure', figure: 'anxiety-loop' },
              { type: 'list', items: [
                { text: 'Тригер → тривога росте → уникання чи втеча → миттєве полегшення.' },
                { text: 'Мозок робить висновок: «небезпечно, добре що втік» — страх підкріплюється.' },
                { text: 'Наступного разу тривога ще сильніша, коло безпечних ситуацій звужується — цикл закручується.' },
              ] },
              { type: 'h', text: 'Чому це не питання сили волі' },
              { type: 'p', text: 'Полегшення після втечі — потужне підкріплення, біологічно вмонтоване. Тому «просто потерпи» не працює: мозок щоразу отримує доказ, що уникання рятує. Розірвати цикл — не про силу волі, а про новий досвід, який суперечить прогнозу катастрофи.' },
              { type: 'h', text: 'Що з цим робити' },
              { type: 'p', text: 'Сучасна модель (інгібіторне научіння, Craske та ін., 2014) уточнює давню ідею «перечекай, і тривога спаде». Лікує не стільки те, що тривога падає в моменті, скільки те, що передбачення не справджується: клієнт лишається в ситуації, очікувана катастрофа не настає — і мозок формує нову, конкуруючу памʼять «тут безпечно». Саме на цьому будується експозиція (третій модуль).' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Я просто не ходжу у великі супермаркети, так спокійніше.' },
                { who: 'Терапевт', text: 'І це справді знімає тривогу тут і зараз. А подивимось разом, чого ви так і не дізнаєтесь, поки уникаєте, — наприклад, що буде, якщо тривога підніметься, а ви лишитесь?' },
              ] },
              { type: 'quote', text: 'Уникання — це знеболювальне, яке підживлює хворобу.' },
              { type: 'sources', sources: [
                { label: 'Craske та ін. (2014). Maximizing exposure therapy: інгібіторне научіння — сучасна модель того, чому наближення лікує. Behaviour Research and Therapy.', url: 'https://pubmed.ncbi.nlm.nih.gov/24864005/' },
                { label: 'Craske та ін. (2017). Anxiety disorders. Nature Reviews Disease Primers — роль уникання в підтриманні тривоги.', url: 'https://pubmed.ncbi.nlm.nih.gov/28470168/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'Avoidance brings instant relief — and that is exactly why it maintains anxiety. Each avoidance "teaches" the brain that the situation really was dangerous and that retreat was the rescue. A short gain for a long cost.' },
              { type: 'h', text: 'How the loop works' },
              { type: 'figure', figure: 'anxiety-loop' },
              { type: 'list', items: [
                { text: 'Trigger → anxiety rises → avoid or escape → instant relief.' },
                { text: 'The brain concludes: "dangerous, good thing I fled" — the fear is reinforced.' },
                { text: 'Next time anxiety is stronger and the world of safe situations shrinks — the loop tightens.' },
              ] },
              { type: 'h', text: 'Why this is not about willpower' },
              { type: 'p', text: 'The relief after escape is a powerful, biologically built-in reinforcer. That is why "just tough it out" fails: the brain keeps getting proof that avoidance rescues. Breaking the loop is not about willpower but about a new experience that contradicts the predicted catastrophe.' },
              { type: 'h', text: 'What to do about it' },
              { type: 'p', text: 'The modern model (inhibitory learning; Craske et al., 2014) refines the old idea of "wait it out and anxiety drops". What heals is less that anxiety falls in the moment and more that the prediction fails to come true: the client stays, the expected catastrophe does not happen, and the brain builds a new, competing "I am safe here" memory. This is the basis of exposure (module 3).' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "I just don't go to big supermarkets, it's calmer that way." },
                { who: 'Therapist', text: 'And that really does ease the anxiety right now. Shall we look together at what you never get to find out while you avoid — for instance, what happens if the anxiety rises and you stay?' },
              ] },
              { type: 'quote', text: 'Avoidance is a painkiller that feeds the illness.' },
              { type: 'sources', sources: [
                { label: 'Craske et al. (2014). Maximizing exposure therapy: inhibitory learning — the current model of why approach heals. Behaviour Research and Therapy.', url: 'https://pubmed.ncbi.nlm.nih.gov/24864005/' },
                { label: 'Craske et al. (2017). Anxiety disorders. Nature Reviews Disease Primers — the role of avoidance in maintaining anxiety.', url: 'https://pubmed.ncbi.nlm.nih.gov/28470168/' },
              ] },
            ],
          },
          {
            kind: 'quiz',
            titleUk: 'Перевірка: природа тривоги',
            titleEn: 'Check: the nature of anxiety',
            quizUk: [
              {
                q: 'Як найкраще описати тривогу клієнту?',
                options: ['Поломка психіки', 'Система сигналізації тіла, що іноді хибно спрацьовує', 'Завжди ознака хвороби', 'Те, що треба негайно прибрати'],
                correct: 1,
                explain: 'Психоедукація подає тривогу як нормальну систему з хибними спрацюваннями.',
              },
              {
                q: 'Чому уникання підтримує тривогу?',
                options: ['Бо забирає полегшення', 'Бо «вчить» мозок, що ситуація небезпечна, і наступного разу тривога сильніша', 'Бо не діє взагалі', 'Бо викликає сором'],
                correct: 1,
                explain: 'Миттєве полегшення підкріплює уникання й закручує цикл.',
              },
            ],
            quizEn: [
              {
                q: 'How is anxiety best described to a client?',
                options: ['A broken psyche', 'A body alarm system that sometimes false-alarms', 'Always a sign of illness', 'Something to remove immediately'],
                correct: 1,
                explain: 'Psychoeducation frames anxiety as a normal system with false alarms.',
              },
              {
                q: 'Why does avoidance maintain anxiety?',
                options: ['It removes relief', 'It "teaches" the brain the situation is dangerous, so next time anxiety is stronger', 'It does nothing at all', 'It causes shame'],
                correct: 1,
                explain: 'Instant relief reinforces avoidance and tightens the loop.',
              },
            ],
          },
          {
            kind: 'practice',
            titleUk: 'Практика: психоедукація тривоги',
            titleEn: 'Practice: anxiety psychoeducation',
            characterRef: 'Анна',
            techniqueKey: 'psychoeducation',
            bodyUk: [
              { type: 'p', text: 'Завдання: поясни Анні простими словами, що таке тривога й цикл уникання — нормалізуй, без жаргону. Заверши сесію й отримай фідбек, щоб зарахувати крок.' },
            ],
            bodyEn: [
              { type: 'p', text: 'Task: explain anxiety and the avoidance loop to Anna in plain words — normalise, no jargon. End the session and get feedback to complete the step.' },
            ],
          },
        ],
      },
      {
        titleUk: 'Навички регуляції',
        titleEn: 'Regulation skills',
        objectivesUk: [
          'Навчити клієнта дихальній навичці й заземленню.',
          'Розпізнавати й перевіряти тривожні думки.',
          'Відпрацювати навчання навички в сесії.',
        ],
        objectivesEn: [
          'Teach the client a breathing skill and grounding.',
          'Spot and test anxious thoughts.',
          'Practise teaching a skill in a session.',
        ],
        steps: [
          {
            kind: 'lesson',
            titleUk: 'Дихання й заземлення',
            titleEn: 'Breathing and grounding',
            bodyUk: [
              { type: 'p', text: 'Коли тривога висока, мислення майже не працює — кора «віддає кермо» системі тривоги. Тому спершу варто збити фізіологічну хвилю, а вже потім думати. Дві прості навички: сповільнене дихання й заземлення.' },
              { type: 'h', text: 'Сповільнене дихання' },
              { type: 'p', text: 'Видих, довший за вдих, активує парасимпатичну («гальмівну») гілку нервової системи й знижує збудження. Орієнтир: вдих на 4, видих на 6, кілька хвилин. Важливо не глибоко, а повільно — гіпервентиляція навпаки розганяє тривогу.' },
              { type: 'h', text: 'Заземлення 5-4-3-2-1' },
              { type: 'figure', figure: 'grounding' },
              { type: 'list', items: [
                { text: '5 речей, які бачиш; 4 — які чуєш; 3 — яких торкаєшся; 2 — які відчуваєш на запах; 1 — смак.' },
                { text: 'Повертає увагу з «голови» (думок-катастроф) у «тут і зараз».' },
              ] },
              { type: 'h', text: 'Важливе застереження: навичка чи «рятувальний костур»?' },
              { type: 'p', text: 'Ці навички — щоб упоратися й рухатися далі, а не щоб уникати. Якщо клієнт переживає ситуацію лише тому, що «правильно дихав», він може так і не дізнатися, що був би в безпеці й без цього. Тоді дихання перетворюється на рятувальну поведінку, яка тихо підживлює тривогу (Craske та ін., 2014). Тому регуляцію подаємо як підтримку на шляху до наближення, а не як спосіб не відчувати.' },
              { type: 'h', text: 'Як навчати навички в сесії' },
              { type: 'list', items: [
                { text: 'Спершу поясни навіщо (раціонал).' },
                { text: 'Покажи і зроби разом тут, у кабінеті.' },
                { text: 'Дай спробувати клієнту самому й дай зворотний звʼязок.' },
                { text: 'Домовся про конкретну практику між сесіями.' },
              ] },
              { type: 'quote', text: 'Навичка, яку не відпрацювали в кабінеті, рідко спрацьовує вдома.' },
              { type: 'sources', sources: [
                { label: 'Craske та ін. (2014). Maximizing exposure therapy: інгібіторне научіння — чому «рятувальна» поведінка може підтримувати тривогу. Behaviour Research and Therapy.', url: 'https://pubmed.ncbi.nlm.nih.gov/24864005/' },
                { label: 'Craske та ін. (2017). Anxiety disorders. Nature Reviews Disease Primers — компоненти лікування тривоги.', url: 'https://pubmed.ncbi.nlm.nih.gov/28470168/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'When anxiety is high, thinking barely works — the cortex "hands the wheel" to the alarm system. So first knock down the physiological wave, then think. Two simple skills: slowed breathing and grounding.' },
              { type: 'h', text: 'Slowed breathing' },
              { type: 'p', text: 'An exhale longer than the inhale activates the parasympathetic ("braking") branch of the nervous system and lowers arousal. A guide: in for 4, out for 6, for a few minutes. Slow matters more than deep — hyperventilation actually revs anxiety up.' },
              { type: 'h', text: 'Grounding 5-4-3-2-1' },
              { type: 'figure', figure: 'grounding' },
              { type: 'list', items: [
                { text: '5 things you see; 4 you hear; 3 you touch; 2 you smell; 1 you taste.' },
                { text: 'Pulls attention out of "the head" (catastrophe thoughts) and into the here and now.' },
              ] },
              { type: 'h', text: 'An important caveat: a skill, or a "safety crutch"?' },
              { type: 'p', text: 'These skills are for coping and moving forward, not for avoiding. If a client only gets through a situation because they "breathed correctly", they may never learn they would have been safe without it. Then breathing becomes a safety behaviour that quietly feeds the anxiety (Craske et al., 2014). So we frame regulation as support on the way toward approaching fear, not as a way not to feel.' },
              { type: 'h', text: 'How to teach a skill in session' },
              { type: 'list', items: [
                { text: 'Explain the rationale first.' },
                { text: 'Demonstrate and do it together here, in the room.' },
                { text: 'Let the client try it themselves and give feedback.' },
                { text: 'Agree on concrete practice between sessions.' },
              ] },
              { type: 'quote', text: 'A skill not rehearsed in the room rarely works at home.' },
              { type: 'sources', sources: [
                { label: 'Craske et al. (2014). Maximizing exposure therapy: inhibitory learning — why "safety" behaviours can maintain anxiety. Behaviour Research and Therapy.', url: 'https://pubmed.ncbi.nlm.nih.gov/24864005/' },
                { label: 'Craske et al. (2017). Anxiety disorders. Nature Reviews Disease Primers — components of anxiety treatment.', url: 'https://pubmed.ncbi.nlm.nih.gov/28470168/' },
              ] },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Робота з тривожними думками',
            titleEn: 'Working with anxious thoughts',
            bodyUk: [
              { type: 'p', text: 'Тривога живиться думками-передбаченнями катастрофи: «я зганьблюся», «станеться найгірше». За когнітивною моделлю тривога зростає, коли ми переоцінюємо ймовірність і ціну поганого — і недооцінюємо власну здатність упоратися. Тож працюємо не суперечкою, а перевіркою цих передбачень.' },
              { type: 'h', text: 'Типові пастки мислення' },
              { type: 'list', items: [
                { term: 'Катастрофізація', text: 'одразу найгірший сценарій.' },
                { term: 'Читання думок', text: '«усі думають, що я нікчема».' },
                { term: 'Чорно-біле мислення', text: 'або ідеально, або провал.' },
                { term: 'Переоцінка ймовірності', text: 'малоймовірне здається неминучим.' },
              ] },
              { type: 'h', text: 'Перевірка думки (а не суперечка з нею)' },
              { type: 'p', text: 'Мета — не переконати клієнта, що він «неправий» (це лише посилює опір), а разом, із цікавістю, перевірити думку на реалістичність. Запитання-помічники:' },
              { type: 'list', items: [
                { text: 'Яка саме думка лякає?' },
                { text: 'Які докази за і проти?' },
                { text: 'Що найімовірніше станеться насправді?' },
                { text: 'Якщо найгірше таки станеться — як я з цим упораюсь?' },
                { text: 'Що б я сказав другові з такою думкою?' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Якщо я помилюся на зустрічі, всі вирішать, що я нікчема.' },
                { who: 'Терапевт', text: 'Це звучить лякаюче. А якби колега помилився — ви б вирішили, що він нікчема?' },
              ] },
              { type: 'h', text: 'Думка — це гіпотеза, яку перевіряють у житті' },
              { type: 'p', text: 'Найсильніше переконує не логіка в кабінеті, а досвід. Тому когнітивну роботу зазвичай поєднують із поведінковим експериментом: клієнт іде й перевіряє передбачення в реальній ситуації (місток до експозиції). Саме поєднання думок і дій робить КПТ при тривозі дієвою (Carpenter та ін., 2018).' },
              { type: 'quote', text: 'Ми не сперечаємося з думкою — ми робимо її перевіряною.' },
              { type: 'sources', sources: [
                { label: 'Carpenter та ін. (2018). КПТ при тривожних розладах: метааналіз РКД (g≈0.56). Depression and Anxiety.', url: 'https://doi.org/10.1002/da.22728' },
                { label: 'Craske та ін. (2017). Anxiety disorders. Nature Reviews Disease Primers — когнітивні чинники тривоги.', url: 'https://pubmed.ncbi.nlm.nih.gov/28470168/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'Anxiety feeds on catastrophe-predicting thoughts: "I\'ll humiliate myself", "the worst will happen". On the cognitive model, anxiety grows when we overestimate the probability and cost of something bad — and underestimate our own ability to cope. So we work not by arguing but by testing these predictions.' },
              { type: 'h', text: 'Common thinking traps' },
              { type: 'list', items: [
                { term: 'Catastrophising', text: 'jumping straight to the worst case.' },
                { term: 'Mind-reading', text: '"everyone thinks I\'m worthless".' },
                { term: 'Black-and-white thinking', text: 'either perfect or a failure.' },
                { term: 'Overestimating probability', text: 'the unlikely feels inevitable.' },
              ] },
              { type: 'h', text: 'Testing a thought (not arguing with it)' },
              { type: 'p', text: 'The goal is not to convince the client they are "wrong" (that only feeds resistance) but to test the thought for realism together, with curiosity. Helper questions:' },
              { type: 'list', items: [
                { text: 'What exactly is the frightening thought?' },
                { text: 'What is the evidence for and against?' },
                { text: 'What will most likely actually happen?' },
                { text: 'If the worst does happen — how would I cope with it?' },
                { text: 'What would I tell a friend with this thought?' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'If I slip up in the meeting, everyone will decide I\'m worthless.' },
                { who: 'Therapist', text: 'That sounds frightening. And if a colleague slipped up — would you decide they were worthless?' },
              ] },
              { type: 'h', text: 'A thought is a hypothesis to test in real life' },
              { type: 'p', text: 'What convinces most is not logic in the room but experience. So cognitive work is usually paired with a behavioural experiment: the client goes and tests the prediction in a real situation (the bridge to exposure). It is this combination of thoughts and actions that makes CBT for anxiety work (Carpenter et al., 2018).' },
              { type: 'quote', text: 'We don\'t argue with a thought — we make it testable.' },
              { type: 'sources', sources: [
                { label: 'Carpenter et al. (2018). CBT for anxiety disorders: meta-analysis of RCTs (g≈0.56). Depression and Anxiety.', url: 'https://doi.org/10.1002/da.22728' },
                { label: 'Craske et al. (2017). Anxiety disorders. Nature Reviews Disease Primers — cognitive factors in anxiety.', url: 'https://pubmed.ncbi.nlm.nih.gov/28470168/' },
              ] },
            ],
          },
          {
            kind: 'quiz',
            titleUk: 'Перевірка: навички',
            titleEn: 'Check: skills',
            quizUk: [
              {
                q: 'Яке співвідношення дихання заспокоює нервову систему?',
                options: ['Вдих довший за видих', 'Видих довший за вдих', 'Затримка дихання', 'Швидке поверхневе дихання'],
                correct: 1,
                explain: 'Подовжений видих активує парасимпатичну («гальмівну») систему.',
              },
              {
                q: 'Що таке «перевірка думки»?',
                options: ['Переконати клієнта, що він неправий', 'Разом подивитися на докази за і проти й оцінити реалістичність', 'Ігнорувати думку', 'Замінити її позитивною афірмацією'],
                correct: 1,
                explain: 'Мета — зробити думку перевіряною, а не виграти суперечку.',
              },
            ],
            quizEn: [
              {
                q: 'Which breathing ratio calms the nervous system?',
                options: ['Inhale longer than exhale', 'Exhale longer than inhale', 'Breath-holding', 'Fast shallow breathing'],
                correct: 1,
                explain: 'A longer exhale engages the parasympathetic ("brake") system.',
              },
              {
                q: 'What is "testing a thought"?',
                options: ['Convincing the client they are wrong', 'Looking together at evidence for and against and rating how realistic it is', 'Ignoring the thought', 'Replacing it with a positive affirmation'],
                correct: 1,
                explain: 'The aim is to make the thought testable, not to win an argument.',
              },
            ],
          },
          {
            kind: 'practice',
            titleUk: 'Практика: навчити навички',
            titleEn: 'Practice: teach a skill',
            characterRef: 'Максим',
            techniqueKey: 'grounding',
            bodyUk: [
              { type: 'p', text: 'Завдання: навчи Максима однієї навички регуляції (дихання чи заземлення) — поясни навіщо, зробіть разом, дай спробувати. Заверши сесію й отримай фідбек.' },
            ],
            bodyEn: [
              { type: 'p', text: 'Task: teach Maksym one regulation skill (breathing or grounding) — explain why, do it together, let him try. End the session and get feedback.' },
            ],
          },
        ],
      },
      {
        titleUk: 'Експозиція (основи)',
        titleEn: 'Exposure (basics)',
        objectivesUk: [
          'Пояснити сенс поступового наближення до страху.',
          'Скласти просту ієрархію експозиції зі шкалою SUDS.',
          'Відпрацювати планування експозиції в сесії.',
        ],
        objectivesEn: [
          'Explain the rationale for gradually approaching fear.',
          'Build a simple exposure hierarchy with a SUDS scale.',
          'Practise planning exposure in a session.',
        ],
        steps: [
          {
            kind: 'lesson',
            titleUk: 'Навіщо й як наближатися до страху',
            titleEn: 'Why and how to approach fear',
            bodyUk: [
              { type: 'p', text: 'Експозиція — золотий стандарт роботи з тривогою: поступове, сплановане наближення до того, чого людина боїться й уникає. Це не «терпіти», а вчити мозок новому: ситуація, що здавалась небезпечною, насправді безпечна (або принаймні стерпна).' },
              { type: 'h', text: 'Як це насправді працює (важливе уточнення)' },
              { type: 'p', text: 'Раніше вважали, що головне — лишатися, доки тривога «спаде сама» (звикання). Сучасна модель інгібіторного научіння (Craske та ін., 2014; 2022) показала інше: ключове не падіння тривоги в моменті, а порушення очікувань — клієнт перевіряє конкретне передбачення («я знепритомнію», «усі сміятимуться»), воно не справджується, і формується нова памʼять, що конкурує зі старим страхом. Тому експозицію будують як експеримент: «що ти передбачаєш? перевірмо».' },
              { type: 'h', text: 'Ключові принципи' },
              { type: 'list', items: [
                { term: 'Поступовість', text: 'від легшого до важчого, хоч і не обовʼязково суворо по черзі.' },
                { term: 'Мета — здивування, не «перечекати»', text: 'лишатися достатньо, щоб побачити: передбачене лихо не сталося.' },
                { term: 'Без «рятувальної» поведінки', text: 'прибрати костурі (пляшка води «про всяк», місце біля виходу) — інакше клієнт припише безпеку їм, а не реальності.' },
                { term: 'Повторюваність і різні контексти', text: 'нове навчання міцніше, коли пробувати в різних місцях і станах.' },
              ] },
              { type: 'h', text: 'Шкала SUDS і ієрархія' },
              { type: 'figure', figure: 'suds' },
              { type: 'p', text: 'SUDS — субʼєктивна одиниця дискомфорту, 0–100. Вона допомагає скласти «драбину» ситуацій (від ~30 до ~90) і відстежувати інтенсивність. Але мета кроку — не «довести SUDS до нуля», а перевірити передбачення; інколи людина виходить ще схвильованою, але вже з новим досвідом «я впорався».' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Я ніколи не зможу виступати перед людьми.' },
                { who: 'Терапевт', text: 'Почнімо не з виступу. Що було б на 30 зі 100 — наприклад, поставити одне запитання на нараді? І що, на вашу думку, тоді станеться найгірше?' },
              ] },
              { type: 'h', text: 'Чого не робити' },
              { type: 'list', items: [
                { text: 'Не штовхати в найстрашніше одразу й без згоди.' },
                { text: 'Не вимагати, щоб тривога «впала», перш ніж завершити, — це повертає до застарілої моделі.' },
                { text: 'Не дозволяти рятувальну поведінку, що «рятує» саме від перевірки передбачення.' },
              ] },
              { type: 'quote', text: 'Сміливість — це не відсутність тривоги, а дія поряд із нею.' },
              { type: 'sources', sources: [
                { label: 'Craske та ін. (2014). Maximizing exposure therapy: інгібіторне научіння (порушення очікувань). Behaviour Research and Therapy.', url: 'https://pubmed.ncbi.nlm.nih.gov/24864005/' },
                { label: 'Craske та ін. (2022). Optimizing exposure therapy (inhibitory retrieval, OptEx Nexus) — оновлені стратегії. Behaviour Research and Therapy.', url: 'https://doi.org/10.1016/j.brat.2022.104069' },
                { label: 'Carpenter та ін. (2018). КПТ при тривожних розладах: метааналіз (g≈0.56). Depression and Anxiety.', url: 'https://doi.org/10.1002/da.22728' },
                { label: 'van Dis та ін. (2020). Довгострокові результати КПТ при тривозі: метааналіз. JAMA Psychiatry.', url: 'https://jamanetwork.com/journals/jamapsychiatry/fullarticle/2756136' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'Exposure is the gold standard for anxiety: gradual, planned approach to what the person fears and avoids. It is not "enduring" but teaching the brain something new — that a situation that felt dangerous is actually safe (or at least bearable).' },
              { type: 'h', text: 'How it actually works (an important update)' },
              { type: 'p', text: 'It used to be thought that the key was to stay until anxiety "drops on its own" (habituation). The modern inhibitory-learning model (Craske et al., 2014; 2022) showed otherwise: what matters is not anxiety falling in the moment but expectancy violation — the client tests a specific prediction ("I\'ll faint", "everyone will laugh"), it fails to come true, and a new memory forms that competes with the old fear. So exposure is built as an experiment: "what do you predict? let\'s test it".' },
              { type: 'h', text: 'Key principles' },
              { type: 'list', items: [
                { term: 'Gradual', text: 'from easier to harder, though not necessarily in strict order.' },
                { term: 'Goal is surprise, not "waiting it out"', text: 'stay long enough to see that the predicted disaster did not happen.' },
                { term: 'No "safety" behaviour', text: 'drop the crutches (a "just-in-case" water bottle, a seat by the exit) — otherwise the client credits safety to them, not to reality.' },
                { term: 'Repeated, across contexts', text: 'new learning sticks better when practised in varied places and states.' },
              ] },
              { type: 'h', text: 'The SUDS scale and a hierarchy' },
              { type: 'figure', figure: 'suds' },
              { type: 'p', text: 'SUDS is a subjective unit of distress, 0–100. It helps build a "ladder" of situations (from ~30 to ~90) and track intensity. But the goal of a step is not to "drive SUDS to zero" — it is to test the prediction; sometimes the person leaves still anxious, but with a new experience of "I coped".' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "I'll never be able to speak in front of people." },
                { who: 'Therapist', text: "Let's not start with a speech. What would be a 30 out of 100 — say, asking one question in a meeting? And what do you predict would be the worst that happens?" },
              ] },
              { type: 'h', text: 'What not to do' },
              { type: 'list', items: [
                { text: "Don't push into the scariest thing at once, or without consent." },
                { text: 'Don\'t require anxiety to "drop" before ending — that reverts to the outdated model.' },
                { text: 'Don\'t allow safety behaviour that "rescues" the client from testing the prediction.' },
              ] },
              { type: 'quote', text: 'Courage is not the absence of anxiety but action alongside it.' },
              { type: 'sources', sources: [
                { label: 'Craske et al. (2014). Maximizing exposure therapy: inhibitory learning (expectancy violation). Behaviour Research and Therapy.', url: 'https://pubmed.ncbi.nlm.nih.gov/24864005/' },
                { label: 'Craske et al. (2022). Optimizing exposure therapy (inhibitory retrieval, OptEx Nexus) — updated strategies. Behaviour Research and Therapy.', url: 'https://doi.org/10.1016/j.brat.2022.104069' },
                { label: 'Carpenter et al. (2018). CBT for anxiety disorders: meta-analysis (g≈0.56). Depression and Anxiety.', url: 'https://doi.org/10.1002/da.22728' },
                { label: 'van Dis et al. (2020). Long-term outcomes of CBT for anxiety: meta-analysis. JAMA Psychiatry.', url: 'https://jamanetwork.com/journals/jamapsychiatry/fullarticle/2756136' },
              ] },
            ],
          },
          {
            kind: 'quiz',
            titleUk: 'Перевірка: експозиція',
            titleEn: 'Check: exposure',
            quizUk: [
              {
                q: 'У чому, за сучасною моделлю, головний механізм експозиції?',
                options: ['Відволікти клієнта від страху', 'Перевірити лякаюче передбачення й переконатися, що воно не справджується (порушення очікувань)', 'Дочекатися, доки тривога обовʼязково впаде до нуля', 'Прибрати всі тригери з життя'],
                correct: 1,
                explain: 'За інгібіторним научінням лікує порушення очікувань і нове навчання, а не саме лише падіння тривоги в моменті.',
              },
              {
                q: 'Що таке SUDS?',
                options: ['Тип ліків', 'Субʼєктивна шкала дискомфорту 0–100', 'Дихальна вправа', 'Діагноз'],
                correct: 1,
                explain: 'SUDS допомагає будувати ієрархію й відстежувати прогрес.',
              },
            ],
            quizEn: [
              {
                q: 'On the modern model, what is the core mechanism of exposure?',
                options: ['Distract the client from fear', 'Test a feared prediction and find it does not come true (expectancy violation)', 'Wait until anxiety necessarily drops to zero', 'Remove all triggers from life'],
                correct: 1,
                explain: 'Under inhibitory learning, what heals is expectancy violation and new learning, not merely anxiety dropping in the moment.',
              },
              {
                q: 'What is SUDS?',
                options: ['A type of medication', 'A subjective distress scale, 0–100', 'A breathing exercise', 'A diagnosis'],
                correct: 1,
                explain: 'SUDS helps build the hierarchy and track progress.',
              },
            ],
          },
          {
            kind: 'practice',
            titleUk: 'Практика: спланувати експозицію',
            titleEn: 'Practice: plan an exposure',
            characterRef: 'Анна',
            techniqueKey: 'exposure',
            bodyUk: [
              { type: 'p', text: 'Завдання: разом з Анною оберіть один страх і складіть перший крок ієрархії (щось на ~30 за SUDS). Поясни, що мета — перевірити передбачення, а не дочекатися, доки тривога впаде. Заверши сесію й отримай фідбек.' },
            ],
            bodyEn: [
              { type: 'p', text: 'Task: with Anna, pick one fear and build the first step of a hierarchy (something around 30 on SUDS). Explain that the goal is to test the prediction, not to wait for anxiety to drop. End the session and get feedback.' },
            ],
          },
        ],
      },
    ],
  },
  {
    key: 'depression-basics',
    titleUk: 'Депресія: основи',
    titleEn: 'Depression: foundations',
    descUk:
      'Як розпізнати депресію, пояснити її клієнту й допомогти доказовими методами: поведінкова активація, робота з думками, ризик і профілактика рецидиву. 3 модулі з квізами та практикою.',
    descEn:
      'How to recognise depression, explain it to a client, and help with evidence-based methods: behavioural activation, working with thoughts, risk and relapse prevention. 3 modules with quizzes and practice.',
    aboutUk: [
      { type: 'p', text: '«Депресія: основи» — практичний курс про те, як допомогти людині в депресії: побачити, що це не лінь і не слабкість, пояснити механізм, запустити рух через поведінкову активацію й безпечно тримати в полі зору ризик.' },
      { type: 'h', text: 'Чого ти навчишся' },
      { type: 'list', items: [
        { text: 'Розпізнавати депресію й відрізняти її від звичайного смутку.' },
        { text: 'Пояснювати клієнту низхідну спіраль настрою простими словами.' },
        { text: 'Запускати поведінкову активацію — головний робочий інструмент.' },
        { text: 'Працювати з негативними думками й когнітивною тріадою.' },
        { text: 'Тримати в полі зору ризик і складати план профілактики рецидиву.' },
      ] },
      { type: 'h', text: 'Як влаштовано курс' },
      { type: 'p', text: '3 модулі: природа депресії → поведінкова активація → думки, ризик і профілактика рецидиву. У кожному — уроки з прикладами, квіз і практика з AI-пацієнтом із фідбеком.' },
      { type: 'p', text: 'Базований на відкритих КПТ/BA-рамках і сучасних настановах. Контент навчальний — не заміна супервізії, діагностики чи терапії.' },
    ],
    aboutEn: [
      { type: 'p', text: '"Depression: foundations" is a practical course on helping a depressed person: seeing that this is not laziness or weakness, explaining the mechanism, getting movement going through behavioural activation, and keeping risk safely in view.' },
      { type: 'h', text: 'What you will learn' },
      { type: 'list', items: [
        { text: 'Recognise depression and tell it apart from ordinary sadness.' },
        { text: 'Explain the downward mood spiral to a client in plain words.' },
        { text: 'Start behavioural activation — the main working tool.' },
        { text: 'Work with negative thoughts and the cognitive triad.' },
        { text: 'Keep risk in view and build a relapse-prevention plan.' },
      ] },
      { type: 'h', text: 'How the course works' },
      { type: 'p', text: '3 modules: the nature of depression → behavioural activation → thoughts, risk and relapse prevention. Each has lessons with examples, a quiz, and practice with an AI patient with feedback.' },
      { type: 'p', text: 'Based on public CBT/BA frameworks and current guidelines. The content is educational — not a substitute for supervision, diagnosis or therapy.' },
    ],
    order: 3,
    published: true,
    modules: [
      {
        titleUk: 'Що таке депресія',
        titleEn: 'What depression is',
        objectivesUk: [
          'Відрізняти депресію від звичайного смутку за ключовими ознаками.',
          'Пояснювати депресію як стан, а не ваду характеру.',
          'Описувати низхідну спіраль настрою й активності.',
        ],
        objectivesEn: [
          'Tell depression apart from ordinary sadness by key features.',
          'Explain depression as a state, not a character flaw.',
          'Describe the downward spiral of mood and activity.',
        ],
        steps: [
          {
            kind: 'lesson',
            titleUk: 'Депресія — не лінь і не слабкість',
            titleEn: 'Depression is not laziness or weakness',
            bodyUk: [
              { type: 'p', text: 'Уяви: близька людина каже Максимові «та просто візьми себе в руки». Він і сам себе картає — але не може встати з ліжка, і від цього лише гірше. Якщо ти ніколи не стикався з депресією, збоку вона й справді схожа на лінь чи слабкість. Цей урок — щоб побачити, що відбувається насправді: звідки взялося саме поняття, що коїться з людиною й чому, і як їй допомагають.' },
              { type: 'p', text: 'Почнімо з простого. Депресія — це не «поганий настрій» і не звичайний смуток. Це стан, у якому надовго згасають три речі одразу: енергія, інтерес і здатність радіти. Світ ніби втрачає кольори й сенс, а найпростіші справи потребують зусиль, наче йдеш під водою. І це не вибір людини — це з нею відбувається.' },
              { type: 'h', text: 'Звідки взялося саме поняття' },
              { type: 'p', text: 'Цей стан людство описує тисячоліттями. Ще близько 400 року до н. е. давньогрецький лікар Гіппократ назвав його «меланхолією» — буквально «чорна жовч» (грец. melas — чорний, kholé — жовч). Тоді вважали, що тілом керують чотири рідини («гумори»), і нібито надлишок чорної жовчі занурює людину в тугу. Теорія виявилася хибною, але назва й точні спостереження прожили понад дві тисячі років.' },
              { type: 'p', text: 'Сучасне слово «депресія» походить від латинського deprimere — «придавлювати, тиснути донизу»; воно влучно передає відчуття. На зламі 19–20 століть психіатр Еміль Крепелін упорядкував розлади настрою в систему, відділивши їх від інших станів. А сьогодні депресію розуміють не як «забагато чорної жовчі» й не як одну-єдину поломку, а як сплетіння біологічного, психологічного й соціального — до цього ще повернемось.' },
              { type: 'h', text: 'Як це виглядає зсередини' },
              { type: 'p', text: 'У депресії змінюється майже все потроху. Настрій — пригнічений, порожній, інколи дратівливий. Зникає задоволення від того, що раніше тішило (це називають ангедонією — від грецького «без насолоди»): улюблена музика, їжа, спілкування більше не «вмикають». Озивається й тіло: сон і апетит то зникають, то стають надмірними, а сил немає навіть на дрібниці. Думки робляться важкими й самокритичними — «я нікчема», «я тягар для всіх». А інколи з’являються думки, що життя не варте; їх не бояться обговорювати, а перевіряють прямо й спокійно (про це — у третьому модулі).' },
              { type: 'p', text: 'Щоб говорити про депресію саме як про розлад (а не просто важкий тиждень), у клініці орієнтуються на тривалість і охоплення: знижений настрій та/або втрата інтересу тримаються щонайменше два тижні, більшість дня, майже щодня, і помітно заважають жити. На це спираються сучасні класифікації — DSM-5-TR і МКХ-11.' },
              { type: 'h', text: 'Чим це відрізняється від смутку' },
              { type: 'p', text: 'Смуток — нормальна й навіть корисна реакція на втрату чи невдачу: він приходить хвилями, лишає просвітки й поступово минає. Депресія інша: вона стійка й рівна, накриває майже весь день і забирає інтерес майже до всього, а не лише до причини суму. Тобто річ не в тім, що людина «забагато сумує», а в тривалості, всеохопності та ціні, яку це бере з її життя.' },
              { type: 'h', text: 'Що ж насправді «не так»' },
              { type: 'figure', figure: 'biopsychosocial', caption: 'Депресія постає зі сплетіння біологічного, психологічного й соціального — тому й допомога працює на кількох рівнях.' },
              { type: 'p', text: 'Можливо, ти чув, що «депресія — це просто нестача серотоніну», «хімічний дисбаланс у мозку». Це зручне, але надто спрощене пояснення: великий огляд доказів (Moncrieff та ін., 2022) не знайшов підтвердження, що депресію спричиняє саме низький серотонін. Ближче до правди — взаємодія багатьох чинників: біологія (гени, хронічний стрес, сон), психологія (звички мислення, самокритика) і соціальне (втрати, самотність, обставини життя). Саме тому й немає однієї «чарівної таблетки від поломки» — натомість є кілька дієвих шляхів, що працюють на різних рівнях.' },
              { type: 'h', text: 'Чому не можна «просто взяти себе в руки»' },
              { type: 'p', text: 'Бо депресія знижує саму здатність докладати зусиль: мозкові системи мотивації й винагороди працюють приглушено. Порада «старайся» — це майже як сказати людині зі зламаною ногою «просто йди». Тому перший крок допомоги — не підганяти, а зняти провину й пояснити: це стан, а не вирок характеру.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Я просто лінивий. Усі якось справляються, а я ні.' },
                { who: 'Терапевт', text: 'Те, що ви описуєте, — не лінь. Лінь — це коли можеш, але не хочеш. А у вас зникла сама здатність хотіти й мати сили. Це ознака депресії, і з цим можна працювати.' },
              ] },
              { type: 'h', text: 'Як депресію лікують' },
              { type: 'p', text: 'Хороша новина: депресія — один із найкраще досліджених станів, і вона лікується. Є два головні доказові шляхи. Перший — психотерапія, тобто «лікування розмовою»: наприклад, поведінкова активація (вчитися потроху повертати в життя дії, що дають сенс і задоволення) і когнітивно-поведінкова терапія (вчитися помічати й перевіряти думки-пастки). Саме цьому й присвячений наш курс.' },
              { type: 'p', text: 'Другий шлях — медикаменти (антидепресанти), які призначає лікар; вони допомагають, особливо при помірній і тяжкій депресії (Cipriani та ін., 2018). Дослідження показують, що психотерапія й ліки в короткій перспективі допомагають приблизно однаково, а психотерапія дає стійкіший ефект у часі (Cuijpers та ін., 2023); нерідко їх поєднують. Вибір залежить від тяжкості стану й бажання людини (настанови NICE, 2022). Терапевт ліків не призначає, але має знати, коли направити до лікаря.' },
              { type: 'quote', text: 'Депресія бреше людині, що вона лінива й безнадійна. Наша робота — не сперечатися з нею словами, а показати інше: і поясненням, і досвідом.' },
              { type: 'sources', sources: [
                { label: 'Cuijpers та ін. (2023). Психотерапія при депресії: метааналіз 409 досліджень (52 702 пацієнти). World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
                { label: 'NICE (2022). Depression in adults: treatment and management (NG222) — сучасні настанови щодо лікування.', url: 'https://www.nice.org.uk/guidance/ng222' },
                { label: 'Moncrieff та ін. (2022). Серотонінова теорія депресії: парасолькова рев’ю — «хімічний дисбаланс» не підтверджено. Molecular Psychiatry.', url: 'https://www.nature.com/articles/s41380-022-01661-0' },
                { label: 'Cipriani та ін. (2018). Порівняння 21 антидепресанту: мережевий метааналіз. Lancet.', url: 'https://pubmed.ncbi.nlm.nih.gov/30264698/' },
                { label: 'American Psychiatric Association (2022). DSM-5-TR — критерії великого депресивного розладу.', url: 'https://www.psychiatry.org/psychiatrists/practice/dsm' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: "Imagine: someone close says to Maksym, \"just pull yourself together.\" He berates himself too — but he cannot get out of bed, and that only makes it worse. If you have never met depression, from the outside it really does look like laziness or weakness. This lesson is to see what is actually happening: where the very concept came from, what is going on with the person and why, and how they are helped." },
              { type: 'p', text: "Let's start simply. Depression is not a \"bad mood\" and not ordinary sadness. It is a state in which three things fade at once, for a long time: energy, interest and the capacity for joy. The world seems to lose its colour and meaning, and the simplest tasks take effort, like walking underwater. And it is not the person's choice — it is happening to them." },
              { type: 'h', text: 'Where the concept came from' },
              { type: 'p', text: 'Humanity has described this state for millennia. As early as around 400 BCE the ancient Greek physician Hippocrates called it "melancholia" — literally "black bile" (Greek melas, black; kholé, bile). The belief then was that the body is governed by four fluids ("humours"), and that an excess of black bile sinks a person into gloom. The theory turned out to be wrong, but the name and the sharp observations have lived on for over two thousand years.' },
              { type: 'p', text: 'The modern word "depression" comes from the Latin deprimere — "to press down"; it captures the feeling well. At the turn of the 19th–20th centuries the psychiatrist Emil Kraepelin organised mood disorders into a system, separating them from other conditions. And today depression is understood not as "too much black bile" and not as one single fault, but as a weave of the biological, psychological and social — we will come back to this.' },
              { type: 'h', text: 'What it looks like from the inside' },
              { type: 'p', text: 'In depression almost everything shifts a little. Mood is low, empty, sometimes irritable. Pleasure drains from what used to please (this is called anhedonia — from the Greek for "without pleasure"): favourite music, food, company no longer "switch on". The body speaks up too: sleep and appetite either vanish or become excessive, and there is no energy even for trifles. Thoughts turn heavy and self-critical — "I\'m worthless", "I\'m a burden to everyone". And sometimes thoughts appear that life is not worth it; these are not feared or avoided but screened directly and calmly (more on this in module 3).' },
              { type: 'p', text: 'To speak of depression as a disorder (rather than just a hard week), clinics look at duration and breadth: low mood and/or loss of interest persist for at least two weeks, most of the day, nearly every day, and clearly get in the way of living. The modern classifications — DSM-5-TR and ICD-11 — rest on this.' },
              { type: 'h', text: 'How it differs from sadness' },
              { type: 'p', text: 'Sadness is a normal, even useful reaction to loss or failure: it comes in waves, leaves clear spells, and gradually passes. Depression is different: it is sustained and flat, covers almost the whole day and drains interest in almost everything, not just the cause of the sadness. So the point is not that a person "is sad too much", but the duration, the pervasiveness, and the price it takes from their life.' },
              { type: 'h', text: 'So what is actually "wrong"' },
              { type: 'figure', figure: 'biopsychosocial', caption: 'Depression arises from a weave of the biological, psychological and social — which is why help works on several levels.' },
              { type: 'p', text: 'You may have heard that "depression is just a lack of serotonin", a "chemical imbalance in the brain". This is a convenient but oversimplified explanation: a large review of the evidence (Moncrieff et al., 2022) found no support for low serotonin actually causing depression. Closer to the truth is an interplay of many factors: biology (genes, chronic stress, sleep), psychology (thinking habits, self-criticism) and the social (losses, loneliness, life circumstances). That is exactly why there is no single "magic pill for a fault" — instead there are several effective routes that work at different levels.' },
              { type: 'h', text: 'Why you cannot "just pull yourself together"' },
              { type: 'p', text: 'Because depression lowers the very capacity to exert effort: the brain\'s motivation and reward systems run muted. The advice "try harder" is almost like telling someone with a broken leg to "just walk". So the first step of help is not to push, but to lift the guilt and explain: this is a state, not a verdict on one\'s character.' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "I'm just lazy. Everyone else copes, and I can't." },
                { who: 'Therapist', text: 'What you describe is not laziness. Laziness is when you can but won\'t. In you, the very capacity to want and to have energy has gone. That is a sign of depression — and it can be worked with.' },
              ] },
              { type: 'h', text: 'How depression is treated' },
              { type: 'p', text: 'The good news: depression is one of the best-studied conditions, and it is treatable. There are two main evidence-based routes. The first is psychotherapy — "treatment by talking": for example, behavioural activation (gradually learning to bring back actions that give meaning and pleasure) and cognitive behavioural therapy (learning to notice and test thinking traps). This is exactly what our course is about.' },
              { type: 'p', text: "The second route is medication (antidepressants), prescribed by a doctor; they help, especially in moderate and severe depression (Cipriani et al., 2018). Research shows that psychotherapy and medication help roughly equally in the short term, while psychotherapy gives a more durable effect over time (Cuijpers et al., 2023); the two are often combined. The choice depends on the severity and the person's wishes (NICE guidance, 2022). A therapist does not prescribe medication but must know when to refer to a doctor." },
              { type: 'quote', text: 'Depression lies to a person that they are lazy and hopeless. Our job is not to argue with it in words but to show otherwise — through explanation and through experience.' },
              { type: 'sources', sources: [
                { label: 'Cuijpers et al. (2023). Psychotherapy for depression: meta-analysis of 409 trials (52,702 patients). World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
                { label: 'NICE (2022). Depression in adults: treatment and management (NG222) — current treatment guidance.', url: 'https://www.nice.org.uk/guidance/ng222' },
                { label: 'Moncrieff et al. (2022). The serotonin theory of depression: an umbrella review — the "chemical imbalance" is not supported. Molecular Psychiatry.', url: 'https://www.nature.com/articles/s41380-022-01661-0' },
                { label: 'Cipriani et al. (2018). Comparison of 21 antidepressants: a network meta-analysis. Lancet.', url: 'https://pubmed.ncbi.nlm.nih.gov/30264698/' },
                { label: 'American Psychiatric Association (2022). DSM-5-TR — criteria for major depressive disorder.', url: 'https://www.psychiatry.org/psychiatrists/practice/dsm' },
              ] },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Низхідна спіраль: як депресія себе тримає',
            titleEn: 'The downward spiral: how depression sustains itself',
            bodyUk: [
              { type: 'p', text: 'Максим лежить у ліжку до обіду. Сил немає, тож він скасовує зустріч із другом, не йде на пробіжку, відкладає роботу. Здавалося б, логічно — відпочити, поки не відпустить. Але дивна річ: що більше він «бережеться», то гірше стає. У цьому й парадокс депресії: вона тримається не лише «в голові», а через коло поведінки, яке здається розумним, а насправді затягує глибше.' },
              { type: 'h', text: 'Звідки психологи знають, як це влаштовано' },
              { type: 'p', text: 'Ще в 1970-х Чарльз Ферстер і Пітер Левінсон помітили просту, але важливу річ: депресія підживлюється тим, що з життя людини зникають «винагороди» — моменти задоволення, сенсу, визнання, тепла. Менше робиш — менше отримуєш у відповідь хорошого — і мозок робить висновок «намагатися марно». Так народилася поведінкова модель депресії, на якій згодом виросла ціла дієва терапія (про неї — наступний модуль).' },
              { type: 'h', text: 'Як працює низхідна спіраль' },
              { type: 'figure', figure: 'depression-cycle' },
              { type: 'p', text: 'Подивися на коло на малюнку. Усе починається зі зниженого настрою й втоми: «немає сенсу, немає сил». Людина відмовляється від справ, зустрічей, звичної рутини — відступає. Через це в житті стає ще менше приємного й менше відчуття «я впорався». А отже, настрій падає ще нижче — і коло замикається, з кожним обертом тугіше. Найпідступніше те, що кожен окремий крок здається розумним: «сьогодні точно не до того».' },
              { type: 'h', text: 'Пастка «спершу захочу — потім зроблю»' },
              { type: 'p', text: 'У звичайному стані мотивація часто йде попереду дії: захотів — зробив. Депресія ламає саме цю послідовність. Чекати, доки «захочеться», — означає чекати майже вічно, бо депресія приглушує саму здатність хотіти. Тому ключ не в тому, щоб «накрутити» бажання, а в тому, щоб почати з крихітної дії — і дати мотивації наздогнати. Звучить парадоксально, але саме так і відновлюється рух.' },
              { type: 'h', text: 'Чому «думати про проблему» не рятує' },
              { type: 'p', text: 'Коли активності мало, її місце займає румінація — нескінченне пережовування думок «чому я такий?», «що зі мною не так?». Зсередини це відчувається як «я розбираюся в собі», корисна робота. Але дослідження Сьюзен Нолен-Гуксеми показали протилежне: таке абстрактне самокопання не веде до рішень, а лише поглиблює настрій і передбачає гірший стан згодом. Тобто це не вихід зі спіралі, а ще один її виток.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Я просто чекаю, доки повернуться сили, і тоді знову почну жити.' },
                { who: 'Терапевт', text: 'Дуже зрозуміле бажання. От тільки депресія влаштована так, що сили частіше повертаються ПІСЛЯ маленьких дій, а не до них. Спробуємо перевірити це разом — на чомусь зовсім невеликому?' },
              ] },
              { type: 'p', text: 'І ось чому це дає надію: коло крутиться в обидва боки. Якщо вихід кожної дії з життя тягне настрій униз, то повернення навіть дрібних дій здатне розкрутити спіраль угору. Саме на цьому будується поведінкова активація, до якої ми перейдемо в наступному модулі.' },
              { type: 'quote', text: 'Депресія каже: «зачекай, поки стане легше, тоді почнеш». Насправді легше стає тому, хто починає потроху раніше.' },
              { type: 'sources', sources: [
                { label: 'Ferster (1973). A functional analysis of depression — поведінкова модель депресії (першоджерело). American Psychologist.', url: 'https://doi.org/10.1037/h0035605' },
                { label: 'Nolen-Hoeksema та ін. (2008). Rethinking Rumination — румінація поглиблює й передбачає депресію. Perspectives on Psychological Science.', url: 'https://pubmed.ncbi.nlm.nih.gov/26158958/' },
                { label: 'Ekers та ін. (2014). Поведінкова активація при депресії: оновлений метааналіз. PLoS ONE.', url: 'https://pubmed.ncbi.nlm.nih.gov/24936656/' },
                { label: 'Cuijpers та ін. (2023). Психотерапія при депресії: метааналіз. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'Maksym lies in bed until noon. He has no energy, so he cancels meeting a friend, skips the run, puts off work. It seems logical — rest until it lifts. But here is the strange thing: the more he "spares himself", the worse it gets. This is the paradox of depression: it holds on not only "in the head" but through a loop of behaviour that feels reasonable yet drags you deeper.' },
              { type: 'h', text: 'How psychologists know how this works' },
              { type: 'p', text: 'Back in the 1970s Charles Ferster and Peter Lewinsohn noticed something simple but important: depression is fed by "rewards" draining out of a person\'s life — moments of pleasure, meaning, recognition, warmth. You do less → you get less good in return → the brain concludes "there is no point trying". This is the behavioural model of depression, and a whole effective therapy later grew from it (next module).' },
              { type: 'h', text: 'How the downward spiral works' },
              { type: 'figure', figure: 'depression-cycle' },
              { type: 'p', text: 'Look at the circle in the figure. It starts with low mood and fatigue: "no point, no energy". The person drops tasks, meetings, the usual routine — they withdraw. Because of this there is even less that is pleasant and less of the "I managed" feeling. So mood falls further — and the circle closes, tighter with each turn. The most insidious part is that each single step feels reasonable: "today is really not the day".' },
              { type: 'h', text: 'The "want it first, then do it" trap' },
              { type: 'p', text: 'When you are well, motivation often runs ahead of action: you feel like it, you do it. Depression breaks exactly that order. Waiting until you "feel like it" means waiting almost forever, because depression mutes the very capacity to want. So the key is not to "pump up" the wanting but to start with a tiny action — and let motivation catch up. It sounds paradoxical, but that is how movement returns.' },
              { type: 'h', text: 'Why "thinking about the problem" does not rescue' },
              { type: 'p', text: 'When activity is scarce, rumination takes its place — endless chewing over "why am I like this?", "what is wrong with me?". From the inside it feels like "figuring myself out", useful work. But Susan Nolen-Hoeksema\'s research showed the opposite: this abstract self-digging leads to no solutions and only deepens mood and predicts a worse state later. It is not a way out of the spiral — it is another turn of it.' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "I'm just waiting for my energy to come back, and then I'll start living again." },
                { who: 'Therapist', text: 'A very understandable wish. The catch is that depression is built so that energy more often returns AFTER small actions, not before them. Shall we test that together — on something really small?' },
              ] },
              { type: 'p', text: 'And here is the hope: the circle turns both ways. If each activity leaving the life pulls mood down, then bringing even small actions back can wind the spiral upward. This is exactly what behavioural activation is built on — we turn to it in the next module.' },
              { type: 'quote', text: 'Depression says: "wait until it gets easier, then start". In fact it gets easier for the one who starts, a little, sooner.' },
              { type: 'sources', sources: [
                { label: 'Ferster (1973). A functional analysis of depression — the behavioural model of depression (original source). American Psychologist.', url: 'https://doi.org/10.1037/h0035605' },
                { label: 'Nolen-Hoeksema et al. (2008). Rethinking Rumination — rumination deepens and predicts depression. Perspectives on Psychological Science.', url: 'https://pubmed.ncbi.nlm.nih.gov/26158958/' },
                { label: 'Ekers et al. (2014). Behavioural activation for depression: updated meta-analysis. PLoS ONE.', url: 'https://pubmed.ncbi.nlm.nih.gov/24936656/' },
                { label: 'Cuijpers et al. (2023). Psychotherapy for depression: meta-analysis. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
          },
          {
            kind: 'quiz',
            titleUk: 'Перевірка: природа депресії',
            titleEn: 'Check: the nature of depression',
            quizUk: [
              {
                q: 'Що найкраще відрізняє депресію від звичайного смутку?',
                options: ['Інтенсивність переживання', 'Стійкість (≥2 тижнів), охоплення більшості дня, втрата інтересу й вплив на функціонування', 'Наявність причини', 'Сльози'],
                correct: 1,
                explain: 'Депресія — це тривалість, охоплення й порушення функціонування, а не просто сильний смуток.',
              },
              {
                q: 'Чому порада «просто старайся» при депресії не працює?',
                options: ['Бо клієнт не хоче', 'Бо депресія знижує саму здатність докладати зусиль і мотивацію', 'Бо це образливо', 'Бо потрібні лише ліки'],
                correct: 1,
                explain: 'Мотивація й винагорода приглушені — тому починаємо з дії, а не з заклику «старатися».',
              },
            ],
            quizEn: [
              {
                q: 'What best distinguishes depression from ordinary sadness?',
                options: ['How intense it feels', 'Persistence (≥2 weeks), pervading most of the day, loss of interest and impaired functioning', 'Having a cause', 'Crying'],
                correct: 1,
                explain: 'Depression is about duration, breadth and impaired functioning, not just strong sadness.',
              },
              {
                q: 'Why does "just try harder" fail in depression?',
                options: ["Because the client doesn't want to", 'Because depression lowers the very capacity for effort and motivation', 'Because it is offensive', 'Because only medication works'],
                correct: 1,
                explain: 'Motivation and reward are muted — so we start with action, not an exhortation to "try".',
              },
            ],
          },
          {
            kind: 'practice',
            titleUk: 'Практика: психоедукація депресії',
            titleEn: 'Practice: depression psychoeducation',
            characterRef: 'Анна',
            techniqueKey: 'psychoeducation',
            bodyUk: [
              { type: 'p', text: 'Завдання: з Анною, яка винить себе за «лінь», поясни депресію як стан, а не ваду характеру: познач ознаки, зніми провину, дай надію (це лікується). Заверши сесію й отримай фідбек.' },
            ],
            bodyEn: [
              { type: 'p', text: 'Task: with Anna, who blames herself for "laziness", explain depression as a state, not a character flaw: name the features, lift the guilt, offer hope (it is treatable). End the session and get feedback.' },
            ],
          },
        ],
      },
      {
        titleUk: 'Поведінкова активація',
        titleEn: 'Behavioural activation',
        objectivesUk: [
          'Пояснювати принцип «дія передує мотивації».',
          'Розрізняти дії на задоволення, досягнення й цінності.',
          'Складати з клієнтом перший мікрокрок активації.',
        ],
        objectivesEn: [
          'Explain the "action precedes motivation" principle.',
          'Distinguish pleasure, mastery and values-based activities.',
          'Build a first micro-step of activation with the client.',
        ],
        steps: [
          {
            kind: 'lesson',
            titleUk: 'Поведінкова активація: дія передує мотивації',
            titleEn: 'Behavioural activation: action precedes motivation',
            bodyUk: [
              { type: 'p', text: 'У попередньому уроці ми побачили низхідну спіраль: менше дій → менше радості й сенсу → нижчий настрій. Поведінкова активація (BA) — це спосіб розкрутити те саме коло у зворотний бік. Звучить майже занадто просто, та це одна з найдієвіших стратегій при депресії: велике дослідження COBRA показало, що сама лише BA працює не гірше за повноцінну КПТ — і її можуть проводити навіть менш досвідчені фахівці (Richards та ін., 2016; Ekers та ін., 2014).' },
              { type: 'h', text: 'У чому ідея' },
              { type: 'p', text: 'Суть BA — поступово повертати в життя дії, які дають три речі: задоволення, відчуття досягнення й звʼязок з іншими. Логіка пряма й випливає з поведінкової моделі депресії (Ферстер, Левінсон): якщо депресію живить брак «винагород» у житті, то ліки — не вмовляння, а відновлення цих винагород через дію.' },
              { type: 'h', text: 'Чому діємо ДО того, як захочеться' },
              { type: 'p', text: 'Головний — і найважчий для розуміння — принцип: дія йде першою, мотивація наздоганяє. Маленька дія дає крихту задоволення чи сенсу → настрій і енергія трохи піднімаються → наступний крок дається легше. Це не «змусь себе бути щасливим», а «зроби маленький крок попри настрій — і дай досвіду змінити настрій». Якщо чекати на бажання, у депресії воно не прийде; якщо діяти — поступово повертається й воно.' },
              { type: 'h', text: 'Які дії повертати' },
              { type: 'p', text: 'Разом із клієнтом шукають дії трьох видів. Перший — задоволення: те, що колись тішило (музика, прогулянка, кава з другом). Другий — досягнення, або майстерність: дрібні справи, після яких є відчуття «я впорався» (помити чашку, відповісти на лист). Третій — цінності й звʼязок: те, що важливо саме для цієї людини (побути з дитиною, рух, віра, спільнота). На старті важливіше не «велике», а «здійсненне».' },
              { type: 'h', text: 'Як почати, не перевантаживши' },
              { type: 'p', text: 'Спершу варто разом помітити звʼязок «що я роблю ↔ як почуваюся» — у цьому допомагає простий щоденник дня. Далі обирають мікрокрок: не «бігати щодня», а «взути кросівки й вийти на пʼять хвилин». Його планують на конкретний час, а не «коли захочеться». І домовляються заздалегідь: настрій підтягнеться згодом, тож не треба вимагати від себе радості одразу — достатньо зробити крок.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Який сенс кудись іти, якщо мені все одно нічого не приносить радості?' },
                { who: 'Терапевт', text: 'Зараз справді не приносить — це сама депресія приглушила радість. Тому ми не чекаємо на радість, а робимо маленький крок як експеримент: подивимось, що з настроєм через годину після короткої прогулянки. Згодні спробувати один раз?' },
              ] },
              { type: 'p', text: 'І кілька типових помилок. Найчастіша — замахнутися надто високо одразу: великий план провалюється й підкріплює «у мене нічого не виходить». Друга — чекати мотивації перед дією (у депресії вона приходить після). Третя — знецінювати дрібні кроки; але саме вони, накопичуючись, і розкручують спіраль угору.' },
              { type: 'quote', text: 'Не «спершу захотіти, потім зробити», а «зробити маленьке — і дати настрою наздогнати».' },
              { type: 'sources', sources: [
                { label: 'Richards та ін. (2016). COBRA: поведінкова активація не поступається КПТ і дешевша. Lancet.', url: 'https://pubmed.ncbi.nlm.nih.gov/27461440/' },
                { label: 'Ekers та ін. (2014). Поведінкова активація при депресії: оновлений метааналіз. PLoS ONE.', url: 'https://pubmed.ncbi.nlm.nih.gov/24936656/' },
                { label: 'Ferster (1973). A functional analysis of depression — поведінкова модель (першоджерело). American Psychologist.', url: 'https://doi.org/10.1037/h0035605' },
                { label: 'Cuijpers та ін. (2023). Психотерапія при депресії: метааналіз. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'In the previous lesson we saw the downward spiral: less activity → less joy and meaning → lower mood. Behavioural activation (BA) is a way to wind that same circle in reverse. It sounds almost too simple, yet it is one of the most effective strategies for depression: the large COBRA trial showed BA alone works no worse than full CBT — and can be delivered by less experienced staff (Richards et al., 2016; Ekers et al., 2014).' },
              { type: 'h', text: 'The idea' },
              { type: 'p', text: 'The essence of BA is to gradually bring back into life actions that give three things: pleasure, a sense of achievement, and connection with others. The logic is direct and follows from the behavioural model of depression (Ferster, Lewinsohn): if depression is fed by a lack of "rewards" in life, then the remedy is not persuasion but restoring those rewards through action.' },
              { type: 'h', text: 'Why we act BEFORE we feel like it' },
              { type: 'p', text: 'The main — and hardest to grasp — principle: action comes first, motivation catches up. A small action gives a crumb of pleasure or meaning → mood and energy rise a little → the next step is easier. It is not "force yourself to be happy" but "take a small step despite your mood — and let experience change the mood". If you wait for the wanting, in depression it will not come; if you act, it gradually returns too.' },
              { type: 'h', text: 'Which actions to bring back' },
              { type: 'p', text: 'Together with the client you look for actions of three kinds. First, pleasure: what once pleased (music, a walk, coffee with a friend). Second, achievement, or mastery: small tasks that leave an "I managed" feeling (wash a cup, answer an email). Third, values and connection: what matters to this particular person (time with a child, movement, faith, community). At the start "doable" matters more than "big".' },
              { type: 'h', text: 'How to start without overload' },
              { type: 'p', text: 'First it helps to notice, together, the link "what I do ↔ how I feel" — a simple day diary is enough. Then you pick a micro-step: not "run every day" but "put on trainers and step out for five minutes". You schedule it for a concrete time, not "when I feel like it". And you agree in advance: mood will catch up later, so there is no need to demand joy right away — taking the step is enough.' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "What's the point of going anywhere if nothing brings me joy anyway?" },
                { who: 'Therapist', text: "Right now it really doesn't — depression itself has muted the joy. So we don't wait for joy; we take a small step as an experiment: let's see what happens to your mood an hour after a short walk. Willing to try it once?" },
              ] },
              { type: 'p', text: 'And a few common mistakes. The most frequent is aiming too high at once: a big plan fails and reinforces "I can\'t do anything". The second is waiting for motivation before acting (in depression it comes after). The third is dismissing small steps; yet it is exactly those, accumulating, that wind the spiral upward.' },
              { type: 'quote', text: 'Not "want first, then do", but "do something small — and let the mood catch up".' },
              { type: 'sources', sources: [
                { label: 'Richards et al. (2016). COBRA: behavioural activation non-inferior to CBT and cheaper. Lancet.', url: 'https://pubmed.ncbi.nlm.nih.gov/27461440/' },
                { label: 'Ekers et al. (2014). Behavioural activation for depression: updated meta-analysis. PLoS ONE.', url: 'https://pubmed.ncbi.nlm.nih.gov/24936656/' },
                { label: 'Ferster (1973). A functional analysis of depression — the behavioural model (original source). American Psychologist.', url: 'https://doi.org/10.1037/h0035605' },
                { label: 'Cuijpers et al. (2023). Psychotherapy for depression: meta-analysis. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
          },
          {
            kind: 'quiz',
            titleUk: 'Перевірка: активація',
            titleEn: 'Check: activation',
            quizUk: [
              {
                q: 'Який головний принцип поведінкової активації?',
                options: ['Дочекатися мотивації, тоді діяти', 'Дія передує мотивації: маленький крок попри настрій', 'Робити лише те, що приємно', 'Заповнити день під зав’язку'],
                correct: 1,
                explain: 'У депресії мотивація приходить після дії, тому починаємо з маленького кроку.',
              },
              {
                q: 'З чого найкраще почати активацію?',
                options: ['З великої амбітної мети', 'З мікрокроку, запланованого за часом', 'Коли клієнт відчує бажання', 'З найважчої справи, щоб «пробити стелю»'],
                correct: 1,
                explain: 'Мікрокрок здійсненний навіть на нулі енергії й дає перший доказ, що рух можливий.',
              },
            ],
            quizEn: [
              {
                q: 'What is the core principle of behavioural activation?',
                options: ['Wait for motivation, then act', 'Action precedes motivation: a small step despite the mood', 'Only do what feels pleasant', 'Fill the day to the brim'],
                correct: 1,
                explain: 'In depression motivation comes after action, so we start with a small step.',
              },
              {
                q: 'How is it best to start activation?',
                options: ['With a big ambitious goal', 'With a micro-step scheduled by time', 'When the client feels the urge', 'With the hardest task to "break the ceiling"'],
                correct: 1,
                explain: 'A micro-step is doable even at zero energy and gives the first proof that movement is possible.',
              },
            ],
          },
          {
            kind: 'practice',
            titleUk: 'Практика: план активації',
            titleEn: 'Practice: an activation plan',
            characterRef: 'Максим',
            techniqueKey: 'behavioral_activation',
            bodyUk: [
              { type: 'p', text: 'Завдання: з Максимом, який «чекає сил», складіть один конкретний мікрокрок активації на найближчі дні (задоволення, досягнення чи цінність), запланований за часом. Поясни принцип «дія передує мотивації». Заверши сесію й отримай фідбек.' },
            ],
            bodyEn: [
              { type: 'p', text: 'Task: with Maksym, who is "waiting for energy", build one concrete activation micro-step for the next few days (pleasure, achievement or value), scheduled by time. Explain the "action precedes motivation" principle. End the session and get feedback.' },
            ],
          },
        ],
      },
      {
        titleUk: 'Думки, ризик і профілактика рецидиву',
        titleEn: 'Thoughts, risk and relapse prevention',
        objectivesUk: [
          'Розпізнавати когнітивну тріаду й працювати з думкою як гіпотезою.',
          'Прямо й спокійно перевіряти суїцидальний ризик при депресії.',
          'Складати простий план профілактики рецидиву.',
        ],
        objectivesEn: [
          'Recognise the cognitive triad and treat a thought as a hypothesis.',
          'Screen suicide risk in depression directly and calmly.',
          'Build a simple relapse-prevention plan.',
        ],
        steps: [
          {
            kind: 'lesson',
            titleUk: 'Робота з думками при депресії',
            titleEn: 'Working with thoughts in depression',
            bodyUk: [
              { type: 'p', text: 'Депресія не лише забирає сили — вона змінює саме мислення, ніби вдягає на людину темні окуляри. Ті самі факти вона забарвлює в найгірший колір: успіх — «випадковість», нейтральне — «погано», майбутнє — «безнадія». Психіатр Аарон Бек, спостерігаючи це в 1960-х, помітив закономірність і назвав її когнітивною тріадою.' },
              { type: 'h', text: 'Когнітивна тріада' },
              { type: 'figure', figure: 'cognitive-triad' },
              { type: 'p', text: 'Тріада — це три напрями негативного погляду, які депресія підтримує одночасно: на СЕБЕ («я нікчема, зі мною щось не так»), на СВІТ і свій досвід («усе погано, я нікому не потрібен») і на МАЙБУТНЄ («нічого не зміниться»). Три вершини живлять одна одну: безнадійне майбутнє знесилює, знесилення «підтверджує» власну нікчемність, а та забарвлює весь світ. Найважливіше, що варто пояснити клієнту: ці думки відчуваються як беззаперечна правда, хоча насправді вони — симптом депресії, а не факт про людину.' },
              { type: 'h', text: 'Чому не варто сперечатися' },
              { type: 'p', text: 'Перший порив новачка — переконати: «ну що ви, ви ж насправді молодець». Це майже не працює: депресивний мозок миттєво відбиває оптимізм («ви просто маєте так казати»). Тому замість суперечки ми разом дивимося на думку як на гіпотезу — припущення, яке можна перевірити фактами, а не вирок, який треба прийняти.' },
              { type: 'p', text: 'Перевірка виглядає як спокійні, цікаві запитання. Яка конкретно думка зараз найважча? Які факти за неї, а які — проти? Це факт — чи відчуття, що видається фактом? Що б я сказав другові, якби він так думав про себе? І нарешті — який маленький крок у житті перевірив би цю думку? Мета не «виграти» суперечку, а разом звузити велике чорне узагальнення («я невдаха») до чогось конкретного й перевірюваного.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Я нічого не довів до кінця. Я просто невдаха.' },
                { who: 'Терапевт', text: '«Невдаха» — це велике слово про всю людину. Можемо звузити: цього тижня були речі, навіть дрібні, які ви все-таки зробили? Подивимось на факти разом.' },
              ] },
              { type: 'h', text: 'Думки й дії — разом' },
              { type: 'p', text: 'І ще важливе: найсильніше депресивні переконання спростовує не розмова, а досвід. Тому роботу з думками майже завжди поєднують із поведінковою активацією з попереднього модуля: клієнт перевіряє думку «у мене все одно нічого не вийде», зробивши маленький крок, — і отримує контрдоказ не з вуст терапевта, а з власного життя. Слова й дії працюють у парі.' },
              { type: 'quote', text: 'Депресивна думка — це не вирок, а симптом. Її не виграють у суперечці — її перевіряють.' },
              { type: 'sources', sources: [
                { label: 'Beck та ін. (1979). Cognitive Therapy of Depression — когнітивна тріада (першоджерело).', url: 'https://www.guilford.com/books/Cognitive-Therapy-of-Depression/Beck-Rush-Shaw-Emery/9780898629194' },
                { label: 'Beck J. (2021). Cognitive Behavior Therapy: Basics and Beyond, 3-тє вид. — сучасна КПТ-робота з думками.', url: 'https://www.guilford.com/books/Cognitive-Behavior-Therapy/Judith-Beck/9781462544196' },
                { label: 'Cuijpers та ін. (2023). КПТ при депресії: метааналіз 409 досліджень. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'Depression does not only drain energy — it changes thinking itself, as if putting dark glasses on the person. It paints the same facts in the worst colour: success is "luck", neutral is "bad", the future is "hopeless". Watching this in the 1960s, the psychiatrist Aaron Beck spotted a pattern and called it the cognitive triad.' },
              { type: 'h', text: 'The cognitive triad' },
              { type: 'figure', figure: 'cognitive-triad' },
              { type: 'p', text: 'The triad is three directions of a negative view that depression holds at once: of the SELF ("I\'m worthless, something is wrong with me"), of the WORLD and one\'s experience ("everything is bad, nobody needs me") and of the FUTURE ("nothing will change"). The three vertices feed one another: a hopeless future saps energy, low energy "confirms" worthlessness, and that colours the whole world. The most important thing to explain to the client: these thoughts feel like undeniable truth, yet they are a symptom of depression, not a fact about the person.' },
              { type: 'h', text: 'Why not to argue' },
              { type: 'p', text: 'The beginner\'s first urge is to convince: "come on, you\'re actually doing well". This barely works: a depressed brain instantly bats away the optimism ("you just have to say that"). So instead of arguing, we look at the thought together as a hypothesis — an assumption that can be tested against facts, not a verdict to be accepted.' },
              { type: 'p', text: 'Testing looks like calm, curious questions. What exactly is the hardest thought right now? What facts are for it, and which are against? Is it a fact — or a feeling that seems like a fact? What would I say to a friend who thought this of themselves? And finally — what small step in real life would test this thought? The goal is not to "win" the argument but to narrow a big black generalisation ("I\'m a failure") down to something concrete and testable.' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "I haven't finished anything. I'm just a failure." },
                { who: 'Therapist', text: '"Failure" is a big word about a whole person. Can we narrow it down: were there things this week, even small ones, that you did do? Let\'s look at the facts together.' },
              ] },
              { type: 'h', text: 'Thoughts and actions — together' },
              { type: 'p', text: 'And one more important point: what refutes depressive beliefs most is not conversation but experience. So work with thoughts is almost always paired with behavioural activation from the previous module: the client tests "nothing will work out for me anyway" by taking a small step — and gets counter-evidence not from the therapist\'s mouth but from their own life. Words and actions work in a pair.' },
              { type: 'quote', text: 'A depressive thought is not a verdict but a symptom. You don\'t win it in an argument — you test it.' },
              { type: 'sources', sources: [
                { label: 'Beck et al. (1979). Cognitive Therapy of Depression — the cognitive triad (original source).', url: 'https://www.guilford.com/books/Cognitive-Therapy-of-Depression/Beck-Rush-Shaw-Emery/9780898629194' },
                { label: 'Beck J. (2021). Cognitive Behavior Therapy: Basics and Beyond, 3rd ed. — modern CBT work with thoughts.', url: 'https://www.guilford.com/books/Cognitive-Behavior-Therapy/Judith-Beck/9781462544196' },
                { label: 'Cuijpers et al. (2023). CBT for depression: meta-analysis of 409 trials. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Ризик і профілактика рецидиву',
            titleEn: 'Risk and relapse prevention',
            bodyUk: [
              { type: 'p', text: 'Є дві речі, які при депресії не можна пропустити, і вони дзеркальні: безпека зараз і стійкість потім. «Зараз» — бо депресія підвищує ризик думок про небажання жити, тож цю тему перевіряють прямо й регулярно. «Потім» — бо депресія схильна повертатися, і розумно готуватися до можливих спадів заздалегідь.' },
              { type: 'h', text: 'Чому ризик перевіряють прямо' },
              { type: 'p', text: 'Знижений настрій і безнадія часто йдуть поруч із думками «краще б мене не було». Новачки бояться про це питати — здається, ніби питанням можна «нашкодити» чи «наштовхнути». Це міф (ми розбирали його в курсі про інтейк): пряме, спокійне питання не підштовхує, а навпаки приносить полегшення, бо людина нарешті може сказати вголос те, що носила сама. Тому діємо так само: нормалізуй, запитай прямо, лишайся спокійним і теплим, а за потреби складіть разом план безпеки. Уникати теми небезпечніше, ніж спитати.' },
              { type: 'figure', figure: 'risk-ladder', caption: 'Та сама логіка уточнення, що й у курсі інтейку: думки → план → засоби → намір.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Іноді думаю, що рідним було б спокійніше без мене.' },
                { who: 'Терапевт', text: 'Дякую, що сказали — це важливо. Коли настрій такий низький, такі думки трапляються. Чи бували думки зробити щось, щоб піти з життя?' },
              ] },
              { type: 'h', text: 'Профілактика рецидиву' },
              { type: 'p', text: 'Коли людині стає краще — це не кінець роботи, а добрий момент підготуватися до майбутнього. Разом складають простий план на випадок спаду, у якому три частини. Перша — ранні маркери: індивідуальні сигнали, що спад починається («сон поповз», «почав скасовувати зустрічі»). Друга — робочі інструменти: те, що вже допомагало раніше (активація, певні люди, навички). Третя — план дій: що конкретно зробити й кому подзвонити на перші ознаки. Сенс у тому, щоб людина впізнала спад раніше, ніж він розгорнеться на повну.' },
              { type: 'p', text: 'Окрему доказову роль для тих, хто вже мав кілька епізодів, відіграє майндфулнес-орієнтована КПТ (MBCT) — програма, що вчить помічати ранні думки-провісники й не зісковзувати в стару колію. Індивідуальний метааналіз показав, що вона знижує ризик повернення депресії, особливо коли лишаються залишкові симптоми (Kuyken та ін., 2016).' },
              { type: 'quote', text: 'Депресію лікують не лише до полегшення, а й «на виріст» — щоб людина впізнала спад раніше за нього самого.' },
              { type: 'sources', sources: [
                { label: 'Kuyken та ін. (2016). MBCT для профілактики рецидиву депресії: індивідуальний метааналіз. JAMA Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/27119968/' },
                { label: 'NICE (2022). Depression in adults (NG222) — оцінка ризику й профілактика рецидиву.', url: 'https://www.nice.org.uk/guidance/ng222' },
                { label: 'Cuijpers та ін. (2023). Психотерапія при депресії: метааналіз. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'There are two things you must not miss in depression, and they mirror each other: safety now and durability later. "Now" — because depression raises the risk of thoughts of not wanting to live, so this topic is checked directly and regularly. "Later" — because depression tends to return, and it is wise to prepare for possible dips in advance.' },
              { type: 'h', text: 'Why risk is screened directly' },
              { type: 'p', text: 'Low mood and hopelessness often travel with thoughts of "better if I weren\'t here". Beginners are afraid to ask about this — it seems a question might "harm" or "plant the idea". That is a myth (we covered it in the intake course): a direct, calm question does not push — on the contrary it brings relief, because the person can finally say aloud what they carried alone. So we do the same: normalise, ask directly, stay calm and warm, and build a safety plan together if needed. Avoiding the topic is more dangerous than asking.' },
              { type: 'figure', figure: 'risk-ladder', caption: 'The same clarifying logic as in the intake course: thoughts → plan → means → intent.' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'Sometimes I think my family would be calmer without me.' },
                { who: 'Therapist', text: 'Thank you for telling me — that matters. When mood is this low, such thoughts do come up. Have you had thoughts of doing something to end your life?' },
              ] },
              { type: 'h', text: 'Relapse prevention' },
              { type: 'p', text: 'When a person gets better, that is not the end of the work but a good moment to prepare for the future. Together you build a simple plan for a dip, in three parts. First, early markers: individual signals that a dip is starting ("sleep slipping", "starting to cancel meetings"). Second, working tools: what already helped before (activation, certain people, skills). Third, an action plan: what specifically to do and who to call at the first signs. The point is that the person recognises a dip before it unfolds fully.' },
              { type: 'p', text: 'For those who have already had several episodes, mindfulness-based cognitive therapy (MBCT) plays a distinct evidence-based role — a programme that teaches noticing early warning thoughts and not sliding into the old groove. An individual-patient meta-analysis showed it reduces the risk of depression returning, especially when residual symptoms remain (Kuyken et al., 2016).' },
              { type: 'quote', text: 'Depression is treated not only to relief but "for the future" — so the person recognises a dip before it recognises them.' },
              { type: 'sources', sources: [
                { label: 'Kuyken et al. (2016). MBCT for prevention of depressive relapse: individual patient data meta-analysis. JAMA Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/27119968/' },
                { label: 'NICE (2022). Depression in adults (NG222) — risk assessment and relapse prevention.', url: 'https://www.nice.org.uk/guidance/ng222' },
                { label: 'Cuijpers et al. (2023). Psychotherapy for depression: meta-analysis. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
          },
          {
            kind: 'quiz',
            titleUk: 'Перевірка: думки й ризик',
            titleEn: 'Check: thoughts and risk',
            quizUk: [
              {
                q: 'Що таке когнітивна тріада Бека?',
                options: ['Три типи ліків', 'Негативний погляд на себе, світ і майбутнє', 'Три стадії терапії', 'Тіло, думки, поведінка'],
                correct: 1,
                explain: 'Тріада — негативні погляди на СЕБЕ, СВІТ і МАЙБУТНЄ, що живлять одне одного.',
              },
              {
                q: 'Як перевіряти суїцидальний ризик при депресії?',
                options: ['Уникати теми, щоб не нашкодити', 'Прямо, спокійно й нормалізуючи; не уникати', 'Лише якщо клієнт сам згадає', 'Натяками'],
                correct: 1,
                explain: 'Пряме спокійне питання дає полегшення й точність; уникати небезпечніше.',
              },
            ],
            quizEn: [
              {
                q: "What is Beck's cognitive triad?",
                options: ['Three types of medication', 'A negative view of the self, the world and the future', 'Three stages of therapy', 'Body, thoughts, behaviour'],
                correct: 1,
                explain: 'The triad is negative views of the SELF, the WORLD and the FUTURE, feeding one another.',
              },
              {
                q: 'How should you screen suicide risk in depression?',
                options: ['Avoid the topic to do no harm', 'Directly, calmly and normalising; do not avoid it', 'Only if the client raises it', 'Through hints'],
                correct: 1,
                explain: 'A direct, calm question brings relief and clarity; avoiding it is more dangerous.',
              },
            ],
          },
          {
            kind: 'practice',
            titleUk: 'Практика: ризик при депресії',
            titleEn: 'Practice: risk in depression',
            characterRef: 'Олеся',
            techniqueKey: 'risk_screening',
            passSignal: 'riskScreened',
            bodyUk: [
              { type: 'p', text: 'Завдання: з Олесею, у якої знижений настрій і безнадія, помічай натяки й прямо, спокійно перевір суїцидальний ризик (нормалізуй → запитай прямо → уточни). Крок зарахується, коли фідбек покаже сигнал «ризик перевірено».' },
            ],
            bodyEn: [
              { type: 'p', text: 'Task: with Olesya, who has low mood and hopelessness, notice the hints and screen suicide risk directly and calmly (normalise → ask directly → clarify). The step passes when the feedback shows the "risk screened" signal.' },
            ],
          },
        ],
      },
    ],
  },
  {
    key: 'depression-deeper',
    titleUk: 'Депресія: глибша робота',
    titleEn: 'Depression: going deeper',
    descUk:
      'Наступний крок після основ: дістатися глибинних переконань, приборкати румінацію й самокритику та витримати безнадію і клієнта, що відштовхує допомогу. 3 модулі з квізами та практикою.',
    descEn:
      'The next step after the basics: reach core beliefs, tame rumination and self-criticism, and hold hopelessness and the help-rejecting client. 3 modules with quizzes and practice.',
    aboutUk: [
      { type: 'p', text: '«Депресія: глибша робота» — продовження курсу основ. Якщо основи давали перший рух (психоедукація, активація, перевірка думок), цей курс — про глибші й важчі речі, з якими стикаєшся, коли поверхневі техніки вже не дають зрушення.' },
      { type: 'h', text: 'Чого ти навчишся' },
      { type: 'list', items: [
        { text: 'Від автоматичної думки доходити до глибинного переконання технікою «стріла вниз».' },
        { text: 'Поступово змінювати глибинні переконання — досвідом, а не суперечкою.' },
        { text: 'Працювати з румінацією: від «чому я такий» до «що зроблю далі».' },
        { text: 'Помʼякшувати самокритику через самоспівчуття.' },
        { text: 'Витримувати безнадію й контакт із клієнтом, що відштовхує допомогу.' },
      ] },
      { type: 'h', text: 'Як влаштовано курс' },
      { type: 'p', text: '3 модулі: глибинні переконання → румінація й самокритика → безнадія і складний контакт. У кожному — уроки з прикладами, квіз і практика з AI-пацієнтом із фідбеком.' },
      { type: 'p', text: 'Базований на сучасній КПТ (J. Beck), РФ-КПТ (Watkins) і терапії, сфокусованій на співчутті (Gilbert). Рекомендовано після курсу «Депресія: основи». Контент навчальний — не заміна супервізії чи терапії.' },
    ],
    aboutEn: [
      { type: 'p', text: '"Depression: going deeper" continues the foundations course. If the basics got the first movement going (psychoeducation, activation, testing thoughts), this course is about the deeper, harder things you meet when surface techniques stop shifting anything.' },
      { type: 'h', text: 'What you will learn' },
      { type: 'list', items: [
        { text: 'Move from an automatic thought to a core belief with the downward-arrow technique.' },
        { text: 'Change core beliefs gradually — through experience, not argument.' },
        { text: 'Work with rumination: from "why am I like this" to "what will I do next".' },
        { text: 'Soften self-criticism through self-compassion.' },
        { text: 'Hold hopelessness and contact with a help-rejecting client.' },
      ] },
      { type: 'h', text: 'How the course works' },
      { type: 'p', text: '3 modules: core beliefs → rumination and self-criticism → hopelessness and difficult contact. Each has lessons with examples, a quiz, and practice with an AI patient with feedback.' },
      { type: 'p', text: 'Based on modern CBT (J. Beck), rumination-focused CBT (Watkins) and compassion-focused therapy (Gilbert). Recommended after "Depression: foundations". The content is educational — not a substitute for supervision or therapy.' },
    ],
    order: 4,
    published: true,
    modules: [
      {
        titleUk: 'Глибше за думку: переконання',
        titleEn: 'Beneath the thought: beliefs',
        objectivesUk: [
          'Розрізняти автоматичні думки, правила й глибинні переконання.',
          'Застосовувати техніку «стріла вниз», щоб дістатися переконання.',
          'Змінювати переконання поступово, через досвід.',
        ],
        objectivesEn: [
          'Distinguish automatic thoughts, rules and core beliefs.',
          'Use the downward-arrow technique to reach a belief.',
          'Change beliefs gradually, through experience.',
        ],
        steps: [
          {
            kind: 'lesson',
            titleUk: 'Від думок до глибинних переконань',
            titleEn: 'From thoughts to core beliefs',
            bodyUk: [
              { type: 'p', text: 'Ви вже перевіряли з клієнткою думку «я завалю презентацію» — і начебто переконали, що доказів катастрофи мало. Та наступного тижня вона знову прийшла розбита: «Ну от, я ж казала, що зі мною щось не так». Думка про презентацію була лише верхівкою. Під нею — глибше переконання про себе, до якого варто дістатися.' },
              { type: 'h', text: 'Три рівні думок' },
              { type: 'figure', figure: 'belief-levels' },
              { type: 'p', text: 'Сучасна КПТ (J. Beck, 2021) розрізняє три рівні: автоматичні думки — швидкі, ситуативні («я провалюся»); проміжні переконання — правила й припущення («якщо я не ідеальний, мене відкинуть»); глибинні переконання — абсолютні твердження про себе, сформовані рано в житті.' },
              { type: 'h', text: 'Три типові глибинні переконання' },
              { type: 'list', items: [
                { term: 'Я нелюбимий', text: '«мене не можна любити», «я нікому не потрібен».' },
                { term: 'Я нікчемний / неспроможний', text: '«я невдаха», «я нічого не вартий».' },
                { term: 'Я безпорадний', text: '«я не впораюся», «світ небезпечний, а я слабкий».' },
              ] },
              { type: 'h', text: 'Техніка «стріла вниз»' },
              { type: 'p', text: 'Щоб дістатися переконання, не сперечайся з поверхневою думкою, а йди вглиб питанням: «Припустимо, це правда — і що це означає / чим це погано для вас?» Повторюй, доки не впрешся в абсолютне твердження про себе.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Я завалю презентацію.' },
                { who: 'Терапевт', text: 'Припустимо, так і станеться. Що це означало б для вас?' },
                { who: 'Клієнт', text: 'Що я не тягну цю роботу.' },
                { who: 'Терапевт', text: 'А якби й так — що тоді найгірше?' },
                { who: 'Клієнт', text: '…Що я взагалі нездара. Що зі мною щось не так.' },
              ] },
              { type: 'p', text: 'Ось воно — глибинне переконання («я нездара»). Тепер видно, з чим насправді працювати.' },
              { type: 'h', text: 'Обережно' },
              { type: 'list', items: [
                { text: 'Не «бури» надто швидко — «стріла вниз» торкається болючого; йди в темпі клієнта.' },
                { text: 'Дійшовши до переконання, не лишай людину в ньому — познач, що це переконання, а не факт, і що далі працюватимете разом.' },
              ] },
              { type: 'quote', text: 'Поверхнева думка — це симптом. Глибинне переконання — корінь. Лікувати корінь надійніше.' },
              { type: 'sources', sources: [
                { label: 'Beck J. (2021). Cognitive Behavior Therapy: Basics and Beyond, 3-тє вид. — рівні думок і техніка «стріла вниз».', url: 'https://www.guilford.com/books/Cognitive-Behavior-Therapy/Judith-Beck/9781462544196' },
                { label: 'Beck та ін. (1979). Cognitive Therapy of Depression — першоджерело когнітивної моделі.', url: 'https://www.guilford.com/books/Cognitive-Therapy-of-Depression/Beck-Rush-Shaw-Emery/9780898629194' },
                { label: 'Cuijpers та ін. (2023). КПТ при депресії: метааналіз 409 досліджень. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'You already tested the thought "I\'ll bomb the presentation" with a client — and seemingly convinced her the evidence for catastrophe was thin. Yet the next week she came in crushed again: "See, I told you something\'s wrong with me." The presentation thought was only the tip. Beneath it sits a deeper belief about the self, worth reaching.' },
              { type: 'h', text: 'Three levels of cognition' },
              { type: 'figure', figure: 'belief-levels' },
              { type: 'p', text: 'Modern CBT (J. Beck, 2021) distinguishes three levels: automatic thoughts — fast, situational ("I\'ll fail"); intermediate beliefs — rules and assumptions ("if I\'m not perfect, I\'ll be rejected"); core beliefs — absolute statements about the self, formed early in life.' },
              { type: 'h', text: 'Three typical core beliefs' },
              { type: 'list', items: [
                { term: 'I am unlovable', text: '"I can\'t be loved", "nobody needs me".' },
                { term: 'I am worthless / incompetent', text: '"I\'m a failure", "I\'m worth nothing".' },
                { term: 'I am helpless', text: '"I can\'t cope", "the world is dangerous and I\'m weak".' },
              ] },
              { type: 'h', text: 'The downward-arrow technique' },
              { type: 'p', text: 'To reach the belief, do not argue with the surface thought; go down with a question: "Suppose it\'s true — what would that mean / why is that bad for you?" Repeat until you hit an absolute statement about the self.' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "I'll bomb the presentation." },
                { who: 'Therapist', text: 'Suppose you do. What would that mean for you?' },
                { who: 'Client', text: "That I can't handle this job." },
                { who: 'Therapist', text: 'And if so — what would be the worst of it?' },
                { who: 'Client', text: "…That I'm useless, full stop. That something is wrong with me." },
              ] },
              { type: 'p', text: 'There it is — the core belief ("I\'m useless"). Now you can see what you are really working with.' },
              { type: 'h', text: 'Carefully' },
              { type: 'list', items: [
                { text: 'Don\'t drill too fast — the downward arrow touches the tender; go at the client\'s pace.' },
                { text: 'Having reached the belief, don\'t leave the person in it — name it as a belief, not a fact, and that you\'ll work on it together.' },
              ] },
              { type: 'quote', text: 'The surface thought is a symptom. The core belief is the root. Treating the root holds better.' },
              { type: 'sources', sources: [
                { label: 'Beck J. (2021). Cognitive Behavior Therapy: Basics and Beyond, 3rd ed. — levels of cognition and the downward-arrow technique.', url: 'https://www.guilford.com/books/Cognitive-Behavior-Therapy/Judith-Beck/9781462544196' },
                { label: 'Beck et al. (1979). Cognitive Therapy of Depression — the original source of the cognitive model.', url: 'https://www.guilford.com/books/Cognitive-Therapy-of-Depression/Beck-Rush-Shaw-Emery/9780898629194' },
                { label: 'Cuijpers et al. (2023). CBT for depression: meta-analysis of 409 trials. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Як змінювати глибинне переконання',
            titleEn: 'How to change a core belief',
            bodyUk: [
              { type: 'p', text: 'Глибинне переконання не спростувати однією розмовою: воно роками «збирало докази» на свою користь і відкидало решту. Тому міняють його не суперечкою, а накопиченням нового досвіду — терпляче, як перепрошивають стару звичку.' },
              { type: 'h', text: 'Чому «просто переконати» не працює' },
              { type: 'p', text: 'У клієнта вже є фільтр: усе, що підтверджує «я нікчема», помічається й запамʼятовується, а успіхи знецінюються («пощастило», «будь-хто б зміг»). Логічний доказ протилежного відскакує від цього фільтра. Працює інше — досвід, який важко відмахнути.' },
              { type: 'h', text: 'Інструменти зміни' },
              { type: 'list', items: [
                { term: 'Журнал нових доказів', text: 'щодня занотовувати дрібниці, що суперечать переконанню («колега подякував» проти «я нікому не потрібен»).' },
                { term: 'Континуум', text: 'замість «нікчема / ідеал» — шкала 0–100 і питання «де ти насправді, з фактами?».' },
                { term: 'Історичний огляд', text: 'переглянути життя в пошуках епізодів, що не вписуються в переконання.' },
                { term: 'Дія всупереч', text: 'поведінковий експеримент — зробити те, чого переконання «забороняє», і подивитися на реальний результат.' },
              ] },
              { type: 'h', text: 'Формулюємо нове, реалістичне переконання' },
              { type: 'p', text: 'Мета — не плакат «я чудовий» (мозок не повірить), а збалансоване й правдоподібне: «я звичайна людина, яка має і сильні сторони, і промахи — як усі». Таке переконання витримує перевірку реальністю.' },
              { type: 'dialogue', lines: [
                { who: 'Терапевт', text: 'Цього тижня ви написали, що подруга сама зателефонувала спитати поради. Як це вписується в «я нікому не потрібен»?' },
                { who: 'Клієнт', text: 'Ну… мабуть, не дуже вписується.' },
                { who: 'Терапевт', text: 'Саме так. Назбираймо ще таких випадків — і подивимось, наскільки старе переконання точне.' },
              ] },
              { type: 'h', text: 'Типові помилки' },
              { type: 'list', items: [
                { text: 'Намагатися «перемогти» переконання логікою за одну сесію.' },
                { text: 'Підмінювати реалістичне переконання нещирим позитивом.' },
                { text: 'Збирати докази лише в кабінеті — головна робота відбувається в житті між сесіями.' },
              ] },
              { type: 'quote', text: 'Глибинне переконання міняє не сильніший аргумент, а інший досвід, що накопичується.' },
              { type: 'sources', sources: [
                { label: 'Beck J. (2021). Cognitive Behavior Therapy: Basics and Beyond, 3-тє вид. — модифікація переконань.', url: 'https://www.guilford.com/books/Cognitive-Behavior-Therapy/Judith-Beck/9781462544196' },
                { label: 'Cuijpers та ін. (2023). КПТ при депресії: метааналіз. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'A core belief cannot be refuted in one conversation: for years it "gathered evidence" in its favour and discarded the rest. So you change it not by argument but by accumulating new experience — patiently, the way you re-wire an old habit.' },
              { type: 'h', text: 'Why "just convince them" fails' },
              { type: 'p', text: 'The client already has a filter: everything confirming "I\'m worthless" is noticed and remembered, while successes are discounted ("luck", "anyone could"). A logical proof to the contrary bounces off this filter. What works is different — experience that is hard to wave away.' },
              { type: 'h', text: 'Tools for change' },
              { type: 'list', items: [
                { term: 'Positive-data log', text: 'note daily the small things that contradict the belief ("a colleague thanked me" vs "nobody needs me").' },
                { term: 'Continuum', text: 'instead of "worthless / ideal" — a 0–100 scale and "where are you really, with the facts?".' },
                { term: 'Historical review', text: 'scan the life story for episodes that do not fit the belief.' },
                { term: 'Acting against it', text: 'a behavioural experiment — do what the belief "forbids" and look at the real outcome.' },
              ] },
              { type: 'h', text: 'Craft a new, realistic belief' },
              { type: 'p', text: 'The goal is not a "I\'m wonderful" poster (the brain won\'t buy it) but something balanced and plausible: "I\'m an ordinary person with strengths and slip-ups — like everyone." Such a belief survives contact with reality.' },
              { type: 'dialogue', lines: [
                { who: 'Therapist', text: 'This week you wrote that a friend called you herself to ask for advice. How does that fit "nobody needs me"?' },
                { who: 'Client', text: "Well… I suppose it doesn't fit very well." },
                { who: 'Therapist', text: "Exactly. Let's collect more cases like that — and see how accurate the old belief really is." },
              ] },
              { type: 'h', text: 'Common mistakes' },
              { type: 'list', items: [
                { text: 'Trying to "win" against the belief with logic in a single session.' },
                { text: 'Replacing a realistic belief with insincere positivity.' },
                { text: 'Collecting evidence only in the room — the main work happens in life between sessions.' },
              ] },
              { type: 'quote', text: 'A core belief is changed not by a stronger argument but by different experience that accumulates.' },
              { type: 'sources', sources: [
                { label: 'Beck J. (2021). Cognitive Behavior Therapy: Basics and Beyond, 3rd ed. — modifying beliefs.', url: 'https://www.guilford.com/books/Cognitive-Behavior-Therapy/Judith-Beck/9781462544196' },
                { label: 'Cuijpers et al. (2023). CBT for depression: meta-analysis. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
          },
          {
            kind: 'quiz',
            titleUk: 'Перевірка: переконання',
            titleEn: 'Check: beliefs',
            quizUk: [
              {
                q: 'Що робить техніка «стріла вниз»?',
                options: ['Сперечається з думкою доказами', 'Послідовно питає «і що це означає / чим це погано?», доки не дійде до глибинного переконання', 'Замінює думку позитивною', 'Відволікає від думки'],
                correct: 1,
                explain: 'Мета — не спростувати поверхневу думку, а дістатися кореня — глибинного переконання.',
              },
              {
                q: 'Як найнадійніше змінювати глибинне переконання?',
                options: ['Переконати клієнта логікою за одну сесію', 'Накопичувати новий досвід і докази (журнал, експерименти, континуум)', 'Замінити його гаслом «я чудовий»', 'Не чіпати взагалі'],
                correct: 1,
                explain: 'Фільтр сприйняття відбиває логіку; змінює досвід, що накопичується між сесіями.',
              },
            ],
            quizEn: [
              {
                q: 'What does the downward-arrow technique do?',
                options: ['Argues against the thought with evidence', 'Repeatedly asks "what would that mean / why is that bad?" until it reaches a core belief', 'Replaces the thought with a positive one', 'Distracts from the thought'],
                correct: 1,
                explain: 'The aim is not to refute the surface thought but to reach the root — the core belief.',
              },
              {
                q: 'What most reliably changes a core belief?',
                options: ['Convincing the client with logic in one session', 'Accumulating new experience and evidence (log, experiments, continuum)', 'Replacing it with an "I\'m wonderful" slogan', 'Not touching it at all'],
                correct: 1,
                explain: 'The perceptual filter deflects logic; accumulated experience between sessions is what changes it.',
              },
            ],
          },
          {
            kind: 'practice',
            titleUk: 'Практика: стріла вниз',
            titleEn: 'Practice: the downward arrow',
            characterRef: 'Максим',
            techniqueKey: 'core_beliefs',
            passSignal: 'hiddenLayerReached',
            bodyUk: [
              { type: 'p', text: 'Завдання: з Максимом візьми поверхневу самокритичну думку й технікою «стріла вниз» обережно дійди до глибинного переконання про себе («і що це означає / чим це погано?»). Не лишай його в переконанні — познач, що це переконання, а не факт. Крок зарахується, коли фідбек покаже сигнал «дістався глибшого шару».' },
            ],
            bodyEn: [
              { type: 'p', text: 'Task: with Maksym, take a surface self-critical thought and use the downward arrow to gently reach a core belief about the self ("what would that mean / why is that bad?"). Don\'t leave him in the belief — name it as a belief, not a fact. The step passes when the feedback shows the "deeper layer reached" signal.' },
            ],
          },
        ],
      },
      {
        titleUk: 'Двигуни депресії: румінація й самокритика',
        titleEn: 'Engines of depression: rumination and self-criticism',
        objectivesUk: [
          'Відрізняти румінацію від корисного розвʼязання проблем.',
          'Зміщувати клієнта з «чому» на «як / що далі».',
          'Помʼякшувати самокритику через самоспівчуття.',
        ],
        objectivesEn: [
          'Distinguish rumination from useful problem-solving.',
          'Shift the client from "why" to "how / what next".',
          'Soften self-criticism through self-compassion.',
        ],
        steps: [
          {
            kind: 'lesson',
            titleUk: 'Румінація: від «чому я» до «що далі»',
            titleEn: 'Rumination: from "why me" to "what next"',
            bodyUk: [
              { type: 'p', text: 'Максим годинами лежить і прокручує: «чому я такий слабкий? чому в мене нічого не виходить? що зі мною не так?». Йому здається, що він «розбирається в собі». Насправді це румінація — і вона не наближає до рішення, а лише поглиблює яму.' },
              { type: 'h', text: 'Румінація — це не аналіз, а звичка' },
              { type: 'p', text: 'РФ-КПТ (Watkins, 2016) показує: справа не в темі думок, а в РЕЖИМІ мислення. Абстрактно-оцінне «чому це зі мною?» крутиться без виходу. Конкретно-дієве «що саме сталося і що я зроблю далі?» — рухає вперед. Та сама проблема, два режими — і лише один корисний.' },
              { type: 'figure', figure: 'depression-cycle', caption: 'Румінація живить низхідну спіраль: забирає час і сили, нічого не вирішуючи.' },
              { type: 'h', text: 'Як зміщувати режим' },
              { type: 'list', items: [
                { term: 'Лови ранні ознаки', text: 'разом визначте, де й коли зазвичай починається «жуйка» (ліжко ввечері, дорога).' },
                { term: 'Питай «як», а не «чому»', text: '«як я можу зробити перший крок?» замість «чому я такий?».' },
                { term: 'Відкладена румінація', text: 'домовитися «думати про це о 18:00 15 хвилин», а не цілий день.' },
                { term: 'Дія перебиває жуйку', text: 'конкретна дрібна справа (та сама активація) вириває з абстрактного циклу.' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Я просто не розумію, чому я завжди все псую.' },
                { who: 'Терапевт', text: '«Чому завжди» — велике питання без дна. Спробуймо інше: який конкретний момент цього тижня вас зачепив — і що ви могли б зробити в схожій ситуації наступного разу?' },
              ] },
              { type: 'h', text: 'Чому це працює' },
              { type: 'p', text: 'Румінація відчувається продуктивною («я ж думаю над проблемою»), тому за неї тримаються. Зсув до конкретного «як» повертає відчуття впливу, а дія дає новий досвід замість нового кола думок.' },
              { type: 'quote', text: 'Питання «чому я такий?» не має дна. Питання «що зроблю далі?» має крок.' },
              { type: 'sources', sources: [
                { label: 'Watkins та ін. (2011). РФ-КПТ при резидуальній депресії: РКД. Br J Psychiatry, 199, 317–322.', url: 'https://pubmed.ncbi.nlm.nih.gov/21778171/' },
                { label: 'Watkins (2016). Rumination-Focused CBT for Depression — режими мислення (абстрактний vs конкретний).', url: 'https://www.guilford.com/books/Rumination-Focused-Cognitive-Behavioral-Therapy-for-Depression/Edward-Watkins/9781462536047' },
                { label: 'Cuijpers та ін. (2023). Психотерапії депресії: метааналіз. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'Maksym lies for hours replaying: "why am I so weak? why does nothing work out for me? what\'s wrong with me?". It feels to him like "figuring himself out". In fact it is rumination — and it brings him no closer to a solution; it only deepens the pit.' },
              { type: 'h', text: 'Rumination is not analysis but a habit' },
              { type: 'p', text: 'Rumination-focused CBT (Watkins, 2016) shows: it is not the topic of the thoughts that matters but the MODE of thinking. The abstract-evaluative "why is this happening to me?" spins with no exit. The concrete-active "what exactly happened and what will I do next?" moves forward. Same problem, two modes — and only one is useful.' },
              { type: 'figure', figure: 'depression-cycle', caption: 'Rumination feeds the downward spiral: it eats time and energy while resolving nothing.' },
              { type: 'h', text: 'How to shift the mode' },
              { type: 'list', items: [
                { term: 'Catch the early signs', text: 'map together where and when the "chewing" usually starts (bed at night, the commute).' },
                { term: 'Ask "how", not "why"', text: '"how can I take a first step?" instead of "why am I like this?".' },
                { term: 'Postponed rumination', text: 'agree to "think about it at 6 pm for 15 minutes", not all day.' },
                { term: 'Action interrupts the loop', text: 'a concrete small task (the same activation) pulls one out of the abstract cycle.' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "I just don't understand why I always ruin everything." },
                { who: 'Therapist', text: '"Why always" is a big, bottomless question. Let\'s try another: what specific moment this week stung — and what could you do in a similar situation next time?' },
              ] },
              { type: 'h', text: 'Why it works' },
              { type: 'p', text: 'Rumination feels productive ("I am thinking about the problem"), so people cling to it. Shifting to a concrete "how" restores a sense of agency, and action gives new experience instead of another loop of thoughts.' },
              { type: 'quote', text: 'The question "why am I like this?" has no bottom. The question "what will I do next?" has a step.' },
              { type: 'sources', sources: [
                { label: 'Watkins et al. (2011). RFCBT for residual depression: RCT. Br J Psychiatry, 199, 317–322.', url: 'https://pubmed.ncbi.nlm.nih.gov/21778171/' },
                { label: 'Watkins (2016). Rumination-Focused CBT for Depression — modes of thinking (abstract vs concrete).', url: 'https://www.guilford.com/books/Rumination-Focused-Cognitive-Behavioral-Therapy-for-Depression/Edward-Watkins/9781462536047' },
                { label: 'Cuijpers et al. (2023). Psychotherapies for depression: meta-analysis. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Самокритика й самоспівчуття',
            titleEn: 'Self-criticism and self-compassion',
            bodyUk: [
              { type: 'p', text: 'Спитайте депресивного клієнта, яким тоном він говорить сам із собою, — і часто почуєте те, чого нікому б не сказали вголос: «ти жалюгідний», «знову все зіпсував». Цей внутрішній критик здається мотиватором, а насправді підливає палива в депресію.' },
              { type: 'h', text: 'Чому самокритика така в’язка' },
              { type: 'p', text: 'Самокритика тримається на вірі «якщо я перестану себе бичувати — розкисну й нічого не робитиму». Насправді постійна загроза зсередини виснажує. Тут у пригоді терапія, сфокусована на співчутті (Gilbert): вона не «хвалить», а вмикає іншу систему регуляції емоцій.' },
              { type: 'h', text: 'Три системи емоцій' },
              { type: 'figure', figure: 'three-circles' },
              { type: 'list', items: [
                { term: 'Загроза', text: 'тривога, сором, самокритика — захищає, але в депресії гіперактивна.' },
                { term: 'Драйв', text: 'гонитва за результатом; сама собою не заспокоює.' },
                { term: 'Заспокоєння', text: 'безпека, тепло, звʼязок. У депресії «спить» — її і треба плекати.' },
              ] },
              { type: 'h', text: 'Як вирощувати самоспівчуття' },
              { type: 'list', items: [
                { term: 'Тон друга', text: '«що б ви сказали другові в такій ситуації?» — і запропонувати сказати це собі.' },
                { term: 'Спільність людського', text: 'нагадати: помилятися й страждати — частина людського досвіду, а не лише «моя вада».' },
                { term: 'Пауза самоспівчуття', text: 'коротка практика: назвати біль, визнати його, побажати собі доброти.' },
              ] },
              { type: 'p', text: 'Важливо: самоспівчуття — не самопоблажливість і не порожнє самопідбадьорювання. Це чесно визнати біль і поставитися до себе так, як до того, кого любиш. Метааналіз показав, що такі інтервенції помірно знижують депресію, тривогу й стрес (Ferrari та ін., 2019).' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Якщо я перестану себе гнобити, то взагалі зупинюся.' },
                { who: 'Терапевт', text: 'Уявімо тренера, який лише кричить на гравця. Той видасть результат — чи зламається? А якби той самий тренер був вимогливим, але теплим?' },
              ] },
              { type: 'quote', text: 'Самокритика батожить виснаженого коня. Самоспівчуття — годує його, щоб він ішов далі.' },
              { type: 'sources', sources: [
                { label: 'Ferrari та ін. (2019). Інтервенції самоспівчуття: метааналіз РКД (середній ефект на депресію/тривогу). Mindfulness.', url: 'https://doi.org/10.1007/s12671-019-01134-6' },
                { label: 'Leaviss & Uttley (2015). Терапія, сфокусована на співчутті: систематичний огляд. Psychological Medicine.', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4413786/' },
                { label: 'Gilbert (2014). Витоки й природа терапії, сфокусованої на співчутті — першоджерело. Br J Clin Psychol.', url: 'https://doi.org/10.1111/bjc.12043' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'Ask a depressed client what tone they use with themselves — and you often hear what they\'d never say aloud to anyone: "you\'re pathetic", "you ruined it again". This inner critic feels like a motivator but actually pours fuel on the depression.' },
              { type: 'h', text: 'Why self-criticism is so sticky' },
              { type: 'p', text: 'Self-criticism rests on the belief "if I stop flogging myself, I\'ll go soft and do nothing". In fact a constant internal threat exhausts. Here compassion-focused therapy (Gilbert) helps: it does not "praise" but switches on a different emotion-regulation system.' },
              { type: 'h', text: 'Three emotion systems' },
              { type: 'figure', figure: 'three-circles' },
              { type: 'list', items: [
                { term: 'Threat', text: 'anxiety, shame, self-criticism — protective, but hyperactive in depression.' },
                { term: 'Drive', text: 'striving for results; does not soothe on its own.' },
                { term: 'Soothing', text: 'safety, warmth, connection. In depression it "sleeps" — this is the one to cultivate.' },
              ] },
              { type: 'h', text: 'How to grow self-compassion' },
              { type: 'list', items: [
                { term: 'A friend\'s tone', text: '"what would you say to a friend in this situation?" — then invite them to say it to themselves.' },
                { term: 'Common humanity', text: 'remind: erring and suffering are part of the human experience, not just "my flaw".' },
                { term: 'Self-compassion break', text: 'a short practice: name the pain, acknowledge it, wish yourself kindness.' },
              ] },
              { type: 'p', text: 'Important: self-compassion is not self-indulgence and not empty self-cheerleading. It is to honestly acknowledge pain and treat yourself as you would someone you love. A meta-analysis found such interventions moderately reduce depression, anxiety and stress (Ferrari et al., 2019).' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "If I stop beating myself up, I'll just stop altogether." },
                { who: 'Therapist', text: 'Picture a coach who only screams at the player. Will they perform — or break? And if that same coach were demanding but warm?' },
              ] },
              { type: 'quote', text: 'Self-criticism whips an exhausted horse. Self-compassion feeds it, so it can keep going.' },
              { type: 'sources', sources: [
                { label: 'Ferrari et al. (2019). Self-compassion interventions: meta-analysis of RCTs (medium effect on depression/anxiety). Mindfulness.', url: 'https://doi.org/10.1007/s12671-019-01134-6' },
                { label: 'Leaviss & Uttley (2015). Psychotherapeutic benefits of compassion-focused therapy: systematic review. Psychological Medicine.', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4413786/' },
                { label: 'Gilbert (2014). The origins and nature of compassion focused therapy — original source. Br J Clin Psychol.', url: 'https://doi.org/10.1111/bjc.12043' },
              ] },
            ],
          },
          {
            kind: 'quiz',
            titleUk: 'Перевірка: румінація й співчуття',
            titleEn: 'Check: rumination and compassion',
            quizUk: [
              {
                q: 'Що відрізняє корисне мислення від румінації?',
                options: ['Тема (про себе чи про інших)', 'Режим: конкретне «що далі» рухає, абстрактне «чому я» крутиться без виходу', 'Тривалість', 'Час доби'],
                correct: 1,
                explain: 'За РФ-КПТ ключовий не зміст, а режим — абстрактно-оцінний vs конкретно-дієвий.',
              },
              {
                q: 'Самоспівчуття — це...',
                options: ['Самопоблажливість, дозволити собі все', 'Чесно визнати біль і поставитися до себе по-доброму', 'Хвалити себе, щоб підняти настрій', 'Ігнорувати свої помилки'],
                correct: 1,
                explain: 'Це не поблажливість і не порожня похвала, а доброта до себе у визнанні болю.',
              },
            ],
            quizEn: [
              {
                q: 'What distinguishes useful thinking from rumination?',
                options: ['The topic (about the self or others)', 'The mode: concrete "what next" moves forward, abstract "why me" spins with no exit', 'The duration', 'The time of day'],
                correct: 1,
                explain: 'In RFCBT what matters is not the content but the mode — abstract-evaluative vs concrete-active.',
              },
              {
                q: 'Self-compassion is...',
                options: ['Self-indulgence, letting yourself off everything', 'Honestly acknowledging pain and treating yourself kindly', 'Praising yourself to lift your mood', 'Ignoring your mistakes'],
                correct: 1,
                explain: 'It is neither indulgence nor empty praise, but kindness to yourself while acknowledging pain.',
              },
            ],
          },
          {
            kind: 'practice',
            titleUk: 'Практика: помʼякшити критика',
            titleEn: 'Practice: soften the critic',
            characterRef: 'Анна',
            techniqueKey: 'self_compassion',
            bodyUk: [
              { type: 'p', text: 'Завдання: з Анною, яка жорстко себе критикує й «жує» думки «чому я така», поміть критичний тон, запропонуй «тон друга» й коротку паузу самоспівчуття; змісти її з «чому» на «що далі». Заверши сесію й отримай фідбек.' },
            ],
            bodyEn: [
              { type: 'p', text: 'Task: with Anna, who criticises herself harshly and "chews" on "why am I like this", notice the critical tone, offer the "friend\'s tone" and a brief self-compassion break; shift her from "why" to "what next". End the session and get feedback.' },
            ],
          },
        ],
      },
      {
        titleUk: 'Безнадія і складний контакт',
        titleEn: 'Hopelessness and difficult contact',
        objectivesUk: [
          'Розпізнавати безнадію як ядро депресії й чинник ризику.',
          'Не потрапляти в пастку «полагодити» з клієнтом, що відштовхує допомогу.',
          'Вселяти реалістичну надію через дію, а не суперечку.',
        ],
        objectivesEn: [
          'Recognise hopelessness as a core of depression and a risk factor.',
          'Avoid the "fix-it" trap with a help-rejecting client.',
          'Instil realistic hope through action, not argument.',
        ],
        steps: [
          {
            kind: 'lesson',
            titleUk: 'Безнадія і клієнт, що відштовхує допомогу',
            titleEn: 'Hopelessness and the help-rejecting client',
            bodyUk: [
              { type: 'p', text: 'Що б ви не запропонували, Олеся відповідає «так, але…»: «я пробувала — не працює», «вам легко казати». Ви відчуваєте, як наростає безсилля й бажання її переконати. Це не «важкий клієнт» — це сама депресія говорить її вустами. І ключ не в сильнішому аргументі.' },
              { type: 'h', text: 'Безнадія — ядро, а не деталь' },
              { type: 'p', text: 'Безнадія («нічого не зміниться, тож нащо й намагатися») — серцевина депресії і, за даними, найсильніший чинник суїцидального ризику (McMillan та ін., 2007). Тому її не оминають: помічають, називають і тримають у полі зору разом із ризиком.' },
              { type: 'figure', figure: 'risk-ladder', caption: 'Безнадія тісно повʼязана з ризиком — тримай ту саму логіку перевірки під рукою.' },
              { type: 'h', text: 'Пастка «полагодити»' },
              { type: 'p', text: 'Природний порив — закидати клієнта рішеннями й доводити, що «не все так погано». Але кожне ваше «а ви спробуйте…» наражається на «так, але…», ви вигораєте, а клієнт зайвий раз «доводить», що його випадок безнадійний. Ви мимоволі граєте оптиміста — і змушуєте його грати песиміста.' },
              { type: 'h', text: 'Що працює натомість' },
              { type: 'list', items: [
                { term: 'Спершу визнати, не переконувати', text: '«Схоже, звідти, де ви зараз, справді не видно виходу.» Валідація відкриває, сперечання зачиняє.' },
                { term: 'Не сперечайся з безнадією — досліджуй', text: '«Що мало б статися, щоб зʼявилася хоч крихта надії?»' },
                { term: 'Надія через дію, не слова', text: 'один крихітний експеримент (активація) дає докази краще за будь-яке переконування.' },
                { term: 'Тримай ризик у фокусі', text: 'безнадія + «нащо все це» — привід прямо перевірити суїцидальні думки.' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Та що ті ваші вправи. Мені вже нічого не допоможе.' },
                { who: 'Терапевт', text: 'Можливо, ви маєте рацію — звідси справді важко повірити, що щось зрушить. Я не проситиму вірити. Пропоную крихітний експеримент на тиждень — і нехай результат скаже сам за себе. А якщо не спрацює — це теж корисна інформація для нас.' },
              ] },
              { type: 'h', text: 'Бережи й себе' },
              { type: 'p', text: 'Відчуття безсилля у відповідь на «так, але» — це контрперенесення, сигнал, а не провал. Поміть його, не тисни сильніше і, за потреби, винеси на супервізію.' },
              { type: 'quote', text: 'З безнадією не сперечаються. Її витримують поруч — доки маленька дія не принесе перший доказ протилежного.' },
              { type: 'sources', sources: [
                { label: 'McMillan та ін. (2007). Чи передбачає шкала безнадії Бека суїцид/самоушкодження: метааналіз. Psychol Med.', url: 'https://pubmed.ncbi.nlm.nih.gov/17202001/' },
                { label: 'Beck та ін. (1979). Cognitive Therapy of Depression — безнадія в когнітивній моделі.', url: 'https://www.guilford.com/books/Cognitive-Therapy-of-Depression/Beck-Rush-Shaw-Emery/9780898629194' },
                { label: 'NICE (2022). Depression in adults (NG222) — оцінка ризику.', url: 'https://www.nice.org.uk/guidance/ng222' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'Whatever you suggest, Olesya answers "yes, but…": "I tried — it doesn\'t work", "easy for you to say". You feel powerlessness rising and the urge to convince her. This is not a "difficult client" — it is the depression speaking through her. And the key is not a stronger argument.' },
              { type: 'h', text: 'Hopelessness is the core, not a detail' },
              { type: 'p', text: 'Hopelessness ("nothing will change, so why try") is the heart of depression and, per the evidence, the strongest factor in suicide risk (McMillan et al., 2007). So you do not bypass it: you notice it, name it, and keep it in view together with risk.' },
              { type: 'figure', figure: 'risk-ladder', caption: 'Hopelessness is closely tied to risk — keep the same screening logic to hand.' },
              { type: 'h', text: 'The "fix-it" trap' },
              { type: 'p', text: 'The natural urge is to pelt the client with solutions and prove "it\'s not all that bad". But every "well, why don\'t you try…" runs into "yes, but…", you burn out, and the client once more "proves" their case is hopeless. You end up playing the optimist — and casting them as the pessimist.' },
              { type: 'h', text: 'What works instead' },
              { type: 'list', items: [
                { term: 'Acknowledge first, don\'t convince', text: '"It sounds like, from where you are, there really is no way out in sight." Validation opens; arguing closes.' },
                { term: 'Don\'t argue with hopelessness — explore it', text: '"What would have to happen for even a crumb of hope to appear?"' },
                { term: 'Hope through action, not words', text: 'one tiny experiment (activation) gives evidence better than any persuasion.' },
                { term: 'Keep risk in focus', text: 'hopelessness + "what\'s the point of any of this" is a cue to screen suicidal thoughts directly.' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "Come on, your exercises. Nothing will help me now." },
                { who: 'Therapist', text: "You may be right — from here it really is hard to believe anything will shift. I won't ask you to believe. I'm proposing a tiny experiment for one week — and let the result speak for itself. And if it doesn't work, that's useful information for us too." },
              ] },
              { type: 'h', text: 'Look after yourself too' },
              { type: 'p', text: 'The sense of powerlessness in response to "yes, but" is countertransference — a signal, not a failure. Notice it, don\'t push harder, and take it to supervision if needed.' },
              { type: 'quote', text: 'You don\'t argue with hopelessness. You endure it alongside — until a small action brings the first proof to the contrary.' },
              { type: 'sources', sources: [
                { label: 'McMillan et al. (2007). Can the Beck Hopelessness Scale predict suicide/self-harm: a meta-analysis. Psychol Med.', url: 'https://pubmed.ncbi.nlm.nih.gov/17202001/' },
                { label: 'Beck et al. (1979). Cognitive Therapy of Depression — hopelessness in the cognitive model.', url: 'https://www.guilford.com/books/Cognitive-Therapy-of-Depression/Beck-Rush-Shaw-Emery/9780898629194' },
                { label: 'NICE (2022). Depression in adults (NG222) — risk assessment.', url: 'https://www.nice.org.uk/guidance/ng222' },
              ] },
            ],
          },
          {
            kind: 'quiz',
            titleUk: 'Перевірка: безнадія й контакт',
            titleEn: 'Check: hopelessness and contact',
            quizUk: [
              {
                q: 'Як найкраще реагувати на «так, але» й безнадію?',
                options: ['Закидати рішеннями й доводити, що не все так погано', 'Спершу визнати й дослідити безнадію, не сперечаючись, а надію будувати через крихітну дію', 'Погодитися, що випадок безнадійний', 'Змінити тему'],
                correct: 1,
                explain: 'Сперечання лише закручує «так, але»; валідація + маленький експеримент дають вихід.',
              },
              {
                q: 'Чому безнадію не можна оминати?',
                options: ['Бо це неввічливо', 'Бо це ядро депресії й найсильніший чинник суїцидального ризику', 'Бо вона швидко мине сама', 'Бо це не стосується терапії'],
                correct: 1,
                explain: 'Безнадію тримають у фокусі й поряд із нею прямо перевіряють ризик.',
              },
            ],
            quizEn: [
              {
                q: 'How is it best to respond to "yes, but" and hopelessness?',
                options: ['Pelt them with solutions and prove it\'s not so bad', 'Acknowledge and explore the hopelessness without arguing, and build hope through a tiny action', 'Agree the case is hopeless', 'Change the subject'],
                correct: 1,
                explain: 'Arguing only tightens the "yes, but"; validation plus a small experiment opens a way out.',
              },
              {
                q: 'Why must hopelessness not be bypassed?',
                options: ['Because it is impolite', 'Because it is a core of depression and the strongest factor in suicide risk', 'Because it passes quickly on its own', 'Because it is not relevant to therapy'],
                correct: 1,
                explain: 'Hopelessness is kept in focus, and risk is screened directly alongside it.',
              },
            ],
          },
          {
            kind: 'practice',
            titleUk: 'Практика: безнадійний клієнт',
            titleEn: 'Practice: the hopeless client',
            characterRef: 'Олеся',
            techniqueKey: 'hopelessness',
            passSignal: 'ruptureRepaired',
            bodyUk: [
              { type: 'p', text: 'Завдання: з Олесею, що відповідає «так, але…», не потрап у пастку «полагодити». Визнай безнадію без сперечання, дослідь її, запропонуй крихітний експеримент і тримай ризик у полі зору. Крок зарахується, коли фідбек покаже сигнал «розрив відновлено».' },
            ],
            bodyEn: [
              { type: 'p', text: 'Task: with Olesya, who answers "yes, but…", don\'t fall into the "fix-it" trap. Acknowledge the hopelessness without arguing, explore it, offer a tiny experiment, and keep risk in view. The step passes when the feedback shows the "rupture repaired" signal.' },
            ],
          },
        ],
      },
    ],
  },
];
