import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { PushService, type WebPushSubscription } from './push.service';

/**
 * Web Push subscription management. All auth-gated (global JWT guard) — only a
 * logged-in user can register their own device. Sending is internal (the
 * reminder scheduler), never an HTTP endpoint.
 */
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  /** Browser fetches this to subscribe. `{ publicKey: null }` ⇒ push disabled. */
  @Get('vapid-public-key')
  vapidPublicKey() {
    return { publicKey: this.push.getPublicKey() };
  }

  @Post('subscribe')
  async subscribe(
    @CurrentUser() user: AuthUser,
    @Body() body: { subscription: WebPushSubscription; userAgent?: string; lang?: string },
  ) {
    await this.push.subscribe(user.id, body.subscription, {
      userAgent: body.userAgent,
      lang: body.lang,
    });
    return { ok: true };
  }

  @Post('unsubscribe')
  async unsubscribe(@CurrentUser() user: AuthUser, @Body() body: { endpoint: string }) {
    await this.push.unsubscribe(user.id, body.endpoint);
    return { ok: true };
  }

  /**
   * Send an immediate test notification to the caller's own devices. Lets a
   * user confirm end-to-end delivery without waiting for the daily reminder
   * cron. `sent` = how many of their devices it reached (0 ⇒ not subscribed on
   * this device, or push disabled server-side).
   */
  @Post('test')
  async test(@CurrentUser() user: AuthUser, @Body() body: { lang?: string }) {
    const msg =
      body?.lang === 'en'
        ? 'Test reminder — push notifications are working.'
        : body?.lang === 'fr'
          ? 'Notification test — les push fonctionnent.'
          : 'Тестове нагадування — пуш працює.';
    const sent = await this.push.sendToUser(user.id, {
      title: 'Reflect',
      body: msg,
      url: '/',
      tag: 'reflect-test',
    });
    return { sent, enabled: this.push.isEnabled() };
  }
}
