import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PLANS, PlanId, planRank } from './plans.config';

/**
 * CRUD + state machine for per-user subscriptions.
 *
 * The billing model is intentionally simple: one row per user,
 * mutated in place on plan change. History (period transitions,
 * vouchers, manual grants) is captured by Subscription.notes for
 * now — we'll add a proper ledger when payments go live.
 *
 * State transitions:
 *
 *   register/oauth-create
 *        └─ provisionTrial()  →  status=active, plan=trial,
 *                                trialEndsAt=now+14d
 *
 *   admin / future payment success
 *        └─ grant(plan)       →  status=active, plan={lite|pro|master},
 *                                currentPeriodEnd=now+30d
 *
 *   user pause
 *        └─ pause(resumeIn?)  →  status=paused, pausedAt=now,
 *                                resumesAt=now+resumeIn (or null)
 *
 *   user resume / cron auto-resume
 *        └─ resume()          →  status=active, pausedAt=null,
 *                                resumesAt=null,
 *                                currentPeriodEnd shifted by paused-duration
 *
 *   user cancel
 *        └─ cancel()          →  canceledAt=now (status stays active
 *                                until currentPeriodEnd → then expired)
 *
 *   cron sweep (period rollover)
 *        └─ rolloverPeriod()  →  resets sessionsThisPeriod, advances
 *                                currentPeriodEnd if active+renewed
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Get the user's subscription. Lazily provisions a trial if none
   *  exists — covers pre-billing-rollout accounts on first request. */
  async getOrProvision(userId: number) {
    const existing = await this.prisma.subscription.findUnique({ where: { userId } });
    if (existing) return existing;
    return this.provisionTrial(userId);
  }

  /** Create a fresh 14-day trial. Idempotent: if a sub already exists,
   *  returns it unchanged. Called by AuthService.register + provideOAuth. */
  async provisionTrial(userId: number) {
    const trialCfg = PLANS.trial;
    const trialEnds = new Date(Date.now() + (trialCfg.trialDays ?? 14) * 24 * 60 * 60 * 1000);
    return this.prisma.subscription.upsert({
      where: { userId },
      create: {
        userId,
        plan: 'trial',
        status: 'active',
        currentPeriodEnd: trialEnds,
        trialEndsAt: trialEnds,
      },
      update: {}, // do not clobber existing
    });
  }

  /** Admin/payment-success path: switch user to a paid plan.
   *  Resets the billing window to a fresh 30 days and zeros the
   *  in-period session counter. */
  async grant(userId: number, plan: PlanId, opts: { months?: number; note?: string } = {}) {
    if (!(plan in PLANS)) throw new BadRequestException(`Невідомий план: ${plan}`);
    const months = opts.months ?? 1;
    const days = Math.round(months * 30); // approximate, fine for non-cents pricing
    const periodEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const existing = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!existing) {
      return this.prisma.subscription.create({
        data: {
          userId,
          plan,
          status: 'active',
          currentPeriodEnd: periodEnd,
          notes: opts.note ?? null,
        },
      });
    }
    return this.prisma.subscription.update({
      where: { userId },
      data: {
        plan,
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: periodEnd,
        trialEndsAt: null,
        canceledAt: null,
        pausedAt: null,
        resumesAt: null,
        sessionsThisPeriod: 0,
        notes: opts.note ? `${existing.notes ?? ''}\n${new Date().toISOString()}: ${opts.note}`.trim() : existing.notes,
      },
    });
  }

  /** Schedule cancellation. Access continues until currentPeriodEnd. */
  async cancel(userId: number) {
    const sub = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!sub) throw new NotFoundException('Підписка відсутня');
    if (sub.status === 'canceled') return sub;
    return this.prisma.subscription.update({
      where: { userId },
      data: { canceledAt: new Date() },
    });
  }

  /** Pause subscription. Cuts off new sessions but preserves data.
   *  If resumeInDays provided, sets auto-resume target. */
  async pause(userId: number, resumeInDays?: number) {
    const sub = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!sub) throw new NotFoundException('Підписка відсутня');
    if (sub.status === 'paused') return sub;
    const resumesAt = resumeInDays
      ? new Date(Date.now() + resumeInDays * 24 * 60 * 60 * 1000)
      : null;
    return this.prisma.subscription.update({
      where: { userId },
      data: { status: 'paused', pausedAt: new Date(), resumesAt },
    });
  }

  /** Resume a paused subscription. */
  async resume(userId: number) {
    const sub = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!sub) throw new NotFoundException('Підписка відсутня');
    if (sub.status !== 'paused') return sub;
    // Extend currentPeriodEnd by however long the user was paused —
    // they shouldn't lose paid days to the pause.
    const pausedMs = sub.pausedAt ? Date.now() - sub.pausedAt.getTime() : 0;
    return this.prisma.subscription.update({
      where: { userId },
      data: {
        status: 'active',
        pausedAt: null,
        resumesAt: null,
        currentPeriodEnd: new Date(sub.currentPeriodEnd.getTime() + pausedMs),
      },
    });
  }

  /** Increment the period-scoped session counter. Called after
   *  successful session start (not at end — we charge for the slot,
   *  not the outcome). */
  async incrementSessions(userId: number) {
    return this.prisma.subscription.update({
      where: { userId },
      data: { sessionsThisPeriod: { increment: 1 } },
    });
  }

  /** Useful for admin: how many users on each plan right now. */
  async distributionStats() {
    const rows = await this.prisma.subscription.groupBy({
      by: ['plan', 'status'],
      _count: { _all: true },
    });
    return rows.map((r) => ({ plan: r.plan, status: r.status, count: r._count._all }));
  }

  /** Compare two plans by tier order — used for upgrade nudges. */
  isUpgrade(from: PlanId, to: PlanId): boolean {
    return planRank(to) > planRank(from);
  }
}
