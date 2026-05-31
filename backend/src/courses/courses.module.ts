import { Module } from '@nestjs/common';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { SessionsModule } from '../sessions/sessions.module';
import { GlossaryModule } from '../glossary/glossary.module';

@Module({
  imports: [SessionsModule, GlossaryModule],
  controllers: [CoursesController],
  providers: [CoursesService],
})
export class CoursesModule {}
