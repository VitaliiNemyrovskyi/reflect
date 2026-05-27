import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';

/** Allowed NPC relation slugs. Anything else is rejected at the
 *  service layer — keeps prompt phrasing predictable and lets the
 *  3D network color-code by relation later. */
const ALLOWED_RELATIONS = [
  'mother',
  'father',
  'partner',
  'ex',
  'sibling',
  'child',
  'friend',
  'colleague',
  'boss',
  'neighbor',
  'therapist_prev',
  'other',
] as const;

export type NpcRelation = (typeof ALLOWED_RELATIONS)[number];

export interface CreateNpcDto {
  name: string;
  relation: string;
  bio?: string;
  avatarUrl?: string;
  tags?: string[];
  tension?: number;
}

export type UpdateNpcDto = Partial<CreateNpcDto>;

export interface NpcDto {
  id: number;
  characterId: number;
  name: string;
  relation: string;
  bio: string | null;
  avatarUrl: string | null;
  tags: string[];
  tension: number;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class NpcService {
  private readonly logger = new Logger(NpcService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  // ─── CRUD ──────────────────────────────────────────────────────────────

  async listForCharacter(characterId: number): Promise<NpcDto[]> {
    const rows = await this.prisma.nPC.findMany({
      where: { characterId },
      orderBy: { tension: 'desc' }, // higher tension first — likely more salient
    });
    return rows.map((r) => this.toDto(r));
  }

  async create(characterId: number, dto: CreateNpcDto): Promise<NpcDto> {
    const data = this.validate(dto, /* allowEmptyName */ false);
    const created = await this.prisma.nPC.create({
      data: {
        characterId,
        name: data.name!.trim(),
        relation: data.relation!,
        bio: data.bio ?? null,
        avatarUrl: data.avatarUrl ?? null,
        tags: data.tags ? JSON.stringify(data.tags) : null,
        tension: data.tension ?? 5,
      },
    });
    return this.toDto(created);
  }

  async update(id: number, dto: UpdateNpcDto): Promise<NpcDto> {
    const existing = await this.prisma.nPC.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('npc not found');
    const data = this.validate(dto, /* allowEmptyName */ true);
    const updated = await this.prisma.nPC.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(data.relation !== undefined ? { relation: data.relation } : {}),
        ...(data.bio !== undefined ? { bio: data.bio || null } : {}),
        ...(data.avatarUrl !== undefined ? { avatarUrl: data.avatarUrl || null } : {}),
        ...(data.tags !== undefined
          ? { tags: data.tags.length ? JSON.stringify(data.tags) : null }
          : {}),
        ...(data.tension !== undefined ? { tension: data.tension } : {}),
      },
    });
    return this.toDto(updated);
  }

  async delete(id: number): Promise<void> {
    const existing = await this.prisma.nPC.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('npc not found');
    await this.prisma.nPC.delete({ where: { id } });
  }

  // ─── LLM helpers ───────────────────────────────────────────────────────

  /**
   * Generate a believable supporting cast for a character based on
   * their profile + diagnosis. One LLM call returns 3-5 NPCs as a JSON
   * array; we validate and persist them. Idempotent only in spirit —
   * re-running adds another set of NPCs alongside existing ones, so
   * callers may want to wipe first.
   *
   * Returns the freshly-created NPC list.
   */
  async generateForCharacter(characterId: number, opts: { count?: number } = {}): Promise<NpcDto[]> {
    const character = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: { id: true, displayName: true, profileText: true, lang: true },
    });
    if (!character) throw new NotFoundException('character not found');

    const count = Math.max(2, Math.min(opts.count ?? 4, 6));
    const isUk = character.lang === 'uk';

    const systemPrompt = isUk
      ? [
          `Ти створюєш реалістичне коло близьких людей (NPC) для пацієнтки/пацієнта тренажера психотерапевта.`,
          `Профіль персонажа: ${character.displayName}.`,
          '',
          `Поверни ЛИШЕ JSON-масив з ${count} об'єктами у форматі:`,
          '[',
          '  {',
          '    "name": "ім\'я або роль (напр. \\"Мама\\", \\"Денис\\", \\"Олена з роботи\\")",',
          '    "relation": "mother | father | partner | ex | sibling | child | friend | colleague | boss | neighbor | therapist_prev | other",',
          '    "bio": "1-2 короткі речення українською — хто це людина і яка з нею динаміка зараз",',
          '    "tags": ["3-5 тегів latin-only: supportive, conflict, distant, financial-pressure, controlling, ill, recently-deceased, complicated"],',
          '    "tension": <число 0-10, 5 = нейтрально, >7 = джерело стресу, <3 = опора>',
          '  }',
          ']',
          '',
          'Реалістично! Опирайся на профіль — діагноз, контекст, теми у профілі. Не давай усім "конфліктним мамам". Створи мікс — хтось підтримка, хтось стрес, хтось периферія.',
        ].join('\n')
      : [
          `You compose a realistic circle of close people (NPCs) for a psychotherapy-trainer patient.`,
          `Character profile: ${character.displayName}.`,
          '',
          `Return ONLY a JSON array of ${count} objects in the format:`,
          '[',
          '  {',
          '    "name": "name or role (e.g. \\"Mum\\", \\"James\\", \\"Sarah from work\\")",',
          '    "relation": "mother | father | partner | ex | sibling | child | friend | colleague | boss | neighbor | therapist_prev | other",',
          '    "bio": "1-2 short sentences in English — who they are and the current dynamic",',
          '    "tags": ["3-5 lowercase tags: supportive, conflict, distant, financial-pressure, controlling, ill, recently-deceased, complicated"],',
          '    "tension": <number 0-10, 5 = neutral, >7 = source of stress, <3 = support>',
          '  }',
          ']',
          '',
          'Be realistic! Anchor in the profile — diagnosis, context, themes. Don\'t default to "conflicted mother" for everyone. Create a mix — some support, some stress, some peripheral.',
        ].join('\n');

    const raw = await this.llm.chat({
      systemPrompt,
      history: [
        {
          role: 'user',
          content: `Профіль:\n\n${character.profileText.slice(0, 3000)}\n\nЗгенеруй коло близьких людей.`,
        },
      ],
      maxTokens: 1500,
    });

    const parsed = this.extractJsonArray(raw);
    if (!Array.isArray(parsed)) {
      throw new BadRequestException('LLM did not return a valid NPC array');
    }

    const created: NpcDto[] = [];
    for (const item of parsed.slice(0, count)) {
      try {
        const dto = this.coerceLlmItem(item);
        const npc = await this.create(characterId, dto);
        created.push(npc);
      } catch (e) {
        this.logger.warn(`skipping invalid LLM-generated NPC: ${(e as Error).message}`);
      }
    }
    return created;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private validate(dto: CreateNpcDto | UpdateNpcDto, allowEmptyName: boolean): CreateNpcDto {
    const out: CreateNpcDto = {} as CreateNpcDto;
    if (dto.name !== undefined) {
      const trimmed = dto.name.trim();
      if (!trimmed) {
        if (!allowEmptyName) throw new BadRequestException('name is required');
      } else {
        if (trimmed.length > 100) {
          throw new BadRequestException('name too long (max 100 chars)');
        }
        out.name = trimmed;
      }
    } else if (!allowEmptyName) {
      throw new BadRequestException('name is required');
    }
    if (dto.relation !== undefined) {
      if (!ALLOWED_RELATIONS.includes(dto.relation as NpcRelation)) {
        throw new BadRequestException(
          `relation must be one of: ${ALLOWED_RELATIONS.join(', ')}`,
        );
      }
      out.relation = dto.relation;
    } else if (!allowEmptyName) {
      // On create require relation; on update it's optional.
      throw new BadRequestException('relation is required');
    }
    if (dto.bio !== undefined) {
      if (dto.bio.length > 1000) {
        throw new BadRequestException('bio too long (max 1000 chars)');
      }
      out.bio = dto.bio;
    }
    if (dto.avatarUrl !== undefined) {
      out.avatarUrl = dto.avatarUrl;
    }
    if (dto.tags !== undefined) {
      if (!Array.isArray(dto.tags) || dto.tags.some((t) => typeof t !== 'string')) {
        throw new BadRequestException('tags must be string[]');
      }
      out.tags = dto.tags.slice(0, 10).map((t) => t.trim().toLowerCase()).filter(Boolean);
    }
    if (dto.tension !== undefined) {
      const n = Number(dto.tension);
      if (!Number.isFinite(n) || n < 0 || n > 10) {
        throw new BadRequestException('tension must be 0..10');
      }
      out.tension = n;
    }
    return out;
  }

  private coerceLlmItem(raw: unknown): CreateNpcDto {
    if (!raw || typeof raw !== 'object') throw new Error('not an object');
    const r = raw as Record<string, unknown>;
    return {
      name: typeof r.name === 'string' ? r.name : '',
      relation: typeof r.relation === 'string' ? r.relation : 'other',
      bio: typeof r.bio === 'string' ? r.bio : undefined,
      tags: Array.isArray(r.tags)
        ? r.tags.filter((t): t is string => typeof t === 'string')
        : undefined,
      tension: typeof r.tension === 'number' ? r.tension : 5,
    };
  }

  private extractJsonArray(raw: string): unknown {
    // LLM may wrap in ```json fences or preamble. Locate the first
    // [ and matching last ].
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start < 0 || end < start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  private toDto(row: {
    id: number;
    characterId: number;
    name: string;
    relation: string;
    bio: string | null;
    avatarUrl: string | null;
    tags: string | null;
    tension: number;
    createdAt: Date;
    updatedAt: Date;
  }): NpcDto {
    return {
      id: row.id,
      characterId: row.characterId,
      name: row.name,
      relation: row.relation,
      bio: row.bio,
      avatarUrl: row.avatarUrl,
      tags: row.tags ? this.safeJsonArray(row.tags) : [],
      tension: row.tension,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
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
