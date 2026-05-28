import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type MemoryKind = 'session' | 'world' | 'social' | 'diary' | 'seed' | 'avoided';

export interface AddMemoryInput {
  characterId: number;
  userId: number;
  kind: MemoryKind;
  content: string;
  sessionId?: number;
  weight?: number;
  tags?: string[];
}

export interface MemoryEntry {
  id: number;
  kind: MemoryKind;
  content: string;
  sessionId: number | null;
  weight: number;
  tags: string[];
  createdAt: Date;
}

/**
 * Default weights per memory kind — controls retrieval ranking when
 * the prompt-builder picks top-N. Higher = more likely to surface.
 *
 * Tuned so that:
 *  - session memories outweigh diary entries (the therapy work is the
 *    backbone of what the character remembers about the relationship)
 *  - seed biographical context wins ties because it's always relevant
 *  - world reactions are background-weight — they're vivid but
 *    transient
 */
const DEFAULT_WEIGHTS: Record<MemoryKind, number> = {
  seed: 0.8,
  // A between-session consequential event the patient is AVOIDING. Weighted
  // high so it reliably surfaces in the chat prompt — but rendered there as
  // an avoidance instruction (see sessions.service.buildMemorySection), not
  // a recited bullet, so the trainee has to draw it out.
  avoided: 0.7,
  session: 0.6,
  social: 0.5,
  diary: 0.4,
  world: 0.3,
};

@Injectable()
export class MemoryService implements OnModuleInit {
  private readonly logger = new Logger(MemoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    // One-time migration from the legacy `Session.patientMemory` field
    // to the new CharacterMemory table. Idempotent — only inserts rows
    // that don't already have a corresponding session-kind memory.
    // Runs in background so app boot isn't slowed.
    void this.migrateLegacyPatientMemory();
  }

  /**
   * Persist a new memory entry. Returns the created row's id. Callers
   * should pass a sensible weight if they want to override the
   * kind-default — otherwise omit and let DEFAULT_WEIGHTS handle it.
   */
  async add(input: AddMemoryInput): Promise<number> {
    if (!input.content?.trim()) {
      // Don't store empty memories — they're noise in retrieval and
      // suggest the LLM produced no useful summary.
      return -1;
    }
    const weight = input.weight ?? DEFAULT_WEIGHTS[input.kind];
    const created = await this.prisma.characterMemory.create({
      data: {
        characterId: input.characterId,
        userId: input.userId,
        sessionId: input.sessionId ?? null,
        kind: input.kind,
        content: input.content.trim(),
        weight,
        tags: input.tags?.length ? JSON.stringify(input.tags) : null,
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Load the top-N most-relevant memories for a (user, character) pair,
   * ordered for prompt injection. Ranking: weight first, recency
   * tiebreaker. Caller can filter by kinds — e.g. chat injects all
   * kinds but the patient-detail page might show only 'session'.
   *
   * Returns lightweight DTOs with tags pre-parsed from JSON.
   */
  async loadRecent(
    userId: number,
    characterId: number,
    opts: { limit?: number; kinds?: MemoryKind[] } = {},
  ): Promise<MemoryEntry[]> {
    const limit = opts.limit ?? 8;
    const rows = await this.prisma.characterMemory.findMany({
      where: {
        userId,
        characterId,
        ...(opts.kinds?.length ? { kind: { in: opts.kinds } } : {}),
      },
      // Higher weight first; same-weight ties → newer first. We do this
      // in two stages because Prisma can only order by one field at a
      // time on SQLite without raw SQL — but the table's small per
      // character so we can sort in JS.
      orderBy: { createdAt: 'desc' },
      take: limit * 3, // pull a wider window so weight-sort has room
    });
    const sorted = rows
      .map((r) => ({
        id: r.id,
        kind: r.kind as MemoryKind,
        content: r.content,
        sessionId: r.sessionId,
        weight: r.weight,
        tags: r.tags ? this.safeJsonArray(r.tags) : [],
        createdAt: r.createdAt,
      }))
      .sort((a, b) => {
        if (b.weight !== a.weight) return b.weight - a.weight;
        return b.createdAt.getTime() - a.createdAt.getTime();
      })
      .slice(0, limit);
    return sorted;
  }

  /**
   * For backward-compat: pull just the session memories in chronological
   * order (oldest first), returning their content strings. Drop-in
   * replacement for the old loadPriorMemories() helper on
   * SessionsService.
   */
  async loadSessionMemoryStrings(
    userId: number,
    characterId: number,
    limit = 5,
  ): Promise<string[]> {
    const rows = await this.prisma.characterMemory.findMany({
      where: { userId, characterId, kind: 'session' },
      orderBy: { createdAt: 'asc' },
      select: { content: true },
      // Take the most recent N — but we order asc for prompt readability,
      // so do this via two queries: count + skip. SQLite small enough
      // that we just pull all and slice in JS.
    });
    return rows.slice(-limit).map((r) => r.content);
  }

  /**
   * Idempotently migrate any Session.patientMemory entries that don't
   * yet have a corresponding CharacterMemory row. Runs once at boot.
   * Detection uses sessionId — if any memory exists for that session,
   * we assume it's already migrated and skip.
   */
  private async migrateLegacyPatientMemory(): Promise<void> {
    try {
      const sessions = await this.prisma.session.findMany({
        where: {
          patientMemory: { not: null },
          userId: { not: null },
          memories: { none: { kind: 'session' } },
        },
        select: { id: true, userId: true, characterId: true, patientMemory: true },
      });

      if (sessions.length === 0) {
        this.logger.log('no legacy patient memories to migrate');
        return;
      }

      let migrated = 0;
      for (const s of sessions) {
        if (!s.patientMemory || !s.userId) continue;
        await this.prisma.characterMemory.create({
          data: {
            characterId: s.characterId,
            userId: s.userId,
            sessionId: s.id,
            kind: 'session',
            content: s.patientMemory,
            weight: DEFAULT_WEIGHTS.session,
          },
        });
        migrated++;
      }
      this.logger.log(`migrated ${migrated} legacy session memories`);
    } catch (e) {
      this.logger.warn(`legacy memory migration failed: ${(e as Error).message}`);
    }
  }

  private safeJsonArray(raw: string): string[] {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
}
