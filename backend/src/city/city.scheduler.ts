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
    // Refresh a stale digest FIRST, from news already stored in the DB.
    // This used to run AFTER `news.ingest()` — but a full ingest is a
    // multi-minute job (a dozen RSS feeds + a serial LLM summary per new
    // item). With frequent deploys, each warm start got killed mid-ingest
    // before ever reaching the regen, so the digest sat stale for days even
    // though the independent hourly cron kept news fresh. Regenerating first
    // (a few seconds, off already-ingested news) makes every boot refresh a
    // stale digest. Only regenerates if missing or >24h old.
    try {
      await this.regenerateStaleDigests();
    } catch (e) {
      this.logger.warn(`warm start digest failed: ${(e as Error).message}`);
    }

    // Then top up news in the background — fire-and-forget so a slow feed
    // sweep can never again block app readiness or starve the digest
    // refresh above. The hourly cron is the steady-state path anyway.
    this.logger.log('warm start: ingesting news in background…');
    void this.news
      .ingest()
      .then(({ added, skipped }) =>
        this.logger.log(`warm start ingest: +${added} skipped=${skipped}`),
      )
      .catch((e) =>
        this.logger.warn(`warm start ingest failed: ${(e as Error).message}`),
      );
  }

  private async regenerateStaleDigests(): Promise<void> {
    const cities = await this.prisma.city.findMany({
      // weeklyDigest needed too — a city with a NULL digest but a
      // fresh `digestUpdatedAt` is still stale; that combo happens
      // when an earlier regen ran during an empty news window and
      // stamped the timestamp without producing text. The next day
      // when news arrives we still want to retry.
      select: { id: true, key: true, weeklyDigest: true, digestUpdatedAt: true },
    });
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const c of cities) {
      const hasDigest = typeof c.weeklyDigest === 'string' && c.weeklyDigest.trim().length > 0;
      const stale = !hasDigest || !c.digestUpdatedAt || c.digestUpdatedAt.getTime() < dayAgo;
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
