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
}
