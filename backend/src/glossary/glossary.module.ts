import { Module } from '@nestjs/common';
import { GlossaryController } from './glossary.controller';
import { GlossaryService } from './glossary.service';

@Module({
  controllers: [GlossaryController],
  providers: [GlossaryService],
  exports: [GlossaryService],
})
export class GlossaryModule {}
