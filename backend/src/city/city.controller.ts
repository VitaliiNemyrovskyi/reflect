import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CityService } from './city.service';
import { NewsService } from './news.service';

/**
 * Admin-only inspection + manual-trigger endpoints for the city pipeline.
 *
 * - GET /admin/city — overview of all seeded cities + their digest state
 * - GET /admin/city/:id/news — last N news items for one city
 * - POST /admin/city/ingest — force-run RSS ingestion now (don't wait
 *   for the hourly cron). Returns the +added / skipped tally.
 * - POST /admin/city/:id/digest — force-regenerate the weekly digest
 *   for one city (1 LLM call).
 *
 * The cron does all this automatically; these endpoints exist for
 * debugging, seeding a fresh deploy, or recovering after an LLM/
 * RSS-source outage.
 */
@Controller('admin/city')
@UseGuards(AdminGuard)
export class CityController {
  constructor(
    private readonly city: CityService,
    private readonly news: NewsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list() {
    const cities = await this.prisma.city.findMany({
      orderBy: { id: 'asc' },
      include: {
        _count: { select: { newsItems: true, characters: true } },
      },
    });
    return cities.map((c) => ({
      id: c.id,
      key: c.key,
      lang: c.lang,
      displayName: c.displayName,
      country: c.country,
      weeklyDigest: c.weeklyDigest,
      weatherSummary: c.weatherSummary,
      digestUpdatedAt: c.digestUpdatedAt,
      newsCount: c._count.newsItems,
      characterCount: c._count.characters,
    }));
  }

  @Get(':id/news')
  async listNews(
    @Param('id', ParseIntPipe) id: number,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Math.max(limit ? parseInt(limit, 10) : 50, 1), 200);
    return this.prisma.newsItem.findMany({
      where: { cityId: id },
      orderBy: { publishedAt: 'desc' },
      take,
    });
  }

  @Post('ingest')
  async ingestNow() {
    return this.news.ingest();
  }

  @Post(':id/digest')
  async regenerateDigest(@Param('id', ParseIntPipe) id: number) {
    const digest = await this.city.regenerateDigest(id);
    return { id, digest };
  }
}
