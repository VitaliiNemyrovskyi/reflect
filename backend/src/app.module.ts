import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
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
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { CityModule } from './city/city.module';
import { MemoryModule } from './memory/memory.module';
import { NetworkModule } from './network/network.module';
import { NpcModule } from './npc/npc.module';
import { DiaryModule } from './diary/diary.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ProgressModule } from './progress/progress.module';
import { PushModule } from './push/push.module';
import { CohortModule } from './cohort/cohort.module';
import { CoursesModule } from './courses/courses.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [join(process.cwd(), '..', '.env'), join(process.cwd(), '.env')],
    }),
    // Global rate limit: 300 requests / minute / IP. Generous for normal
    // use (a heavy session bursts well under this) but caps abuse, auth
    // brute-force, and runaway client loops (the Memory-tab storm would
    // have been clipped server-side too). Per-IP relies on trust-proxy in
    // main.ts so Caddy's X-Forwarded-For yields the real client. State is
    // in-memory per replica, so a client hitting both api replicas gets up
    // to 2× the limit — acceptable for MVP; a shared Redis store would make
    // it exact. Tighter per-route limits live on the auth endpoints.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
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
    AppConfigModule,
    HealthModule,
    CityModule,
    MemoryModule,
    NetworkModule,
    NpcModule,
    DiaryModule,
    DashboardModule,
    ProgressModule,
    PushModule,
    CohortModule,
    CoursesModule,
  ],
  providers: [
    // Apply the throttler globally. Individual routes opt out with
    // @SkipThrottle() (e.g. /health) or override with @Throttle() (auth).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
