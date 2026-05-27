import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CityService } from './city.service';
import { NewsService } from './news.service';

/**
 * Cron-driven background jobs that keep the city's news + digest fresh.
 * Two cadences:
 *   - hourly: ingest RSS feeds (cheap, additive)
 *   - daily 04:00: regenerate the weekly digest (1 LLM call per city)
 *
 * Both run on EVERY API replica — fine because:
 *   - NewsItem has a unique constraint, so concurrent ingestion just
 *     dedupes naturally
 *   - Digest write is last-writer-wins, idempotent enough
 *
 * If this becomes a problem at scale, we can gate via a Redis lock or
 * dedicated worker.
 *
 * On module init we kick a one-shot ingest (don't wait an hour for the
 * very first batch on a fresh deploy) and lazily regenerate the digest
 * if it's stale (>24h or never).
 */
@Injectable()
export class CityScheduler implements OnModuleInit {
  private readonly logger = new Logger(CityScheduler.name);

  constructor(
    private readonly city: CityService,
    private readonly news: NewsService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    // Kick off in the background so app boot isn't blocked by an LLM
    // round-trip or RSS fetch. Errors are logged, not thrown.
    void this.warmStart();
  }

  private async warmStart(): Promise<void> {
    try {
      this.logger.log('warm start: ingesting news…');
      const { added, skipped } = await this.news.ingest();
      this.logger.log(`warm start ingest: +${added} skipped=${skipped}`);
    } catch (e) {
      this.logger.warn(`warm start ingest failed: ${(e as Error).message}`);
    }

    try {
      // Only regenerate digest if missing or older than 24h. Saves an
      // LLM call on every container restart.
      await this.regenerateStaleDigests();
    } catch (e) {
      this.logger.warn(`warm start digest failed: ${(e as Error).message}`);
    }
  }

  private async regenerateStaleDigests(): Promise<void> {
    const cities = await this.prisma.city.findMany({
      select: { id: true, key: true, digestUpdatedAt: true },
    });
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const c of cities) {
      const stale = !c.digestUpdatedAt || c.digestUpdatedAt.getTime() < dayAgo;
      if (!stale) {
        this.logger.log(`city=${c.key}: digest fresh, skipping warm regen`);
        continue;
      }
      try {
        await this.city.regenerateDigest(c.id);
      } catch (e) {
        this.logger.warn(`city=${c.key}: warm digest failed (${(e as Error).message})`);
      }
    }
  }

  /** Pull every RSS source once an hour. Light work — just RSS + LLM
   *  summary for new items. */
  @Cron(CronExpression.EVERY_HOUR)
  async hourlyIngest() {
    try {
      const { added, skipped } = await this.news.ingest();
      this.logger.log(`hourly ingest: +${added} skipped=${skipped}`);
    } catch (e) {
      this.logger.error(`hourly ingest failed: ${(e as Error).message}`);
    }
  }

  /** Regenerate every city's weekly digest once a day at 04:00 server
   *  time. Off-peak so we don't compete with active sessions for the
   *  LLM rate limit. */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async dailyDigest() {
    this.logger.log('daily digest regeneration starting');
    try {
      await this.city.regenerateAllDigests();
    } catch (e) {
      this.logger.error(`daily digest failed: ${(e as Error).message}`);
    }
  }
}
