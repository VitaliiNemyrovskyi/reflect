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
  category: 'frame' | 'alliance' | 'listening' | 'risk' | 'general' | 'anxiety';
  courses?: string[];
}

const C = ['intake-rapport'];
const A = ['anxiety-basics'];

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
  oars: 'oars',
  reflection: 'рефлекс',
  validation: 'валідаці',
  'motivational-interviewing': 'мотиваційн',
  'risk-screening': 'скринінг',
  'c-ssrs': 'ssrs',
  normalizing: 'нормаліз',
  'suicidal-ideation': 'суїцидальн',
  exposure: 'експозиці',
  suds: 'suds',
  catastrophising: 'катастроф',
  grounding: 'заземл',
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
    defUk: 'Поступове, безпечне й повторюване перебування в лякаючій ситуації, доки тривога спаде сама. Золотий стандарт роботи з тривогою.',
    defEn: 'Gradually, safely and repeatedly staying in a feared situation until anxiety subsides on its own. The gold standard for anxiety.',
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
];
