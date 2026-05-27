import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type NodeType = 'city' | 'character' | 'user' | 'npc';
export type EdgeType = 'lives_in' | 'treats' | 'shared_with' | 'knows' | 'co_resident';

export interface NetworkNode {
  /** Globally-unique node id encoded as "type:dbId" — e.g. "character:5",
   *  "city:1", "user:3". Lets the frontend address nodes without
   *  collisions across types. */
  id: string;
  type: NodeType;
  label: string;
  /** 1..10 importance — drives node radius and gravitational mass in
   *  the force layout. Larger nodes anchor the scene. */
  size: number;
  /** Optional route path the frontend navigates to on click. */
  href?: string;
  /** Free-form payload for the side panel (city of residence,
   *  session count, diagnosis preview, etc). The client renders
   *  whatever keys it knows about. */
  meta?: Record<string, unknown>;
}

export interface NetworkEdge {
  source: string;
  target: string;
  type: EdgeType;
  /** Edge thickness in the 3D view. Defaults to 1. */
  weight?: number;
}

export interface NetworkGraph {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  /** Server time the graph was built — frontend shows "as of ...". */
  generatedAt: string;
  /** Which slice the caller asked for; echoed for UI. */
  scope: 'mine' | 'admin';
}

/**
 * Assembles the social/professional graph for the 3D visualisation.
 *
 * v1 surfaces:
 *   - Cities (Kyiv, London) — gravitational super-nodes
 *   - Characters living in each city
 *   - Therapists (Users with at least one session) and their
 *     character-treatment edges, weight = sessionCount
 *   - Co-residence edges between characters of the same city —
 *     weak ties that hint at the eventual NPC / cross-mention layer
 *
 * Two scopes:
 *   - 'mine' — what the current therapist can see (own + shared)
 *   - 'admin' — full graph across all users and characters
 *
 * Future phases will add NPC nodes (Phase 3 — Knows-edges to their
 * owner character) and news-topic nodes (Phase 4 — clustering
 * characters who reacted to similar topics).
 */
@Injectable()
export class NetworkService {
  constructor(private readonly prisma: PrismaService) {}

  async buildGraph(opts: {
    userId: number;
    isAdmin: boolean;
    scope: 'mine' | 'admin';
  }): Promise<NetworkGraph> {
    const scope = opts.scope === 'admin' && opts.isAdmin ? 'admin' : 'mine';

    // ─── Characters in scope ────────────────────────────────────────
    const characterWhere = scope === 'admin'
      ? {}
      : {
          OR: [
            { createdById: null }, // system characters visible to all
            { createdById: opts.userId },
            { shares: { some: { userId: opts.userId } } },
          ],
        };

    const characters = await this.prisma.character.findMany({
      where: characterWhere,
      select: {
        id: true,
        displayName: true,
        diagnosis: true,
        difficulty: true,
        cityId: true,
        lang: true,
        createdById: true,
        _count: { select: { sessions: true } },
      },
    });

    // ─── Cities referenced by these characters ──────────────────────
    const cityIds = [...new Set(characters.map((c) => c.cityId).filter((v): v is number => v !== null))];
    const cities = cityIds.length
      ? await this.prisma.city.findMany({
          where: { id: { in: cityIds } },
          select: { id: true, key: true, displayName: true, lang: true },
        })
      : [];

    // ─── Sessions in scope, for therapist → character edges ─────────
    // Aggregated by (userId, characterId) so the weight is sessionCount,
    // not one edge per session.
    const sessionsRaw = await this.prisma.session.groupBy({
      by: ['userId', 'characterId'],
      where: {
        characterId: { in: characters.map((c) => c.id) },
        userId: { not: null },
        ...(scope === 'mine' ? { userId: opts.userId } : {}),
      },
      _count: { _all: true },
    });

    const therapistIds = [...new Set(
      sessionsRaw.map((s) => s.userId).filter((v): v is number => v !== null),
    )];
    const therapists = therapistIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: therapistIds } },
          select: { id: true, email: true, displayName: true },
        })
      : [];

    // ─── Build nodes ────────────────────────────────────────────────
    const nodes: NetworkNode[] = [];

    for (const city of cities) {
      const residents = characters.filter((c) => c.cityId === city.id).length;
      nodes.push({
        id: `city:${city.id}`,
        type: 'city',
        label: city.displayName,
        // Cities are super-nodes — scaled by how many residents they have
        // so a bigger city pulls more characters into its orbit.
        size: Math.min(10, 4 + Math.sqrt(residents)),
        meta: { lang: city.lang, residentCount: residents },
      });
    }

    for (const c of characters) {
      nodes.push({
        id: `character:${c.id}`,
        type: 'character',
        label: c.displayName,
        // Characters scale with how often they've been worked with.
        size: Math.min(8, 3 + Math.sqrt(c._count.sessions)),
        href: `/patient/${c.id}`,
        meta: {
          diagnosis: c.diagnosis,
          difficulty: c.difficulty,
          lang: c.lang,
          sessionCount: c._count.sessions,
          isSystem: c.createdById === null,
        },
      });
    }

    for (const t of therapists) {
      const isSelf = t.id === opts.userId;
      const sessionTotal = sessionsRaw
        .filter((s) => s.userId === t.id)
        .reduce((acc, s) => acc + s._count._all, 0);
      nodes.push({
        id: `user:${t.id}`,
        type: 'user',
        label: t.displayName || t.email,
        size: Math.min(7, 3 + Math.sqrt(sessionTotal)),
        meta: { isSelf, sessionCount: sessionTotal, email: t.email },
      });
    }

    // ─── Build edges ────────────────────────────────────────────────
    const edges: NetworkEdge[] = [];

    // Character → City (lives_in)
    for (const c of characters) {
      if (c.cityId !== null) {
        edges.push({
          source: `character:${c.id}`,
          target: `city:${c.cityId}`,
          type: 'lives_in',
        });
      }
    }

    // Therapist → Character (treats), weight = sessionCount
    for (const s of sessionsRaw) {
      if (s.userId === null) continue;
      edges.push({
        source: `user:${s.userId}`,
        target: `character:${s.characterId}`,
        type: 'treats',
        weight: s._count._all,
      });
    }

    // Character ↔ Character (co_resident) — same-city pairs surface
    // weak ties. Cap by character count to avoid O(n²) explosion in
    // wide cities; for v1 just enumerate, since we're nowhere near
    // that scale yet.
    const byCity = new Map<number, typeof characters>();
    for (const c of characters) {
      if (c.cityId === null) continue;
      if (!byCity.has(c.cityId)) byCity.set(c.cityId, []);
      byCity.get(c.cityId)!.push(c);
    }
    for (const [, residents] of byCity) {
      for (let i = 0; i < residents.length; i++) {
        for (let j = i + 1; j < residents.length; j++) {
          edges.push({
            source: `character:${residents[i].id}`,
            target: `character:${residents[j].id}`,
            type: 'co_resident',
            // Light weight so it shows but doesn't dominate the layout
            weight: 0.3,
          });
        }
      }
    }

    return {
      nodes,
      edges,
      generatedAt: new Date().toISOString(),
      scope,
    };
  }
}
