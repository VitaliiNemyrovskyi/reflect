import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from './push.service';
import { computeWellbeing, patientStateScore, type PatientState } from '../dashboard/wellbeing';

/**
 * Daily care-loop reminder (design §4/§13). Once a day it finds, per subscribed
 * trainee, their MOST-idle slipping/at-risk patient and sends ONE gentle,
 * supervisor-voice push. Never the patient "texting"; never guilt.
 *
 * Guardrails:
 *  - At most one reminder per patient per ~week (PushReminder throttle log).
 *  - Fires at 17:00 UTC — early evening across the UA/UK/FR cohort, so it lands
 *    in waking hours without per-user timezone tracking.
 *  - Replica-safe: a coarse 20h staleness lock (the diary-scheduler pattern)
 *    keeps the two api replicas from double-sending on the same tick.
 *  - No warm-start: restarts must NOT fire reminders. Cron-only.
 *  - Whole thing is a no-op when VAPID isn't configured.
 */
@Injectable()
export class PushReminderScheduler {
  private readonly logger = new Logger(PushReminderScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  @Cron('0 17 * * *')
  async dailyReminders(): Promise<void> {
    if (!this.push.isEnabled()) return;
    try {
      await this.runIfStale();
    } catch (e) {
      this.logger.error(`reminder cron failed: ${(e as Error).message}`);
    }
  }

  private async runIfStale(): Promise<void> {
    const last = await this.prisma.pushReminder.findFirst({
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true },
    });
    if (last && (Date.now() - last.sentAt.getTime()) / 3_600_000 < 20) {
      this.logger.log('reminders already ran recently — skipping (replica lockout)');
      return;
    }
    await this.sendReminders();
  }

  private async sendReminders(): Promise<void> {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3_600_000);
    const subscribers = await this.prisma.pushSubscription.findMany({
      select: { userId: true },
      distinct: ['userId'],
    });

    let sent = 0;
    for (const { userId } of subscribers) {
      const lang =
        (await this.prisma.pushSubscription.findFirst({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          select: { lang: true },
        }))?.lang ?? 'uk';

      const sessions = await this.prisma.session.findMany({
        where: { userId, endedAt: { not: null }, feedbackJson: { not: null } },
        orderBy: { endedAt: 'asc' },
        select: {
          characterId: true,
          endedAt: true,
          feedbackJson: true,
          character: { select: { displayName: true } },
        },
      });
      if (sessions.length === 0) continue;

      // Last scored session per patient → most-idle slipping/at-risk one.
      const lastByChar = new Map<number, (typeof sessions)[number]>();
      for (const s of sessions) lastByChar.set(s.characterId, s);
      let best: { cid: number; name: string; weeks: number } | null = null;
      for (const s of lastByChar.values()) {
        if (!s.endedAt) continue;
        let patient: PatientState | null = null;
        try {
          patient = (JSON.parse(s.feedbackJson!) as { patient?: PatientState }).patient ?? null;
        } catch {
          patient = null;
        }
        const wb = computeWellbeing(patientStateScore(patient), s.endedAt, now);
        if (!wb || (wb.stage !== 'slipping' && wb.stage !== 'at_risk')) continue;
        if (!best || wb.weeksIdle > best.weeks) {
          best = { cid: s.characterId, name: s.character.displayName, weeks: wb.weeksIdle };
        }
      }
      if (!best) continue;

      // Throttle: at most one reminder per patient per week.
      const recent = await this.prisma.pushReminder.findFirst({
        where: { userId, characterId: best.cid, sentAt: { gte: weekAgo } },
      });
      if (recent) continue;

      const n = await this.push.sendToUser(userId, {
        title: 'Reflect',
        body: this.copy(lang, best.name, Math.max(1, Math.round(best.weeks))),
        url: `/patient/${best.cid}`,
        tag: `caseload-${best.cid}`,
      });
      if (n > 0) {
        await this.prisma.pushReminder.create({ data: { userId, characterId: best.cid } });
        sent += n;
      }
    }
    this.logger.log(`reminder run complete: subscribers=${subscribers.length} sent=${sent}`);
  }

  /** Supervisor-voice, informational — never guilt, never the patient texting. */
  private copy(lang: string, name: string, weeks: number): string {
    if (lang === 'en') return `${name} hasn't had a session in ~${weeks} week${weeks === 1 ? '' : 's'}. Drop by when you have time.`;
    if (lang === 'fr') return `${name} n'a pas eu de séance depuis ~${weeks} sem. Passez quand vous aurez un moment.`;
    return `${name} давно не було на сесії — ~${weeks} тиж. Зайдіть, коли буде час.`;
  }
}
