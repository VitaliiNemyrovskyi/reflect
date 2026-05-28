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
    /** Locale to scope the graph to — only characters with this lang
     *  and their resident city appear. Strict isolation (no admin
     *  bypass) so EN trainees see only London + UK Anna stays out. */
    lang: 'uk' | 'en' | 'fr';
  }): Promise<NetworkGraph> {
    const scope = opts.scope === 'admin' && opts.isAdmin ? 'admin' : 'mine';

    // ─── Characters in scope ────────────────────────────────────────
    // Layer 1: visibility (mine / admin)
    // Layer 2: locale isolation — applied always, even for admins, so
    //          flipping the lang picker actually swaps the visible
    //          population.
    const visibilityWhere = scope === 'admin'
      ? {}
      : {
          OR: [
            { createdById: null }, // system characters visible to all
            { createdById: opts.userId },
            { shares: { some: { userId: opts.userId } } },
          ],
        };
    const characterWhere = {
      AND: [visibilityWhere, { lang: opts.lang }],
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
        avatarUrl: true,
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

    // ─── NPCs for in-scope characters (Phase 3) ─────────────────────
    // NPCs belong to characters — pulled together so the 3D web shows
    // each character's social orbit. Slate-colored nodes connected by
    // `knows` edges; size scales with tension (high-tension NPCs are
    // larger / more visually present, signalling salience).
    const npcs = characters.length
      ? await this.prisma.nPC.findMany({
          where: { characterId: { in: characters.map((c) => c.id) } },
          select: {
            id: true,
            characterId: true,
            name: true,
            relation: true,
            tension: true,
            bio: true,
            avatarUrl: true,
          },
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
          // avatarUrl drives the frontend's nodeThreeObject hook so the
          // character renders as a circular avatar sprite in 3D rather
          // than the default sphere. Missing → fall back to sphere.
          avatarUrl: c.avatarUrl ?? null,
          diagnosis: c.diagnosis,
          difficulty: c.difficulty,
          lang: c.lang,
          sessionCount: c._count.sessions,
          isSystem: c.createdById === null,
        },
      });
    }

    for (const npc of npcs) {
      nodes.push({
        id: `npc:${npc.id}`,
        type: 'npc',
        label: npc.name,
        // NPC size grows with tension — high-tension relationships
        // dominate the patient's mental space, so they should be more
        // visually present in the social orbit.
        size: 2 + (npc.tension / 10) * 2,
        meta: {
          relation: npc.relation,
          tension: npc.tension,
          bio: npc.bio,
          avatarUrl: npc.avatarUrl,
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

    // Character → NPC (knows). Edge weight scales with tension so
    // high-stakes relationships (tension > 6) tug their NPC closer in
    // the force layout, while peripheral acquaintances drift looser.
    for (const npc of npcs) {
      edges.push({
        source: `character:${npc.characterId}`,
        target: `npc:${npc.id}`,
        type: 'knows',
        weight: 0.3 + (npc.tension / 10) * 0.7,
      });
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
