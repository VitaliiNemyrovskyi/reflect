import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import type { User } from '@prisma/client';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends AuthTokens {
  user: { id: number; email: string; displayName: string | null; isAdmin: boolean };
}

/** Admin email allow-list, sourced from ADMIN_EMAILS env var. */
function adminEmailSet(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * User-scoped UI preferences. Persisted as JSON in `User.preferencesJson`.
 * Add new keys with sensible defaults below — the merge logic protects
 * existing users from seeing `undefined` when a new preference ships.
 */
export interface UserPreferences {
  /** Show "💡 Що спитати?" hint button during chat sessions. */
  hintsEnabled: boolean;
}

const PREFERENCES_DEFAULTS: UserPreferences = {
  hintsEnabled: true,
};

function parseJson(raw: string | null): Partial<UserPreferences> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<UserPreferences>) : {};
  } catch {
    return {};
  }
}

function mergeDefaults(p: Partial<UserPreferences>): UserPreferences {
  return { ...PREFERENCES_DEFAULTS, ...p };
}

/**
 * Strip unknown keys + coerce types. Keeps the persisted JSON clean and
 * defends against clients sending random shapes.
 */
function sanitize(patch: Partial<UserPreferences>): Partial<UserPreferences> {
  const out: Partial<UserPreferences> = {};
  if (typeof patch.hintsEnabled === 'boolean') out.hintsEnabled = patch.hintsEnabled;
  return out;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(email: string, password: string, displayName?: string): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) throw new ConflictException('Email вже зареєстрований');
    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await this.prisma.user.create({
      data: {
        email: email.toLowerCase(),
        hashedPassword,
        displayName: displayName?.trim() || null,
        provider: 'local',
      },
    });
    return this.issueAndReturn(user);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !user.hashedPassword) {
      throw new UnauthorizedException('Невірний email або пароль');
    }
    const ok = await bcrypt.compare(password, user.hashedPassword);
    if (!ok) throw new UnauthorizedException('Невірний email або пароль');
    return this.issueAndReturn(user);
  }

  async refresh(refreshToken: string): Promise<AuthResult> {
    let payload: { sub: number; type?: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Refresh-токен недійсний або прострочений');
    }
    if (payload.type !== 'refresh') throw new UnauthorizedException('Невірний тип токена');
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.refreshTokenHash) throw new UnauthorizedException('Сесія завершена');
    const matches = await bcrypt.compare(refreshToken, user.refreshTokenHash);
    if (!matches) throw new UnauthorizedException('Refresh-токен відкликаний');
    // rotate
    return this.issueAndReturn(user);
  }

  async logout(userId: number): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshTokenHash: null },
    });
  }

  async findOrCreateOAuth(opts: {
    provider: 'google' | 'facebook';
    providerUserId: string;
    email: string;
    displayName?: string;
  }): Promise<AuthResult> {
    const email = opts.email.toLowerCase();
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email,
          displayName: opts.displayName ?? null,
          provider: opts.provider,
          providerUserId: opts.providerUserId,
        },
      });
    } else if (user.provider === 'local' && !user.providerUserId) {
      // link OAuth to existing local account
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { provider: opts.provider, providerUserId: opts.providerUserId },
      });
    }
    return this.issueAndReturn(user);
  }

  async getProfile(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    const isAdmin = await this.reconcileAdmin(user);
    return { id: user.id, email: user.email, displayName: user.displayName, isAdmin };
  }

  /**
   * Bootstraps admin status from `ADMIN_EMAILS` env var. Called on every
   * profile fetch and login — so adding/removing emails takes effect on
   * the next request, no DB poke needed. Persists the change to DB so
   * AdminGuard can rely on the column directly without re-checking env.
   */
  private async reconcileAdmin(user: User): Promise<boolean> {
    const allowList = adminEmailSet();
    const shouldBeAdmin = allowList.has(user.email.toLowerCase());
    if (shouldBeAdmin === user.isAdmin) return user.isAdmin;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { isAdmin: shouldBeAdmin },
    });
    return shouldBeAdmin;
  }

  /**
   * User-scoped preferences. Defaults are returned for any keys a user
   * has never set, so the frontend gets a stable shape from day one.
   */
  async getPreferences(userId: number): Promise<UserPreferences> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { preferencesJson: true },
    });
    if (!user) throw new UnauthorizedException();
    return mergeDefaults(parseJson(user.preferencesJson));
  }

  /**
   * Patch-update preferences — caller passes only the keys it wants to
   * change, server merges over the existing record. Unknown keys are
   * silently dropped to keep the JSON clean.
   */
  async updatePreferences(
    userId: number,
    patch: Partial<UserPreferences>,
  ): Promise<UserPreferences> {
    const current = await this.getPreferences(userId);
    const next = mergeDefaults({
      ...current,
      ...sanitize(patch),
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: { preferencesJson: JSON.stringify(next) },
    });
    return next;
  }

  private async issueAndReturn(user: User): Promise<AuthResult> {
    const tokens = await this.issueTokens(user.id);
    const refreshHash = await bcrypt.hash(tokens.refreshToken, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshTokenHash: refreshHash },
    });
    const isAdmin = await this.reconcileAdmin(user);
    return {
      ...tokens,
      user: { id: user.id, email: user.email, displayName: user.displayName, isAdmin },
    };
  }

  private async issueTokens(userId: number): Promise<AuthTokens> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, type: 'access' },
      {
        secret: process.env.JWT_ACCESS_SECRET,
        expiresIn: process.env.JWT_ACCESS_TTL ?? '15m',
      },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, type: 'refresh' },
      {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: process.env.JWT_REFRESH_TTL ?? '7d',
      },
    );
    return { accessToken, refreshToken };
  }
}
