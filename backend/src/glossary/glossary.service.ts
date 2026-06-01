import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Glossary of clinical terms. Seeded/upserted on boot. Each term can be tagged
 * with the course keys it's relevant to (`courses`), so the same dictionary
 * powers both the global /glossary page and each course's "Словник" section.
 * Content is AI-drafted from public frameworks in our own words.
 */
@Injectable()
export class GlossaryService implements OnModuleInit {
  private readonly logger = new Logger(GlossaryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seed();
    } catch (err) {
      this.logger.error('glossary seed failed', err as Error);
    }
  }

  /** All terms, ordered by category then order. */
  async list() {
    const terms = await this.prisma.glossaryTerm.findMany({ orderBy: [{ category: 'asc' }, { order: 'asc' }] });
    return terms.map((t) => this.shape(t));
  }

  /** Terms tagged with the given course key. */
  async listForCourse(courseKey: string) {
    const all = await this.prisma.glossaryTerm.findMany({ orderBy: [{ order: 'asc' }] });
    return all
      .filter((t) => {
        if (!t.courses) return false;
        try {
          return (JSON.parse(t.courses) as string[]).includes(courseKey);
        } catch {
          return false;
        }
      })
      .map((t) => this.shape(t));
  }

  private shape(t: {
    slug: string;
    termUk: string;
    termEn: string;
    defUk: string;
    defEn: string;
    category: string | null;
  }) {
    return {
      slug: t.slug,
      termUk: t.termUk,
      termEn: t.termEn,
      defUk: t.defUk,
      defEn: t.defEn,
      category: t.category,
      // Ukrainian invariant stem for inline linkifying (+ up to ~3 inflectional
      // letters on the frontend). null = not auto-linked inline (too generic /
      // collision-prone), but still a glossary entry.
      match: TERM_MATCH[t.slug] ?? null,
    };
  }

  private async seed(): Promise<void> {
    let n = 0;
    for (let i = 0; i < SEED_TERMS.length; i++) {
      const t = SEED_TERMS[i];
      const data = {
        termUk: t.termUk,
        termEn: t.termEn,
        defUk: t.defUk,
        defEn: t.defEn,
        category: t.category,
        courses: t.courses ? JSON.stringify(t.courses) : null,
        order: i,
      };
      await this.prisma.glossaryTerm.upsert({
        where: { slug: t.slug },
        create: { slug: t.slug, ...data },
        update: data,
      });
      n++;
    }
    this.logger.log(`glossary seeded/updated: ${n} terms`);
  }
}

interface SeedTerm {
  slug: string;
  termUk: string;
  termEn: string;
  defUk: string;
  defEn: string;
  category: 'frame' | 'alliance' | 'listening' | 'risk' | 'general' | 'anxiety' | 'depression';
  courses?: string[];
}

const C = ['intake-rapport'];
const A = ['anxiety-basics'];
const D = ['depression-basics'];
const DD = ['depression-deeper'];

/**
 * Ukrainian invariant stems for inline linkifying. The frontend matches each
 * stem + up to ~4 trailing letters at word boundaries, so inflected forms link
 * too (e.g. "альянс" → "альянсу").
 *
 * Only SPECIALISED terms are linked — words that are jargon or carry a specific
 * meaning in psychology (OARS, рефлексія, емпатія, рамка, експозиція…). Everyday
 * words that merely happen to be glossary entries ("відкрите питання",
 * "конфіденційність", "запит", "тривога", "уникання"…) are deliberately NOT
 * auto-linked — they'd be noise. Such terms still exist as full glossary
 * entries and can surface in the per-lesson terms list.
 */
const TERM_MATCH: Record<string, string> = {
  rapport: 'рапорт',
  frame: 'рамк',
  biopsychosocial: 'біопсихосоціальн',
  'working-alliance': 'альянс',
  empathy: 'емпаті',
  congruence: 'конгруентн',
  'alliance-rupture': 'розрив',
  oars: 'oars',
  reflection: 'рефлекс',
  validation: 'валідаці',
  'motivational-interviewing': 'мотиваційн',
  'self-efficacy': 'самоефективн',
  'risk-screening': 'скринінг',
  'c-ssrs': 'ssrs',
  normalizing: 'нормаліз',
  'suicidal-ideation': 'суїцидальн',
  exposure: 'експозиці',
  suds: 'suds',
  catastrophising: 'катастроф',
  grounding: 'заземл',
  'inhibitory-learning': 'інгібіторн',
  'safety-behavior': 'рятувальн',
  anhedonia: 'ангедон',
  'behavioral-activation': 'поведінков',
  rumination: 'румінаці',
  'core-belief': 'глибинн',
  'downward-arrow': 'стріла',
  'behavioral-experiment': 'експеримент',
  'self-criticism': 'самокритик',
  'self-compassion': 'самоспівчутт',
  hopelessness: 'безнаді',
};

const SEED_TERMS: SeedTerm[] = [
  // ── General ──
  {
    slug: 'rapport',
    termUk: 'Рапорт',
    termEn: 'Rapport',
    defUk: 'Відчуття контакту й довіри між клієнтом і терапевтом. Будується не словами «довіртеся мені», а тим, що клієнт відчуває себе почутим і прийнятим.',
    defEn: 'A felt sense of contact and trust between client and therapist. Built not by saying "trust me" but by the client feeling heard and accepted.',
    category: 'general',
    courses: C,
  },
  // ── Frame ──
  {
    slug: 'frame',
    termUk: 'Рамка (терапевтична)',
    termEn: 'Frame',
    defUk: 'Сукупність домовленостей, що тримають терапію: час і тривалість сесій, конфіденційність та її межі, ролі, оплата. Передбачуваність рамки створює безпеку.',
    defEn: 'The set of agreements that hold therapy: session time and length, confidentiality and its limits, roles, payment. A predictable frame creates safety.',
    category: 'frame',
    courses: C,
  },
  {
    slug: 'presenting-concern',
    termUk: 'Запит',
    termEn: 'Presenting concern',
    defUk: 'Те, з чим клієнт прийшов, його власними словами. Вихідна точка першої сесії: «Що привело вас сьогодні?»',
    defEn: "What the client comes in with, in their own words. The starting point of a first session: \"What brings you in today?\"",
    category: 'frame',
    courses: C,
  },
  {
    slug: 'therapeutic-contract',
    termUk: 'Терапевтичний контракт',
    termEn: 'Therapeutic contract',
    defUk: 'Явна домовленість про те, як ви працюватимете разом: цілі, формат, межі, очікування. Проговорюється на початку, переглядається за потреби.',
    defEn: 'An explicit agreement about how you will work together: goals, format, boundaries, expectations. Stated at the start, revisited as needed.',
    category: 'frame',
    courses: C,
  },
  {
    slug: 'confidentiality',
    termUk: 'Конфіденційність та її межі',
    termEn: 'Confidentiality and its limits',
    defUk: 'Те, що сказане в кабінеті, лишається в кабінеті — окрім ситуацій ризику для життя клієнта чи інших. Межі озвучують прямо й заздалегідь.',
    defEn: "What is said in the room stays in the room — except where there is risk to the client's life or others'. The limits are stated directly and up front.",
    category: 'frame',
    courses: C,
  },
  {
    slug: 'biopsychosocial',
    termUk: 'Біопсихосоціальна модель',
    termEn: 'Biopsychosocial model',
    defUk: 'Орієнтир для збору картини на трьох рівнях: біологічне (сон, апетит, здоровʼя, речовини), психологічне (думки, емоції, копінг) і соціальне (стосунки, робота, підтримка).',
    defEn: 'A map for gathering the picture on three levels: biological (sleep, appetite, health, substances), psychological (thoughts, emotions, coping), and social (relationships, work, support).',
    category: 'frame',
    courses: C,
  },
  // ── Alliance ──
  {
    slug: 'working-alliance',
    termUk: 'Робочий альянс',
    termEn: 'Working alliance',
    defUk: 'Співпраця клієнта й терапевта. За Бордіном має три складові: звʼязок (довіра), цілі (куди йдемо) і завдання (як саме). Найсильніший предиктор результату терапії.',
    defEn: 'The collaboration between client and therapist. Bordin: three parts — bond (trust), goals (where), and tasks (how). The strongest predictor of outcome.',
    category: 'alliance',
    courses: C,
  },
  {
    slug: 'empathy',
    termUk: 'Емпатія',
    termEn: 'Empathy',
    defUk: 'Точне відчуття світу клієнта зсередини, ніби це твій світ, — але не втрачаючи це «ніби». Одна з ядрових умов за Роджерсом.',
    defEn: "Accurately sensing the client's world from the inside, as if it were yours — without losing the \"as if\". One of Rogers's core conditions.",
    category: 'alliance',
    courses: C,
  },
  {
    slug: 'positive-regard',
    termUk: 'Безумовне прийняття',
    termEn: 'Unconditional positive regard',
    defUk: 'Повага й тепло до клієнта без осуду, незалежно від того, що він каже чи робить. Не схвалення вчинків, а прийняття людини.',
    defEn: 'Respect and warmth toward the client without judgement, regardless of what they say or do. Not approval of actions but acceptance of the person.',
    category: 'alliance',
    courses: C,
  },
  {
    slug: 'congruence',
    termUk: 'Конгруентність',
    termEn: 'Congruence',
    defUk: 'Щирість терапевта: те, що він показує, збігається з тим, що відчуває. Без «маски експерта». Ядрова умова за Роджерсом.',
    defEn: "The therapist's genuineness: what they show matches what they feel. No \"expert mask\". A Rogerian core condition.",
    category: 'alliance',
    courses: C,
  },
  {
    slug: 'alliance-rupture',
    termUk: 'Розрив альянсу',
    termEn: 'Alliance rupture',
    defUk: 'Напруга чи збій у співпраці: клієнт віддаляється (відсторонення) або йде проти (конфронтація). За Safran і Muran помічені й відновлені розриви покращують результат — лікує саме відновлення.',
    defEn: 'A strain or breakdown in collaboration: the client moves away (withdrawal) or against (confrontation). Per Safran & Muran, noticing and repairing ruptures improves outcome — the repair itself heals.',
    category: 'alliance',
    courses: C,
  },
  // ── Listening (OARS) ──
  {
    slug: 'oars',
    termUk: 'OARS',
    termEn: 'OARS',
    defUk: 'Чотири базові навички слухання з мотиваційного інтервʼю: Open questions (відкриті питання), Affirmations (підтримки), Reflections (рефлексії), Summaries (резюме).',
    defEn: 'The four core listening skills from motivational interviewing: Open questions, Affirmations, Reflections, Summaries.',
    category: 'listening',
    courses: C,
  },
  {
    slug: 'open-question',
    termUk: 'Відкрите питання',
    termEn: 'Open question',
    defUk: 'Питання, що запрошує розгорнуту відповідь, а не «так/ні». «Розкажіть, як виглядають ваші ночі?» замість «Ви погано спите?»',
    defEn: 'A question that invites an unfolding answer rather than yes/no. "Tell me what your nights look like?" instead of "Do you sleep badly?"',
    category: 'listening',
    courses: C,
  },
  {
    slug: 'closed-question',
    termUk: 'Закрите питання',
    termEn: 'Closed question',
    defUk: 'Питання з короткою відповіддю «так/ні» чи фактом. Корисне для уточнення, але серія закритих питань створює ефект допиту.',
    defEn: 'A question answered with yes/no or a single fact. Useful for clarifying, but a run of them creates an interrogation effect.',
    category: 'listening',
    courses: C,
  },
  {
    slug: 'reflection',
    termUk: 'Рефлексія',
    termEn: 'Reflection',
    defUk: 'Повернення клієнту суті почутого своїми словами. Показує, що ви слухаєте, і запрошує заглибитись. Орієнтир — щонайменше одна рефлексія на кожне питання.',
    defEn: 'Handing back the essence of what you heard, in your words. Shows you are listening and invites depth. Aim for at least one reflection per question.',
    category: 'listening',
    courses: C,
  },
  {
    slug: 'complex-reflection',
    termUk: 'Складна рефлексія',
    termEn: 'Complex reflection',
    defUk: 'Рефлексія, що додає здогад про почуття чи значення за словами клієнта, а не лише повторює зміст. «Тримаєтесь на автоматі — бо зупинитись зараз надто важко.»',
    defEn: "A reflection that adds a guess about the feeling or meaning behind the words, not just restating content. \"You're on autopilot — because stopping to feel it now is too much.\"",
    category: 'listening',
    courses: C,
  },
  {
    slug: 'validation',
    termUk: 'Валідація',
    termEn: 'Validation',
    defUk: 'Визнання, що почуття чи реакція клієнта зрозумілі в його контексті. Не означає згоду з висновками — означає «твоя реакція має сенс».',
    defEn: "Acknowledging that the client's feeling or reaction makes sense in their context. Not agreement with their conclusions — \"your reaction makes sense\".",
    category: 'listening',
    courses: C,
  },
  {
    slug: 'summarizing',
    termUk: 'Резюмування',
    termEn: 'Summarizing',
    defUk: 'Стисле зведення кількох речей, які сказав клієнт, докупи. Показує, що ви тримаєте нитку, і допомагає перейти до наступної теми.',
    defEn: "Pulling several things the client said together into a brief recap. Shows you're holding the thread and helps transition to the next topic.",
    category: 'listening',
    courses: C,
  },
  {
    slug: 'motivational-interviewing',
    termUk: 'Мотиваційне інтервʼю (МІ)',
    termEn: 'Motivational interviewing (MI)',
    defUk: 'Підхід до розмови про зміни, що спирається на власну мотивацію клієнта замість тиску. Звідси походить набір навичок OARS.',
    defEn: "An approach to talking about change that draws on the client's own motivation rather than pressure. OARS comes from it.",
    category: 'listening',
    courses: C,
  },
  {
    slug: 'change-talk',
    termUk: 'Мова зміни',
    termEn: 'Change talk',
    defUk: 'Власні висловлювання клієнта на користь зміни (бажання, здатність, причини, потреба, кроки). У мотиваційному інтервʼю мета — почути її більше: що частіше людина сама проговорює аргументи за зміну, то ймовірніша зміна.',
    defEn: "The client's own statements in favour of change (desire, ability, reasons, need, steps). In motivational interviewing the aim is to evoke more of it: the more a person voices their own arguments for change, the likelier change becomes.",
    category: 'listening',
    courses: C,
  },
  {
    slug: 'self-efficacy',
    termUk: 'Самоефективність',
    termEn: 'Self-efficacy',
    defUk: 'Віра людини в те, що вона здатна впоратися й досягти зміни. Підтримки (affirmations) живлять самоефективність, а вона, своєю чергою, підтримує мотивацію до роботи.',
    defEn: "A person's belief that they are capable of coping and achieving change. Affirmations feed self-efficacy, which in turn sustains motivation for the work.",
    category: 'listening',
    courses: C,
  },
  {
    slug: 'active-listening',
    termUk: 'Активне слухання',
    termEn: 'Active listening',
    defUk: 'Слухання, у якому ви не просто мовчите, а показуєте розуміння — рефлексіями, уточненнями, невербально. Баланс: більше слухати, ніж говорити (≈80/20).',
    defEn: 'Listening where you actively show understanding — through reflections, clarifications, nonverbals — not just staying silent. Balance: listen more than you speak (≈80/20).',
    category: 'listening',
    courses: C,
  },
  // ── Risk ──
  {
    slug: 'risk-screening',
    termUk: 'Скринінг ризику',
    termEn: 'Risk screening',
    defUk: 'Делікатна, але пряма перевірка суїцидальних думок. Уникати теми небезпечніше, ніж спитати: пряме питання дає полегшення й точність, а не «підштовхує».',
    defEn: 'A gentle but direct check for suicidal thoughts. Avoiding the topic is more dangerous than asking: a direct question brings relief and clarity, it does not "plant" the idea.',
    category: 'risk',
    courses: C,
  },
  {
    slug: 'c-ssrs',
    termUk: 'C-SSRS (логіка уточнення ризику)',
    termEn: 'C-SSRS (risk-clarifying logic)',
    defUk: 'Послідовність уточнення гостроти суїцидального ризику: думки → план → засоби → намір. Кожен наступний рівень підвищує гостроту.',
    defEn: 'A sequence for clarifying the acuity of suicide risk: thoughts → plan → means → intent. Each level raises the acuity.',
    category: 'risk',
    courses: C,
  },
  {
    slug: 'normalizing',
    termUk: 'Нормалізація',
    termEn: 'Normalizing',
    defUk: 'Спосіб зробити важку тему обговорюваною: «Коли людям так важко, інколи бувають думки, що не хочеться жити — чи є такі у вас?»',
    defEn: 'A way to make a hard topic discussable: "When things are this hard, people sometimes have thoughts that they don\'t want to be alive — do you ever have those?"',
    category: 'risk',
    courses: C,
  },
  {
    slug: 'suicidal-ideation',
    termUk: 'Суїцидальні думки',
    termEn: 'Suicidal ideation',
    defUk: 'Думки про небажання жити чи про самоушкодження — від пасивних («краще б мене не було») до активних із планом. Завжди перевіряють прямо й спокійно.',
    defEn: 'Thoughts of not wanting to live or of self-harm — from passive ("I wish I weren\'t here") to active with a plan. Always screened directly and calmly.',
    category: 'risk',
    courses: C,
  },
  {
    slug: 'safety-plan',
    termUk: 'План безпеки',
    termEn: 'Safety plan',
    defUk: 'Конкретний, спільно складений план на випадок загострення: сигнали-тригери, навички самозаспокоєння, кого набрати, кризові контакти. Не фальшиві обіцянки, а кроки.',
    defEn: 'A concrete, collaboratively built plan for a crisis: warning signs, coping skills, who to call, crisis contacts. Steps, not false reassurance.',
    category: 'risk',
    courses: C,
  },
  {
    slug: 'means-safety',
    termUk: 'Безпека засобів',
    termEn: 'Means safety',
    defUk: 'Спільне зменшення доступу до того, чим людина могла б завдати собі шкоди, на час кризи. Компонент плану безпеки з найсильнішою доказовою базою: криза часто минуща, а доступ до засобу в ці хвилини буває вирішальним.',
    defEn: 'Collaboratively reducing access to whatever a person could use to harm themselves during a crisis. The safety-plan component with the strongest evidence base: a crisis is often transient, and access to means in those minutes can be decisive.',
    category: 'risk',
    courses: C,
  },
  // ── Anxiety ──
  {
    slug: 'anxiety',
    termUk: 'Тривога',
    termEn: 'Anxiety',
    defUk: 'Реакція системи сигналізації тіла на сприйняту загрозу (бий–біжи–завмри). Корисна перед реальною небезпекою, виснажлива — при хибних спрацюваннях.',
    defEn: "The body alarm system's response to perceived threat (fight–flight–freeze). Useful before real danger, exhausting when it false-alarms.",
    category: 'anxiety',
    courses: A,
  },
  {
    slug: 'fight-flight-freeze',
    termUk: 'Бий–біжи–завмри',
    termEn: 'Fight–flight–freeze',
    defUk: 'Три давні реакції на загрозу. Пояснюють тілесні симптоми тривоги: серцебиття, напруга, заклякання. Нормалізація цих реакцій знижує «страх страху».',
    defEn: 'Three ancient threat responses. They explain anxiety\'s bodily symptoms: pounding heart, tension, freezing. Normalising them lowers the "fear of fear".',
    category: 'anxiety',
    courses: A,
  },
  {
    slug: 'avoidance',
    termUk: 'Уникання',
    termEn: 'Avoidance',
    defUk: 'Втеча від лякаючої ситуації заради миттєвого полегшення. Парадоксально підтримує тривогу: «вчить» мозок, що ситуація небезпечна.',
    defEn: 'Escaping a feared situation for instant relief. Paradoxically maintains anxiety: it "teaches" the brain the situation is dangerous.',
    category: 'anxiety',
    courses: A,
  },
  {
    slug: 'exposure',
    termUk: 'Експозиція',
    termEn: 'Exposure',
    defUk: 'Поступове, безпечне й повторюване наближення до лякаючої ситуації, щоб перевірити передбачення про катастрофу й сформувати нову памʼять «безпечно» (інгібіторне научіння). Золотий стандарт роботи з тривогою.',
    defEn: 'Gradually, safely and repeatedly approaching a feared situation to test the predicted catastrophe and build a new "safe" memory (inhibitory learning). The gold standard for anxiety.',
    category: 'anxiety',
    courses: A,
  },
  {
    slug: 'suds',
    termUk: 'SUDS',
    termEn: 'SUDS',
    defUk: 'Субʼєктивна одиниця дискомфорту (0–100). Допомагає скласти ієрархію експозиції й відстежувати, як спадає тривога.',
    defEn: 'Subjective Units of Distress (0–100). Helps build an exposure hierarchy and track how anxiety falls.',
    category: 'anxiety',
    courses: A,
  },
  {
    slug: 'catastrophising',
    termUk: 'Катастрофізація',
    termEn: 'Catastrophising',
    defUk: 'Пастка мислення: автоматичний перехід до найгіршого сценарію. Працюють не суперечкою, а перевіркою доказів і реалістичної ймовірності.',
    defEn: 'A thinking trap: automatically jumping to the worst case. Worked with not by arguing but by testing evidence and realistic probability.',
    category: 'anxiety',
    courses: A,
  },
  {
    slug: 'grounding',
    termUk: 'Заземлення',
    termEn: 'Grounding',
    defUk: 'Навичка повернути увагу в «тут і зараз» через відчуття (напр. 5-4-3-2-1). Збиває фізіологічну хвилю тривоги, щоб знову запрацювало мислення.',
    defEn: 'A skill to bring attention into the here-and-now through the senses (e.g. 5-4-3-2-1). Knocks down the physiological wave so thinking can work again.',
    category: 'anxiety',
    courses: A,
  },
  {
    slug: 'inhibitory-learning',
    termUk: 'Інгібіторне научіння',
    termEn: 'Inhibitory learning',
    defUk: 'Сучасна модель того, як діє експозиція: старий страх не стирається, а поряд формується нова памʼять «безпечно», що його гальмує. Лікує не падіння тривоги в моменті, а порушення очікувань.',
    defEn: 'The modern model of how exposure works: the old fear is not erased; a new "safe" memory forms alongside it and inhibits it. What heals is expectancy violation, not anxiety dropping in the moment.',
    category: 'anxiety',
    courses: A,
  },
  {
    slug: 'expectancy-violation',
    termUk: 'Порушення очікувань',
    termEn: 'Expectancy violation',
    defUk: 'Ключовий момент експозиції: клієнт перевіряє конкретне лякаюче передбачення, і воно не справджується. Що більший розрив між очікуваним і реальним, то сильніше нове навчання.',
    defEn: 'The key moment in exposure: the client tests a specific feared prediction and it does not come true. The bigger the gap between expected and actual, the stronger the new learning.',
    category: 'anxiety',
    courses: A,
  },
  {
    slug: 'safety-behavior',
    termUk: 'Рятувальна поведінка',
    termEn: 'Safety behaviour',
    defUk: 'Дрібні дії «про всяк випадок» (триматися за телефон, сидіти біля виходу, дихати «правильно»), що нібито рятують. Вони заважають перевірити передбачення, тож тихо підтримують тривогу.',
    defEn: 'Small "just-in-case" actions (clutching a phone, sitting by the exit, breathing "correctly") that seem to rescue. They prevent testing the prediction, so they quietly maintain anxiety.',
    category: 'anxiety',
    courses: A,
  },
  {
    slug: 'depression',
    termUk: 'Депресія',
    termEn: 'Depression',
    defUk: 'Стійке (≥2 тижнів) зниження настрою та/або втрата інтересу й задоволення разом з іншими ознаками (сон, енергія, думки), що порушує функціонування. Стан, а не слабкість характеру.',
    defEn: 'A sustained (≥2 weeks) drop in mood and/or loss of interest and pleasure, with other features (sleep, energy, thinking), impairing functioning. A state, not a character weakness.',
    category: 'depression',
    courses: D,
  },
  {
    slug: 'anhedonia',
    termUk: 'Ангедонія',
    termEn: 'Anhedonia',
    defUk: 'Втрата здатності відчувати задоволення від того, що раніше тішило. Одна з ядрових ознак депресії.',
    defEn: 'Loss of the capacity to feel pleasure from what once pleased. A core feature of depression.',
    category: 'depression',
    courses: D,
  },
  {
    slug: 'behavioral-activation',
    termUk: 'Поведінкова активація',
    termEn: 'Behavioural activation',
    defUk: 'Доказовий метод при депресії: поступово повертати дії, що дають задоволення, досягнення й звʼязок, не чекаючи мотивації. Дія йде першою — настрій наздоганяє.',
    defEn: 'An evidence-based method for depression: gradually bringing back activities that give pleasure, achievement and connection, without waiting for motivation. Action comes first — mood catches up.',
    category: 'depression',
    courses: D,
  },
  {
    slug: 'rumination',
    termUk: 'Румінація',
    termEn: 'Rumination',
    defUk: 'Нескінченне пережовування думок «чому я такий», «що зі мною не так». Відчувається як самоаналіз, а насправді поглиблює настрій і нічого не вирішує.',
    defEn: 'Endless chewing over "why am I like this", "what is wrong with me". It feels like self-analysis but deepens mood and resolves nothing.',
    category: 'depression',
    courses: D,
  },
  {
    slug: 'cognitive-triad',
    termUk: 'Когнітивна тріада',
    termEn: 'Cognitive triad',
    defUk: 'Опис Бека: депресивний негативний погляд на СЕБЕ, СВІТ і МАЙБУТНЄ, що живлять одне одного. Думки сприймаються як правда, хоча є симптомом.',
    defEn: "Beck's description: the depressive negative view of the SELF, the WORLD and the FUTURE, feeding one another. The thoughts feel like truth though they are a symptom.",
    category: 'depression',
    courses: D,
  },
  {
    slug: 'relapse-prevention',
    termUk: 'Профілактика рецидиву',
    termEn: 'Relapse prevention',
    defUk: 'Підготовка до можливих майбутніх спадів: ранні маркери, що допомагало раніше, і план дій на перші ознаки. При повторних епізодах доказову роль має MBCT.',
    defEn: 'Preparing for possible future dips: early markers, what helped before, and an action plan for the first signs. For recurrent episodes, MBCT has an evidence-based role.',
    category: 'depression',
    courses: D,
  },
  {
    slug: 'core-belief',
    termUk: 'Глибинне переконання',
    termEn: 'Core belief',
    defUk: 'Абсолютне твердження про себе, інших чи світ, сформоване рано («я нікчемний», «я нелюбимий», «я безпорадний»). Корінь автоматичних думок; сприймається як факт.',
    defEn: 'An absolute statement about the self, others or the world, formed early ("I\'m worthless", "I\'m unlovable", "I\'m helpless"). The root of automatic thoughts; experienced as fact.',
    category: 'depression',
    courses: DD,
  },
  {
    slug: 'downward-arrow',
    termUk: 'Техніка «стріла вниз»',
    termEn: 'Downward arrow',
    defUk: 'Спосіб дістатися глибинного переконання: послідовно питати «припустимо, це правда — і що це означає / чим це погано?», доки не впрешся в абсолютне твердження про себе.',
    defEn: 'A way to reach a core belief: repeatedly ask "suppose it\'s true — what would that mean / why is that bad?" until you hit an absolute statement about the self.',
    category: 'depression',
    courses: DD,
  },
  {
    slug: 'behavioral-experiment',
    termUk: 'Поведінковий експеримент',
    termEn: 'Behavioural experiment',
    defUk: 'Запланована дія, якою клієнт перевіряє переконання чи передбачення в реальному житті. Досвід переконує сильніше за будь-яку логіку в кабінеті.',
    defEn: 'A planned action by which the client tests a belief or prediction in real life. Experience convinces more than any in-session logic.',
    category: 'depression',
    courses: DD,
  },
  {
    slug: 'self-criticism',
    termUk: 'Самокритика',
    termEn: 'Self-criticism',
    defUk: 'Жорсткий внутрішній голос («ти жалюгідний», «знову все зіпсував»). Здається мотиватором, а насправді виснажує й підтримує депресію.',
    defEn: 'A harsh inner voice ("you\'re pathetic", "you ruined it again"). It seems like a motivator but actually drains and maintains depression.',
    category: 'depression',
    courses: DD,
  },
  {
    slug: 'self-compassion',
    termUk: 'Самоспівчуття',
    termEn: 'Self-compassion',
    defUk: 'Чесно визнати власний біль і поставитися до себе по-доброму, як до того, кого любиш. Не самопоблажливість і не порожня похвала.',
    defEn: 'Honestly acknowledging your own pain and treating yourself kindly, as you would someone you love. Not self-indulgence and not empty praise.',
    category: 'depression',
    courses: DD,
  },
  {
    slug: 'hopelessness',
    termUk: 'Безнадія',
    termEn: 'Hopelessness',
    defUk: 'Переконання «нічого не зміниться, тож нащо й намагатися». Ядро депресії і — за даними — найсильніший чинник суїцидального ризику; тримають у полі зору.',
    defEn: 'The belief that "nothing will change, so why try". A core of depression and — per the evidence — the strongest factor in suicide risk; kept in view.',
    category: 'depression',
    courses: DD,
  },
];
