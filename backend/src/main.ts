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

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  Logger.log(`Reflect API → http://localhost:${port}/api`, 'Bootstrap');
}

void bootstrap();
