import { Module } from '@nestjs/common';
import { ProgressModule } from '../progress/progress.module';
import { CohortController } from './cohort.controller';
import { CohortService } from './cohort.service';

/**
 * Teaching cohorts (instructor mode). Imports ProgressModule to reuse the
 * per-user progress summary for the instructor's member dashboard.
 */
@Module({
  imports: [ProgressModule],
  controllers: [CohortController],
  providers: [CohortService],
})
export class CohortModule {}
