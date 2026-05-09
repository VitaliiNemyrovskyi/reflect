import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type Profile } from 'passport-facebook';

@Injectable()
export class FacebookStrategy extends PassportStrategy(Strategy, 'facebook') {
  static readonly enabled =
    !!process.env.FACEBOOK_APP_ID && !!process.env.FACEBOOK_APP_SECRET;

  constructor() {
    super({
      clientID: process.env.FACEBOOK_APP_ID || 'unset',
      clientSecret: process.env.FACEBOOK_APP_SECRET || 'unset',
      callbackURL: `${process.env.API_BASE_URL ?? 'http://localhost:3000'}/api/auth/facebook/callback`,
      profileFields: ['id', 'emails', 'name', 'displayName'],
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: (err: unknown, user?: unknown) => void,
  ) {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      return done(new Error('Facebook не повернув email — користувач має дозволити email scope'));
    }
    const fullName = `${profile.name?.givenName ?? ''} ${profile.name?.familyName ?? ''}`.trim();
    const displayName = profile.displayName || fullName || email;
    done(null, {
      provider: 'facebook' as const,
      providerUserId: profile.id,
      email,
      displayName,
    });
  }
}
