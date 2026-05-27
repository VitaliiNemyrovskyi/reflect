import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { DiaryController } from './diary.controller';
import { DiaryScheduler } from './diary.scheduler';
import { DiaryService } from './diary.service';

/**
 * MemoryModule / NpcModule / CityModule are all global, so DiaryService
 * can pull them via constructor injection without re-importing here.
 * ScheduleModule.forRoot was already imported by CityModule (also
 * global), so DiaryScheduler's @Cron decorators wire into the same
 * timer registry.
 */
@Module({
  imports: [LlmModule],
  controllers: [DiaryController],
  providers: [DiaryService, DiaryScheduler],
  exports: [DiaryService],
})
export class DiaryModule {}
