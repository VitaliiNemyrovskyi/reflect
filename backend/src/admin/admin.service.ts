import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  /** All users with their session count + admin flag. */
  async listUsers() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { sessions: true } } },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      provider: u.provider,
      isAdmin: u.isAdmin,
      sessionCount: u._count.sessions,
      createdAt: u.createdAt,
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
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
