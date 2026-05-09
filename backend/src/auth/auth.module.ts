import { Module, Provider } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { GoogleStrategy } from './google.strategy';
import { FacebookStrategy } from './facebook.strategy';

const oauthProviders: Provider[] = [];
if (GoogleStrategy.enabled) oauthProviders.push(GoogleStrategy);
if (FacebookStrategy.enabled) oauthProviders.push(FacebookStrategy);

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      // secrets and TTLs are passed per-token in AuthService for clarity
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    ...oauthProviders,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
