import { Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * Global so any controller (e.g. SessionsController for SSE streams)
 * can inject HealthService without re-importing the module everywhere.
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
