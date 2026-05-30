import { Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { CoursesService } from './courses.service';

/** /api/courses — skill-path catalog, detail + progress, and step actions. */
@Controller('courses')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.courses.listForUser(user.id);
  }

  @Get(':key')
  detail(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.courses.getDetail(user.id, key);
  }

  @Post('steps/:stepId/complete')
  complete(@CurrentUser() user: AuthUser, @Param('stepId', ParseIntPipe) stepId: number) {
    return this.courses.completeStep(user.id, stepId);
  }

  @Post('steps/:stepId/practice')
  practice(@CurrentUser() user: AuthUser, @Param('stepId', ParseIntPipe) stepId: number) {
    return this.courses.startPractice(user.id, stepId);
  }
}
