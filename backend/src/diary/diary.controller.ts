import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { DiaryService } from './diary.service';

/**
 * Admin-only manual triggers for the diary pipeline. The cron at
 * 05:00 UTC handles the routine case; these endpoints exist for
 * seeding (right after Phase 4 ships, before the first cron fires)
 * and for ad-hoc regeneration per pair.
 *
 *   POST /api/admin/diary/run-all                   — batch every active pair
 *   POST /api/admin/diary/pair/:userId/:characterId — single pair
 */
@Controller('admin/diary')
@UseGuards(AdminGuard)
export class DiaryController {
  constructor(private readonly diary: DiaryService) {}

  @Post('run-all')
  @HttpCode(HttpStatus.OK)
  async runAll() {
    return this.diary.runDailyForAllActive();
  }

  @Post('pair/:userId/:characterId')
  @HttpCode(HttpStatus.OK)
  async runOne(
    @Param('userId', ParseIntPipe) userId: number,
    @Param('characterId', ParseIntPipe) characterId: number,
  ) {
    const added = await this.diary.generateForPair(userId, characterId);
    return { userId, characterId, added };
  }
}
