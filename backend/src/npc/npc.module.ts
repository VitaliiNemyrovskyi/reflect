import { Global, Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { CharactersModule } from '../characters/characters.module';
import { NpcController } from './npc.controller';
import { NpcService } from './npc.service';

/**
 * Global so SessionsService (chat prompt injection) and NetworkService
 * (3D graph) can both pull NPC data without duplicate imports.
 */
@Global()
@Module({
  imports: [LlmModule, CharactersModule],
  controllers: [NpcController],
  providers: [NpcService],
  exports: [NpcService],
})
export class NpcModule {}
