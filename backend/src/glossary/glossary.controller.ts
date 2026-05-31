import { Controller, Get, Query } from '@nestjs/common';
import { GlossaryService } from './glossary.service';

/** /api/glossary — clinical terms. `?course=KEY` filters to one course. */
@Controller('glossary')
export class GlossaryController {
  constructor(private readonly glossary: GlossaryService) {}

  @Get()
  list(@Query('course') course?: string) {
    return course ? this.glossary.listForCourse(course) : this.glossary.list();
  }
}
