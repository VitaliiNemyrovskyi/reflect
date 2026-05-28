import { Injectable, Logger } from '@nestjs/common';
import Parser from 'rss-parser';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';

/**
 * RSS source registry. Each entry binds a feed URL to a city: news
 * fetched from this URL gets stored under that cityId. Add new sources
 * here — the ingester picks them up automatically. Keep sources to ~5
 * per city to avoid hammering RSS endpoints and to keep LLM cost down.
 */
interface NewsSource {
  /** Stable slug stored on NewsItem.source for trace-back. */
  source: string;
  /** RSS / Atom feed URL. */
  url: string;
  /** Which city this source covers. */
  cityKey: string;
}

const NEWS_SOURCES: NewsSource[] = [
  // ── Ukraine (Kyiv) ──────────────────────────────────────────────
  // RSS landscape for UA mainstream media is fragmented in 2026 —
  // hromadske.ua, suspilne.media, ukrinform, censor.net, lb.ua all
  // either dropped their feeds or block bots. These five remain
  // reliably reachable + parseable. Add new ones here if they expose
  // a working RSS/Atom URL (probe with curl first).
  { source: 'pravda', url: 'https://www.pravda.com.ua/rss/', cityKey: 'kyiv' },
  { source: 'texty', url: 'https://texty.org.ua/articles/feed.xml', cityKey: 'kyiv' },
  { source: 'nv', url: 'https://nv.ua/rss', cityKey: 'kyiv' },
  { source: '24tv', url: 'https://24tv.ua/rss/all.rss', cityKey: 'kyiv' },
  { source: 'tsn', url: 'https://tsn.ua/rss', cityKey: 'kyiv' },

  // ── UK / EN (London) ────────────────────────────────────────────
  { source: 'bbc', url: 'https://feeds.bbci.co.uk/news/uk/rss.xml', cityKey: 'london' },
  { source: 'guardian-uk', url: 'https://www.theguardian.com/uk-news/rss', cityKey: 'london' },
  { source: 'politico-eu', url: 'https://www.politico.eu/feed/', cityKey: 'london' },

  // ── France / EN (Paris) ─────────────────────────────────────────
  // English-language sources covering France — keeps digest in en
  // until we ship a real fr locale. Le Monde EN + France 24 EN cover
  // politics + culture; The Local + Connexion focus on day-to-day
  // life (transport strikes, sécu, cost of living, banlieue politics).
  { source: 'lemonde-en', url: 'https://www.lemonde.fr/en/rss/une.xml', cityKey: 'paris' },
  { source: 'france24-en', url: 'https://www.france24.com/en/france/rss', cityKey: 'paris' },
  { source: 'thelocal-fr', url: 'https://www.thelocal.fr/feeds/rss.php', cityKey: 'paris' },
  { source: 'connexion-fr', url: 'https://www.connexionfrance.com/articles.rss', cityKey: 'paris' },
];

/** Cap on how many articles to summarize per source per ingest run.
 *  Keeps LLM cost predictable: 7 sources × 8 articles = 56 calls/hr =
 *  ~1.3k/day at $0.0005 each = $0.65/day worst case. In practice most
 *  articles dedupe so cost is much lower. */
const MAX_PER_SOURCE = 8;

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);
  private readonly parser = new Parser({
    timeout: 15_000,
    // Some feeds (Espreso, Censor, others) 403 the default "node-fetch"
    // UA. A browser-style UA passes most of them.
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; ReflectNewsBot/1.0; +https://reflect.swift-mail.app)',
    },
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  /**
   * Pull every configured RSS source, summarize new items, dedupe
   * against `NewsItem.sourceUrl`, and persist. Logs a tally per source.
   * Best-effort — one feed failing doesn't take down the rest.
   *
   * Idempotent: re-running won't double-store items (unique constraint
   * on (cityId, sourceUrl) catches duplicates).
   */
  async ingest(): Promise<{ added: number; skipped: number }> {
    const cities = await this.prisma.city.findMany({
      select: { id: true, key: true, lang: true },
    });
    const cityByKey = new Map(cities.map((c) => [c.key, c]));

    let added = 0;
    let skipped = 0;

    for (const source of NEWS_SOURCES) {
      const city = cityByKey.get(source.cityKey);
      if (!city) {
        this.logger.warn(`source=${source.source}: cityKey=${source.cityKey} not seeded — skipping`);
        continue;
      }

      let feed;
      try {
        feed = await this.parser.parseURL(source.url);
      } catch (e) {
        this.logger.warn(`source=${source.source}: feed fetch failed (${(e as Error).message})`);
        continue;
      }

      const items = (feed.items ?? []).slice(0, MAX_PER_SOURCE);
      let perFeedAdded = 0;

      for (const item of items) {
        if (!item.link || !item.title) continue;

        const existing = await this.prisma.newsItem.findUnique({
          where: { cityId_sourceUrl: { cityId: city.id, sourceUrl: item.link } },
          select: { id: true },
        });
        if (existing) {
          skipped++;
          continue;
        }

        const publishedAt = item.isoDate
          ? new Date(item.isoDate)
          : item.pubDate
          ? new Date(item.pubDate)
          : new Date();

        const rawBody = (item.contentSnippet ?? item.content ?? '').slice(0, 1000);
        let summary = '';
        let topics: string[] = [];
        try {
          const result = await this.summarize(item.title, rawBody, city.lang as 'uk' | 'en');
          summary = result.summary;
          topics = result.topics;
        } catch (e) {
          this.logger.warn(
            `source=${source.source}: summary failed for "${item.title.slice(0, 50)}" — using snippet fallback (${(e as Error).message})`,
          );
          // Fallback: use the raw content snippet so we don't lose the
          // item entirely. The digest step will work with this too.
          summary = rawBody.slice(0, 200) || item.title;
        }

        await this.prisma.newsItem.create({
          data: {
            cityId: city.id,
            source: source.source,
            sourceUrl: item.link,
            title: item.title.slice(0, 500),
            summary: summary.slice(0, 1000),
            topics: JSON.stringify(topics),
            publishedAt,
          },
        });
        added++;
        perFeedAdded++;
      }

      this.logger.log(
        `source=${source.source} city=${source.cityKey}: +${perFeedAdded} new (${items.length} seen)`,
      );
    }

    return { added, skipped };
  }

  /**
   * LLM step: turn a news article (title + body snippet) into
   *  - a short conversational summary ("what someone living here would
   *    say about this in a chat")
   *  - 3-5 topic tags for matching against Character.interests
   *
   * Single LLM call. Uses the chat model (DeepSeek Flash) for speed +
   * cost. Returns plain object — caller wraps in DB write.
   */
  private async summarize(
    title: string,
    body: string,
    lang: 'uk' | 'en',
  ): Promise<{ summary: string; topics: string[] }> {
    const systemPrompt =
      lang === 'uk'
        ? [
            'Ти готуєш короткий жит­тєвий summary новини для жителя міста.',
            'Поверни ЛИШЕ JSON-обʼєкт у форматі:',
            '{"summary": "1-2 речення про що ця новина, як житель розповів би в чаті", "topics": ["tag1","tag2","tag3"]}',
            'topics — 3-5 тегів англійською latin-only: blackout, energy, transport, war, weather, culture, politics, economy, health, crime, sport.',
            'summary — українською, без штампів, без слова "новина".',
          ].join('\n')
        : [
            'You produce a short, lived-in summary of a news article for a city resident.',
            'Return ONLY a JSON object in the format:',
            '{"summary": "1-2 sentences about what this is, as a resident would say in a chat", "topics": ["tag1","tag2","tag3"]}',
            'topics — 3-5 lowercase tags: blackout, energy, transport, war, weather, culture, politics, economy, health, crime, sport.',
            'summary — in English, no cliches, no the word "news".',
          ].join('\n');

    const raw = await this.llm.chat({
      systemPrompt,
      history: [
        {
          role: 'user',
          content: `Заголовок: ${title}\n\nТекст: ${body || '(текст недоступний — узагальни по заголовку)'}`,
        },
      ],
      maxTokens: 300,
    });

    // The chat model sometimes wraps JSON in ```json``` fences or adds
    // a preface. Be defensive: find the first { and last } and parse.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end < start) {
      throw new Error('no JSON braces found in summary response');
    }
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      summary?: string;
      topics?: unknown;
    };
    return {
      summary: String(parsed.summary ?? '').trim(),
      topics: Array.isArray(parsed.topics)
        ? parsed.topics.filter((t): t is string => typeof t === 'string').slice(0, 5)
        : [],
    };
  }
}
