import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LlmModule } from '../llm/llm.module';
import { CityController } from './city.controller';
import { CityScheduler } from './city.scheduler';
import { CityService } from './city.service';
import { NewsService } from './news.service';

/**
 * Global so SessionsService can inject CityService for prompt
 * augmentation without re-importing this module everywhere. The
 * scheduler is a side-effecting provider — its @Cron decorators
 * fire as long as it's registered. ScheduleModule.forRoot() boots
 * the timer registry.
 */
@Global()
@Module({
  imports: [LlmModule, ScheduleModule.forRoot()],
  controllers: [CityController],
  providers: [CityService, NewsService, CityScheduler],
  exports: [CityService, NewsService],
})
export class CityModule {}
