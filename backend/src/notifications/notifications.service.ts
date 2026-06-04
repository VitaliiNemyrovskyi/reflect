import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';

export interface NotificationDto {
  id: number;
  type: string;
  title: string;
  body: string;
  url: string | null;
  read: boolean;
  createdAt: Date;
}

/**
 * In-app notification feed: the read/manage side of the system. Writing rows
 * happens in PushService.sendToUser (which mirrors every push), so callers that
 * want "push + in-app" just call push.sendToUser with a `type`. This service
 * powers the header bell + /notifications page, and the admin broadcast.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  /** Most-recent notifications for a user (newest first). */
  async list(userId: number, limit = 50): Promise<NotificationDto[]> {
    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      url: n.url,
      read: n.readAt !== null,
      createdAt: n.createdAt,
    }));
  }

  /** Count of unread notifications — drives the bell's red indicator. */
  unreadCount(userId: number): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  /** Mark one notification read. Scoped to the owner so you can't touch others'. */
  async markRead(userId: number, id: number): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /** Mark every unread notification read (the "mark all read" action). */
  async markAllRead(userId: number): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /**
   * Admin broadcast: send one announcement to every user — mirrored to each
   * user's in-app feed (via push.sendToUser) and web-pushed to their devices.
   * Returns how many users it reached. Best-effort per user.
   */
  async broadcast(payload: { title: string; body: string; url?: string }): Promise<number> {
    const users = await this.prisma.user.findMany({ select: { id: true } });
    let reached = 0;
    for (const { id } of users) {
      try {
        await this.push.sendToUser(id, {
          title: payload.title,
          body: payload.body,
          url: payload.url,
          tag: 'announcement',
          type: 'announcement',
        });
        reached++;
      } catch (e) {
        this.logger.warn(`broadcast to user=${id} failed: ${(e as Error).message}`);
      }
    }
    this.logger.log(`broadcast "${payload.title}" → ${reached}/${users.length} users`);
    return reached;
  }
}
