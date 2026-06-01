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
              { type: 'p', text: 'Близька каже Максимові: «Та просто візьми себе в руки». Він і сам себе картає — але не може встати з ліжка, і від цього ще гірше. У цьому й пастка депресії: вона виглядає як лінь, а насправді це стан, у якому зникають енергія, інтерес і здатність радіти. Звинувачення («просто старайся») не лікують, а поглиблюють провину.' },
              { type: 'h', text: 'Як виглядає депресія' },
              { type: 'p', text: 'Депресія — це не один поганий день, а стійке (≥2 тижнів) зниження настрою та/або втрата інтересу й задоволення разом із низкою інших ознак (логіка DSM-5-TR / МКХ-11):' },
              { type: 'list', items: [
                { term: 'Настрій', text: 'пригніченість, порожнеча, іноді дратівливість.' },
                { term: 'Ангедонія', text: 'те, що тішило, більше не тішить.' },
                { term: 'Тіло', text: 'сон, апетит, енергія — забагато або замало; усе «через силу».' },
                { term: 'Думки', text: 'самокритика, провина, безнадія, важко зосередитися.' },
                { term: 'Ризик', text: 'думки, що життя не варте, — їх перевіряють прямо (див. модуль 3).' },
              ] },
              { type: 'h', text: 'Смуток чи депресія?' },
              { type: 'p', text: 'Смуток — нормальна реакція; він минає й лишає простір для радості між хвилями. Депресія стійка, пронизує більшість дня майже щодня, забирає інтерес до майже всього й заважає функціонувати. Це різниця в тривалості, охопленні та впливі на життя — а не «слабкий характер».' },
              { type: 'figure', figure: 'biopsychosocial', caption: 'Депресія постає зі сплетіння біологічного, психологічного й соціального — тому й допомога працює на кількох рівнях.' },
              { type: 'h', text: 'Чому це не питання волі' },
              { type: 'p', text: 'Депресія знижує саму здатність докладати зусиль: мозкові системи мотивації й винагороди працюють приглушено. Сказати «просто старайся» — це майже як сказати людині зі зламаною ногою «просто йди». Тому перший крок терапії — зняти провину й пояснити: це стан, який лікується.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Я просто лінивий. Усі якось справляються, а я ні.' },
                { who: 'Терапевт', text: 'Те, що ви описуєте, — не лінь. Лінь — це коли можеш, але не хочеш. А у вас зникла сама здатність хотіти й мати сили. Це ознака депресії, і з цим можна працювати.' },
              ] },
              { type: 'h', text: 'Добра новина' },
              { type: 'p', text: 'Депресія — один із найкраще досліджених станів у психотерапії. Психологічні методи (КПТ, поведінкова активація та інші) надійно допомагають — у короткій перспективі не гірше за ліки, а в довшій навіть стійкіше (Cuijpers та ін., 2023).' },
              { type: 'quote', text: 'Депресія бреше людині, що вона лінива й безнадійна. Наша робота — не сперечатися з нею словами, а показати інше досвідом.' },
              { type: 'sources', sources: [
                { label: 'American Psychiatric Association (2022). DSM-5-TR — критерії великого депресивного розладу.', url: 'https://www.psychiatry.org/psychiatrists/practice/dsm' },
                { label: 'Cuijpers та ін. (2023). КПТ при депресії: метааналіз 409 досліджень (52 702 пацієнти). World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
                { label: 'NICE (2022). Depression in adults: treatment and management (NG222).', url: 'https://www.nice.org.uk/guidance/ng222' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: "Someone close says to Maksym: \"Just pull yourself together.\" He berates himself too — but he cannot get out of bed, and that makes it worse. This is the trap of depression: it looks like laziness, but it is a state in which energy, interest and the capacity for joy drain away. Blame (\"just try harder\") does not heal it — it deepens the guilt." },
              { type: 'h', text: 'What depression looks like' },
              { type: 'p', text: 'Depression is not one bad day but a sustained (≥2 weeks) drop in mood and/or loss of interest and pleasure, along with a cluster of other features (the logic of DSM-5-TR / ICD-11):' },
              { type: 'list', items: [
                { term: 'Mood', text: 'low, empty, sometimes irritable.' },
                { term: 'Anhedonia', text: 'what used to please no longer pleases.' },
                { term: 'Body', text: 'sleep, appetite, energy — too much or too little; everything is an effort.' },
                { term: 'Thinking', text: 'self-criticism, guilt, hopelessness, hard to concentrate.' },
                { term: 'Risk', text: 'thoughts that life is not worth it — screened directly (see module 3).' },
              ] },
              { type: 'h', text: 'Sadness or depression?' },
              { type: 'p', text: 'Sadness is a normal reaction; it passes and leaves room for joy between waves. Depression is sustained, pervades most of the day nearly every day, drains interest in almost everything, and impairs functioning. It is a difference of duration, breadth and impact — not "weak character".' },
              { type: 'figure', figure: 'biopsychosocial', caption: 'Depression arises from a weave of the biological, psychological and social — which is why help works on several levels.' },
              { type: 'h', text: 'Why it is not about willpower' },
              { type: 'p', text: 'Depression lowers the very capacity to exert effort: the brain\'s motivation and reward systems run muted. Saying "just try harder" is almost like telling someone with a broken leg to "just walk". So the first step of therapy is to lift the guilt and explain: this is a state, and it is treatable.' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "I'm just lazy. Everyone else copes, and I can't." },
                { who: 'Therapist', text: 'What you describe is not laziness. Laziness is when you can but won\'t. In you, the very capacity to want and to have energy has gone. That is a sign of depression — and it can be worked with.' },
              ] },
              { type: 'h', text: 'The good news' },
              { type: 'p', text: 'Depression is one of the best-studied conditions in psychotherapy. Psychological methods (CBT, behavioural activation and others) reliably help — no worse than medication in the short term, and even more durable in the longer term (Cuijpers et al., 2023).' },
              { type: 'quote', text: 'Depression lies to a person that they are lazy and hopeless. Our job is not to argue with it in words but to show otherwise through experience.' },
              { type: 'sources', sources: [
                { label: 'American Psychiatric Association (2022). DSM-5-TR — criteria for major depressive disorder.', url: 'https://www.psychiatry.org/psychiatrists/practice/dsm' },
                { label: 'Cuijpers et al. (2023). CBT for depression: meta-analysis of 409 trials (52,702 patients). World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
                { label: 'NICE (2022). Depression in adults: treatment and management (NG222).', url: 'https://www.nice.org.uk/guidance/ng222' },
              ] },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Низхідна спіраль: як депресія себе тримає',
            titleEn: 'The downward spiral: how depression sustains itself',
            bodyUk: [
              { type: 'p', text: 'Депресія тримається не лише «в голові» — вона закручує петлю поведінки. Настрій падає → людина менше робить і уникає зусиль → у житті стає менше приємного й важливого → настрій падає ще нижче. Що логічнішим здається «відпочити, поки не відпустить», то глибша спіраль.' },
              { type: 'h', text: 'Як працює низхідна спіраль' },
              { type: 'figure', figure: 'depression-cycle' },
              { type: 'list', items: [
                { text: 'Низький настрій і втома → «немає сенсу / немає сил».' },
                { text: 'Відмова від справ, зустрічей, рутини — відступ.' },
                { text: 'Менше джерел задоволення й відчуття досягнення.' },
                { text: 'Більше часу наодинці з важкими думками → настрій нижчий.' },
              ] },
              { type: 'h', text: 'Пастка «спершу захочу — потім зроблю»' },
              { type: 'p', text: 'У здоровому стані мотивація часто передує дії. У депресії це ламається: чекати, доки «захочеться», — означає чекати майже вічно, бо саме здатність хотіти й пригнічена. Тому ключ не в тому, щоб «накрутити» мотивацію, а в тому, щоб почати з маленької дії, від якої мотивація з’являється згодом.' },
              { type: 'h', text: 'Румінація підливає оливи' },
              { type: 'p', text: 'Коли активності мало, її місце займає румінація — нескінченне пережовування «чому я такий», «що зі мною не так». Вона відчувається як «розбираюся в собі», а насправді поглиблює настрій і нічого не вирішує.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Я просто чекаю, доки повернуться сили, і тоді знову почну жити.' },
                { who: 'Терапевт', text: 'Дуже зрозуміле бажання. От тільки депресія влаштована так, що сили частіше повертаються ПІСЛЯ маленьких дій, а не до них. Спробуємо перевірити це разом?' },
              ] },
              { type: 'quote', text: 'Депресія каже: «зачекай, поки стане легше, тоді почнеш». Насправді легше стає тому, хто починає потроху раніше.' },
              { type: 'sources', sources: [
                { label: 'Cuijpers та ін. (2023). Психотерапії депресії: метааналіз. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
                { label: 'Ekers та ін. (2014). Поведінкова активація при депресії: оновлений метааналіз. PLoS ONE.', url: 'https://pubmed.ncbi.nlm.nih.gov/24936656/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'Depression holds on not only "in the head" — it winds a loop of behaviour. Mood drops → the person does less and avoids effort → there is less that is pleasant or meaningful in life → mood drops further. The more sensible "rest until it lifts" feels, the deeper the spiral.' },
              { type: 'h', text: 'How the downward spiral works' },
              { type: 'figure', figure: 'depression-cycle' },
              { type: 'list', items: [
                { text: 'Low mood and fatigue → "no point / no energy".' },
                { text: 'Dropping tasks, meetings, routine — withdrawal.' },
                { text: 'Fewer sources of pleasure and sense of achievement.' },
                { text: 'More time alone with hard thoughts → lower mood.' },
              ] },
              { type: 'h', text: 'The "want it first, then do it" trap' },
              { type: 'p', text: 'When well, motivation often comes before action. In depression this breaks: waiting until you "feel like it" means waiting almost forever, because the very capacity to want is suppressed. So the key is not to "pump up" motivation but to start with a small action that motivation follows.' },
              { type: 'h', text: 'Rumination pours on fuel' },
              { type: 'p', text: 'When activity is scarce, rumination takes its place — endless chewing over "why am I like this", "what is wrong with me". It feels like "figuring myself out", but it deepens mood and resolves nothing.' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "I'm just waiting for my energy to come back, and then I'll start living again." },
                { who: 'Therapist', text: 'A very understandable wish. The catch is that depression is built so that energy more often returns AFTER small actions, not before them. Shall we test that together?' },
              ] },
              { type: 'quote', text: 'Depression says: "wait until it gets easier, then start". In fact it gets easier for the one who starts, a little, sooner.' },
              { type: 'sources', sources: [
                { label: 'Cuijpers et al. (2023). Psychotherapies for depression: meta-analysis. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
                { label: 'Ekers et al. (2014). Behavioural activation for depression: updated meta-analysis. PLoS ONE.', url: 'https://pubmed.ncbi.nlm.nih.gov/24936656/' },
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
              { type: 'p', text: 'Поведінкова активація (BA) — на вигляд проста, але одна з найдієвіших стратегій при депресії: масштабне дослідження COBRA показало, що сама лише BA не поступається повноцінній КПТ і її можуть проводити навіть менш досвідчені фахівці (Richards та ін., 2016; Ekers та ін., 2014). Її суть — повертати в життя дії, що дають задоволення, відчуття досягнення й звʼязок, навіть коли «не хочеться».' },
              { type: 'h', text: 'Чому це працює' },
              { type: 'p', text: 'BA запускає низхідну спіраль у зворотний бік: маленька дія → крихта задоволення чи сенсу → трохи вищий настрій і енергія → легше зробити наступний крок. Дія йде першою, мотивація наздоганяє. Це не «змусь себе бути щасливим», а «зроби маленький крок попри настрій — і дай досвіду змінити настрій».' },
              { type: 'h', text: 'Три типи дій, які варто повертати' },
              { type: 'list', items: [
                { term: 'Задоволення', text: 'те, що колись тішило: музика, прогулянка, кава з другом.' },
                { term: 'Досягнення / майстерність', text: 'дрібні справи з відчуттям «я впорався»: помити чашку, відповісти на лист.' },
                { term: 'Цінності й звʼязок', text: 'те, що важливо саме для цієї людини: побути з дитиною, рух, віра, спільнота.' },
              ] },
              { type: 'h', text: 'Як почати — без перевантаження' },
              { type: 'list', items: [
                { text: 'Разом помітьте звʼязок «активність ↔ настрій» (простий щоденник дня).' },
                { text: 'Почніть з мікрокроку: не «бігати щодня», а «взути кросівки й вийти на 5 хвилин».' },
                { text: 'Плануйте за часом, а не «коли захочеться».' },
                { text: 'Очікуйте, що настрій підтягнеться згодом — не вимагайте радості одразу.' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Який сенс кудись іти, якщо мені все одно нічого не приносить радості?' },
                { who: 'Терапевт', text: 'Зараз справді не приносить — це сама депресія приглушила радість. Тому ми не чекаємо на радість, а робимо маленький крок як експеримент: подивимось, що з настроєм через годину після короткої прогулянки. Згодні спробувати раз?' },
              ] },
              { type: 'h', text: 'Часті помилки' },
              { type: 'list', items: [
                { text: 'Замахнутися надто високо одразу — провал підкріплює «у мене не виходить».' },
                { text: 'Чекати мотивації перед дією — у депресії вона приходить після.' },
                { text: 'Знецінювати дрібні кроки — саме вони розкручують спіраль угору.' },
              ] },
              { type: 'quote', text: 'Не «спершу захотіти, потім зробити», а «зробити маленьке — і дати настрою наздогнати».' },
              { type: 'sources', sources: [
                { label: 'Richards та ін. (2016). COBRA: поведінкова активація не поступається КПТ і дешевша. Lancet.', url: 'https://pubmed.ncbi.nlm.nih.gov/27461440/' },
                { label: 'Ekers та ін. (2014). Поведінкова активація при депресії: оновлений метааналіз. PLoS ONE.', url: 'https://pubmed.ncbi.nlm.nih.gov/24936656/' },
                { label: 'Cuijpers та ін. (2023). Психотерапії депресії: метааналіз. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'Behavioural activation (BA) looks simple but is one of the most effective strategies for depression: the large COBRA trial showed BA alone is non-inferior to full CBT and can be delivered by less experienced staff (Richards et al., 2016; Ekers et al., 2014). Its essence is bringing back into life the actions that give pleasure, a sense of achievement and connection — even when you "don\'t feel like it".' },
              { type: 'h', text: 'Why it works' },
              { type: 'p', text: 'BA runs the downward spiral in reverse: a small action → a crumb of pleasure or meaning → slightly higher mood and energy → the next step is easier. Action comes first, motivation catches up. It is not "force yourself to be happy" but "take a small step despite your mood — and let experience change the mood".' },
              { type: 'h', text: 'Three kinds of action to bring back' },
              { type: 'list', items: [
                { term: 'Pleasure', text: 'what once pleased: music, a walk, coffee with a friend.' },
                { term: 'Achievement / mastery', text: 'small tasks with an "I managed" feeling: wash a cup, answer an email.' },
                { term: 'Values and connection', text: 'what matters to this particular person: time with a child, movement, faith, community.' },
              ] },
              { type: 'h', text: 'How to start — without overload' },
              { type: 'list', items: [
                { text: 'Notice the "activity ↔ mood" link together (a simple day diary).' },
                { text: 'Start with a micro-step: not "run every day" but "put on trainers and step out for 5 minutes".' },
                { text: 'Schedule by time, not "when I feel like it".' },
                { text: 'Expect mood to catch up later — do not demand joy right away.' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "What's the point of going anywhere if nothing brings me joy anyway?" },
                { who: 'Therapist', text: "Right now it really doesn't — depression itself has muted the joy. So we don't wait for joy; we take a small step as an experiment: let's see what happens to your mood an hour after a short walk. Willing to try it once?" },
              ] },
              { type: 'h', text: 'Common mistakes' },
              { type: 'list', items: [
                { text: 'Aiming too high at once — failure reinforces "I can\'t do it".' },
                { text: 'Waiting for motivation before acting — in depression it comes after.' },
                { text: 'Dismissing small steps — they are exactly what winds the spiral upward.' },
              ] },
              { type: 'quote', text: 'Not "want first, then do", but "do something small — and let the mood catch up".' },
              { type: 'sources', sources: [
                { label: 'Richards et al. (2016). COBRA: behavioural activation non-inferior to CBT and cheaper. Lancet.', url: 'https://pubmed.ncbi.nlm.nih.gov/27461440/' },
                { label: 'Ekers et al. (2014). Behavioural activation for depression: updated meta-analysis. PLoS ONE.', url: 'https://pubmed.ncbi.nlm.nih.gov/24936656/' },
                { label: 'Cuijpers et al. (2023). Psychotherapies for depression: meta-analysis. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
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
              { type: 'p', text: 'Депресія дивиться на світ крізь темне скло. Аарон Бек описав це як когнітивну тріаду: негативний погляд на СЕБЕ («я нікчема»), на СВІТ і досвід («усе погано, я нікому не потрібен») і на МАЙБУТНЄ («нічого не зміниться»). Ці думки відчуваються як беззаперечна правда — хоча є симптомом, а не фактом.' },
              { type: 'h', text: 'Когнітивна тріада' },
              { type: 'figure', figure: 'cognitive-triad' },
              { type: 'p', text: 'Три вершини живлять одна одну: безнадійне майбутнє знесилює, знесилення «підтверджує» нікчемність, а та забарвлює світ. Розірвати коло можна з будь-якої вершини — і дією (активація), і перевіркою думок.' },
              { type: 'h', text: 'Як працювати з думкою (не суперечкою)' },
              { type: 'p', text: 'Мета — не переконати клієнта, що він «неправий» (депресивний мозок легко відіб’є оптимізм), а разом подивитися на думку як на гіпотезу й перевірити її. Запитання-помічники:' },
              { type: 'list', items: [
                { text: 'Яка конкретна думка зараз найважча?' },
                { text: 'Які факти за неї, а які — проти?' },
                { text: 'Це факт чи відчуття, що видається фактом?' },
                { text: 'Що б я сказав другові, який так думає про себе?' },
                { text: 'Який маленький крок перевірить цю думку в житті?' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Я нічого не довів до кінця. Я просто невдаха.' },
                { who: 'Терапевт', text: '«Невдаха» — це велике слово про всю людину. Можемо звузити: цього тижня були речі, навіть дрібні, які ви все-таки зробили? Подивимось на факти разом.' },
              ] },
              { type: 'h', text: 'Думки й дії — разом' },
              { type: 'p', text: 'Найсильніше депресивні переконання спростовує не дискусія, а досвід. Тому роботу з думками поєднують із поведінковою активацією: клієнт перевіряє «у мене все одно нічого не вийде», зробивши маленький крок, — і отримує контрдоказ із власного життя.' },
              { type: 'quote', text: 'Депресивна думка — це не вирок, а симптом. Її не виграють у суперечці — її перевіряють.' },
              { type: 'sources', sources: [
                { label: 'Beck та ін. (1979). Cognitive Therapy of Depression — першоджерело когнітивної тріади.', url: 'https://www.guilford.com/books/Cognitive-Therapy-of-Depression/Beck-Rush-Shaw-Emery/9780898629194' },
                { label: 'Cuijpers та ін. (2023). КПТ при депресії: метааналіз 409 досліджень. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'Depression looks at the world through dark glass. Aaron Beck described this as the cognitive triad: a negative view of the SELF ("I\'m worthless"), of the WORLD and experience ("everything is bad, nobody needs me") and of the FUTURE ("nothing will change"). These thoughts feel like undeniable truth — yet they are a symptom, not a fact.' },
              { type: 'h', text: 'The cognitive triad' },
              { type: 'figure', figure: 'cognitive-triad' },
              { type: 'p', text: 'The three vertices feed one another: a hopeless future saps energy, low energy "confirms" worthlessness, and that colours the world. You can break the circle from any vertex — through action (activation) and through testing thoughts.' },
              { type: 'h', text: 'How to work with a thought (not argue)' },
              { type: 'p', text: 'The goal is not to convince the client they are "wrong" (a depressed brain easily bats away optimism) but to look at the thought together as a hypothesis and test it. Helper questions:' },
              { type: 'list', items: [
                { text: 'What specific thought is hardest right now?' },
                { text: 'What facts are for it, and which are against?' },
                { text: 'Is this a fact, or a feeling that seems like a fact?' },
                { text: 'What would I say to a friend who thought this of themselves?' },
                { text: 'What small step would test this thought in real life?' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Client', text: "I haven't finished anything. I'm just a failure." },
                { who: 'Therapist', text: '"Failure" is a big word about a whole person. Can we narrow it down: were there things this week, even small ones, that you did do? Let\'s look at the facts together.' },
              ] },
              { type: 'h', text: 'Thoughts and actions — together' },
              { type: 'p', text: 'What refutes depressive beliefs most is not debate but experience. So work with thoughts is paired with behavioural activation: the client tests "nothing will work out for me anyway" by taking a small step — and gets counter-evidence from their own life.' },
              { type: 'quote', text: 'A depressive thought is not a verdict but a symptom. You don\'t win it in an argument — you test it.' },
              { type: 'sources', sources: [
                { label: 'Beck et al. (1979). Cognitive Therapy of Depression — the original source of the cognitive triad.', url: 'https://www.guilford.com/books/Cognitive-Therapy-of-Depression/Beck-Rush-Shaw-Emery/9780898629194' },
                { label: 'Cuijpers et al. (2023). CBT for depression: meta-analysis of 409 trials. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Ризик і профілактика рецидиву',
            titleEn: 'Risk and relapse prevention',
            bodyUk: [
              { type: 'p', text: 'Два моменти, які не можна пропустити при депресії: безпека зараз і стійкість потім. Депресія підвищує ризик суїцидальних думок, тому ризик перевіряють прямо й регулярно. А оскільки депресія схильна повертатися, у роботу від початку закладають профілактику рецидиву.' },
              { type: 'h', text: 'Ризик — питати прямо' },
              { type: 'p', text: 'Знижений настрій і безнадія часто йдуть поруч із думками «краще б мене не було». Як і в модулі скринінгу ризику: нормалізуй, запитай прямо, лишайся спокійним і теплим, за потреби складіть план безпеки. Уникати теми небезпечніше, ніж спитати.' },
              { type: 'figure', figure: 'risk-ladder', caption: 'Та сама логіка уточнення, що й у курсі інтейку: думки → план → засоби → намір.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Іноді думаю, що рідним було б спокійніше без мене.' },
                { who: 'Терапевт', text: 'Дякую, що сказали — це важливо. Коли настрій такий низький, такі думки трапляються. Чи бували думки зробити щось, щоб піти з життя?' },
              ] },
              { type: 'h', text: 'Профілактика рецидиву' },
              { type: 'p', text: 'Коли стає краще — це не кінець роботи, а час підготуватися до можливих спадів. Разом складають план: ранні ознаки («сон поповз», «почав скасовувати зустрічі»), що допомагало раніше (активація, контакти, фахівець) і конкретні дії на перші ознаки.' },
              { type: 'list', items: [
                { term: 'Ранні маркери', text: 'індивідуальні сигнали початку спаду.' },
                { term: 'Робочі інструменти', text: 'що вже допомагало: активація, люди, навички.' },
                { term: 'План дій', text: 'що зробити й кому подзвонити на перші ознаки.' },
              ] },
              { type: 'p', text: 'Для тих, хто має кілька епізодів в анамнезі, окрему доказову роль у профілактиці рецидиву відіграє майндфулнес-орієнтована КПТ (MBCT): індивідуальний метааналіз показав зниження ризику повернення депресії, особливо при залишкових симптомах (Kuyken та ін., 2016).' },
              { type: 'quote', text: 'Депресію лікують не лише до полегшення, а й «на виріст» — щоб людина впізнала спад раніше за нього самого.' },
              { type: 'sources', sources: [
                { label: 'Kuyken та ін. (2016). MBCT для профілактики рецидиву депресії: індивідуальний метааналіз. JAMA Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/27119968/' },
                { label: 'NICE (2022). Depression in adults (NG222) — оцінка ризику й профілактика рецидиву.', url: 'https://www.nice.org.uk/guidance/ng222' },
                { label: 'Cuijpers та ін. (2023). Психотерапії депресії: метааналіз. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
              ] },
            ],
            bodyEn: [
              { type: 'p', text: 'Two things you must not miss in depression: safety now and durability later. Depression raises the risk of suicidal thoughts, so risk is screened directly and regularly. And because depression tends to return, relapse prevention is built in from the start.' },
              { type: 'h', text: 'Risk — ask directly' },
              { type: 'p', text: 'Low mood and hopelessness often travel with thoughts of "better if I weren\'t here". As in the risk-screening module: normalise, ask directly, stay calm and warm, and build a safety plan if needed. Avoiding the topic is more dangerous than asking.' },
              { type: 'figure', figure: 'risk-ladder', caption: 'The same clarifying logic as in the intake course: thoughts → plan → means → intent.' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'Sometimes I think my family would be calmer without me.' },
                { who: 'Therapist', text: 'Thank you for telling me — that matters. When mood is this low, such thoughts do come up. Have you had thoughts of doing something to end your life?' },
              ] },
              { type: 'h', text: 'Relapse prevention' },
              { type: 'p', text: 'Getting better is not the end of the work but the time to prepare for possible dips. Together you build a plan: early signs ("sleep slipping", "starting to cancel meetings"), what helped before (activation, contacts, a professional) and concrete actions at the first signs.' },
              { type: 'list', items: [
                { term: 'Early markers', text: 'individual signals that a dip is starting.' },
                { term: 'Working tools', text: 'what already helped: activation, people, skills.' },
                { term: 'Action plan', text: 'what to do and who to call at the first signs.' },
              ] },
              { type: 'p', text: 'For those with several past episodes, mindfulness-based cognitive therapy (MBCT) has a distinct evidence-based role in relapse prevention: an individual-patient meta-analysis showed reduced risk of depression returning, especially with residual symptoms (Kuyken et al., 2016).' },
              { type: 'quote', text: 'Depression is treated not only to relief but "for the future" — so the person recognises a dip before it recognises them.' },
              { type: 'sources', sources: [
                { label: 'Kuyken et al. (2016). MBCT for prevention of depressive relapse: individual patient data meta-analysis. JAMA Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/27119968/' },
                { label: 'NICE (2022). Depression in adults (NG222) — risk assessment and relapse prevention.', url: 'https://www.nice.org.uk/guidance/ng222' },
                { label: 'Cuijpers et al. (2023). Psychotherapies for depression: meta-analysis. World Psychiatry.', url: 'https://pubmed.ncbi.nlm.nih.gov/36640411/' },
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
];
