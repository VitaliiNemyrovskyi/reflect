import { Global, Module } from '@nestjs/common';
import { MemoryService } from './memory.service';

/**
 * Global so SessionsService and (future) Phase-3 NPC / Phase-4 diary
 * jobs can all inject it without re-importing the module.
 */
@Global()
@Module({
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
