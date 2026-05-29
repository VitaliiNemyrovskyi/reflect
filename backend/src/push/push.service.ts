import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

export interface PushPayload {
  title: string;
  body: string;
  /** Deep-link opened on notification click. */
  url?: string;
  /** Collapses repeat notifications on the device. */
  tag?: string;
}

/** Browser PushSubscription.toJSON() shape. */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Web Push (VAPID). The whole feature degrades gracefully: with no VAPID keys
 * in the env the service stays disabled — every method is a safe no-op, so the
 * app runs identically until the keys are provisioned. Sends never throw to the
 * caller; dead endpoints (404/410) are pruned automatically.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly publicKey: string;
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.publicKey = this.config.get<string>('VAPID_PUBLIC_KEY') ?? '';
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY') ?? '';
    const subject =
      this.config.get<string>('VAPID_SUBJECT') ?? 'mailto:hello@reflect.swift-mail.app';
    this.enabled = !!(this.publicKey && privateKey);
    if (this.enabled) {
      webpush.setVapidDetails(subject, this.publicKey, privateKey);
      this.logger.log('Web Push enabled (VAPID configured)');
    } else {
      this.logger.log('Web Push disabled (VAPID keys absent) — reminders are a no-op');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** VAPID public key for the browser to subscribe with; null when disabled. */
  getPublicKey(): string | null {
    return this.enabled ? this.publicKey : null;
  }

  /** Register (or refresh) a device subscription, keyed by its endpoint. */
  async subscribe(
    userId: number,
    sub: WebPushSubscription,
    opts: { userAgent?: string; lang?: string } = {},
  ): Promise<void> {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return;
    const lang = ['uk', 'en', 'fr'].includes(opts.lang ?? '') ? opts.lang : null;
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: {
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: opts.userAgent?.slice(0, 200) ?? null,
        lang,
      },
      // Re-subscribing from the same endpoint (e.g. another account on the
      // same browser) re-points it at the current user + refreshes keys.
      update: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, lang },
    });
  }

  async unsubscribe(userId: number, endpoint: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }

  /** How many device subscriptions this user has registered. */
  subscriptionCount(userId: number): Promise<number> {
    return this.prisma.pushSubscription.count({ where: { userId } });
  }

  /** Send a notification to every device a user has. Returns how many landed. */
  async sendToUser(userId: number, payload: PushPayload): Promise<number> {
    if (!this.enabled) return 0;
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    const json = JSON.stringify(payload);
    let sent = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          json,
        );
        sent++;
      } catch (err: unknown) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          // Subscription expired/revoked — drop it so we stop trying.
          await this.prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
          this.logger.log(`pruned dead push endpoint (${code})`);
        } else {
          this.logger.warn(`push send failed (${code ?? '?'}): ${(err as Error).message}`);
        }
      }
    }
    return sent;
  }
}
