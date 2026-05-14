import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Lightweight telemetry pipeline. Frontend posts events one-at-a-time
 * (or in small batches) to /api/events; we persist them as-is with
 * minimal validation so the funnel-analysis admin endpoint can roll
 * them up later.
 *
 * No PII beyond what's already on User. Anonymous visitors are
 * tracked by a stable hash of (IP + UA) — collides across sessions
 * from the same browser, which is the point: we want to know if "the
 * same visitor came back to /demo three times" without ever
 * de-anonymizing them.
 *
 * Known event types (validated to avoid noise from typos / random
 * input from a misbehaving client):
 *
 *   page.demo            — anon visit to /demo
 *   page.pricing         — anon visit to /pricing
 *   auth.register        — successful new account
 *   welcome.dismissed    — clicked through first-time onboarding
 *   session.created      — started a new session w/ a character
 *   session.message_sent — user sent a chat message
 *   session.ended        — clicked "End session" (vs discarded)
 *   feedback.viewed      — reached /session/:id/feedback
 *   billing.upgrade_clicked — clicked an upgrade CTA
 */
export const KNOWN_EVENT_TYPES = new Set([
  'page.demo',
  'page.pricing',
  'auth.register',
  'auth.login',
  'welcome.dismissed',
  'session.created',
  'session.message_sent',
  'session.ended',
  'feedback.viewed',
  'billing.upgrade_clicked',
]);

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Hash IP+UA into a stable 16-hex anon identifier. */
  anonHash(ip: string, ua: string): string {
    return crypto
      .createHash('sha256')
      .update(`${ip}|${ua}`)
      .digest('hex')
      .slice(0, 16);
  }

  /** Persist a single event. Silently drops if eventType not in
   *  KNOWN_EVENT_TYPES — protects the table from random keys. */
  async record(opts: {
    userId: number | null;
    anonHash: string | null;
    eventType: string;
    props?: Record<string, unknown> | null;
    sessionId?: number | null;
    userAgent?: string | null;
  }) {
    if (!KNOWN_EVENT_TYPES.has(opts.eventType)) {
      this.logger.debug(`drop unknown event type: ${opts.eventType}`);
      return null;
    }
    return this.prisma.event.create({
      data: {
        userId: opts.userId,
        anonHash: opts.anonHash,
        eventType: opts.eventType,
        props: opts.props ? JSON.stringify(opts.props).slice(0, 500) : null,
        sessionId: opts.sessionId ?? null,
        userAgent: (opts.userAgent ?? null)?.slice(0, 200) ?? null,
      },
    });
  }

  /**
   * Reconstruct a 7-day funnel snapshot:
   *   visited /demo or /pricing
   *      → registered
   *      → started 1st session
   *      → started 3rd session
   *      → reached feedback page
   *
   * Counts are unique-by-userId/anonHash so a visitor refreshing the
   * demo 10 times doesn't inflate the top of the funnel.
   */
  async funnelLast7Days() {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const events = await this.prisma.event.findMany({
      where: { createdAt: { gte: since } },
      select: { eventType: true, userId: true, anonHash: true, createdAt: true },
    });

    // anonymous visitors keyed by anonHash; registered by userId
    const uniqueByEvent = (type: string) => {
      const set = new Set<string>();
      for (const e of events) {
        if (e.eventType !== type) continue;
        const key = e.userId ? `u:${e.userId}` : e.anonHash ? `a:${e.anonHash}` : null;
        if (key) set.add(key);
      }
      return set;
    };

    // Multi-session counts per user
    const sessionsByUser = new Map<number, number>();
    for (const e of events) {
      if (e.eventType !== 'session.created' || !e.userId) continue;
      sessionsByUser.set(e.userId, (sessionsByUser.get(e.userId) ?? 0) + 1);
    }

    const visited = new Set<string>();
    for (const e of events) {
      if (e.eventType !== 'page.demo' && e.eventType !== 'page.pricing') continue;
      const key = e.userId ? `u:${e.userId}` : e.anonHash ? `a:${e.anonHash}` : null;
      if (key) visited.add(key);
    }

    const registered = uniqueByEvent('auth.register');
    const startedSession = uniqueByEvent('session.created');
    const reachedThirdSession = Array.from(sessionsByUser.entries())
      .filter(([_, n]) => n >= 3).length;
    const sawFeedback = uniqueByEvent('feedback.viewed');

    return {
      windowDays: 7,
      since: since.toISOString(),
      funnel: {
        visited_demo_or_pricing: visited.size,
        registered: registered.size,
        started_first_session: startedSession.size,
        started_third_session: reachedThirdSession,
        viewed_feedback: sawFeedback.size,
      },
      rates: {
        register_per_visit:
          visited.size > 0 ? +(registered.size / visited.size).toFixed(3) : null,
        session_per_register:
          registered.size > 0 ? +(startedSession.size / registered.size).toFixed(3) : null,
        feedback_per_session:
          startedSession.size > 0 ? +(sawFeedback.size / startedSession.size).toFixed(3) : null,
        retention_3plus_sessions:
          startedSession.size > 0 ? +(reachedThirdSession / startedSession.size).toFixed(3) : null,
      },
    };
  }

  /** Most-recent N events, for the admin "live tail" widget. */
  async recentEvents(limit = 100) {
    return this.prisma.event.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
      select: {
        id: true,
        eventType: true,
        userId: true,
        anonHash: true,
        props: true,
        createdAt: true,
      },
    });
  }
}
