import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { DiaryService } from './diary.service';

/**
 * Daily diary cron — runs at 05:00 UTC, AFTER the 04:00 city-digest
 * regeneration (Phase 1's scheduler). That way each diary call sees a
 * fresh digest reflecting the previous 24h of news.
 *
 * Both api replicas run this cron — to avoid duplicate diary entries
 * each day, we use a coarse lockout: only run if the LAST diary
 * memory in the DB is older than 23 hours. With WAL-mode SQLite +
 * the unique-per-pair-per-day check this is good enough for v1; if
 * we ever see double-runs we can promote to a proper Redis lock.
 *
 * Warm-start also fires on boot but only after a 60s settling delay
 * (so the first-deploy doesn't race with PromptsService / CityService
 * onModuleInit batches that already hammer the LLM).
 */
@Injectable()
export class DiaryScheduler implements OnModuleInit {
  private readonly logger = new Logger(DiaryScheduler.name);

  constructor(
    private readonly diary: DiaryService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    setTimeout(() => void this.warmStart(), 60_000);
  }

  private async warmStart(): Promise<void> {
    try {
      this.logger.log('warm start: checking if diary generation needed…');
      await this.runIfStale();
    } catch (e) {
      this.logger.warn(`warm start failed: ${(e as Error).message}`);
    }
  }

  /** Skip the batch when the most recent diary entry in the DB is
   *  fresher than this threshold. Keeps the two api replicas from
   *  doubling up on cron tick, and prevents warm-start on every
   *  container restart from regenerating diary on top of itself. */
  private async runIfStale(): Promise<void> {
    const last = await this.prisma.characterMemory.findFirst({
      where: { kind: 'diary' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last) {
      const ageHours = (Date.now() - last.createdAt.getTime()) / 3_600_000;
      if (ageHours < 23) {
        this.logger.log(
          `diary already ran ${ageHours.toFixed(1)}h ago — skipping (threshold: 23h)`,
        );
        return;
      }
    }
    const result = await this.diary.runDailyForAllActive();
    this.logger.log(
      `diary daily run complete: pairs=${result.pairs} entries=${result.entries} failed=${result.failed}`,
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async dailyDiary() {
    this.logger.log('daily diary cron starting');
    try {
      await this.runIfStale();
    } catch (e) {
      this.logger.error(`daily diary cron failed: ${(e as Error).message}`);
    }
  }
}
