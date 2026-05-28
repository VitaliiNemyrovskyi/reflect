import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  /** All users with their session count, admin flag, and current plan. */
  async listUsers() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { sessions: true } },
        subscription: {
          select: {
            plan: true,
            status: true,
            currentPeriodEnd: true,
            sessionsThisPeriod: true,
          },
        },
      },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      provider: u.provider,
      isAdmin: u.isAdmin,
      sessionCount: u._count.sessions,
      createdAt: u.createdAt,
      // Surface billing fields so the admin table can render current
      // plan + expiry inline. null when the user has no subscription
      // (shouldn't happen with the trial-on-create flow, but be safe).
      plan: u.subscription?.plan ?? null,
      planStatus: u.subscription?.status ?? null,
      planEndsAt: u.subscription?.currentPeriodEnd ?? null,
      sessionsThisPeriod: u.subscription?.sessionsThisPeriod ?? null,
    }));
  }

  /**
   * All sessions across all users. Optional filter by userId, by ended/active,
   * by character. Limited to 200 most recent — admin should narrow with
   * filters rather than scrolling thousands.
   */
  async listSessions(opts: {
    userId?: number;
    characterId?: number;
    ended?: boolean;
  }) {
    const where: Prisma.SessionWhereInput = {};
    if (opts.userId != null) where.userId = opts.userId;
    if (opts.characterId != null) where.characterId = opts.characterId;
    if (opts.ended === true) where.endedAt = { not: null };
    if (opts.ended === false) where.endedAt = null;

    const sessions = await this.prisma.session.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: 200,
      include: {
        user: { select: { id: true, email: true, displayName: true } },
        character: { select: { id: true, displayName: true, slug: true } },
        _count: { select: { messages: true, notes: true } },
      },
    });

    return sessions.map((s) => ({
      id: s.id,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      user: s.user,
      character: s.character,
      messageCount: s._count.messages,
      noteCount: s._count.notes,
      hasFeedback: !!s.feedback,
    }));
  }

  /**
   * Full session details — transcript, feedback, JSON assessment, errors
   * tied to this session. The single-stop view for diagnosing what
   * happened.
   */
  async getSession(id: number) {
    const session = await this.prisma.session.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, displayName: true } },
        character: { select: { id: true, displayName: true, slug: true } },
        messages: { orderBy: { id: 'asc' } },
        notes: { orderBy: { id: 'asc' } },
      },
    });
    if (!session) throw new NotFoundException('session not found');

    // Errors that mention this session in their endpoint URL OR have
    // sessionId set (the filter writes both).
    const errors = await this.prisma.errorLog.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return {
      ...session,
      // Parse the assessment JSON for convenience — frontend would do
      // this anyway. Keep raw too for debugging.
      assessment: session.feedbackJson ? safeParse(session.feedbackJson) : null,
      errors,
    };
  }

  /**
   * Hard-delete a session bypassing ownership — admin only. Cascades
   * (per schema) to messages, notes. ErrorLog rows mentioning the
   * session keep sessionId pointer (no FK), so they survive for
   * forensic value.
   */
  async deleteSession(id: number): Promise<{ deleted: true }> {
    const session = await this.prisma.session.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    await this.prisma.session.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Grant admin to a user by id. Idempotent — re-granting a user who's
   * already an admin is a no-op (returns the unchanged row). The grant
   * persists in the DB regardless of ADMIN_EMAILS env var, so a manual
   * grant survives env-var changes.
   */
  async grantAdmin(targetUserId: number): Promise<{ id: number; email: string; isAdmin: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, isAdmin: true },
    });
    if (!user) throw new NotFoundException('user not found');
    if (user.isAdmin) return user;
    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { isAdmin: true },
      select: { id: true, email: true, isAdmin: true },
    });
    return updated;
  }

  /**
   * Revoke admin from a user by id. Refuses when:
   *  - the target is the last remaining admin (would lock everyone out)
   *  - the target isn't an admin (idempotent — returns unchanged row)
   *
   * Self-revoke IS allowed as long as another admin still exists. The
   * caller is responsible for confirming with the user before sending.
   * Caller's userId is required so we can surface a clearer error if
   * they try to demote themselves and they're the last admin.
   */
  async revokeAdmin(
    targetUserId: number,
    callerUserId: number,
  ): Promise<{ id: number; email: string; isAdmin: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, isAdmin: true },
    });
    if (!user) throw new NotFoundException('user not found');
    if (!user.isAdmin) return user;

    const adminCount = await this.prisma.user.count({ where: { isAdmin: true } });
    if (adminCount <= 1) {
      throw new BadRequestException(
        targetUserId === callerUserId
          ? 'Не можна відкликати власні адмін-права — ти зараз єдиний адмін'
          : 'Не можна відкликати останнього адміна',
      );
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { isAdmin: false },
      select: { id: true, email: true, isAdmin: true },
    });
    return updated;
  }

  /**
   * Last N error log entries. Admin can paginate via `before` (id).
   * Default 100, max 500.
   */
  async listErrors(opts: { limit?: number; before?: number; userId?: number }) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const errors = await this.prisma.errorLog.findMany({
      where: {
        ...(opts.before != null ? { id: { lt: opts.before } } : {}),
        ...(opts.userId != null ? { userId: opts.userId } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit,
      include: {
        user: { select: { id: true, email: true, displayName: true } },
      },
    });
    return errors;
  }

  /**
   * LLM spend rollup for the admin dashboard. Aggregates the LlmUsage table
   * over today + last 7 days, plus a per-model breakdown (last 7d). Cost is
   * the estimated USD from LlmService's price map; tokens are exact.
   */
  async llmUsageSummary() {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [today, week, byModel] = await Promise.all([
      this.prisma.llmUsage.aggregate({
        where: { createdAt: { gte: dayAgo } },
        _count: true,
        _sum: { costUsd: true, promptTokens: true, completionTokens: true },
      }),
      this.prisma.llmUsage.aggregate({
        where: { createdAt: { gte: weekAgo } },
        _count: true,
        _sum: { costUsd: true, promptTokens: true, completionTokens: true },
      }),
      this.prisma.llmUsage.groupBy({
        by: ['model'],
        where: { createdAt: { gte: weekAgo } },
        _count: true,
        _sum: { costUsd: true, promptTokens: true, completionTokens: true },
        orderBy: { _sum: { costUsd: 'desc' } },
      }),
    ]);

    const roll = (count: number, sum: { costUsd: number | null; promptTokens: number | null; completionTokens: number | null }) => ({
      calls: count,
      costUsd: Number((sum.costUsd ?? 0).toFixed(4)),
      promptTokens: sum.promptTokens ?? 0,
      completionTokens: sum.completionTokens ?? 0,
    });

    return {
      today: roll(today._count, today._sum),
      last7d: roll(week._count, week._sum),
      byModel: byModel.map((m) => ({
        model: m.model,
        calls: m._count,
        costUsd: Number((m._sum.costUsd ?? 0).toFixed(4)),
        tokens: (m._sum.promptTokens ?? 0) + (m._sum.completionTokens ?? 0),
      })),
    };
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
