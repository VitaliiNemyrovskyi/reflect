import { Controller, Get, Param, Query } from '@nestjs/common';
import { TestsService } from './tests.service';

/**
 * Catalog endpoints for the psychological tests library. Read-only —
 * tests live in prompts/tests/*.json and are loaded at boot. To add a
 * test, drop a JSON file and restart the API.
 */
@Controller('tests')
export class TestsController {
  constructor(private readonly tests: TestsService) {}

  /**
   * List tests with optional full-text search (`?q=`) and domain
   * filter (`?domain=anxiety`). Items array is stripped from the
   * response — frontend fetches the full test by key only when the
   * user actually picks one from the modal.
   */
  @Get()
  list(@Query('q') q?: string, @Query('domain') domain?: string) {
    return this.tests.list({ q, domain });
  }

  /**
   * Distinct domains across the loaded catalog — drives the filter
   * chips so they auto-populate from what's actually available.
   */
  @Get('domains')
  domains() {
    return this.tests.listDomains();
  }

  /**
   * Full test definition with items + options. Used by the result
   * card to render the question text next to each answer.
   */
  @Get(':key')
  getOne(@Param('key') key: string) {
    return this.tests.getOrThrow(key);
  }
}
