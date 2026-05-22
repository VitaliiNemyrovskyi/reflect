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
/**
 * Reviewer model tier for Pass-2 (and optional Pass-3 in ensemble):
 *  sonnet     — Claude Sonnet 4.6 via OpenRouter (Trial/Lite)
 *  deepseek-r1 — DeepSeek R1 via OpenRouter; 5× cheaper than Opus,
 *               same 7/8 clinical-signal coverage in blind comparison
 *  opus       — Claude Opus 4.7 via OpenRouter (legacy, high cost)
 *  ensemble   — 3-pass chain: Haiku draft → DeepSeek R1 → Qwen 3.7 Max
 *               Catches 8/8 signals (each model sees different gaps).
 *               Sequential: Qwen reads and refines DeepSeek's review.
 */
export type ReviewerModelTier = 'sonnet' | 'deepseek-r1' | 'opus' | 'ensemble';

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
  /** Reviewer pass model tier (see ReviewerModelTier). Trial+Lite get
   *  Sonnet (good enough for basics). Pro gets DeepSeek R1 (same 7/8
   *  clinical signal coverage as Opus at 5× lower cost — $0.040 vs
   *  $0.157). Master gets ensemble (3-pass chain: DeepSeek R1 then
   *  Qwen 3.7 Max) for maximum coverage at still slightly cheaper
   *  cost than Opus alone ($0.142 vs $0.157). */
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
    reviewerModel: 'ensemble',
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
      'Ensemble-фідбек (3 AI-агенти: DeepSeek R1 + Qwen) — максимальна глибина',
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

/**
 * Reviewer configuration for two-pass (and optional three-pass ensemble)
 * feedback generation. `secondary` is non-null only for 'ensemble' tier —
 * it represents the Pass-3 refinement model (Qwen 3.7 Max). When non-null
 * the session service runs a 3-pass chain:
 *   Pass 1 → Haiku draft
 *   Pass 2 → primary reviewer (DeepSeek R1) — non-streaming, blocking
 *   Pass 3 → secondary reviewer (Qwen 3.7 Max) — streaming to client
 *
 * For non-OpenRouter providers the DeepSeek/Qwen models are unavailable —
 * they fall back to Sonnet (primary) / null (secondary) gracefully.
 */
export interface ReviewerConfig {
  primary: string;
  secondary: string | null; // null = 2-pass mode
}

/** Map a plan ID to the reviewer model config.
 *  The draft model (Pass 1) is unaffected — it uses
 *  LlmService.modelFeedback for everyone, regardless of plan. */
export function resolveReviewerConfig(
  plan: PlanId,
  provider: 'anthropic' | 'openrouter',
): ReviewerConfig {
  const tier = PLANS[plan].reviewerModel;

  if (provider === 'anthropic') {
    // Anthropic-native doesn't route DeepSeek/Qwen; degrade gracefully.
    if (tier === 'opus' || tier === 'ensemble') {
      return { primary: 'claude-opus-4-7', secondary: null };
    }
    return { primary: 'claude-sonnet-4-6', secondary: null };
  }

  // OpenRouter — full model menu available.
  switch (tier) {
    case 'ensemble':
      return {
        primary: 'deepseek/deepseek-r1',
        secondary: 'qwen/qwen3.7-max',
      };
    case 'deepseek-r1':
      return { primary: 'deepseek/deepseek-r1', secondary: null };
    case 'opus':
      return { primary: 'anthropic/claude-opus-4-7', secondary: null };
    default: // 'sonnet'
      return { primary: 'anthropic/claude-sonnet-4-6', secondary: null };
  }
}

/** @deprecated Use resolveReviewerConfig instead. Kept for any callers
 *  that haven't been updated yet — returns the primary model ID. */
export function resolveReviewerModelId(
  plan: PlanId,
  provider: 'anthropic' | 'openrouter',
): string {
  return resolveReviewerConfig(plan, provider).primary;
}
