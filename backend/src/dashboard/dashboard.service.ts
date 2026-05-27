import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CityService } from '../city/city.service';
import { CharactersService } from '../characters/characters.service';

/**
 * Aggregator for the logged-in home page. One round-trip returns
 * everything the dashboard needs:
 *
 *   - city pulse (Phase 1 digest + weather for the user's locale)
 *   - active sessions to resume (endedAt null)
 *   - pending feedback (ended but feedback never generated — usually
 *     LLM-fail recovery state)
 *   - recent diary entries (Phase 4) across all the user's characters
 *   - this-week stats
 *   - patient grid for the bottom (compact)
 *
 * Keeps the home page snappy — one API call, indexed queries, no
 * per-section spinners.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly city: CityService,
    private readonly characters: CharactersService,
  ) {}

  async getForUser(userId: number, lang: string) {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // City pulse — shared singleton per locale.
    const city = await this.city.getForLang(lang);

    // Active session = endedAt null AND therapist actually engaged
    // (at least one user turn beyond the seed). Earlier we surfaced
    // every "session row created" — including the abandoned retries
    // during the credit-fail period that only had the SEED message
    // (msg-count=1), producing a row of identical "Продовжити · Анна"
    // cards that's just noise. Now: require ≥2 messages (seed + at
    // least one real exchange), dedupe to the most recent per
    // character, cap at 3.
    const allActiveRaw = await this.prisma.session.findMany({
      where: { userId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      include: {
        character: {
          select: { id: true, displayName: true, avatarUrl: true, diagnosis: true },
        },
        _count: { select: { messages: true } },
      },
    });
    const seenChar = new Set<number>();
    const activeSessions = allActiveRaw
      .filter((s) => s._count.messages >= 2)
      .filter((s) => {
        if (seenChar.has(s.characterId)) return false;
        seenChar.add(s.characterId);
        return true;
      })
      .slice(0, 3);

    // Pending feedback = ended session that never got feedback generated
    // (e.g. LLM-fail). Therapist should retry.
    const pendingFeedback = await this.prisma.session.findMany({
      where: { userId, endedAt: { not: null }, feedback: null },
      orderBy: { endedAt: 'desc' },
      take: 5,
      include: {
        character: {
          select: { id: true, displayName: true, avatarUrl: true },
        },
      },
    });

    // Recent diary across all the user's characters. Limit to 12 so we
    // can render ~6-8 cards comfortably without infinite scroll.
    const recentDiary = await this.prisma.characterMemory.findMany({
      where: { userId, kind: 'diary' },
      orderBy: { createdAt: 'desc' },
      take: 12,
      include: {
        character: {
          select: { id: true, displayName: true, avatarUrl: true, lang: true },
        },
      },
    });

    // This-week stats: sessions count + sessions with feedback +
    // average alliance from the JSON assessment (Phase 2). Small rollup.
    const weekSessions = await this.prisma.session.findMany({
      where: { userId, startedAt: { gte: weekAgo } },
      select: { id: true, feedback: true, feedbackJson: true },
    });
    const alliances = weekSessions
      .map((s) => {
        if (!s.feedbackJson) return null;
        try {
          const a = JSON.parse(s.feedbackJson);
          const v = a?.patient?.alliance;
          return typeof v === 'number' ? v : null;
        } catch {
          return null;
        }
      })
      .filter((v): v is number => v !== null);
    const avgAlliance = alliances.length
      ? alliances.reduce((a, b) => a + b, 0) / alliances.length
      : null;

    // Patient grid — same shape as characters list, but trimmed to
    // the most-recently-active ones to keep the home page compact.
    // The full filtered grid still lives at /clients.
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true },
    });
    const visibility = this.characters.visibilityFilter(userId, !!me?.isAdmin);
    const langFilter = me?.isAdmin
      ? {}
      : { lang: lang === 'en' ? 'en' : 'uk' };
    const allCharacters = await this.prisma.character.findMany({
      where: { AND: [visibility, langFilter] },
      include: {
        sessions: {
          where: { userId },
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: { startedAt: true },
        },
      },
    });
    // Order by last-touched session (recently engaged first), then
    // freshly-loaded characters (no sessions) trail at the end.
    const patientGrid = allCharacters
      .map((c) => ({
        id: c.id,
        displayName: c.displayName,
        avatarUrl: c.avatarUrl,
        diagnosis: c.diagnosis,
        difficulty: c.difficulty,
        modality: c.modality,
        lastSessionAt: c.sessions[0]?.startedAt ?? null,
        isMine: c.createdById === userId,
      }))
      .sort((a, b) => {
        const at = a.lastSessionAt?.getTime() ?? 0;
        const bt = b.lastSessionAt?.getTime() ?? 0;
        return bt - at;
      })
      .slice(0, 12); // Compact grid; "All clients" link goes to /clients

    return {
      city: city
        ? {
            displayName: city.displayName,
            weeklyDigest: city.weeklyDigest,
            weatherSummary: city.weatherSummary,
          }
        : null,
      activeSessions: activeSessions.map((s) => ({
        id: s.id,
        startedAt: s.startedAt,
        character: s.character,
        messageCount: s._count.messages,
      })),
      pendingFeedback: pendingFeedback.map((s) => ({
        id: s.id,
        endedAt: s.endedAt,
        character: s.character,
      })),
      recentDiary: recentDiary.map((m) => ({
        id: m.id,
        characterId: m.characterId,
        character: m.character,
        content: m.content,
        tags: m.tags ? this.safeJsonArray(m.tags) : [],
        createdAt: m.createdAt,
      })),
      weekStats: {
        sessions: weekSessions.length,
        withFeedback: weekSessions.filter((s) => !!s.feedback).length,
        avgAlliance,
      },
      patientGrid,
      // Indicates whether there are more characters than the grid
      // shows — frontend can render an "Усі пацієнти →" link to /clients.
      hasMorePatients: allCharacters.length > patientGrid.length,
    };
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
