import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';

/**
 * Seed cities created on app boot. We start with one city per locale —
 * Київ for UA, London for EN. Adding regional cities (Lviv, Kharkiv,
 * Edinburgh) is just inserting new rows here; characters reference
 * them by cityId so the prompt-injection logic doesn't change.
 */
const SEED_CITIES: Array<{
  key: string;
  lang: 'uk' | 'en';
  displayName: string;
  country: string;
}> = [
  { key: 'kyiv', lang: 'uk', displayName: 'Київ', country: 'UA' },
  { key: 'london', lang: 'en', displayName: 'London', country: 'GB' },
];

@Injectable()
export class CityService implements OnModuleInit {
  private readonly logger = new Logger(CityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  async onModuleInit() {
    // Idempotent upsert — safe to run on every boot. Two API replicas
    // racing here both succeed thanks to the @unique key + SQLite WAL.
    for (const seed of SEED_CITIES) {
      await this.prisma.city.upsert({
        where: { key: seed.key },
        create: seed,
        update: {
          // Don't overwrite the live digest/weather — those are managed
          // by the cron. Only metadata stays in sync with the seed list.
          displayName: seed.displayName,
          country: seed.country,
          lang: seed.lang,
        },
      });
    }
    this.logger.log(`seeded ${SEED_CITIES.length} cities`);

    // Back-fill cityId on characters that don't have one yet (legacy
    // rows from before this feature). Matches by lang — the simplest
    // rule for now; later the patient-form will let users pick a city.
    await this.backfillCharacterCities();
  }

  /**
   * Fetch the city for a given lang, creating a fallback if somehow
   * missing. Used by SessionsService when a character has no cityId.
   */
  async getForLang(lang: string): Promise<{ id: number; displayName: string; weeklyDigest: string | null; weatherSummary: string | null } | null> {
    return this.prisma.city.findFirst({
      where: { lang: lang === 'en' ? 'en' : 'uk' },
      select: {
        id: true,
        displayName: true,
        weeklyDigest: true,
        weatherSummary: true,
      },
    });
  }

  /**
   * Regenerate the weekly digest for ONE city. Pulls the most recent
   * ~25 news items (last 7 days) and asks the LLM to compose a single
   * paragraph "what's going on in {city} this week" — written as a
   * resident would describe it casually to a friend, not as a news
   * recap. The output goes verbatim into every character's chat
   * system prompt for that city, so tone matters.
   *
   * Idempotent — call as often as needed. The cron calls it daily.
   */
  async regenerateDigest(cityId: number): Promise<string> {
    const city = await this.prisma.city.findUnique({ where: { id: cityId } });
    if (!city) throw new Error(`city ${cityId} not found`);

    const sinceWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const items = await this.prisma.newsItem.findMany({
      where: { cityId, publishedAt: { gte: sinceWeekAgo } },
      orderBy: { publishedAt: 'desc' },
      take: 25,
    });

    if (items.length === 0) {
      // No news → empty digest, but mark as fresh so we don't keep
      // retrying. Operator can trigger manual ingestion to populate.
      await this.prisma.city.update({
        where: { id: cityId },
        data: { weeklyDigest: null, digestUpdatedAt: new Date() },
      });
      this.logger.warn(`city=${city.key}: no news items in last 7d, digest cleared`);
      return '';
    }

    const isUk = city.lang === 'uk';
    const newsBlock = items
      .map((n, i) => `${i + 1}. [${n.publishedAt.toISOString().slice(0, 10)}] ${n.title} — ${n.summary}`)
      .join('\n');

    const systemPrompt = isUk
      ? [
          `Ти узагальнюєш новини тижня для жителя міста ${city.displayName}.`,
          'Напиши ОДИН абзац (3-5 речень), як житель розповів би другу:',
          '"цього тижня у нас було…". Без переліків, без слова "новини".',
          'Розмовний тон, теперішній/минулий час. Українською.',
          'Виключно ті теми, що реально впливають на повсякденне життя:',
          'погода, енергетика, транспорт, культурні події, важливі суспільні зрушення.',
          'НЕ пиши клішe на кшталт "цього тижня багато всього сталося".',
        ].join('\n')
      : [
          `You summarize the week's news for a resident of ${city.displayName}.`,
          'Write ONE paragraph (3-5 sentences), as if a resident is telling a friend:',
          '"this week here we had…". No bullet points, no the word "news".',
          'Conversational tone, present/past tense. English.',
          'Only topics that affect everyday life:',
          'weather, energy, transport, cultural events, important social shifts.',
          'NO clichés like "lots of stuff happened this week".',
        ].join('\n');

    try {
      const digest = await this.llm.chat({
        systemPrompt,
        history: [
          {
            role: 'user',
            content: `Новини за тиждень:\n\n${newsBlock}\n\nНапиши абзац-узагальнення.`,
          },
        ],
        maxTokens: 400,
      });
      const trimmed = digest.trim();
      await this.prisma.city.update({
        where: { id: cityId },
        data: { weeklyDigest: trimmed, digestUpdatedAt: new Date() },
      });
      this.logger.log(`city=${city.key}: digest regenerated (${items.length} items → ${trimmed.length} chars)`);
      return trimmed;
    } catch (e) {
      this.logger.error(`city=${city.key}: digest regen failed: ${(e as Error).message}`);
      throw e;
    }
  }

  async regenerateAllDigests(): Promise<void> {
    const cities = await this.prisma.city.findMany({ select: { id: true, key: true } });
    for (const c of cities) {
      try {
        await this.regenerateDigest(c.id);
      } catch (e) {
        // One city failing shouldn't take down the others.
        this.logger.warn(`city=${c.key}: digest failed, skipping (${(e as Error).message})`);
      }
    }
  }

  private async backfillCharacterCities(): Promise<void> {
    const cities = await this.prisma.city.findMany({ select: { id: true, lang: true } });
    const byLang = new Map(cities.map((c) => [c.lang, c.id]));

    const unassigned = await this.prisma.character.findMany({
      where: { cityId: null },
      select: { id: true, lang: true },
    });
    if (unassigned.length === 0) return;

    let assigned = 0;
    for (const ch of unassigned) {
      const cityId = byLang.get(ch.lang) ?? byLang.get('uk');
      if (!cityId) continue;
      await this.prisma.character.update({
        where: { id: ch.id },
        data: { cityId },
      });
      assigned++;
    }
    if (assigned > 0) {
      this.logger.log(`back-filled cityId on ${assigned} characters`);
    }
  }
}
