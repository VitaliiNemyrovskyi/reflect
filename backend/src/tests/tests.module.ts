import { Module } from '@nestjs/common';
import { TestsController } from './tests.controller';
import { TestsService } from './tests.service';

/**
 * Standalone module for the psychological tests catalog. TestsService
 * is re-exported so the sessions module can inject it for the
 * "AI patient takes test" flow.
 */
@Module({
  controllers: [TestsController],
  providers: [TestsService],
  exports: [TestsService],
})
export class TestsModule {}
