import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { PLANS, PlanId, resolveReviewerModelId } from './plans.config';
import { SubscriptionsService } from './subscriptions.service';

/**
 * The single point of truth for "can this user do X right now?"
 *
 * Wraps SubscriptionsService + the static PLANS catalog so that
 * callers (controllers, services) don't need to know the plan slug
 * or rule details — they just ask: canStartSession, getReviewerModel,
 * canUseFeature, etc.
 *
 * NOTE: this service makes a DB read on every call. For high-traffic
 * endpoints we could cache per-request (the same user often hits
 * multiple gates in one request flow). Not premature today — the
 * gates run a handful of times per second across all users.
 */
export type FeatureName =
  | 'psychTests'
  | 'progressGraphs'
  | 'pdfExport'
  | 'customCharacters'
  | 'advancedAnalytics'
  | 'notionExport'
  | 'earlyAccess'
  | 'prioritySupport';

export type GateReason =
  | 'paused'
  | 'expired'
  | 'trial-expired'
  | 'session-limit-reached'
  | 'feature-not-included'
  | 'modality-not-included'
  | 'character-not-accessible';

export interface GateResult {
  ok: boolean;
  reason?: GateReason;
  /** For session-limit: sessions left in current period. */
  remaining?: number;
  /** Plan that gates this feature — for upgrade nudge UI. */
  requiredPlan?: PlanId;
}

@Injectable()
export class FeatureGateService {
  private readonly logger = new Logger(FeatureGateService.name);

  constructor(
    private readonly subs: SubscriptionsService,
    private readonly llm: LlmService,
  ) {}

  /** Resolve user's effective plan + state. Lazily provisions trial
   *  if user has no subscription row. */
  async resolvePlan(userId: number): Promise<{ plan: PlanId; status: string; periodEnd: Date; sessionsUsed: number }> {
    const sub = await this.subs.getOrProvision(userId);
    return {
      plan: sub.plan as PlanId,
      status: sub.status,
      periodEnd: sub.currentPeriodEnd,
      sessionsUsed: sub.sessionsThisPeriod,
    };
  }

  /** Primary gate: can the user start a new session right now? */
  async canStartSession(userId: number): Promise<GateResult> {
    const { plan, status, periodEnd, sessionsUsed } = await this.resolvePlan(userId);

    if (status === 'paused') return { ok: false, reason: 'paused' };
    if (status === 'expired') return { ok: false, reason: 'expired' };

    // Trial-specific: hard expiration date.
    if (plan === 'trial' && periodEnd.getTime() < Date.now()) {
      return { ok: false, reason: 'trial-expired' };
    }

    // Period-end check for paid plans (post-cancel grace).
    if (plan !== 'trial' && periodEnd.getTime() < Date.now()) {
      return { ok: false, reason: 'expired' };
    }

    const limit = PLANS[plan].sessionLimit;
    if (limit !== null && sessionsUsed >= limit) {
      return { ok: false, reason: 'session-limit-reached', remaining: 0 };
    }
    return {
      ok: true,
      remaining: limit !== null ? limit - sessionsUsed : undefined,
    };
  }

  /** Which reviewer model to use for THIS user's two-pass feedback.
   *  Free + Lite get Sonnet (good enough), Pro + Master get Opus. */
  async getReviewerModelId(userId: number): Promise<string> {
    const { plan } = await this.resolvePlan(userId);
    return resolveReviewerModelId(plan, this.llm.provider);
  }

  /** Lookup-style feature check. */
  async canUseFeature(userId: number, feature: FeatureName): Promise<GateResult> {
    const { plan, status } = await this.resolvePlan(userId);
    if (status !== 'active') return { ok: false, reason: 'paused' };
    if (PLANS[plan].features[feature]) return { ok: true };
    const requiredPlan = this.firstPlanWithFeature(feature);
    return { ok: false, reason: 'feature-not-included', requiredPlan };
  }

  /** Modality gate (couples/family/crisis/adolescent need Pro+). */
  async canUseModality(userId: number, modality: string): Promise<GateResult> {
    const { plan, status } = await this.resolvePlan(userId);
    if (status !== 'active') return { ok: false, reason: 'paused' };
    if (modality === 'individual' || PLANS[plan].modalitiesAllAccess) {
      return { ok: true };
    }
    return { ok: false, reason: 'modality-not-included', requiredPlan: 'pro' };
  }

  /** Character access — trial sees only first N system characters
   *  ranked by id. Lite+ sees everything. */
  async canAccessCharacter(
    userId: number,
    character: { id: number; createdById: number | null },
  ): Promise<GateResult> {
    const { plan, status } = await this.resolvePlan(userId);
    if (status !== 'active') return { ok: false, reason: 'paused' };
    // Custom characters: only Master can CREATE; everyone can RUN
    // sessions on their own + shared-with-them characters regardless
    // of plan — that's an existing-feature affordance, not a billing one.
    if (character.createdById !== null) return { ok: true };
    const cap = PLANS[plan].charactersAccessibleCount;
    if (cap === null) return { ok: true };
    // First N system characters (sorted by id). We don't run the
    // ORDER BY here — we trust the caller passed a character row;
    // a separate check in CharactersService filters the LIST view by
    // the same rule.
    return character.id <= cap
      ? { ok: true }
      : { ok: false, reason: 'character-not-accessible', requiredPlan: 'lite' };
  }

  /** Find the cheapest plan that includes a given feature.
   *  Used to suggest an upgrade target ("for PDF export, upgrade to Pro"). */
  private firstPlanWithFeature(feature: FeatureName): PlanId | undefined {
    for (const id of ['lite', 'pro', 'master'] as PlanId[]) {
      if (PLANS[id].features[feature]) return id;
    }
    return undefined;
  }
}
