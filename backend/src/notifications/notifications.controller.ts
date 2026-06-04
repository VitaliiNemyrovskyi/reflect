import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { NotificationsService } from './notifications.service';

/**
 * In-app notification feed. All auth-gated (global JWT guard) — a user only
 * ever reads/manages their own. Broadcast is admin-only.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** Recent notifications, newest first. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.notifications.list(user.id, limit ? parseInt(limit, 10) : 50);
  }

  /** Unread count for the header bell indicator. */
  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthUser) {
    return { count: await this.notifications.unreadCount(user.id) };
  }

  /** Mark every notification read. */
  @Post('read-all')
  async readAll(@CurrentUser() user: AuthUser) {
    await this.notifications.markAllRead(user.id);
    return { ok: true };
  }

  /** Mark one notification read (e.g. after opening it). */
  @Post(':id/read')
  async read(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.notifications.markRead(user.id, id);
    return { ok: true };
  }

  /**
   * Admin broadcast — push an announcement to every user (in-app + web-push).
   * Admin-only on top of the global auth guard.
   */
  @Post('broadcast')
  @UseGuards(AdminGuard)
  async broadcast(@Body() body: { title?: string; body?: string; url?: string }) {
    const title = (body?.title ?? '').trim();
    const text = (body?.body ?? '').trim();
    if (!title || !text) return { ok: false, reached: 0, error: 'title and body required' };
    const reached = await this.notifications.broadcast({
      title: title.slice(0, 120),
      body: text.slice(0, 500),
      url: body?.url?.trim() || undefined,
    });
    return { ok: true, reached };
  }
}
