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

/**
 * Per-field generation result. The frontend dispatches by field name and
 * coerces accordingly: text fields get strings, age/difficulty/complexity
 * get integers, themes gets a string array.
 */
export type DraftFieldName =
  | 'displayName'
  | 'age'
  | 'city'
  | 'profession'
  | 'diagnosis'
  | 'diagnosisCode'
  | 'difficulty'
  | 'complexity'
  | 'brief'
  | 'hiddenLayerHint'
  | 'voiceNotes'
  | 'themes';

export interface DraftFieldResult {
  value: string | number | string[];
}

/**
 * Per-field instruction passed to the LLM. The system prompt assembles
 * description + format + example into a focused micro-prompt, so the
 * model knows exactly what shape to return.
 */
interface FieldInstruction {
  description: string;
  format: string;
  example: string;
}

const THEMES_WHITELIST = [
  'тривога', 'депресія', 'травма', 'горе', 'харчування',
  'стосунки', 'сімейна динаміка', 'війна', 'самооцінка',
  'ідентичність', 'кар\'єра', 'батьківство', 'фобії',
  'обсесивні думки', 'зловживання речовинами',
];

const FIELD_INSTRUCTIONS: Record<DraftFieldName, FieldInstruction> = {
  displayName: {
    description: "Українське ім'я для пацієнтки/-та (узгоджуйся зі статтю)",
    format: "Тільки ім'я, одним словом, без прізвища",
    example: 'Соломія',
  },
  age: {
    description: 'Вік від 14 до 90 років',
    format: 'Тільки число',
    example: '32',
  },
  city: {
    description: 'Українське місто (з районом, якщо доречно)',
    format: 'Назва міста або «Місто (район)»',
    example: 'Львів (Сихів)',
  },
  profession: {
    description: 'Професія або життєвий контекст пацієнта',
    format: '1-4 слова, без коментарів',
    example: 'backend-розробниця у стартапі',
  },
  diagnosis: {
    description: 'Клінічний діагноз українською мовою (узгоджений зі статтю, віком, контекстом)',
    format: 'Одне формулювання, без шифрів',
    example: 'Обсесивно-компульсивний розлад, помірний',
  },
  diagnosisCode: {
    description: 'МКХ-10 та DSM-5 шифри для діагнозу',
    format: 'Формат: «F<код> (МКХ-10) / <код> (DSM-5)»',
    example: 'F42 (МКХ-10) / 300.3 (DSM-5)',
  },
  difficulty: {
    description: 'Поведінкова складність: 1 = відкрита й готова до контакту, 5 = глухий опір і ухиляння',
    format: 'Тільки одне число від 1 до 5',
    example: '3',
  },
  complexity: {
    description: 'Клінічна тяжкість: 1 = легка форма, 5 = гостра небезпека (суїцид, психоз, гострий ризик)',
    format: 'Тільки одне число від 1 до 5',
    example: '3',
  },
  brief: {
    description: 'Короткий опис випадку — що зараз відбувається з пацієнткою/-том',
    format: '2-3 речення українською, конкретні, без передмови',
    example: 'Останні півроку — компульсії перевірки плитки і дверей. Виходить з дому за 40 хвилин до запланованого часу. На роботі по 3-4 рази перевіряє код перед commit.',
  },
  hiddenLayerHint: {
    description: 'Прихований шар — те, що насправді відбувається під поверхнею і чого пацієнт сам не озвучить',
    format: '1-2 речення українською, без передмови',
    example: "Уникнення близькості: дівчина натякає на спільне життя — Соломія боїться відмовитися від ритуалів або довірити їх іншій людині.",
  },
  voiceNotes: {
    description: 'Як пацієнт говорить — темп, тон, уникнення слів, типові захисти',
    format: '2-4 короткі марковані рядки (починай з "- ")',
    example: '- Швидко, чітко, інженерна мова\n- Уникає слова «ритуали» — каже «перевірки»\n- На емоції перемикається на факти',
  },
  themes: {
    description: `Спеціальні теми — ТІЛЬКИ зі списку: ${THEMES_WHITELIST.join(', ')}`,
    format: '2-4 теми зі списку, через кому, без додаткового тексту',
    example: 'обсесивні думки, тривога, стосунки',
  },
};

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
   * Per-field LLM assist. Used by the patient creation form's ✨
   * buttons — each click generates a single field value, using the
   * currently-filled brief as context so the suggestion is coherent
   * with existing inputs. Falls through with explicit fail-safes for
   * numeric and array fields so the frontend always gets a usable shape.
   */
  async draftField(
    field: DraftFieldName,
    brief: Partial<CharacterDraftBrief>,
  ): Promise<DraftFieldResult> {
    const instr = FIELD_INSTRUCTIONS[field];
    if (!instr) {
      throw new BadRequestException(`unknown field: ${field}`);
    }

    const contextLines = formatBriefForFieldContext(brief, field);
    const contextBlock = contextLines
      ? `Поточний бриф (заповнені поля):\n${contextLines}`
      : 'Бриф ще пустий — обери реалістичні значення з нуля.';

    const systemPrompt = [
      'Ти допомагаєш створювати художній портрет пацієнтки/-та для тренажера психотерапевтів.',
      '',
      contextBlock,
      '',
      `Згенеруй значення для поля: **${field}**`,
      `Опис: ${instr.description}`,
      `Формат: ${instr.format}`,
      `Приклад: ${instr.example}`,
      '',
      'Правила:',
      '- Тільки українською мовою, без англіцизмів та англомовних термінів (крім назв технологій якщо це професія)',
      '- Узгоджуйся з уже заповненими полями',
      '- Поверни ТІЛЬКИ значення поля — без передмови, без коментарів, без re-statement у формі «Поле X: ...»',
      '- Якщо поле — число, поверни ЛИШЕ число',
      '- Якщо поле — список тем, через кому, тільки зі списку у описі',
    ].join('\n');

    const raw = await this.llm.chat({
      systemPrompt,
      history: [{ role: 'user', content: `Поле: ${field}` }],
      maxTokens: 256,
    });

    const cleaned = stripCodeFence(raw.trim());
    return { value: parseFieldValue(field, cleaned) };
  }

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
   * patients (createdById === null) PLUS their own PLUS patients
   * shared with them via CharacterShare. Admins see all.
   */
  visibilityFilter(userId: number, isAdmin: boolean) {
    if (isAdmin) return {};
    return {
      OR: [
        { createdById: null },
        { createdById: userId },
        { shares: { some: { userId } } },
      ],
    };
  }

  /**
   * List share-grants for a character. Owner-or-admin only.
   * Returns: who has access (email, displayName) + when granted.
   */
  async listShares(ownerId: number, characterId: number) {
    const character = await this.prisma.character.findUnique({ where: { id: characterId } });
    if (!character) throw new NotFoundException('character not found');
    await this.assertCanEdit(ownerId, character);

    const shares = await this.prisma.characterShare.findMany({
      where: { characterId },
      include: { user: { select: { id: true, email: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return shares.map((s) => ({
      id: s.id,
      userId: s.user.id,
      email: s.user.email,
      displayName: s.user.displayName,
      createdAt: s.createdAt,
    }));
  }

  /**
   * Grant a colleague (by email) read-access to this character. Owner-or-admin
   * only. Throws if the email isn't registered yet (we don't auto-invite).
   * Idempotent on the (characterId, userId) pair — duplicates collapse.
   */
  async addShare(ownerId: number, characterId: number, email: string) {
    const character = await this.prisma.character.findUnique({ where: { id: characterId } });
    if (!character) throw new NotFoundException('character not found');
    await this.assertCanEdit(ownerId, character);

    const normalisedEmail = email?.trim().toLowerCase();
    if (!normalisedEmail) {
      throw new BadRequestException('email is required');
    }
    const target = await this.prisma.user.findUnique({ where: { email: normalisedEmail } });
    if (!target) {
      throw new NotFoundException('користувач із таким email не зареєстрований');
    }
    if (target.id === character.createdById) {
      throw new BadRequestException('власник уже має повний доступ');
    }

    const share = await this.prisma.characterShare.upsert({
      where: {
        characterId_userId: { characterId, userId: target.id },
      },
      update: {},
      create: { characterId, userId: target.id },
      include: { user: { select: { id: true, email: true, displayName: true } } },
    });
    return {
      id: share.id,
      userId: share.user.id,
      email: share.user.email,
      displayName: share.user.displayName,
      createdAt: share.createdAt,
    };
  }

  /**
   * Revoke a specific share-grant. Owner-or-admin only. The shared user's
   * existing sessions stay intact — they just lose access to start new ones.
   */
  async removeShare(ownerId: number, characterId: number, shareId: number): Promise<{ deleted: true }> {
    const share = await this.prisma.characterShare.findUnique({ where: { id: shareId } });
    if (!share || share.characterId !== characterId) {
      throw new NotFoundException('share not found');
    }
    const character = await this.prisma.character.findUnique({ where: { id: characterId } });
    if (!character) throw new NotFoundException('character not found');
    await this.assertCanEdit(ownerId, character);
    await this.prisma.characterShare.delete({ where: { id: shareId } });
    return { deleted: true };
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
 * Same as formatBrief, but tuned for the per-field assist: omits the
 * field that's being generated (so the LLM doesn't echo back what we
 * already have), and includes only filled fields to keep the prompt
 * short and prevent the model from grabbing onto empty placeholders.
 */
function formatBriefForFieldContext(
  b: Partial<CharacterDraftBrief>,
  skip: DraftFieldName,
): string {
  const lines: string[] = [];
  const add = (
    key: DraftFieldName,
    label: string,
    value: string | number | undefined | null,
  ) => {
    if (key === skip) return;
    if (value === undefined || value === null || value === '') return;
    lines.push(`- ${label}: ${value}`);
  };
  add('displayName', "Ім'я", b.displayName);
  // Gender is always present in the form (radio default 'female'); include
  // it so names + diagnoses can be gendered correctly. The 'skip' guard
  // doesn't apply because there's no AI button for gender.
  if (b.gender) {
    lines.push(`- Стать: ${b.gender === 'female' ? 'жіноча' : 'чоловіча'}`);
  }
  add('age', 'Вік', b.age);
  add('city', 'Місто', b.city);
  add('profession', 'Професія', b.profession);
  add('diagnosis', 'Діагноз', b.diagnosis);
  add('diagnosisCode', 'Шифр', b.diagnosisCode);
  add('difficulty', 'Поведінкова складність (1-5)', b.difficulty);
  add('complexity', 'Клінічна тяжкість (1-5)', b.complexity);
  add('brief', 'Короткий опис випадку', b.brief);
  add('hiddenLayerHint', 'Прихований шар', b.hiddenLayerHint);
  add('voiceNotes', 'Особливості мовлення', b.voiceNotes);
  if (skip !== 'themes' && b.themes?.length) {
    lines.push(`- Спеціальні теми: ${b.themes.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Coerce the raw LLM string into the right shape for the field.
 * - Numeric fields → parsed int, clamped to safe range
 * - themes → split by comma/semicolon, lowercased, filtered to whitelist
 * - All else → trimmed string with surrounding "label: " prefix stripped
 *   (in case the model ignored the no-preface instruction)
 */
function parseFieldValue(
  field: DraftFieldName,
  raw: string,
): string | number | string[] {
  const trimmed = raw.trim();
  switch (field) {
    case 'age': {
      const n = parseInt(trimmed.match(/\d+/)?.[0] ?? '', 10);
      if (Number.isNaN(n)) return 30;
      return Math.max(14, Math.min(90, n));
    }
    case 'difficulty':
    case 'complexity': {
      const n = parseInt(trimmed.match(/\d+/)?.[0] ?? '', 10);
      if (Number.isNaN(n)) return 3;
      return Math.max(1, Math.min(5, n));
    }
    case 'themes': {
      return trimmed
        .split(/[,;]+/)
        .map((t) => t.trim().toLowerCase().replace(/[«»"'.]/g, ''))
        .filter((t) => THEMES_WHITELIST.includes(t));
    }
    default: {
      // Strip a leading "Label: " prefix (Ukrainian/English) in case the
      // model preambled despite instructions. Be conservative — only
      // strip if pattern looks like a real label-prefix (short, no
      // sentence punctuation before the colon).
      const stripped = trimmed
        .replace(/^[\p{L}\s]{2,40}:\s+/u, '')
        .replace(/^[«"']+/, '')
        .replace(/[»"']+$/, '')
        .trim();
      return stripped;
    }
  }
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
