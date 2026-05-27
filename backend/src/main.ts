import 'reflect-metadata';
// Load .env BEFORE importing AppModule, so that static field initializers
// (like GoogleStrategy.enabled) see the actual values, not undefined.
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
dotenvConfig({ path: resolve(process.cwd(), '..', '.env') });
dotenvConfig({ path: resolve(process.cwd(), '.env') });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, type INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { ErrorLogFilter } from './error-log.filter';
import { HealthService } from './health/health.service';

/** How long we let Caddy's health-check notice we flipped to 503 before
 *  we start the actual shutdown sequence. Caddy polls every 5s, so 6s
 *  gives one definite "unhealthy" tick. */
const SHUTDOWN_LB_DRAIN_MS = 6_000;

/** Max time to wait for active SSE streams to finish before forcing
 *  exit. 110s leaves ~10s of the 120s `stop_grace_period` budget for
 *  Nest's own app.close() teardown. */
const SHUTDOWN_STREAM_DRAIN_MS = 110_000;

async function bootstrap() {
  // touch — load all 4 patient profiles
  const app = await NestFactory.create(AppModule, { cors: true });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  // Global exception filter — captures 500-class errors into ErrorLog
  // table for admin debugging without losing default response shape.
  // Resolve PrismaService from the container so the filter shares the
  // same connection pool as everything else.
  const prisma = app.get(PrismaService);
  app.useGlobalFilters(new ErrorLogFilter(prisma));

  // Nest's shutdown hooks (onModuleDestroy, onApplicationShutdown) are
  // what PrismaService etc. rely on to close cleanly. Without this they
  // get SIGTERM and die mid-query.
  app.enableShutdownHooks();

  registerGracefulShutdown(app);

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  Logger.log(`Reflect API → http://localhost:${port}/api`, 'Bootstrap');
}

/**
 * Custom SIGTERM handler that drains the API gracefully — without this
 * a deploy kills in-flight feedback streams (30-90s LLM calls) mid-token,
 * which the therapist sees as a frozen typing animation followed by an
 * error.
 *
 * Sequence:
 *   1. Flip HealthService.shuttingDown → /api/health returns 503
 *   2. Wait 6s so Caddy's next health-check tick notices and stops
 *      routing new traffic to us
 *   3. Call app.close() which stops the HTTP listener, runs Nest's
 *      onApplicationShutdown hooks (Prisma disconnect etc.), and waits
 *      for in-flight HTTP requests to drain
 *   4. Poll HealthService.activeStreamCount until 0 or 110s elapsed
 *   5. process.exit(0)
 *
 * Total budget aligns with docker-compose `stop_grace_period: 120s` —
 * after that Docker sends SIGKILL.
 */
function registerGracefulShutdown(app: INestApplication): void {
  const health = app.get(HealthService);
  let shuttingDown = false;

  const handle = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      Logger.warn(`Second ${signal} received during shutdown — ignoring`, 'Shutdown');
      return;
    }
    shuttingDown = true;
    Logger.log(`${signal} received — starting graceful shutdown`, 'Shutdown');

    // Tell the LB we're done. New traffic shifts to the other replica.
    health.beginShutdown();

    // Give Caddy a beat to mark us unhealthy. Without this, requests
    // sent in the gap between SIGTERM and the next 5s probe still land
    // here and get 503'd (Caddy retries them, but the round-trip wastes
    // time the user notices).
    await sleep(SHUTDOWN_LB_DRAIN_MS);

    Logger.log(
      `Closing HTTP listener; ${health.activeStreamCount} active streams to drain`,
      'Shutdown',
    );

    try {
      // app.close() stops the listener and runs lifecycle hooks. Returns
      // once Nest believes everything is wound down — but it does NOT
      // wait for SSE streams (those are open Express responses we
      // tracked ourselves), so we poll below.
      await app.close();
    } catch (e) {
      Logger.error(`app.close() threw: ${(e as Error).message}`, 'Shutdown');
    }

    const deadline = Date.now() + SHUTDOWN_STREAM_DRAIN_MS;
    while (health.activeStreamCount > 0 && Date.now() < deadline) {
      await sleep(500);
    }

    if (health.activeStreamCount > 0) {
      Logger.warn(
        `Force-exiting with ${health.activeStreamCount} streams still active — drain budget exhausted`,
        'Shutdown',
      );
    } else {
      Logger.log('Drained cleanly', 'Shutdown');
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => void handle('SIGTERM'));
  process.on('SIGINT', () => void handle('SIGINT'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

void bootstrap();
