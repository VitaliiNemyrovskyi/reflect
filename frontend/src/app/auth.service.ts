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
  /** Granted via ADMIN_EMAILS env var on backend; reconciled on every login. */
  isAdmin?: boolean;
}

interface AuthResult {
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

  constructor() {
    void this.fetchProviders();
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
    } catch {
      this.clearAuth();
    }
  }

  redirectToOAuth(provider: 'google' | 'facebook') {
    window.location.href = `/api/auth/${provider}`;
  }

  private applyAuth(result: AuthResult) {
    this.storeTokens(result.accessToken, result.refreshToken);
    this.user.set(result.user);
    this.storeUser(result.user);
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
