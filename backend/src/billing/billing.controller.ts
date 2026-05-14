import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { PLANS, PLAN_ORDER, PlanId } from './plans.config';
import { SubscriptionsService } from './subscriptions.service';
import { FeatureGateService } from './feature-gate.service';

/**
 * Public-facing billing API for the logged-in user.
 *
 * GET  /api/billing/plans         — list all plans (public-ish; we
 *                                    don't even require auth here, but
 *                                    keeping it gated keeps the surface
 *                                    minimal).
 * GET  /api/billing/me            — current subscription + usage meter
 * POST /api/billing/cancel        — schedule cancellation at period end
 * POST /api/billing/pause         — pause sub (no charges)
 * POST /api/billing/resume        — resume from paused state
 */
@Controller('billing')
export class BillingController {
  constructor(
    private readonly subs: SubscriptionsService,
    private readonly gate: FeatureGateService,
  ) {}

  /** Plans catalog is public — anonymous visitors on /pricing fetch it
   *  to compare tiers before signing up. */
  @Public()
  @Get('plans')
  async listPlans() {
    return PLAN_ORDER.map((id) => PLANS[id]);
  }

  @Get('me')
  async myStatus(@CurrentUser() user: AuthUser) {
    const sub = await this.subs.getOrProvision(user.id);
    const plan = sub.plan as PlanId;
    const config = PLANS[plan];
    const limit = config.sessionLimit;
    return {
      plan,
      config,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      trialEndsAt: sub.trialEndsAt,
      canceledAt: sub.canceledAt,
      pausedAt: sub.pausedAt,
      resumesAt: sub.resumesAt,
      sessionsUsed: sub.sessionsThisPeriod,
      sessionsRemaining: limit !== null ? Math.max(0, limit - sub.sessionsThisPeriod) : null,
      sessionLimit: limit,
      softCap: config.softCap,
      // Days until next billing trigger (period end or trial end).
      daysUntilPeriodEnd: Math.ceil((sub.currentPeriodEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
    };
  }

  @Post('cancel')
  async cancel(@CurrentUser() user: AuthUser) {
    const sub = await this.subs.cancel(user.id);
    return {
      status: sub.status,
      canceledAt: sub.canceledAt,
      accessUntil: sub.currentPeriodEnd,
    };
  }

  @Post('pause')
  async pause(
    @CurrentUser() user: AuthUser,
    @Body() body: { resumeInDays?: number },
  ) {
    const days = body?.resumeInDays;
    if (days !== undefined && (days < 7 || days > 180)) {
      throw new BadRequestException('Період паузи має бути від 7 до 180 днів');
    }
    const sub = await this.subs.pause(user.id, days);
    return { status: sub.status, pausedAt: sub.pausedAt, resumesAt: sub.resumesAt };
  }

  @Post('resume')
  async resume(@CurrentUser() user: AuthUser) {
    const sub = await this.subs.resume(user.id);
    return { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd };
  }
}
