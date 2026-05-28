import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { MemoryService } from '../memory/memory.service';
import { NpcService } from '../npc/npc.service';
import { parseEvent, parseDiaryArray } from './parse';

/** Active pair = last session within this many days. Beyond this we
 *  stop generating diary entries — saves LLM cost on characters the
 *  therapist has abandoned, and keeps the memory tab from drifting
 *  with months-old stuff that no longer reflects therapy work. */
const ACTIVE_DAYS = 14;

/** Soft cap on how many diary entries to save per generation pass. The
 *  LLM is instructed to return 1-2 entries; we accept up to this many
 *  to be safe but trim the rest. */
const MAX_ENTRIES_PER_PAIR = 2;

/** Chance that a given diary run produces a CONSEQUENTIAL EVENT instead of
 *  the usual mundane diary. An event = one NPC-driven happening with stakes,
 *  a guarded surface the patient half-mentions, and a hidden layer the
 *  trainee must draw out. Kept at ~1/3 so it lands often enough to matter
 *  but rarely enough that the case doesn't turn into a soap opera. When an
 *  event fires it REPLACES the mundane diary for that run, so cost stays at
 *  exactly one LLM call per pair per run. */
const EVENT_CHANCE = 0.34;

/**
 * Generates between-session diary entries — the "what the patient
 * lived through since we last talked" memory layer (Phase 4).
 *
 * Each active (userId, characterId) pair receives 1-2 short
 * first-person entries per cron run, anchored to:
 *   - the city's current weekly digest (Phase 1)
 *   - the character's NPCs and their tension levels (Phase 3)
 *   - the latest session memories (Phase 2 — what's salient in
 *     therapy right now)
 *   - the diary entries from the previous run (continuity)
 *
 * Entries are written as kind='diary' CharacterMemory rows, so they
 * flow straight into the chat-prompt memory section under "Між
 * зустрічами" and into the patient-detail Memory tab UI without any
 * frontend changes.
 *
 * Tone instruction is deliberately low-drama: "small mundane moments,
 * not big breakthroughs". Lowers the risk of the LLM inventing
 * trauma / crises between sessions, which would be both clinically
 * inappropriate and unfair to the therapist's actual session work.
 */
@Injectable()
export class DiaryService {
  private readonly logger = new Logger(DiaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly memory: MemoryService,
    private readonly npcs: NpcService,
  ) {}

  /**
   * Find every (userId, characterId) pair with a recent session and
   * regenerate diary for each. Failures on individual pairs don't stop
   * the batch — logs and moves on.
   */
  async runDailyForAllActive(): Promise<{ pairs: number; entries: number; failed: number }> {
    const since = new Date(Date.now() - ACTIVE_DAYS * 24 * 60 * 60 * 1000);
    const pairs = await this.prisma.session.groupBy({
      by: ['userId', 'characterId'],
      where: {
        startedAt: { gte: since },
        userId: { not: null },
      },
    });
    this.logger.log(`runDailyForAllActive: ${pairs.length} active pairs in last ${ACTIVE_DAYS}d`);

    let totalEntries = 0;
    let failed = 0;
    for (const pair of pairs) {
      if (pair.userId === null) continue;
      try {
        const added = await this.generateForPair(pair.userId, pair.characterId);
        totalEntries += added;
      } catch (e) {
        failed++;
        this.logger.warn(
          `diary failed for u${pair.userId} char${pair.characterId}: ${(e as Error).message}`,
        );
      }
    }
    return { pairs: pairs.length, entries: totalEntries, failed };
  }

  /**
   * Generate (and persist) diary entries for ONE (user, character) pair.
   * Returns the number of entries actually saved. Idempotent in the
   * sense that re-running on the same day adds NEW entries on top —
   * each run is a fresh "day in the life", not a rewrite.
   */
  async generateForPair(userId: number, characterId: number): Promise<number> {
    const character = await this.prisma.character.findUnique({
      where: { id: characterId },
      include: {
        city: { select: { displayName: true, weeklyDigest: true, lang: true } },
      },
    });
    if (!character) throw new NotFoundException('character not found');

    const lang = character.lang === 'en' ? 'en' : 'uk';

    // Pull supporting context. All cheap DB queries.
    const npcs = await this.npcs.listForCharacter(characterId);
    const recentMemories = await this.memory.loadRecent(userId, characterId, { limit: 8 });
    const prevDiary = recentMemories.filter((m) => m.kind === 'diary').slice(0, 3);
    const prevSession = recentMemories.filter((m) => m.kind === 'session').slice(0, 2);

    // World Tick: occasionally a consequential NPC-driven event replaces the
    // mundane diary for this run (cost-neutral — still one LLM call). Gated
    // so it doesn't get repetitive, and only when there's an NPC to drive it
    // AND prior session context to anchor continuity. If event generation
    // fails to parse, we fall through to the normal mundane diary below.
    if (npcs.length > 0 && prevSession.length > 0 && Math.random() < EVENT_CHANCE) {
      const made = await this.generateEvent({
        userId,
        characterId,
        characterName: character.displayName,
        profileText: character.profileText,
        lang,
        cityDigest: character.city?.weeklyDigest ?? null,
        cityName: character.city?.displayName ?? null,
        npcs,
        prevSession,
      });
      if (made > 0) return made; // event carried this run
    }

    const systemPrompt = this.buildSystemPrompt({
      characterName: character.displayName,
      profileText: character.profileText,
      lang,
      cityDigest: character.city?.weeklyDigest ?? null,
      cityName: character.city?.displayName ?? null,
      npcs,
      prevSession,
      prevDiary,
    });

    const userPrompt = lang === 'uk'
      ? 'Напиши 1-2 короткі щоденникові записи за сьогоднішній день. Лише JSON-масив.'
      : 'Write 1-2 short diary entries for today. JSON array only.';

    const raw = await this.llm.chat({
      systemPrompt,
      history: [{ role: 'user', content: userPrompt }],
      maxTokens: 600,
    });

    const entries = parseDiaryArray(raw);
    if (entries.length === 0) {
      this.logger.warn(`diary: no entries parsed for u${userId} char${characterId}`);
      return 0;
    }

    let saved = 0;
    for (const entry of entries.slice(0, MAX_ENTRIES_PER_PAIR)) {
      const tags = entry.tag ? [entry.tag.toLowerCase()] : [];
      const id = await this.memory.add({
        userId,
        characterId,
        kind: 'diary',
        content: entry.content,
        tags,
      });
      if (id > 0) saved++;
    }
    this.logger.log(`diary: u${userId} char${characterId} → +${saved} entries`);
    return saved;
  }

  // ─── World Tick: consequential between-session event ────────────────────

  /**
   * Generate ONE consequential event driven by a specific NPC and persist
   * its pieces. Returns 1 if an event was saved, 0 if parsing failed (caller
   * falls back to mundane diary). Cost: a single LLM call.
   *
   * The model returns a structured object:
   *   - summary   : the factual happening (not stored as memory, just context)
   *   - spoken    : how the patient half-mentions it → kind='diary' memory
   *   - hidden    : what they won't volunteer → kind='avoided' memory, rendered
   *                 as an avoidance directive in the chat prompt
   *   - stateBias : one-line presentation shift → kind='world' memory
   *   - npcInvolved + tensionDelta : nudges that NPC's tension
   *
   * Safety mirror of the mundane diary: the prompt forbids catastrophes /
   * self-harm / acute crises — events stay at the "ordinary life with stakes"
   * level so we never inject crisis content the therapist didn't surface.
   */
  private async generateEvent(ctx: {
    userId: number;
    characterId: number;
    characterName: string;
    profileText: string;
    lang: 'uk' | 'en';
    cityDigest: string | null;
    cityName: string | null;
    npcs: Awaited<ReturnType<NpcService['listForCharacter']>>;
    prevSession: Array<{ content: string }>;
  }): Promise<number> {
    const isUk = ctx.lang === 'uk';
    const npcLines = ctx.npcs
      .slice(0, 6)
      .map((n) => {
        const tone = n.tension >= 7 ? (isUk ? ' (напружено)' : ' (tense)')
          : n.tension <= 3 ? (isUk ? ' (підтримка)' : ' (supportive)') : '';
        return `- ${n.name} (${n.relation}${tone}, tension=${n.tension})${n.bio ? `: ${n.bio}` : ''}`;
      })
      .join('\n');
    const sessionLines = ctx.prevSession
      .map((m, i) => `${i + 1}. ${m.content.slice(0, 350)}`)
      .join('\n\n');
    const cityBlock = ctx.cityDigest
      ? `# ${isUk ? 'Місто' : 'City'} (${ctx.cityName})\n${ctx.cityDigest}\n`
      : '';

    const systemPrompt = isUk
      ? [
          'Ти — симулятор міжсесійного життя пацієнта психотерапевта. Минув тиждень від останньої сесії.',
          'Завдання: змоделювати ОДНУ консеквентну подію через одного з близьких людей — подію зі ставками, що вплине на наступну сесію.',
          '',
          '# Хто пацієнт',
          ctx.profileText.slice(0, 2800),
          '',
          cityBlock,
          '# Близькі люди (рівень напруги 0-10)',
          npcLines,
          '',
          '# Що піднімалось на останніх сесіях',
          sessionLines,
          '',
          '# Правила',
          '- Подія ВИПЛИВАЄ з профілю і динаміки з конкретним NPC — нічого OOC.',
          '- Буденність зі ставками: НЕ катастрофа, НЕ спроба суїциду, НЕ гострий зрив. Напруга рівня звичайного життя.',
          '- "spoken" — як пацієнт згадав би це вголос: стримано, через захист; може й не підняти поки не спитають.',
          '- "hidden" — що насправді відбувається всередині, чого пацієнт сам НЕ скаже. Узгоджено з прихованим шаром профілю.',
          '- "stateBias" — ОДНЕ речення першоособово: як пацієнт презентується на старті наступної сесії.',
          '- "tensionDelta" — ціле -3..+3: як подія зсуває tension цього NPC.',
          '',
          'Поверни ЛИШЕ JSON (без markdown):',
          '{ "npcInvolved": "імʼя", "summary": "що сталось (3-я особа)", "spoken": "як згадає вголос", "hidden": "що приховує", "stateBias": "як презентується", "tensionDelta": 2 }',
        ].filter(Boolean).join('\n')
      : [
          'You simulate a psychotherapy patient\'s between-session life. A week has passed since the last session.',
          'Task: model ONE consequential event via one of their close people — an event with stakes that will affect the next session.',
          '',
          '# Who the patient is',
          ctx.profileText.slice(0, 2800),
          '',
          cityBlock,
          '# Close people (tension level 0-10)',
          npcLines,
          '',
          '# What came up in recent sessions',
          sessionLines,
          '',
          '# Rules',
          '- The event MUST follow from the profile and the dynamic with a specific NPC — nothing out of character.',
          '- Ordinary life with stakes: NOT a catastrophe, NOT a suicide attempt, NOT an acute breakdown.',
          '- "spoken" — how the patient would half-mention it: guarded, through their defenses; may not raise it unless asked.',
          '- "hidden" — what\'s really going on inside that they will NOT volunteer. Consistent with the profile\'s hidden layer.',
          '- "stateBias" — ONE first-person sentence: how the patient presents at the start of the next session.',
          '- "tensionDelta" — integer -3..+3: how the event shifts this NPC\'s tension.',
          '',
          'Return ONLY JSON (no markdown):',
          '{ "npcInvolved": "name", "summary": "what happened (3rd person)", "spoken": "how they mention it", "hidden": "what they hide", "stateBias": "how they present", "tensionDelta": 2 }',
        ].join('\n');

    const raw = await this.llm.chat({
      systemPrompt,
      history: [{ role: 'user', content: isUk ? 'Змоделюй подію цього тижня. Лише JSON.' : 'Model this week\'s event. JSON only.' }],
      maxTokens: 700,
    });

    const ev = parseEvent(raw);
    if (!ev) {
      this.logger.warn(`event: parse fail for u${ctx.userId} char${ctx.characterId}`);
      return 0;
    }

    // Persist the three memory facets. Weights nudge the fresh event above
    // its kind defaults so it reliably colours the next session.
    await this.memory.add({
      userId: ctx.userId, characterId: ctx.characterId,
      kind: 'diary', content: ev.spoken, weight: 0.55, tags: ['event'],
    });
    await this.memory.add({
      userId: ctx.userId, characterId: ctx.characterId,
      kind: 'world', content: ev.stateBias, weight: 0.6, tags: ['event', 'bias'],
    });
    await this.memory.add({
      userId: ctx.userId, characterId: ctx.characterId,
      kind: 'avoided', content: ev.hidden, tags: ['event', ev.npcInvolved.toLowerCase()],
    });

    // Evolve the involved NPC's tension so the social graph actually drifts
    // over time. Match by name (case-insensitive); skip silently if no match.
    if (ev.tensionDelta !== 0) {
      const match = ctx.npcs.find(
        (n) => n.name.trim().toLowerCase() === ev.npcInvolved.trim().toLowerCase(),
      );
      if (match) {
        const delta = Math.max(-3, Math.min(3, ev.tensionDelta));
        const next = Math.max(0, Math.min(10, match.tension + delta));
        if (next !== match.tension) {
          try {
            await this.npcs.update(match.id, { tension: next });
          } catch (e) {
            this.logger.warn(`event: tension update failed for npc ${match.id}: ${(e as Error).message}`);
          }
        }
      }
    }

    this.logger.log(
      `event: u${ctx.userId} char${ctx.characterId} via ${ev.npcInvolved} (tension ${ev.tensionDelta >= 0 ? '+' : ''}${ev.tensionDelta})`,
    );
    return 1;
  }

  // ─── Prompt assembly ───────────────────────────────────────────────────

  private buildSystemPrompt(ctx: {
    characterName: string;
    profileText: string;
    lang: 'uk' | 'en';
    cityDigest: string | null;
    cityName: string | null;
    npcs: Awaited<ReturnType<NpcService['listForCharacter']>>;
    prevSession: Array<{ content: string }>;
    prevDiary: Array<{ content: string }>;
  }): string {
    const isUk = ctx.lang === 'uk';
    const today = new Date().toLocaleDateString(isUk ? 'uk-UA' : 'en-GB', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const npcLines = ctx.npcs.length
      ? ctx.npcs
          .slice(0, 6)
          .map((n) => {
            const tone = n.tension >= 7 ? (isUk ? ' (напружено)' : ' (tense)')
              : n.tension <= 3 ? (isUk ? ' (підтримка)' : ' (supportive)')
              : '';
            return `- ${n.name} (${n.relation}${tone})${n.bio ? `: ${n.bio}` : ''}`;
          })
          .join('\n')
      : (isUk ? '(порожньо)' : '(empty)');

    const sessionLines = ctx.prevSession.length
      ? ctx.prevSession.map((m, i) => `${i + 1}. ${m.content.slice(0, 400)}`).join('\n\n')
      : (isUk ? '(перша зустріч ще попереду чи без пам\'яті)' : '(no prior memory yet)');

    const diaryLines = ctx.prevDiary.length
      ? ctx.prevDiary.map((m, i) => `- ${m.content}`).join('\n')
      : (isUk ? '(почни новий ритм)' : '(start a new rhythm)');

    const cityBlock = ctx.cityDigest
      ? `# ${isUk ? 'Світ навколо' : 'World around'} (${ctx.cityName})\n${ctx.cityDigest}`
      : '';

    if (isUk) {
      return [
        `Ти — ${ctx.characterName}, пацієнтка/-т психотерапевта. Сьогодні ${today}.`,
        'Між сесіями. Напиши 1-2 коротких щоденникових записи від ПЕРШОЇ особи — як ти провела/-в день.',
        '',
        '# Хто ти',
        ctx.profileText.slice(0, 2500),
        '',
        cityBlock,
        '',
        "# Близькі люди",
        npcLines,
        '',
        '# Що піднімалось на останніх сесіях',
        sessionLines,
        '',
        '# Попередні щоденникові записи',
        diaryLines,
        '',
        '# Інструкція',
        'Кожен запис — 1-3 речення, природна першоособова мова, як у щоденнику.',
        'Маленькі моменти, не великі прориви: погода, дрібниця на роботі, NPC дзвонив, спогад, рішення лягти спати раніше.',
        'НЕ пиши драматичних криз, гострих травм, спроб суїциду чи "проривів" — це між-сесійне дрібне життя.',
        'Можна посилатись на City (погода, новина) чи NPC.',
        'Може бути амбівалентний тон, втома, маленька радість — реалізм.',
        '',
        'Поверни ЛИШЕ JSON-масив, без коментарів, без markdown-фенс:',
        '[',
        '  { "tag": "mundane|worry|npc|news|hope|mood|body", "content": "запис від першої особи" }',
        ']',
      ].join('\n');
    }
    return [
      `You are ${ctx.characterName}, a psychotherapy patient. Today is ${today}.`,
      'Between sessions. Write 1-2 short diary entries in FIRST person — how your day went.',
      '',
      '# Who you are',
      ctx.profileText.slice(0, 2500),
      '',
      cityBlock,
      '',
      '# Close people',
      npcLines,
      '',
      '# What came up in recent sessions',
      sessionLines,
      '',
      '# Previous diary entries',
      diaryLines,
      '',
      '# Instructions',
      'Each entry — 1-3 sentences, natural first-person diary voice.',
      'Small moments, not big breakthroughs: weather, work trivia, NPC called, a memory, decision to sleep early.',
      'Do NOT write dramatic crises, acute trauma, suicide attempts, or "breakthroughs" — this is between-session everyday life.',
      'Can reference the city (weather, news) or NPCs.',
      'Ambivalent tone, tiredness, small joys are fine — realism.',
      '',
      'Return ONLY a JSON array, no commentary, no markdown fence:',
      '[',
      '  { "tag": "mundane|worry|npc|news|hope|mood|body", "content": "first-person entry" }',
      ']',
    ].join('\n');
  }

}
