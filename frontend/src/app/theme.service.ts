import { Injectable, signal } from '@angular/core';

/**
 * Available theme keys. The default theme (lavender on near-black) is
 * the identity — picked when `localStorage` has nothing stored. Other
 * keys correspond to `[data-theme="..."]` selectors in styles.scss
 * that override --accent + a couple of surface variables.
 */
export type ThemeKey = 'default' | 'blue' | 'synapse';

export interface ThemeOption {
  key: ThemeKey;
  label: string;
  description: string;
  swatch: string; // accent colour for the toggle swatch
}

const STORAGE_KEY = 'reflect.theme';

const OPTIONS: ThemeOption[] = [
  {
    key: 'default',
    label: 'Лавандова',
    description: 'Спокійна базова. Темно-сірий + лавандовий акцент.',
    swatch: '#d8c9ff',
  },
  {
    key: 'blue',
    label: 'Синя',
    description: 'Холодна електрична. Темний фон + sky-blue акцент.',
    swatch: '#38bdf8',
  },
  {
    key: 'synapse',
    label: 'Synapse',
    description: 'Близька до референс-Synapse: чорний-обсидіан + хірургічний помаранчевий.',
    swatch: '#ff6a25',
  },
];

@Injectable({ providedIn: 'root' })
export class ThemeService {
  /**
   * Current theme key, read by template bindings. Use `set(...)` to
   * change — it updates the signal, writes the data-attribute on
   * `<html>`, and persists to localStorage in one go.
   */
  readonly current = signal<ThemeKey>(this.readStored());

  readonly options = OPTIONS;

  constructor() {
    // Apply on bootstrap — before AppComponent renders, so no FOUC.
    this.apply(this.current());
  }

  set(key: ThemeKey) {
    if (key === this.current()) return;
    this.current.set(key);
    this.apply(key);
    try {
      if (key === 'default') {
        // Default = absence of data-theme; clean slate in localStorage.
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, key);
      }
    } catch {
      // localStorage disabled / quota — theme still applies for the session.
    }
  }

  private apply(key: ThemeKey) {
    const root = document.documentElement;
    if (key === 'default') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', key);
    }
  }

  private readStored(): ThemeKey {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === 'blue' || raw === 'synapse') return raw;
    } catch {}
    return 'default';
  }
}
