import { Injectable, signal } from '@angular/core';

const KEY = 'reflect.sessionMode';

/**
 * Shared chat/video session mode, lifted out of ChatComponent so the global
 * AppHeader can host the 💬/📹 toggle next to the hamburger (and stay sticky)
 * while ChatComponent reads the same signal. `active` is true only while a
 * live session screen is mounted — it gates the toggle's visibility in the
 * header so the global chrome doesn't show a session control on other pages.
 */
@Injectable({ providedIn: 'root' })
export class SessionModeService {
  readonly mode = signal<'chat' | 'video'>(this.read());
  readonly active = signal<boolean>(false);

  set(m: 'chat' | 'video') {
    this.mode.set(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {}
  }

  private read(): 'chat' | 'video' {
    try {
      return localStorage.getItem(KEY) === 'video' ? 'video' : 'chat';
    } catch {
      return 'chat';
    }
  }
}
