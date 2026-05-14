/**
 * Static plan catalog. The DB only stores the plan SLUG per
 * subscription; everything else (prices, limits, feature flags) lives
 * here in code. This keeps plan definitions versioned in git, lets us
 * compare prices across deploys, and avoids paying for an extra Plan
 * table that almost never changes in practice.
 *
 * Currency: ₴ (UAH) is canonical — we sell to a Ukrainian audience.
 * USD shown alongside as info for diaspora users + dashboard math.
 */

export type PlanId = 'trial' | 'lite' | 'pro' | 'master';
export type ReviewerModelTier = 'sonnet' | 'opus';

export interface PlanConfig {
  id: PlanId;
  name: string;
  /** Marketing tagline shown beneath the plan name on /pricing. */
  tagline: string;
  /** Monthly price in ₴. 0 for trial. */
  priceUah: number;
  /** USD equivalent shown for transparency, not billed in USD. */
  priceUsd: number;
  /** Annual prepay price in ₴, ~17% off monthly. null = no annual. */
  annualPriceUah: number | null;
  /** Semester pack (4 months) price in ₴. Ukrainian student-friendly
   *  payment cadence — buy once per semester. null = no pack. */
  semesterPriceUah: number | null;
  /** Trial only: how long the trial period lasts. null for paid plans. */
  trialDays: number | null;
  /** Hard cap on sessions per billing period.
   *  - trial: 3 sessions total over 14 days
   *  - lite: 10/month
   *  - pro: null (unlimited), see softCap
   *  - master: null */
  sessionLimit: number | null;
  /** Pro tier "soft cap" — at this count, user sees an upgrade nudge
   *  but is NOT blocked. Protects margin without blocking power users. */
  softCap: number | null;
  /** Reviewer pass model. trial+lite → Sonnet (good enough), pro+master
   *  → Opus (deep). The draft model (Pass 1) stays Haiku for all tiers. */
  reviewerModel: ReviewerModelTier;
  /** Trial limits to first N system characters (sorted by display
   *  order). Paid tiers see all. */
  charactersAccessibleCount: number | null;
  /** Modalities allowed. Trial+Lite: individual only. Pro+Master: all. */
  modalitiesAllAccess: boolean;
  /** Feature flags. */
  features: {
    psychTests: boolean;
    progressGraphs: boolean;
    pdfExport: boolean;
    customCharacters: boolean;
    advancedAnalytics: boolean;
    notionExport: boolean;
    earlyAccess: boolean;
    prioritySupport: boolean;
  };
  /** UI-only — bullet list shown on /pricing card. Should match the
   *  feature flags above but in human-readable order/grouping. */
  highlights: string[];
}

export const PLANS: Record<PlanId, PlanConfig> = {
  trial: {
    id: 'trial',
    name: 'Trial',
    tagline: 'Спробуй, перш ніж зважитися',
    priceUah: 0,
    priceUsd: 0,
    annualPriceUah: null,
    semesterPriceUah: null,
    trialDays: 14,
    sessionLimit: 3,
    softCap: null,
    reviewerModel: 'sonnet',
    charactersAccessibleCount: 3,
    modalitiesAllAccess: false,
    features: {
      psychTests: false,
      progressGraphs: false,
      pdfExport: false,
      customCharacters: false,
      advancedAnalytics: false,
      notionExport: false,
      earlyAccess: false,
      prioritySupport: false,
    },
    highlights: [
      '3 сесії за 14 днів',
      '3 з 8 персонажів',
      'Базовий фідбек (Sonnet)',
      'Без експорту, без тестів',
    ],
  },
  lite: {
    id: 'lite',
    name: 'Lite',
    tagline: 'Регулярна практика для студента',
    priceUah: 249,
    priceUsd: 6,
    annualPriceUah: 2490,
    semesterPriceUah: null,
    trialDays: null,
    sessionLimit: 10,
    softCap: null,
    reviewerModel: 'sonnet',
    charactersAccessibleCount: null, // all
    modalitiesAllAccess: false,
    features: {
      psychTests: true,
      progressGraphs: true,
      pdfExport: false,
      customCharacters: false,
      advancedAnalytics: false,
      notionExport: false,
      earlyAccess: false,
      prioritySupport: false,
    },
    highlights: [
      '10 сесій на місяць',
      'Всі 8 персонажів',
      'Психологічні тести + графіки прогресу',
      'Базовий фідбек (Sonnet)',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: 'Серйозна підготовка до практики',
    priceUah: 599,
    priceUsd: 14.5,
    annualPriceUah: 5990,
    semesterPriceUah: 1799,
    trialDays: null,
    sessionLimit: null, // unlimited
    softCap: 50,
    reviewerModel: 'opus',
    charactersAccessibleCount: null,
    modalitiesAllAccess: true,
    features: {
      psychTests: true,
      progressGraphs: true,
      pdfExport: true,
      customCharacters: false,
      advancedAnalytics: false,
      notionExport: false,
      earlyAccess: false,
      prioritySupport: true,
    },
    highlights: [
      'Необмежені сесії',
      'Глибокий фідбек (Opus reviewer)',
      'Всі 5 модальностей (couples, family, crisis, adolescent)',
      'Експорт фідбеку в PDF (для CE/портфоліо)',
      'Priority підтримка',
    ],
  },
  master: {
    id: 'master',
    name: 'Master',
    tagline: 'Для практикуючих психотерапевтів',
    priceUah: 1499,
    priceUsd: 36.5,
    annualPriceUah: 14990,
    semesterPriceUah: null,
    trialDays: null,
    sessionLimit: null,
    softCap: null,
    reviewerModel: 'opus',
    charactersAccessibleCount: null,
    modalitiesAllAccess: true,
    features: {
      psychTests: true,
      progressGraphs: true,
      pdfExport: true,
      customCharacters: true,
      advancedAnalytics: true,
      notionExport: true,
      earlyAccess: true,
      prioritySupport: true,
    },
    highlights: [
      'Все з Pro',
      'Створи власних персонажів під свою практику',
      'Advanced analytics: alliance tracking, heatmaps',
      'Експорт сесій у Notion',
      'Early access — нові персонажі за 2 тижні до релізу',
      'Голосуй за наступного персонажа (раз на квартал)',
    ],
  },
};

export const PLAN_ORDER: PlanId[] = ['trial', 'lite', 'pro', 'master'];

/** Compare plan tiers for upgrade/downgrade math.
 *  trial < lite < pro < master */
export function planRank(id: PlanId): number {
  return PLAN_ORDER.indexOf(id);
}

/** Map a plan ID to the OpenRouter/Anthropic model identifier for
 *  the Pass-2 reviewer. The draft model (Pass 1) is unaffected — it
 *  uses LlmService.modelFeedback for everyone, regardless of plan. */
export function resolveReviewerModelId(
  plan: PlanId,
  provider: 'anthropic' | 'openrouter',
): string {
  const tier = PLANS[plan].reviewerModel;
  if (provider === 'anthropic') {
    return tier === 'opus' ? 'claude-opus-4-7' : 'claude-sonnet-4-6';
  }
  // openrouter
  return tier === 'opus' ? 'anthropic/claude-opus-4-7' : 'anthropic/claude-sonnet-4-6';
}
