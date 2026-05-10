import 'reflect-metadata';
// Load .env BEFORE importing AppModule, so that static field initializers
// (like GoogleStrategy.enabled) see the actual values, not undefined.
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
dotenvConfig({ path: resolve(process.cwd(), '..', '.env') });
dotenvConfig({ path: resolve(process.cwd(), '.env') });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { ErrorLogFilter } from './error-log.filter';

async function bootstrap() {
  // touch — load all 4 patient profiles
  const app = await NestFactory.create(AppModule, { cors: true });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  // Global exception filter — captures 500-class errors into ErrorLog
  // table for admin debugging without losing default response shape.
  // Resolve PrismaService from the container so the filter shares the
  // same connection pool as everything else.
  const prisma = app.get(PrismaService);
  app.useGlobalFilters(new ErrorLogFilter(prisma));

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  Logger.log(`Reflect API → http://localhost:${port}/api`, 'Bootstrap');
}

void bootstrap();
