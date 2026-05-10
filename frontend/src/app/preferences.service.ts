import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Per-user UI preferences. Mirrors the backend `UserPreferences` shape.
 * Add new keys here when adding settings — backend silently drops unknown
 * keys, so frontend-side type safety is the single source of truth.
 */
export interface UserPreferences {
  /** Show "💡 Що спитати?" hint button during chat sessions. */
  hintsEnabled: boolean;
}

const DEFAULTS: UserPreferences = {
  hintsEnabled: true,
};

const CACHE_KEY = 'reflect.preferences';

/**
 * Reactive store for user preferences. Reads cached value on construction
 * (instant render) and refreshes from backend in the background. Writes are
 * optimistic — local signal updates immediately, server PATCH happens
 * concurrently, error reverts on failure.
 */
@Injectable({ providedIn: 'root' })
export class PreferencesService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  private readonly _prefs = signal<UserPreferences>(this.readCache());
  readonly prefs = this._prefs.asReadonly();
  readonly hintsEnabled = computed(() => this._prefs().hintsEnabled);

  private inflightFetch: Promise<UserPreferences> | null = null;

  constructor() {
    // Lazy refresh on first auth token presence — defensive against being
    // imported before login.
    if (this.auth.accessToken()) {
      void this.refresh();
    }
  }

  /** Pull fresh preferences from server and update the store. */
  async refresh(): Promise<UserPreferences> {
    if (this.inflightFetch) return this.inflightFetch;
    this.inflightFetch = (async () => {
      try {
        const fetched = await firstValueFrom(
          this.http.get<UserPreferences>('/api/auth/me/preferences'),
        );
        const merged = { ...DEFAULTS, ...fetched };
        this._prefs.set(merged);
        this.writeCache(merged);
        return merged;
      } catch {
        return this._prefs();
      } finally {
        this.inflightFetch = null;
      }
    })();
    return this.inflightFetch;
  }

  /**
   * Optimistic update — flips the local signal immediately, sends PATCH in
   * the background. Reverts the local state if the request fails.
   */
  async update(patch: Partial<UserPreferences>): Promise<void> {
    const prev = this._prefs();
    const next = { ...prev, ...patch };
    this._prefs.set(next);
    this.writeCache(next);
    try {
      const result = await firstValueFrom(
        this.http.patch<UserPreferences>('/api/auth/me/preferences', patch),
      );
      const merged = { ...DEFAULTS, ...result };
      this._prefs.set(merged);
      this.writeCache(merged);
    } catch (err) {
      // Revert on failure so the UI doesn't lie.
      this._prefs.set(prev);
      this.writeCache(prev);
      throw err;
    }
  }

  /** Wipe local state on logout. Call from AuthService.clearAuth if needed. */
  reset(): void {
    this._prefs.set(DEFAULTS);
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      /* ignore */
    }
  }

  private readCache(): UserPreferences {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return DEFAULTS;
      const parsed = JSON.parse(raw) as Partial<UserPreferences>;
      return { ...DEFAULTS, ...parsed };
    } catch {
      return DEFAULTS;
    }
  }

  private writeCache(p: UserPreferences): void {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(p));
    } catch {
      /* storage full / disabled — accept */
    }
  }
}
