import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.$connect();

    // Enable WAL (Write-Ahead Logging) so two API replicas can write to
    // the same SQLite file without SQLITE_BUSY thrash. WAL lets readers
    // proceed concurrently with a writer, and serialises writes via
    // the WAL file rather than locking the whole DB. The PRAGMA is
    // persistent — once set, it survives across reconnects and
    // restarts, so re-running this on every boot is a no-op after the
    // first time. NORMAL synchronous mode pairs with WAL for the right
    // durability/throughput tradeoff (no fsync per transaction; fsync
    // happens at checkpoints).
    try {
      const mode = await this.$queryRawUnsafe<Array<{ journal_mode: string }>>(
        `PRAGMA journal_mode=WAL;`,
      );
      await this.$executeRawUnsafe(`PRAGMA synchronous=NORMAL;`);
      this.logger.log(
        `SQLite ready, journal_mode=${mode[0]?.journal_mode ?? 'unknown'}`,
      );
    } catch (e) {
      // WAL set is best-effort — if the underlying DB driver doesn't
      // expose PRAGMA (e.g. someday we switch to Postgres), don't fail
      // startup over it. Log so an operator knows we didn't apply.
      this.logger.warn(
        `Could not set SQLite WAL mode (likely non-SQLite backend): ${(e as Error).message}`,
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
