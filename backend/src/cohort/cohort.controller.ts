import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { CohortService } from './cohort.service';

/**
 * Teaching cohorts. All auth-gated (global JWT guard). Creating a cohort
 * additionally requires the instructor role (checked in the service);
 * joining + listing are open to any user.
 */
@Controller('cohorts')
export class CohortController {
  constructor(private readonly cohort: CohortService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.cohort.listMine(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: { name: string }) {
    return this.cohort.createCohort(user.id, body?.name);
  }

  @Post('join')
  join(@CurrentUser() user: AuthUser, @Body() body: { code: string }) {
    return this.cohort.joinByCode(user.id, body?.code);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.cohort.getCohortForOwner(user.id, id);
  }
}
