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
              { type: 'p', text: 'OARS — чотири базові навички слухання з мотиваційного інтервʼю: Open questions (відкриті питання), Affirmations (підтримки), Reflections (рефлексії), Summaries (резюме). Цей урок — про перші дві найпотужніші.' },
              { type: 'h', text: 'Відкриті vs закриті' },
              { type: 'figure', figure: 'oars' },
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
              { type: 'figure', figure: 'oars' },
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
            kind: 'lesson',
            titleUk: 'Підтримки та резюмування (A і S)',
            titleEn: 'Affirmations and summaries (A & S)',
            bodyUk: [
              { type: 'p', text: 'Ти вже знаєш O і R — відкриті питання й рефлексії. Лишаються A (Affirmations — підтримки) і S (Summaries — резюме). Разом вони роблять слухання повним і структурованим.' },
              { type: 'h', text: 'Підтримки (A)' },
              { type: 'p', text: 'Підтримка визнає сильну сторону або зусилля клієнта — щиро й конкретно, а не загальне «молодець». Вона зміцнює віру людини у власні сили й тримає альянс.' },
              { type: 'list', items: [
                { term: 'Загальне (слабко)', text: '«Ви молодець.» — звучить порожньо.' },
                { term: 'Конкретне (сильно)', text: '«Ви прийшли сюди, попри те що говорити про це страшно. Це вимагає сміливості.»' },
              ] },
              { type: 'h', text: 'Резюмування (S)' },
              { type: 'p', text: 'Резюме збирає докупи кілька речей, які сказав клієнт. Показує, що ти тримаєш нитку, і допомагає перейти далі. Типи: збиральне (підсумувати), звʼязувальне (поєднати з раніше сказаним), перехідне (закрити тему й відкрити нову).' },
              { type: 'dialogue', lines: [
                { who: 'Терапевт', text: 'Дозвольте підсумую, щоб переконатися, що правильно зрозумів. Ви виснажені на роботі, ночами не спите, і найбільше лякає, що це впливає на доньку. Я нічого не пропустив?' },
                { who: 'Клієнт', text: 'Так… саме за доньку найбільше.' },
              ] },
              { type: 'h', text: 'Чому A і S важливі' },
              { type: 'list', items: [
                { text: 'Підтримки утримують мотивацію й робочий альянс.' },
                { text: 'Резюме структурують сесію й показують клієнту, що його почули цілісно, а не уривками.' },
              ] },
              { type: 'quote', text: 'Резюме — це дзеркало для всієї розмови, а не для одного речення.' },
            ],
            bodyEn: [
              { type: 'p', text: 'You already have O and R — open questions and reflections. That leaves A (Affirmations) and S (Summaries). Together they make listening complete and structured.' },
              { type: 'h', text: 'Affirmations (A)' },
              { type: 'p', text: "An affirmation names a strength or effort — sincerely and specifically, not a generic \"well done\". It builds the client's belief in their own resources and holds the alliance." },
              { type: 'list', items: [
                { term: 'Generic (weak)', text: '"You\'re doing great." — sounds empty.' },
                { term: 'Specific (strong)', text: '"You came here even though talking about this is frightening. That takes courage."' },
              ] },
              { type: 'h', text: 'Summaries (S)' },
              { type: 'p', text: 'A summary pulls several things the client said together. It shows you are holding the thread and helps move on. Types: collecting (recap), linking (tie to earlier), transitional (close a topic and open a new one).' },
              { type: 'dialogue', lines: [
                { who: 'Therapist', text: 'Let me summarise to make sure I got it right. You are exhausted at work, not sleeping at night, and what scares you most is the effect on your daughter. Did I miss anything?' },
                { who: 'Client', text: 'Yes… it\'s the daughter that worries me most.' },
              ] },
              { type: 'h', text: 'Why A and S matter' },
              { type: 'list', items: [
                { text: 'Affirmations sustain motivation and the working alliance.' },
                { text: 'Summaries structure the session and show the client they were heard as a whole, not in fragments.' },
              ] },
              { type: 'quote', text: 'A summary is a mirror for the whole conversation, not for a single sentence.' },
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
              { type: 'figure', figure: 'risk-ladder' },
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
              { type: 'figure', figure: 'risk-ladder' },
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
            kind: 'lesson',
            titleUk: 'Після відповіді: план безпеки',
            titleEn: 'After the answer: the safety plan',
            bodyUk: [
              { type: 'p', text: 'Спитати про ризик — лише половина справи. Друга половина — що робити з відповіддю. Паніка чи різка зміна теми руйнують довіру; спокійний, конкретний наступний крок — навпаки, тримає людину.' },
              { type: 'h', text: 'Якщо ризик є — не лишай клієнта самого з цим' },
              { type: 'p', text: 'Подякуй за відвертість, лишайся спокійним і теплим, і переходь до спільного плану безпеки замість фальшивих обіцянок на кшталт «усе буде добре».' },
              { type: 'h', text: 'Базовий план безпеки' },
              { type: 'list', items: [
                { term: 'Тригери', text: 'що передує загостренню — сигнали тіла, думки, ситуації.' },
                { term: 'Навички самозаспокоєння', text: 'що допомагає перечекати хвилю (дихання, дзвінок, прогулянка).' },
                { term: 'Люди', text: 'кому можна подзвонити, зокрема вночі.' },
                { term: 'Кризові контакти', text: 'лінія довіри, екстрена допомога.' },
                { term: 'Безпека середовища', text: 'тимчасово зменшити доступ до засобів.' },
              ] },
              { type: 'h', text: 'Коли ескалувати' },
              { type: 'p', text: 'Якщо є конкретний план, доступ до засобів і намір — це гостра ситуація: не залишай людину саму, залучай кризові служби чи екстрену допомогу, дій за протоколом установи. У тренажері це навчальна вправа, а не реальна криза.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Іноді думаю, що всім було б легше без мене.' },
                { who: 'Терапевт', text: 'Дякую, що сказали — це важливо й сміливо. Можна я розпитаю трохи докладніше, щоб зрозуміти, наскільки вам зараз небезпечно?' },
              ] },
              { type: 'quote', text: 'План безпеки — це конкретні кроки на випадок темної ночі, складені завчасно, при світлі.' },
            ],
            bodyEn: [
              { type: 'p', text: 'Asking about risk is only half the job. The other half is what you do with the answer. Panic or an abrupt topic change breaks trust; a calm, concrete next step holds the person.' },
              { type: 'h', text: 'If there is risk — do not leave the client alone with it' },
              { type: 'p', text: 'Thank them for being honest, stay calm and warm, and move to a collaborative safety plan instead of false reassurance like "it\'ll all be fine".' },
              { type: 'h', text: 'A basic safety plan' },
              { type: 'list', items: [
                { term: 'Triggers', text: 'what precedes a crisis — body cues, thoughts, situations.' },
                { term: 'Coping skills', text: 'what helps ride out the wave (breathing, a call, a walk).' },
                { term: 'People', text: 'who can be called, including at night.' },
                { term: 'Crisis contacts', text: 'helpline, emergency services.' },
                { term: 'Environment safety', text: 'temporarily reduce access to means.' },
              ] },
              { type: 'h', text: 'When to escalate' },
              { type: 'p', text: 'If there is a concrete plan, access to means and intent — this is acute: do not leave the person alone, involve crisis services or emergency care, follow your setting\'s protocol. In the simulator this is a training exercise, not a real crisis.' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'Sometimes I think everyone would be better off without me.' },
                { who: 'Therapist', text: 'Thank you for telling me — that matters and it\'s brave. May I ask a bit more, to understand how unsafe you feel right now?' },
              ] },
              { type: 'quote', text: 'A safety plan is concrete steps for the dark night, written in advance, in the light.' },
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
              { type: 'p', text: 'Тривога — не ворог і не поломка. Це давня система сигналізації тіла, що готує до загрози (бий–біжи–завмри). Проблема не в тривозі, а в хибних спрацюваннях, коли реальної небезпеки немає.' },
              { type: 'h', text: 'Що відбувається в тілі' },
              { type: 'list', items: [
                { text: 'Серце бʼється швидше — більше кисню до мʼязів.' },
                { text: 'Дихання прискорюється, мʼязи напружені.' },
                { text: 'Увага звужується на загрозі.' },
                { text: 'Усе це рятує перед реальною небезпекою — і виснажує, коли її немає.' },
              ] },
              { type: 'h', text: 'Чому це важливо сказати клієнту' },
              { type: 'p', text: 'Психоедукація знижує «страх страху». Коли людина розуміє, що калатання серця — це адреналін, а не інфаркт, паніка втрачає частину сили.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Мені здається, я божеволію, коли це накочує.' },
                { who: 'Терапевт', text: 'Те, що ви описуєте, дуже схоже на роботу системи тривоги — неприємно, але безпечно. Розповісти, що відбувається в тілі?' },
              ] },
              { type: 'quote', text: 'Мета не «прибрати тривогу», а змінити стосунки з нею.' },
            ],
            bodyEn: [
              { type: 'p', text: 'Anxiety is not an enemy or a malfunction. It is the body\'s ancient alarm system preparing for threat (fight–flight–freeze). The problem is not anxiety itself but false alarms, when there is no real danger.' },
              { type: 'h', text: 'What happens in the body' },
              { type: 'list', items: [
                { text: 'The heart beats faster — more oxygen to the muscles.' },
                { text: 'Breathing speeds up, muscles tense.' },
                { text: 'Attention narrows onto the threat.' },
                { text: 'All life-saving before real danger — and exhausting when there is none.' },
              ] },
              { type: 'h', text: 'Why it matters to tell the client' },
              { type: 'p', text: 'Psychoeducation lowers the "fear of fear". When a person understands that a pounding heart is adrenaline, not a heart attack, panic loses some of its grip.' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'I feel like I\'m going crazy when it hits.' },
                { who: 'Therapist', text: 'What you describe sounds a lot like the alarm system firing — unpleasant, but safe. Shall I explain what happens in the body?' },
              ] },
              { type: 'quote', text: 'The goal is not to "remove" anxiety but to change your relationship with it.' },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Цикл тривоги й уникання',
            titleEn: 'The anxiety–avoidance loop',
            bodyUk: [
              { type: 'p', text: 'Уникання дає миттєве полегшення — і саме тому підтримує тривогу. Кожне уникання «вчить» мозок, що ситуація справді небезпечна.' },
              { type: 'h', text: 'Як працює цикл' },
              { type: 'figure', figure: 'anxiety-loop' },
              { type: 'list', items: [
                { text: 'Тригер → тривога росте → уникання чи втеча → миттєве полегшення.' },
                { text: 'Мозок робить висновок: «небезпечно, добре що втік».' },
                { text: 'Наступного разу тривога ще сильніша — цикл закручується.' },
              ] },
              { type: 'h', text: 'Що з цим робити' },
              { type: 'p', text: 'Розірвати цикл — означає поступово лишатися в ситуації досить довго, щоб тривога спала сама (а вона завжди спадає). Це основа експозиції, до якої дійдемо в третьому модулі.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Я просто не ходжу у великі супермаркети, так спокійніше.' },
                { who: 'Терапевт', text: 'І це справді знімає тривогу тут і зараз. Подивимось разом, що стається з тривогою наступного разу?' },
              ] },
              { type: 'quote', text: 'Уникання — це знеболювальне, яке підживлює хворобу.' },
            ],
            bodyEn: [
              { type: 'p', text: 'Avoidance brings instant relief — and that is exactly why it maintains anxiety. Each avoidance "teaches" the brain the situation really is dangerous.' },
              { type: 'h', text: 'How the loop works' },
              { type: 'figure', figure: 'anxiety-loop' },
              { type: 'list', items: [
                { text: 'Trigger → anxiety rises → avoid or escape → instant relief.' },
                { text: 'The brain concludes: "dangerous, good thing I fled".' },
                { text: 'Next time anxiety is even stronger — the loop tightens.' },
              ] },
              { type: 'h', text: 'What to do about it' },
              { type: 'p', text: 'Breaking the loop means gradually staying in the situation long enough for anxiety to fall on its own (it always does). That is the basis of exposure, covered in module 3.' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'I just don\'t go to big supermarkets, it\'s calmer that way.' },
                { who: 'Therapist', text: 'And that really does ease the anxiety right now. Shall we look together at what happens to it next time?' },
              ] },
              { type: 'quote', text: 'Avoidance is a painkiller that feeds the illness.' },
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
              { type: 'p', text: 'Коли тривога висока, мислення майже не працює — спершу треба збити фізіологічну хвилю. Дві прості навички: сповільнене дихання й заземлення.' },
              { type: 'h', text: 'Сповільнене дихання' },
              { type: 'p', text: 'Видих, довший за вдих, заспокоює нервову систему. Орієнтир: вдих на 4, видих на 6, кілька хвилин. Важливо не глибоко, а повільно.' },
              { type: 'h', text: 'Заземлення 5-4-3-2-1' },
              { type: 'figure', figure: 'grounding' },
              { type: 'list', items: [
                { text: '5 речей, які бачиш; 4 — які чуєш; 3 — яких торкаєшся; 2 — які відчуваєш на запах; 1 — смак.' },
                { text: 'Повертає увагу з «голови» в «тут і зараз».' },
              ] },
              { type: 'h', text: 'Як навчати навички в сесії' },
              { type: 'list', items: [
                { text: 'Спершу поясни навіщо.' },
                { text: 'Покажи і зроби разом тут.' },
                { text: 'Дай спробувати клієнту самому.' },
                { text: 'Домовся про практику між сесіями.' },
              ] },
              { type: 'quote', text: 'Навичка, яку не відпрацювали в кабінеті, рідко спрацьовує вдома.' },
            ],
            bodyEn: [
              { type: 'p', text: 'When anxiety is high, thinking barely works — first knock down the physiological wave. Two simple skills: slowed breathing and grounding.' },
              { type: 'h', text: 'Slowed breathing' },
              { type: 'p', text: 'An exhale longer than the inhale calms the nervous system. A guide: in for 4, out for 6, for a few minutes. Slow matters more than deep.' },
              { type: 'h', text: 'Grounding 5-4-3-2-1' },
              { type: 'figure', figure: 'grounding' },
              { type: 'list', items: [
                { text: '5 things you see; 4 you hear; 3 you touch; 2 you smell; 1 you taste.' },
                { text: 'Pulls attention out of "the head" and into the here and now.' },
              ] },
              { type: 'h', text: 'How to teach a skill in session' },
              { type: 'list', items: [
                { text: 'Explain the rationale first.' },
                { text: 'Demonstrate and do it together here.' },
                { text: 'Let the client try it themselves.' },
                { text: 'Agree on practice between sessions.' },
              ] },
              { type: 'quote', text: 'A skill not rehearsed in the room rarely works at home.' },
            ],
          },
          {
            kind: 'lesson',
            titleUk: 'Робота з тривожними думками',
            titleEn: 'Working with anxious thoughts',
            bodyUk: [
              { type: 'p', text: 'Тривога живиться думками-передбаченнями катастрофи: «я зганьблюся», «станеться найгірше». З ними працюють не суперечкою, а перевіркою.' },
              { type: 'h', text: 'Типові пастки мислення' },
              { type: 'list', items: [
                { term: 'Катастрофізація', text: 'одразу найгірший сценарій.' },
                { term: 'Читання думок', text: '«усі думають, що я нікчема».' },
                { term: 'Чорно-біле мислення', text: 'або ідеально, або провал.' },
                { term: 'Переоцінка ймовірності', text: 'малоймовірне здається неминучим.' },
              ] },
              { type: 'h', text: 'Перевірка думки' },
              { type: 'list', items: [
                { text: 'Яка саме думка лякає?' },
                { text: 'Які докази за і проти?' },
                { text: 'Що найімовірніше станеться насправді?' },
                { text: 'Що б я сказав другові з такою думкою?' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Якщо я помилюся на зустрічі, всі вирішать, що я нікчема.' },
                { who: 'Терапевт', text: 'Це звучить лякаюче. А якби колега помилився — ви б вирішили, що він нікчема?' },
              ] },
              { type: 'quote', text: 'Ми не сперечаємося з думкою — ми робимо її перевіряною.' },
            ],
            bodyEn: [
              { type: 'p', text: 'Anxiety feeds on catastrophe-predicting thoughts: "I\'ll humiliate myself", "the worst will happen". You work with them not by arguing but by testing.' },
              { type: 'h', text: 'Common thinking traps' },
              { type: 'list', items: [
                { term: 'Catastrophising', text: 'jumping straight to the worst case.' },
                { term: 'Mind-reading', text: '"everyone thinks I\'m worthless".' },
                { term: 'Black-and-white thinking', text: 'either perfect or a failure.' },
                { term: 'Overestimating probability', text: 'the unlikely feels inevitable.' },
              ] },
              { type: 'h', text: 'Testing a thought' },
              { type: 'list', items: [
                { text: 'What exactly is the frightening thought?' },
                { text: 'What is the evidence for and against?' },
                { text: 'What will most likely actually happen?' },
                { text: 'What would I tell a friend with this thought?' },
              ] },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'If I slip up in the meeting, everyone will decide I\'m worthless.' },
                { who: 'Therapist', text: 'That sounds frightening. And if a colleague slipped up — would you decide they were worthless?' },
              ] },
              { type: 'quote', text: 'We don\'t argue with a thought — we make it testable.' },
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
              { type: 'p', text: 'Експозиція — золотий стандарт роботи з тривогою. Ідея: поступово й безпечно лишатися в ситуації, що лякає, доки тривога спаде сама. Так мозок переписує висновок «це небезпечно».' },
              { type: 'h', text: 'Ключові принципи' },
              { type: 'list', items: [
                { term: 'Поступовість', text: 'від легшого до важчого.' },
                { term: 'Тривалість', text: 'лишатися, доки тривога спаде, а не тікати на піку.' },
                { term: 'Повторюваність', text: 'регулярно, а не один раз.' },
                { term: 'Без «рятувальних» ритуалів', text: 'вони знецінюють досвід.' },
              ] },
              { type: 'h', text: 'Шкала SUDS і ієрархія' },
              { type: 'figure', figure: 'suds' },
              { type: 'p', text: 'SUDS — субʼєктивна одиниця дискомфорту, 0–100. Разом із клієнтом складають «драбину» ситуацій від ~30 до ~90 і піднімаються поступово, крок за кроком.' },
              { type: 'dialogue', lines: [
                { who: 'Клієнт', text: 'Я ніколи не зможу виступати перед людьми.' },
                { who: 'Терапевт', text: 'Почнімо не з виступу. Що було б на 30 зі 100 — наприклад, поставити одне запитання на нараді?' },
              ] },
              { type: 'h', text: 'Чого не робити' },
              { type: 'list', items: [
                { text: 'Не штовхати в найстрашніше одразу.' },
                { text: 'Не дозволяти «рятувальну поведінку», що знецінює досвід.' },
              ] },
              { type: 'quote', text: 'Сміливість — це не відсутність тривоги, а дія поряд із нею.' },
            ],
            bodyEn: [
              { type: 'p', text: 'Exposure is the gold standard for anxiety. The idea: gradually and safely stay in the feared situation until anxiety subsides on its own. This is how the brain rewrites the "it\'s dangerous" conclusion.' },
              { type: 'h', text: 'Key principles' },
              { type: 'list', items: [
                { term: 'Gradual', text: 'from easier to harder.' },
                { term: 'Duration', text: 'stay until anxiety falls, don\'t flee at the peak.' },
                { term: 'Repeated', text: 'regularly, not once.' },
                { term: 'No "safety" rituals', text: 'they undermine the experience.' },
              ] },
              { type: 'h', text: 'The SUDS scale and a hierarchy' },
              { type: 'figure', figure: 'suds' },
              { type: 'p', text: 'SUDS is a subjective unit of distress, 0–100. With the client you build a "ladder" of situations from ~30 to ~90 and climb it step by step.' },
              { type: 'dialogue', lines: [
                { who: 'Client', text: 'I\'ll never be able to speak in front of people.' },
                { who: 'Therapist', text: 'Let\'s not start with a speech. What would be a 30 out of 100 — say, asking one question in a meeting?' },
              ] },
              { type: 'h', text: 'What not to do' },
              { type: 'list', items: [
                { text: 'Don\'t push into the scariest thing at once.' },
                { text: 'Don\'t allow "safety behaviours" that undermine the experience.' },
              ] },
              { type: 'quote', text: 'Courage is not the absence of anxiety but action alongside it.' },
            ],
          },
          {
            kind: 'quiz',
            titleUk: 'Перевірка: експозиція',
            titleEn: 'Check: exposure',
            quizUk: [
              {
                q: 'У чому головна ідея експозиції?',
                options: ['Відволікти клієнта від страху', 'Поступово лишатися в лякаючій ситуації, доки тривога спаде сама', 'Прибрати всі тригери', 'Переконати, що страху немає'],
                correct: 1,
                explain: 'Залишаючись, клієнт дає тривозі спасти й переписує висновок «небезпечно».',
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
                q: 'What is the core idea of exposure?',
                options: ['Distract the client from fear', 'Gradually stay in the feared situation until anxiety subsides on its own', 'Remove all triggers', 'Convince them there is no fear'],
                correct: 1,
                explain: 'By staying, the client lets anxiety fall and rewrites the "dangerous" conclusion.',
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
              { type: 'p', text: 'Завдання: разом з Анною оберіть один страх і складіть перший крок ієрархії (щось на ~30 за SUDS). Поясни принцип «лишатися, доки спаде». Заверши сесію й отримай фідбек.' },
            ],
            bodyEn: [
              { type: 'p', text: 'Task: with Anna, pick one fear and build the first step of a hierarchy (something around 30 on SUDS). Explain the "stay until it subsides" principle. End the session and get feedback.' },
            ],
          },
        ],
      },
    ],
  },
];
