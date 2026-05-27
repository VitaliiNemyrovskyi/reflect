import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { AdminService } from './admin.service';
import { SubscriptionsService } from '../billing/subscriptions.service';
import { PLANS, PlanId } from '../billing/plans.config';
import { EventsService } from '../events/events.service';

/**
 * All admin endpoints live under /api/admin/* and require both:
 *   - JWT auth (global guard, populates req.user)
 *   - AdminGuard (this controller — checks isAdmin in DB)
 *
 * 403 Forbidden if non-admin tries to hit any of these.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly subscriptions: SubscriptionsService,
    private readonly events: EventsService,
  ) {}

  @Get('users')
  users() {
    return this.admin.listUsers();
  }

  @Get('sessions')
  sessions(
    @Query('userId') userId?: string,
    @Query('characterId') characterId?: string,
    @Query('ended') ended?: string,
  ) {
    return this.admin.listSessions({
      userId: userId ? parseInt(userId, 10) : undefined,
      characterId: characterId ? parseInt(characterId, 10) : undefined,
      ended: ended === 'true' ? true : ended === 'false' ? false : undefined,
    });
  }

  @Get('sessions/:id')
  session(@Param('id', ParseIntPipe) id: number) {
    return this.admin.getSession(id);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSession(@Param('id', ParseIntPipe) id: number) {
    await this.admin.deleteSession(id);
  }

  /**
   * Grant / revoke admin rights. Day-to-day admin management lives here
   * — the ADMIN_EMAILS env var only bootstraps the first admin on cold
   * deploys and acts as a recovery mechanism.
   *
   * Both endpoints are admin-only (AdminGuard). Revoke refuses to remove
   * the last admin so the panel can never lock itself out. Self-revoke
   * is allowed when another admin exists — caller's id flows in via
   * @CurrentUser for a clearer error if they ARE the last admin.
   */
  @Post('users/:id/admin')
  @HttpCode(HttpStatus.OK)
  async grantAdmin(@Param('id', ParseIntPipe) id: number) {
    return this.admin.grantAdmin(id);
  }

  @Delete('users/:id/admin')
  @HttpCode(HttpStatus.OK)
  async revokeAdmin(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() caller: AuthUser,
  ) {
    return this.admin.revokeAdmin(id, caller.id);
  }

  @Get('errors')
  errors(
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('userId') userId?: string,
  ) {
    return this.admin.listErrors({
      limit: limit ? parseInt(limit, 10) : undefined,
      before: before ? parseInt(before, 10) : undefined,
      userId: userId ? parseInt(userId, 10) : undefined,
    });
  }

  /**
   * Grant a paid plan to a user manually. Used for:
   *  - Vouchers / promo codes (before payment integration)
   *  - University pilots (free Pro for a semester)
   *  - Comps for influencers / partners
   *
   * Body: { plan: 'lite'|'pro'|'master', months?: number, note?: string }
   * Default duration = 1 month. note appended to Subscription.notes
   * with timestamp for audit trail.
   */
  @Post('users/:id/grant-plan')
  @HttpCode(HttpStatus.OK)
  async grantPlan(
    @Param('id', ParseIntPipe) userId: number,
    @Body() body: { plan: string; months?: number; note?: string },
  ) {
    if (!body?.plan || !(body.plan in PLANS)) {
      throw new BadRequestException(
        `plan має бути одним з: ${Object.keys(PLANS).join(', ')}`,
      );
    }
    if (body.months !== undefined && (body.months < 1 || body.months > 24)) {
      throw new BadRequestException('months має бути 1-24');
    }
    const sub = await this.subscriptions.grant(userId, body.plan as PlanId, {
      months: body.months,
      note: body.note,
    });
    return {
      userId,
      plan: sub.plan,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
    };
  }

  /** Snapshot of the user base by plan/status — useful for admin dashboards
   *  before we wire a proper BI tool. */
  @Get('billing/distribution')
  billingDistribution() {
    return this.subscriptions.distributionStats();
  }

  /** 7-day acquisition funnel: visits → register → 1st session → 3rd
   *  session → feedback viewed. Computed from the Event table on the
   *  fly (no precomputation cron yet — table stays small enough for
   *  this scope). */
  @Get('analytics/funnel')
  analyticsFunnel() {
    return this.events.funnelLast7Days();
  }

  /** Live tail of the most recent events for ad-hoc debugging. */
  @Get('analytics/recent')
  analyticsRecent(@Query('limit') limit?: string) {
    return this.events.recentEvents(limit ? parseInt(limit, 10) : 100);
  }
}
