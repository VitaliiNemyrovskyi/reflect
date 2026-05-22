import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

interface ProfileFile {
  slug: string;
  displayName: string;
  profileText: string;
  diagnosis: string | null;     // Ukrainian label, e.g. "Затяжна реакція горя"
  diagnosisCode: string | null; // English/DSM-5 code, shown as tooltip
  difficulty: number | null;    // behavioral (Поведінка:) — modulates LLM
  complexity: number | null;    // clinical (Тяжкість:) — informational
  modality: string | null;      // therapy modality (Модальність:) — couples/family/etc.
  avatarUrl: string | null;
}

@Injectable()
export class PromptsService implements OnModuleInit {
  private readonly logger = new Logger(PromptsService.name);

  readonly annaSystem: string;
  readonly supervisorSystem: string;
  readonly supervisorProtocol: string;
  readonly hintSystem: string;
  readonly patientGenerationSystem: string;
  /** Second-pass reviewer prompt — the "two-pass feedback" mode loads
   *  this and feeds the Pass-1 draft + transcript + profile to a
   *  reviewer agent that returns an improved final version. */
  readonly criticReviewer: string;

  /**
   * Skill-agent prompts for the "skills" feedback mode. Each skill is a
   * short, hyper-focused prompt targeting ONE clinical dimension. They
   * run in parallel (Pass 2) and return JSON; a synthesis model (Pass 3)
   * integrates the JSON findings with the Pass-1 draft → final feedback.
   *
   * Loaded from prompts/skills/*.md (except synthesis.md).
   * Key: filename without .md (e.g. 'risk_screening').
   */
  readonly skills: Map<string, string>;

  /** Synthesis template — combines Pass-1 draft + skill JSON results
   *  into final coherent feedback. Placeholders: PROFILE, TRANSCRIPT,
   *  NOTES, DRAFT, SKILL_RESULTS. */
  readonly skillsSynthesis: string;

  private readonly promptsDir: string;
  private readonly profilesDir: string;

  constructor(private readonly prisma: PrismaService) {
    this.promptsDir =
      process.env.PROMPTS_DIR ?? resolve(process.cwd(), '..', 'prompts');
    const promptsDir = this.promptsDir;
    this.annaSystem = this.read(promptsDir, 'anna_system.md');
    this.supervisorSystem = this.read(promptsDir, 'supervisor_system.md');
    const protocolRaw = this.read(promptsDir, 'supervisor_protocol.md');
    // The full protocol prepends ~50 lines of "Джерела протоколу"
    // (canonical sources) and "Mapping … на канонічні шкали"
    // (cross-walk to MITI / CTS-R / Carkhuff). Useful for humans
    // editing the protocol, but the LLM doesn't need these meta
    // sections at runtime — the eight rubric sections ("## Вимір 1."
    // … "## Вимір 8.") already encode the grading criteria. Trimming
    // them saves ~3K tokens per feedback call, which is what keeps us
    // under OpenRouter's free-tier 24817-token prompt cap.
    const firstDimensionIdx = protocolRaw.search(/^##\s*Вимір\s*1\./m);
    this.supervisorProtocol =
      firstDimensionIdx >= 0
        ? '# Протокол першої (інтейкової) сесії\n\n' +
          protocolRaw.slice(firstDimensionIdx).trimEnd()
        : protocolRaw;
    this.hintSystem = this.read(promptsDir, 'hint_system.md');
    this.patientGenerationSystem = this.read(promptsDir, 'patient_generation_system.md');
    this.criticReviewer = this.read(promptsDir, 'critic_reviewer.md');
    this.profilesDir = resolve(promptsDir, 'profiles');

    // Load skill prompts from prompts/skills/*.md. Dynamically discovered
    // so adding a new skill file is enough — no code changes needed.
    const skillsDir = resolve(promptsDir, 'skills');
    this.skills = new Map();
    if (existsSync(skillsDir)) {
      for (const file of readdirSync(skillsDir)) {
        if (!file.endsWith('.md')) continue;
        const name = file.slice(0, -3); // strip .md
        if (name === 'synthesis') continue; // loaded separately below
        this.skills.set(name, readFileSync(resolve(skillsDir, file), 'utf8'));
        this.logger.debug(`Loaded skill: ${name}`);
      }
    }
    this.skillsSynthesis = existsSync(resolve(skillsDir, 'synthesis.md'))
      ? readFileSync(resolve(skillsDir, 'synthesis.md'), 'utf8')
      : this.criticReviewer; // graceful fallback to standard reviewer
    this.logger.log(`Loaded ${this.skills.size} skill prompts from ${skillsDir}`);
  }

  private read(dir: string, name: string): string {
    return readFileSync(resolve(dir, name), 'utf8');
  }

  fill(template: string, vars: Record<string, string>): string {
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v),
      template,
    );
  }

  profileLooksUnfilled(profileText: string): boolean {
    return profileText.length < 800 || /\[\s*заповн/i.test(profileText);
  }

  /**
   * Returns a behavioral modulator instruction string to append to a character's
   * system prompt. The modulator scales how strongly the character resists,
   * tests the therapist, and reveals their hidden layer.
   *
   * Independent of the character's specific profile (defenses, biography) —
   * just controls intensity.
   */
  getDifficultyModulator(level: number | null): string {
    if (level == null || level < 1 || level > 5) return '';

    const intro =
      '\n\n# Налаштування складності цієї сесії\n\n' +
      'Профіль пацієнта вище описує твою унікальну особистість — захисти, ' +
      'прихований шар, мовні особливості. Залиши все це. Параметр нижче ' +
      'модулює лише **інтенсивність** твоєї поведінки в цій сесії.\n\n';

    const modulators: Record<number, string> = {
      1:
        '**Рівень 1 з 5 — лагідний, навчальний.**\n' +
        '- Швидко відкриваєшся, навіть на базові питання.\n' +
        '- Захист, описаний у профілі — м\'якший за зазвичай. Майже не тестуєш терапевта.\n' +
        '- Сама виносиш важливі деталі без скеровуючих питань.\n' +
        '- Прихований шар (з профілю) починаєш натякати вже на перших 10 хвилинах.\n' +
        '- Якщо терапевтка робить помилку (закрите питання, рада на 5-й хв) — продовжуєш ' +
        'розкриватися, не закриваєшся.\n' +
        '- Це тренувальний режим для самого новачка.',

      2:
        '**Рівень 2 з 5 — кооперативний реалістичний.**\n' +
        '- Перші 3-5 хв викладаєш свою презентацію згідно профілю.\n' +
        '- Захист, описаний у профілі — нормальної інтенсивності.\n' +
        '- Тестуєш терапевта легко (1-2 рази за сесію — чи зреагує на іронію, ' +
        'чи витримає тишу).\n' +
        '- Відкриваєшся на хороших OARS-репліках (open questions, reflections).\n' +
        '- Прихований шар (з профілю) починаєш натякати на 15-20 хв сесії, ' +
        'якщо терапевтка створює простір.\n' +
        '- На грубі помилки терапевтки реагуєш помітно — пауза, коротша відповідь, ' +
        'але повертаєшся до контакту.',

      3:
        '**Рівень 3 з 5 — стандартний клінічний випадок.**\n' +
        '- Перші 5-10 хв тестуєш терапевта помірно: жарти, відсторонення, ' +
        'формальні відповіді.\n' +
        '- Захист, описаний у профілі — активний. Якщо терапевтка не помічає тонких ' +
        'сигналів, ти продовжуєш у захисті.\n' +
        '- Відкриваєшся **тільки** на CTRS Level 3+ роботі: коректні reflection, ' +
        'guided discovery, here-and-now коментарі.\n' +
        '- Прихований шар (з профілю) починаєш натякати на 20-25 хв, **тільки** якщо ' +
        'терапевтка двічі повертала тебе до твоїх же слів і не лізла у поради.\n' +
        '- На помилки реагуєш чітко — закриваєшся на 3-5 хв, повертаєшся при ' +
        'наступному правильному ходові.',

      4:
        '**Рівень 4 з 5 — складний, потребує досвіду.**\n' +
        '- Перші 10-15 хв тестуєш терапевта серйозно: звітний голос, мінімум ' +
        'емоції, автоматичні «нормально», постійна оцінка чи варто довіряти.\n' +
        '- Захист, описаний у профілі — **посилений**. Інтелектуалізація, гумор, ' +
        'мінімізація, переключення тем — все на максимумі.\n' +
        '- Відповіді часто короткі (1-2 речення замість абзацу).\n' +
        '- Терапевтка повинна **двічі-тричі повернутися** до однієї теми перш ніж ' +
        'ти даси справжню відповідь.\n' +
        '- Прихований шар (з профілю) **не виявляється на 1-й сесії взагалі**, лише ' +
        'якщо терапевтка робить **Carkhuff Level 4** репліку (відображає невисловлене), ' +
        'натиснула на правильне місце і витримала тишу 10+ секунд.\n' +
        '- На стандартні помилки (поради, психоосвіта на 5-й хв) — закриваєшся надовго.\n' +
        '- На уточнюючі питання можеш відповідати «не знаю», «нічого особливого», ' +
        '«нормально», навіть коли неправда.',

      5:
        '**Рівень 5 з 5 — експертний випадок.**\n' +
        '- Дуже мала вербалізація. Відповіді частково мовчанням, частково 1-2 ' +
        'словами: «так», «нормально», «не знаю», «бачили».\n' +
        '- Захист, описаний у профілі — на максимумі. Часто **тіло говорить замість слів** ' +
        '(якщо це доречно профілю — стискання, опускання погляду, дотик до якогось ' +
        'предмета).\n' +
        '- Тиша 30-60 секунд для тебе нормальна. Не заповнюєш її.\n' +
        '- Прихований шар (з профілю) **майже не виявляється** за 1-3 сесії. Може ' +
        'зачепитися лише при ідеальному комбо: точне Carkhuff-5 reflection + ' +
        'тривала тиша + зорове підтвердження безпеки.\n' +
        '- На більшість стандартних інтервенцій реагуєш ще більшою тишею.\n' +
        '- Не тебе вилікувати за сесію — тебе **витримати**, дати простір, дочекатися ' +
        'тонкого моменту відкритості. Якщо терапевтка не вміє цього — ти не ' +
        'зрушишся з місця, і це нормально, і це урок.',
    };

    return intro + modulators[level];
  }

  /**
   * Modality modulator for the CHAT (patient persona) side. Appended
   * to the character's system prompt so the AI knows how to play the
   * scene — solo, two partners, family system, teen, or crisis.
   *
   * Empty string for 'individual' (the implicit default — no extra
   * instructions needed) and for unknown modalities so a typo can't
   * accidentally inject prompt text.
   */
  getModalityChatModulator(modality: string | null | undefined): string {
    if (!modality || modality === 'individual') return '';
    const intro = '\n\n# Налаштування модальності цієї сесії\n\n';
    const modulators: Record<string, string> = {
      couples:
        '**Це парна сесія.** У кабінеті двоє партнерів.\n\n' +
        '- Ти граєш ОБОХ партнерів. Профіль вище описує **головну** клієнтку/-та — це та, ' +
        'хто переважно говоритиме та найбільше у фокусі.\n' +
        '- Другий партнер також у кабінеті. Опиши коротко (1-2 речення на початку сесії) ' +
        'хто він/вона, який тон.\n' +
        '- Коли терапевт прямо звертається до другого партнера — відповідай від його імені у ' +
        'форматі: `[Імʼя другого партнера]: репліка...`\n' +
        '- Між партнерами буває напруга, тиха агресія, перебивання. Ти можеш зімітувати ' +
        'короткий обмін між партнерами, якщо терапевт залишає простір.\n' +
        '- Не «давай готову динаміку» одразу — нехай терапевт побачить її через те, як ви ' +
        'двоє реагуєте на одну і ту саму репліку.',

      family:
        '**Це сімейна сесія.** У кабінеті кілька членів родини.\n\n' +
        '- Ти граєш **усю систему** одночасно. Профіль вище описує ідентифікованого ' +
        'клієнта (часто дитина / підліток, або один із батьків). Решту учасників ' +
        '(батьки/сиблінги/etc.) вгадай по контексту або вибудуй коротко на старті.\n' +
        '- Кожна репліка від конкретного члена родини починається з `[Імʼя]: ...` крім ' +
        'ідентифікованого клієнта — він говорить «за замовчуванням».\n' +
        '- Демонструй системну динаміку: тригуляція, scapegoating, parentified child, ' +
        'enmeshment або disengagement — те, що описано в профілі або органічне для цієї сімʼї.\n' +
        '- Якщо терапевт центрується на одному — інші можуть втратити інтерес або ' +
        'обороняти центрованого.\n' +
        '- Не дай терапевту легко стати «суддею» — система спротивляється цьому.',

      adolescent:
        '**Це підліткова сесія.** Клієнт — підліток 12-18 років.\n\n' +
        '- Мова — як в реального підлітка: коротше, без професійних термінів, можливо ' +
        'сленг або англіцизми (TikTok, чілити, краш, кринж і т.ін.) — там де профіль ' +
        'дозволяє.\n' +
        '- Захист — типовий для віку: однослівні відповіді, «не знаю», «нормально», ' +
        'погляд у телефон, перевірка чи терапевту реально не байдуже.\n' +
        '- Тема конфіденційності особливо актуальна — підліток МАЄ перевіряти, чи розкаже ' +
        'терапевт батькам, не одразу довіряє межам.\n' +
        '- Шкільний контекст — постійно поряд (вчителі, оцінки, друзі, булінг, дед-лайни).\n' +
        '- Не випливай у роль дорослого — підліток може бути дуже мудрим у моменти, але ' +
        'мова, тон, реакції лишаються віковими.',

      crisis:
        '**Це кризова інтервенція.** Клієнт у гострому стані.\n\n' +
        '- Стан, описаний у профілі — **зараз, у моменті**. Не «розповідає про колишню ' +
        'тривогу» — переживає її просто перед терапевтом.\n' +
        '- Можливі прояви: суїцидальні думки, флешбек, дисоціація, ПА, гостре горе, ' +
        'панічне збудження. Конкретика — з профілю.\n' +
        '- Якщо терапевт пропонує grounding (5-4-3-2-1, дихання, контакт з предметом) — ' +
        'спочатку відмова чи скептицизм, але після наполегливості — реагуєш фізіологічно ' +
        '(заспокоюєшся / повертаєшся в контакт).\n' +
        '- Якщо терапевт працює як на регулярній сесії (інтерпретує, психоосвіта на 5-й ' +
        'хвилині, поради) — це не допомагає, ти можеш дезорганізуватись сильніше.\n' +
        '- Тебе **не треба вилікувати** за сесію — тебе треба стабілізувати, оцінити ризик, ' +
        'зробити safety plan, передати/довести до наступної ланки.',
    };
    return intro + (modulators[modality] ?? '');
  }

  /**
   * Brevity instruction for the chat side. Soft-caps the patient
   * reply length so we don't burn tokens on monologue-style replies
   * that don't help the trainee anyway (real therapy patients give
   * short, textured answers — not essays).
   *
   * Word cap scales by difficulty AND modality:
   *  - Easier patients (D1-D2) talk more openly → larger budget.
   *  - Harder patients (D4-D5) are terse by nature → small budget.
   *  - Couples / family need to voice multiple people → wider budget.
   *  - Crisis sessions need terse, in-the-moment replies.
   *
   * Returns empty for missing inputs — never penalize a request that
   * lacks the metadata.
   */
  getBrevityInstruction(
    difficulty: number | null | undefined,
    modality: string | null | undefined,
  ): string {
    const d = difficulty ?? 3;
    if (d < 1 || d > 5) return '';

    // Base word cap per modality at D3 (mid difficulty).
    const baseByModality: Record<string, number> = {
      individual: 80,
      couples: 130,
      family: 160,
      adolescent: 50,
      crisis: 35,
    };
    const m = modality ?? 'individual';
    const base = baseByModality[m] ?? baseByModality.individual;

    // Each step from D3 shifts the cap by 20 words.
    // D1=+40, D2=+20, D3=0, D4=-20, D5=-40.
    const cap = Math.max(20, base + (3 - d) * 20);

    return (
      '\n\n# Жорсткий лімит довжини репліки\n\n' +
      `Максимум **${cap} слів** за хід. Це принципово — реальні пацієнти ` +
      "не говорять монологами, а терапевтична динаміка не з'являється з " +
      'розгорнутих абзаців.\n\n' +
      '- Якщо у тебе кілька персонажів у сцені (couples / family) — ' +
      'словобюджет ділиться МІЖ ними. Не подвоюй для кожного.\n' +
      '- Якщо терапевт прямо просить розгорнуту відповідь («розкажи ' +
      'детальніше», «з чого це починається?») — можеш перевищити ' +
      'одноразово, але повертайся до коротких реплік на наступному ходу.\n' +
      '- Якщо тиша / односкладна відповідь природна (D4-D5, кризовий стан) — ' +
      "дай саме її, не заповнюй простір.\n" +
      "- Перевищувати ліміт «бо хочеться розповісти більше» — не можна. " +
      'Терпеливість терапевта повинна витягнути більшу відповідь, не твоя ' +
      'багатослівність.'
    );
  }

  /**
   * Brevity instruction for the SUPERVISOR side. Caps the narrative
   * length so feedback stays focused and doesn't pad with truisms.
   */
  getSupervisorBrevityInstruction(): string {
    return (
      '\n\n# Лімит довжини narrative\n\n' +
      'Тримай розбір сесії у межах **800-1500 слів** (без JSON-блоку).\n\n' +
      '- Без води: «важливо слухати клієнта», «емпатія — ключ до контакту» ' +
      "тощо. Це truisms, вони не дадуть студенту жодного нового знання.\n" +
      '- Кожне твердження має додавати щось **специфічне до ЦІЄЇ сесії** з ' +
      'конкретним `[L<n>]` посиланням. Якщо не можеш прив\'язати до ' +
      'конкретного моменту — не пиши взагалі.\n' +
      '- Структуру тримай таку як у protocol, але кожен розділ — 2-4 ' +
      'абзаци максимум. Краще пропустити розділ ніж заповнити загальними ' +
      'фразами.\n' +
      '- Цитати з транскрипту короткі: 5-15 слів на цитату, не цілі репліки.'
    );
  }

  /**
   * Modality modulator for the SUPERVISOR (feedback) side. Appended
   * to the supervisor system prompt so the post-session analysis
   * weighs the right competencies for the case type.
   *
   * Empty for 'individual' — that's the default rubric.
   */
  getModalitySupervisorModulator(modality: string | null | undefined): string {
    if (!modality || modality === 'individual') return '';
    const intro = '\n\n# Особливості оцінки цієї модальності\n\n';
    const modulators: Record<string, string> = {
      couples:
        'Це **парна сесія**. У додаток до базової оцінки звернути окрему увагу на:\n' +
        '- **Alliance з обома партнерами** — терапевт не повинен брати чий-небудь бік, ' +
        'навіть негласно. Перевір баланс уваги, рефлексій, тону до обох.\n' +
        '- **Управління emotional flooding** одного партнера — чи терапевт зміг ' +
        'утримати простір, не дав одному «заглушити» іншого.\n' +
        '- **Перехід від звинувачень до запитів** — чи допоміг терапевт переформулювати ' +
        '«ти завжди…» в «мені потрібно, щоб…».\n' +
        '- **Робота з парою як з одиницею**, а не двома індивідами.',

      family:
        'Це **сімейна сесія**. У додаток до базової оцінки звернути окрему увагу на:\n' +
        '- **Системну перспективу** — терапевт не центрує одного «винуватця», бачить ' +
        'патерни, які підтримує вся система.\n' +
        '- **Тригуляцію** — чи не дав терапевт втягнути себе у коаліцію з одним членом ' +
        'проти інших.\n' +
        '- **Multi-partial alliance** — чи кожен член родини відчув, що його позиція ' +
        'почута.\n' +
        '- **Повнота складу системи** — пройди по ВСІХ членах родини з профілю, не лише ' +
        'по тих, хто фізично присутній на сесії. Якщо родина має дитину/підлітка/' +
        'батьків-літніх, які НЕ прийшли — це ОКРЕМЕ діагностичне питання: чому не привели? ' +
        'хто прийняв рішення? як це впливає на ту динаміку, яку ми бачимо? Терапевт мав ' +
        'би це назвати на 1-й сесії.\n' +
        '- **Реалістичність кроків** — інтервенції мають відповідати фазі розвитку родини ' +
        'та її ресурсам, а не «ідеальній моделі».',

      adolescent:
        'Це **сесія з підлітком**. У додаток до базової оцінки звернути окрему увагу на:\n' +
        '- **Developmental sensitivity** — чи терапевт говорив з підлітком як з підлітком, ' +
        'а не як з мініатюрним дорослим або з дитиною.\n' +
        '- **Конфіденційність** — чи були чітко проговорені межі (що дізнаються батьки, ' +
        'що ні), чи терапевт пояснив це до того, як підліток спитав.\n' +
        '- **Адекватний tempo** — не намагатися «вирвати» інсайт з першої сесії; підліткам ' +
        'треба більше часу на тестування довіри.\n' +
        '- **Інтеграція контексту** — школа, friend group, родинна динаміка враховані як ' +
        'співтворці симптомів, а не як фон.',

      crisis:
        'Це **кризова інтервенція**. У додаток до базової оцінки звернути окрему увагу на:\n' +
        '- **Risk assessment** — чи терапевт прямо оцінив ризик (суїцид, інші небезпеки), ' +
        'а не уник теми. У парадигмі CASE / SAFE-T / Columbia Protocol.\n' +
        '- **Grounding & stabilization** — чи використав конкретні техніки (5-4-3-2-1, ' +
        '4-7-8 дихання, орієнтація у місці-часі), якщо клієнт у дисоціації / гострій ' +
        'тривозі.\n' +
        '- **Safety plan** — чи спільно з клієнтом склали конкретні кроки на найближчі ' +
        '24-48 годин: тригери, копінг-стратегії, контакти підтримки.\n' +
        '- **Відсутність "звичайної" терапії** — психоосвіта, інтерпретації, поради на ' +
        'цьому етапі контрпродуктивні. Терапевт мав це зрозуміти.\n' +
        '- **Передача / координація** — якщо ризик високий, чи терапевт обговорив ' +
        'наступний крок (гаряча лінія, психіатр, лікарня).',
    };
    return intro + (modulators[modality] ?? '');
  }

  /**
   * Scan prompts/profiles/*.md and return a list of patient profiles.
   * Each file's slug = filename (without .md). DisplayName extracted from
   * "# Профіль X" header, falls back to capitalized slug.
   */
  private loadProfileFiles(): ProfileFile[] {
    if (!existsSync(this.profilesDir)) {
      this.logger.warn(`profiles directory missing: ${this.profilesDir}`);
      return [];
    }
    const files = readdirSync(this.profilesDir).filter((f) => f.endsWith('.md'));
    return files.map((file) => {
      const slug = file.replace(/\.md$/, '').toLowerCase();
      const profileText = this.read(this.profilesDir, file).trim();
      // displayName resolution order, in priority:
      //   1. `Назва:` field in the metadata comment — explicit override.
      //      Use this for non-singular cases (couples, families) where
      //      "Ім'я" doesn't apply.
      //   2. First word of `Ім'я:` line in the body — works for
      //      individual patients (the legacy convention).
      //   3. Capitalized slug — last-resort fallback.
      const meta0 = profileText.match(/<!--([\s\S]*?)-->/);
      const explicitName = meta0?.[1]?.match(/^\s*Назва:\s*(.+)$/m)?.[1]?.trim();
      const nameMatch = profileText.match(/^[\s-*]*Ім'я:\s*([^\n,]+)/m);
      const fullName = nameMatch?.[1]?.trim();
      const firstName = fullName?.split(/\s+/)[0];
      const displayName =
        explicitName ?? firstName ?? slug.charAt(0).toUpperCase() + slug.slice(1);

      // Parse metadata block from HTML comment at top:
      // <!--
      // Діагноз: ...
      // Поведінка: 1..5    (behavioral difficulty — how hard to engage)
      // Тяжкість: 1..5     (clinical severity — how serious the case)
      // Avatar: https://...
      // -->
      const metaBlock = profileText.match(/<!--([\s\S]*?)-->/);
      const meta = metaBlock?.[1] ?? '';
      const diagnosisMatch = meta.match(/^\s*Діагноз:\s*(.+)$/m);
      // English DSM-5 / ICD code — shown as tooltip on UI for students who
      // want to look up the original literature.
      const diagnosisCodeMatch = meta.match(/^\s*Шифр:\s*(.+)$/m);
      // Accept "Поведінка:" (preferred) or legacy "Складність:"
      const difficultyMatch =
        meta.match(/^\s*Поведінка:\s*(\d)\b/m) ??
        meta.match(/^\s*Складність:\s*(\d)\b/m);
      const complexityMatch = meta.match(/^\s*Тяжкість:\s*(\d)\b/m);
      const avatarMatch = meta.match(/^\s*Avatar:\s*(\S+)/m);
      // Optional modality key matching the catalog in modality.ts:
      // individual | couples | family | adolescent | crisis. Unknown
      // values are dropped (treated as 'individual' default).
      const modalityMatch = meta.match(/^\s*Модальність:\s*(\w+)/m);
      const rawModality = modalityMatch?.[1]?.trim().toLowerCase() ?? null;
      const KNOWN = new Set(['individual', 'couples', 'family', 'adolescent', 'crisis']);
      const modality = rawModality && KNOWN.has(rawModality) ? rawModality : null;

      return {
        slug,
        displayName,
        profileText,
        diagnosis: diagnosisMatch?.[1]?.trim() ?? null,
        diagnosisCode: diagnosisCodeMatch?.[1]?.trim() ?? null,
        difficulty: difficultyMatch ? parseInt(difficultyMatch[1], 10) : null,
        complexity: complexityMatch ? parseInt(complexityMatch[1], 10) : null,
        modality,
        avatarUrl: avatarMatch?.[1]?.trim() ?? null,
      };
    });
  }

  async onModuleInit() {
    const profiles = this.loadProfileFiles();
    if (profiles.length === 0) {
      this.logger.warn(
        'prompts/profiles/ порожнє. Додай профілі (Анна, Максим тощо), інакше картотека буде порожньою.',
      );
      return;
    }

    // Track current slugs so we can clean up DB rows for deleted profile
    // files. CRITICAL: only touch system patients (createdById === null).
    // User-created patients live alongside in the same table but their
    // lifecycle is managed via the API, not the filesystem.
    const currentSlugs = new Set(profiles.map((p) => p.slug));
    const dbCharacters = await this.prisma.character.findMany({
      where: { createdById: null },
    });
    for (const c of dbCharacters) {
      if (!currentSlugs.has(c.slug)) {
        await this.prisma.character.delete({ where: { id: c.id } }).catch(() => {
          // If sessions reference it, leave it; admin can reassign
        });
      }
    }

    for (const p of profiles) {
      const data = {
        displayName: p.displayName,
        profileText: p.profileText,
        diagnosis: p.diagnosis,
        diagnosisCode: p.diagnosisCode,
        difficulty: p.difficulty,
        complexity: p.complexity,
        // Modality falls back to 'individual' for legacy profiles that
        // don't declare one — keeps existing 1-on-1 cases unchanged.
        modality: p.modality ?? 'individual',
        avatarUrl: p.avatarUrl,
      };
      const existing = await this.prisma.character.findUnique({ where: { slug: p.slug } });
      if (existing) {
        await this.prisma.character.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await this.prisma.character.create({
          data: { slug: p.slug, ...data },
        });
      }
      if (this.profileLooksUnfilled(p.profileText)) {
        this.logger.warn(
          `prompts/profiles/${p.slug}.md виглядає не заповненим. Заповни перед першою сесією.`,
        );
      }
    }

    this.logger.log(
      `Завантажено ${profiles.length} профіл${profiles.length === 1 ? 'ь' : 'і'}: ${profiles.map((p) => p.displayName).join(', ')}`,
    );
  }
}
