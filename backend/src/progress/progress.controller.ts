import { Controller, Get } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { ProgressService } from './progress.service';

/**
 * GET /api/progress — gamification progress for the current user.
 * Auth-gated (global JwtAuthGuard). Recomputes badge awards on read.
 */
@Controller('progress')
export class ProgressController {
  constructor(private readonly progress: ProgressService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.progress.getProgress(user.id);
  }
}
