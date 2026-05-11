import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

const ACCESS_KEY = 'reflect.access';
const REFRESH_KEY = 'reflect.refresh';
const USER_KEY = 'reflect.user';

export interface AuthUser {
  id: number;
  email: string;
  displayName: string | null;
  bio?: string | null;
  /** "local" | "google" | "facebook" — drives whether password change requires currentPassword. */
  provider?: string;
  /** false for OAuth-only users who haven't set a password yet — UI can adapt copy. */
  hasPassword?: boolean;
  /** Granted via ADMIN_EMAILS env var on backend; reconciled on every login. */
  isAdmin?: boolean;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

interface ProvidersStatus {
  local: boolean;
  google: boolean;
  facebook: boolean;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);

  readonly user = signal<AuthUser | null>(this.readStoredUser());
  readonly accessToken = signal<string | null>(this.readStored(ACCESS_KEY));
  readonly providers = signal<ProvidersStatus>({ local: true, google: false, facebook: false });
  readonly isAuthenticated = computed(() => !!this.user());

  private refreshing: Promise<string | null> | null = null;
  /**
   * Timer that fires shortly before the current access token expires,
   * triggering a refresh proactively so requests never see a 401.
   * Re-armed on every applyAuth() and after each successful refresh.
   * Cancelled on clearAuth(). Re-evaluated on tab-visibility resume so
   * background-throttled timers don't leave us stuck with a dead token.
   */
  private refreshTimerId: ReturnType<typeof setTimeout> | null = null;
  /** Refresh this many seconds BEFORE the access token's `exp` claim. */
  private static readonly REFRESH_LEAD_SECONDS = 60;

  constructor() {
    void this.fetchProviders();
    // Bootstrap: if we have a stored access token, schedule the next
    // refresh based on its actual `exp` claim. If the token is already
    // expired, scheduleNextRefresh fires the refresh immediately (~0ms).
    const stored = this.accessToken();
    if (stored) this.scheduleNextRefresh(stored);

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        // Hidden tabs throttle setTimeout — when we come back we may
        // have missed the firing window. Reschedule against the
        // current token's actual exp so we either refresh now (if
        // overdue) or set a fresh accurate timer.
        const token = this.accessToken();
        if (token) this.scheduleNextRefresh(token);
      });
    }
  }

  getRefreshToken(): string | null {
    return this.readStored(REFRESH_KEY);
  }

  async fetchProviders() {
    try {
      const status = await firstValueFrom(this.http.get<ProvidersStatus>('/api/auth/providers'));
      this.providers.set(status);
    } catch {
      // ignore — defaults stand
    }
  }

  async register(email: string, password: string, displayName?: string): Promise<AuthUser> {
    const result = await firstValueFrom(
      this.http.post<AuthResult>('/api/auth/register', { email, password, displayName }),
    );
    this.applyAuth(result);
    return result.user;
  }

  async login(email: string, password: string): Promise<AuthUser> {
    const result = await firstValueFrom(
      this.http.post<AuthResult>('/api/auth/login', { email, password }),
    );
    this.applyAuth(result);
    return result.user;
  }

  /**
   * Used by HTTP interceptor on 401. Returns new access token, or null on failure.
   * Idempotent — concurrent calls share the same in-flight refresh promise.
   */
  refreshAccess(): Promise<string | null> {
    if (this.refreshing) return this.refreshing;
    const refresh = this.getRefreshToken();
    if (!refresh) return Promise.resolve(null);

    this.refreshing = (async () => {
      try {
        const result = await firstValueFrom(
          this.http.post<AuthResult>('/api/auth/refresh', { refreshToken: refresh }),
        );
        this.applyAuth(result);
        return result.accessToken;
      } catch {
        this.clearAuth();
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async logout() {
    try {
      if (this.accessToken()) {
        await firstValueFrom(this.http.post('/api/auth/logout', {}));
      }
    } catch {
      // ignore — clearing local state is the main thing
    }
    this.clearAuth();
    void this.router.navigate(['/login']);
  }

  /**
   * Called when refresh fails or user has no auth. Clears state and bounces to /login.
   */
  forceLogout() {
    this.clearAuth();
    void this.router.navigate(['/login']);
  }

  /**
   * Used by /auth/callback after OAuth redirect — receives tokens via query params.
   */
  async applyOAuthTokens(access: string, refresh: string) {
    this.storeTokens(access, refresh);
    // Fetch user profile
    try {
      const user = await firstValueFrom(this.http.get<AuthUser>('/api/auth/me'));
      this.user.set(user);
      this.storeUser(user);
      this.scheduleNextRefresh(access);
    } catch {
      this.clearAuth();
    }
  }

  redirectToOAuth(provider: 'google' | 'facebook') {
    window.location.href = `/api/auth/${provider}`;
  }

  /**
   * Push a fresh user object into the signal + localStorage cache. Called
   * by ProfileComponent after PATCH /me succeeds, so the header / etc. see
   * the updated displayName immediately without a refresh.
   */
  applyProfileUpdate(user: AuthUser) {
    this.user.set(user);
    this.storeUser(user);
  }

  /**
   * Apply a fresh AuthResult — e.g. after password change which rotates
   * tokens. Same as the private applyAuth path used by login.
   */
  applyAuthResult(result: AuthResult) {
    this.applyAuth(result);
  }

  private applyAuth(result: AuthResult) {
    this.storeTokens(result.accessToken, result.refreshToken);
    this.user.set(result.user);
    this.storeUser(result.user);
    this.scheduleNextRefresh(result.accessToken);
  }

  /**
   * Decode the `exp` claim from a JWT (seconds since epoch). Tolerates
   * malformed input by returning null — caller treats that as "no
   * preemptive refresh, fall back to interceptor-driven 401 retry".
   */
  private decodeJwtExp(token: string): number | null {
    try {
      const part = token.split('.')[1];
      if (!part) return null;
      // JWT uses base64url; convert to base64 before atob.
      const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(
        Math.ceil(part.length / 4) * 4,
        '=',
      );
      const payload = JSON.parse(atob(padded)) as { exp?: number };
      return typeof payload.exp === 'number' ? payload.exp : null;
    } catch {
      return null;
    }
  }

  /**
   * Arm (or re-arm) the proactive refresh timer for the given token.
   * Fires REFRESH_LEAD_SECONDS before the token's `exp`; if the token
   * is already expired or very close to it, fires almost immediately.
   * Safe to call multiple times — replaces any pending timer.
   */
  private scheduleNextRefresh(accessToken: string | null) {
    if (this.refreshTimerId !== null) {
      clearTimeout(this.refreshTimerId);
      this.refreshTimerId = null;
    }
    if (!accessToken) return;
    const exp = this.decodeJwtExp(accessToken);
    if (!exp) return;
    const now = Math.floor(Date.now() / 1000);
    const secsUntilExp = exp - now;
    // Refresh REFRESH_LEAD_SECONDS before expiry. If we're already
    // past that window, run on the next tick (don't block sync flow).
    const refreshIn = Math.max(secsUntilExp - AuthService.REFRESH_LEAD_SECONDS, 0);
    this.refreshTimerId = setTimeout(() => {
      this.refreshTimerId = null;
      void this.refreshAccess();
    }, refreshIn * 1000);
  }

  private storeTokens(access: string, refresh: string) {
    this.accessToken.set(access);
    try {
      localStorage.setItem(ACCESS_KEY, access);
      localStorage.setItem(REFRESH_KEY, refresh);
    } catch {}
  }

  private storeUser(user: AuthUser) {
    try {
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch {}
  }

  private clearAuth() {
    if (this.refreshTimerId !== null) {
      clearTimeout(this.refreshTimerId);
      this.refreshTimerId = null;
    }
    this.user.set(null);
    this.accessToken.set(null);
    try {
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(USER_KEY);
    } catch {}
  }

  private readStored(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private readStoredUser(): AuthUser | null {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? (JSON.parse(raw) as AuthUser) : null;
    } catch {
      return null;
    }
  }
}
