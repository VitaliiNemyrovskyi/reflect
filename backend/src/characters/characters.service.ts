import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PromptsService } from '../prompts/prompts.service';
import { LlmService } from '../llm/llm.service';

/**
 * Brief input the user fills on the frontend form. The LLM uses these
 * fields to draft a full 8-section profile, and the form also stores
 * them server-side as the source-of-truth metadata.
 */
export interface CharacterDraftBrief {
  displayName: string;
  gender: 'female' | 'male';
  age?: number;
  city?: string;
  profession?: string;
  diagnosis?: string;       // Ukrainian label
  diagnosisCode?: string;   // DSM-5 / ICD English label
  difficulty?: number;      // 1-5 behavioural difficulty
  complexity?: number;      // 1-5 clinical severity
  brief?: string;           // 2-3 sentences about the case
  hiddenLayerHint?: string; // 1-2 sentences about what's really going on
  voiceNotes?: string;      // notes about how the patient speaks
  themes?: string[];        // checkboxes: anxiety, depression, trauma, ...
}

export interface CreateCharacterDto {
  displayName: string;
  profileText: string;
  diagnosis?: string;
  diagnosisCode?: string;
  difficulty?: number;
  complexity?: number;
  avatarUrl?: string;
}

@Injectable()
export class CharactersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly prompts: PromptsService,
    private readonly llm: LlmService,
  ) {}

  /**
   * Generate a full 8-section profile markdown from a structured brief.
   * Uses the chat model (faster than feedback model, plenty for this
   * task). Output is raw markdown — caller may further edit before save.
   */
  async draftProfile(brief: CharacterDraftBrief): Promise<{ markdown: string }> {
    if (!brief.displayName?.trim()) {
      throw new BadRequestException('displayName is required');
    }
    const briefText = formatBrief(brief);
    const systemPrompt = this.prompts.fill(this.prompts.patientGenerationSystem, {
      BRIEF: briefText,
    });

    const raw = await this.llm.chat({
      systemPrompt,
      history: [
        {
          role: 'user',
          content:
            'Згенеруй markdown профілю за інструкцією. Тільки markdown, без передмови.',
        },
      ],
      maxTokens: 4096,
    });

    return { markdown: stripCodeFence(raw.trim()) };
  }

  /**
   * Create a user-owned character. Slug is auto-generated from displayName
   * + random hex suffix so it can't collide with file-based patients
   * (whose slugs are derived from the .md filename, all lowercase Latin).
   */
  async create(userId: number, dto: CreateCharacterDto) {
    if (!dto.displayName?.trim()) {
      throw new BadRequestException('displayName is required');
    }
    if (!dto.profileText?.trim()) {
      throw new BadRequestException('profileText is required');
    }
    const slug = await this.generateUniqueSlug(dto.displayName);
    return this.prisma.character.create({
      data: {
        slug,
        displayName: dto.displayName.trim(),
        profileText: dto.profileText,
        diagnosis: dto.diagnosis ?? null,
        diagnosisCode: dto.diagnosisCode ?? null,
        difficulty: dto.difficulty ?? null,
        complexity: dto.complexity ?? null,
        avatarUrl: dto.avatarUrl ?? null,
        createdById: userId,
      },
    });
  }

  /**
   * Update an existing character. Only the owner OR an admin can edit.
   * System characters (createdById === null) require admin.
   */
  async update(userId: number, id: number, dto: Partial<CreateCharacterDto>) {
    const character = await this.prisma.character.findUnique({ where: { id } });
    if (!character) throw new NotFoundException('character not found');
    await this.assertCanEdit(userId, character);

    return this.prisma.character.update({
      where: { id },
      data: {
        ...(dto.displayName !== undefined ? { displayName: dto.displayName.trim() } : {}),
        ...(dto.profileText !== undefined ? { profileText: dto.profileText } : {}),
        ...(dto.diagnosis !== undefined ? { diagnosis: dto.diagnosis || null } : {}),
        ...(dto.diagnosisCode !== undefined ? { diagnosisCode: dto.diagnosisCode || null } : {}),
        ...(dto.difficulty !== undefined ? { difficulty: dto.difficulty } : {}),
        ...(dto.complexity !== undefined ? { complexity: dto.complexity } : {}),
        ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl || null } : {}),
      },
    });
  }

  /**
   * Hard-delete a character. Cascades to all sessions (per schema).
   * Owner or admin only.
   */
  async delete(userId: number, id: number): Promise<{ deleted: true }> {
    const character = await this.prisma.character.findUnique({ where: { id } });
    if (!character) throw new NotFoundException('character not found');
    await this.assertCanEdit(userId, character);
    await this.prisma.character.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Visibility filter for the listing endpoint: a user sees system
   * patients (createdById === null) PLUS their own. Admins see all.
   */
  visibilityFilter(userId: number, isAdmin: boolean) {
    if (isAdmin) return {};
    return {
      OR: [{ createdById: null }, { createdById: userId }],
    };
  }

  private async assertCanEdit(
    userId: number,
    character: { createdById: number | null },
  ) {
    if (character.createdById === userId) return;
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true },
    });
    if (!me?.isAdmin) {
      throw new ForbiddenException(
        character.createdById === null
          ? 'system characters can only be edited by admins'
          : 'only the owner or an admin can edit this character',
      );
    }
  }

  private async generateUniqueSlug(displayName: string): Promise<string> {
    const base = slugify(displayName);
    for (let i = 0; i < 5; i++) {
      const suffix = randomBytes(3).toString('hex');
      const candidate = base ? `${base}-${suffix}` : `patient-${suffix}`;
      const exists = await this.prisma.character.findUnique({ where: { slug: candidate } });
      if (!exists) return candidate;
    }
    // Pathological collision streak — fall back to fully random.
    return `patient-${randomBytes(6).toString('hex')}`;
  }
}

/**
 * Lowercase + Latin-transliterate the display name to a URL-safe stub.
 * Falls back to empty string if name is non-Latin entirely; caller
 * handles that with a `patient-` prefix.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[а-яії]/g, transliterateChar)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ye', ж: 'zh',
  з: 'z', и: 'y', і: 'i', ї: 'yi', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'yu', я: 'ya', "'": '',
};
function transliterateChar(c: string): string {
  return CYR_TO_LAT[c] ?? '';
}

/**
 * Format the structured brief as a readable bullet list for the LLM.
 * Empty / undefined fields are dropped so the prompt stays compact.
 */
function formatBrief(b: CharacterDraftBrief): string {
  const lines: string[] = [];
  const add = (label: string, value: string | number | undefined | null) => {
    if (value === undefined || value === null || value === '') return;
    lines.push(`- ${label}: ${value}`);
  };
  add("Ім'я", b.displayName);
  add('Стать', b.gender === 'female' ? 'жіноча' : 'чоловіча');
  add('Вік', b.age);
  add('Місто/район', b.city);
  add('Професія', b.profession);
  add('Діагноз українською', b.diagnosis);
  add('Шифр (англ. для бібліотеки)', b.diagnosisCode);
  add('Поведінкова складність 1-5', b.difficulty);
  add('Клінічна тяжкість 1-5', b.complexity);
  add('Короткий опис випадку (що відбувається з пацієнткою/-том)', b.brief);
  add('Прихований шар (підказка — що насправді відбувається)', b.hiddenLayerHint);
  add('Особливості мовлення', b.voiceNotes);
  if (b.themes?.length) {
    add('Спеціальні теми', b.themes.join(', '));
  }
  return lines.join('\n');
}

/**
 * If the LLM wraps its output in ```markdown ... ``` despite instructions,
 * strip the fence. Leaves un-fenced output untouched.
 */
function stripCodeFence(text: string): string {
  const fence = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return fence ? fence[1].trim() : text;
}
