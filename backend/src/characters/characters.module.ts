import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { PromptsModule } from '../prompts/prompts.module';
import { CharactersController } from './characters.controller';
import { CharactersService } from './characters.service';

@Module({
  imports: [LlmModule, PromptsModule],
  controllers: [CharactersController],
  providers: [CharactersService],
})
export class CharactersModule {}
