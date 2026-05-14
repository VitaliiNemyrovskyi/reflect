import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'node:path';
import { PrismaModule } from './prisma/prisma.module';
import { PromptsModule } from './prompts/prompts.module';
import { LlmModule } from './llm/llm.module';
import { CharactersModule } from './characters/characters.module';
import { SessionsModule } from './sessions/sessions.module';
import { NotesModule } from './notes/notes.module';
import { TtsModule } from './tts/tts.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { TestsModule } from './tests/tests.module';
import { BillingModule } from './billing/billing.module';
import { EventsModule } from './events/events.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [join(process.cwd(), '..', '.env'), join(process.cwd(), '.env')],
    }),
    PrismaModule,
    PromptsModule,
    LlmModule,
    AuthModule,
    CharactersModule,
    SessionsModule,
    NotesModule,
    TtsModule,
    AdminModule,
    TestsModule,
    BillingModule,
    EventsModule,
  ],
})
export class AppModule {}
