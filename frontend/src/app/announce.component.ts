import { CommonModule } from '@angular/common';
import { Component, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from './auth.service';
import { I18nService } from './i18n.service';
import { IconComponent } from './icon.component';
import { PushClientService } from './push.service';

/**
 * One-time feature-announcement banner. Currently announces patient-reminder
 * push (the only channel that reaches trainees who haven't opted in yet — push
 * itself can't, since there's no subscription until they enable it here).
 *
 * Shows once, only when it's actionable: logged in, push supported, permission
 * not already denied, and not already subscribed. "Enable" subscribes inline
 * (one tap); dismiss or a successful enable both persist a localStorage flag so
 * it never nags again. Bump ANNOUNCE_KEY to broadcast a future announcement.
 */
const ANNOUNCE_KEY = 'reflect_announce_push_v1';

@Component({
  selector: 'app-announce',
  standalone: true,
  imports: [CommonModule, RouterLink, IconComponent],
  template: `
    @if (show()) {
      <div class="announce fx-fade-up" role="status">
        <app-icon name="bell" class="announce-icon" />
        @if (done()) {
          <div class="announce-text">
            <strong>{{ done() }}</strong>
            <a routerLink="/settings" class="announce-link" (click)="close()">
              {{ i18n.t('announce.manageInSettings') }}
            </a>
          </div>
          <button class="ghost icon-btn" (click)="close()" [attr.aria-label]="i18n.t('announce.close')">✕</button>
        } @else {
          <div class="announce-text">
            <strong>{{ i18n.t('announce.title') }}</strong>
            <span>{{ i18n.t('announce.body') }}</span>
          </div>
          <div class="announce-actions">
            <button class="primary small" [disabled]="busy()" (click)="enable()">
              {{ busy() ? '…' : i18n.t('announce.enable') }}
            </button>
            <button class="ghost small" [disabled]="busy()" (click)="dismiss()">
              {{ i18n.t('announce.later') }}
            </button>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .announce {
      display: flex;
      align-items: center;
      gap: 14px;
      margin: 0 0 20px;
      padding: 12px 16px;
      border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
      border-radius: 12px;
      background:
        radial-gradient(ellipse 80% 120% at 0% 0%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 70%),
        color-mix(in srgb, var(--accent) 5%, var(--assistant-bg));
      position: relative;
      z-index: 1;
    }
    .announce-icon {
      font-size: 22px;
      color: var(--accent);
      flex: 0 0 auto;
      filter: drop-shadow(0 0 10px color-mix(in srgb, var(--accent) 40%, transparent));
    }
    .announce-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .announce-text strong { font-size: 14px; font-weight: 600; color: var(--fg); }
    .announce-text span { font-size: 13px; color: var(--fg-dim); line-height: 1.45; }
    .announce-link { font-size: 12.5px; color: var(--accent); text-decoration: none; }
    .announce-link:hover { text-decoration: underline; }
    .announce-actions { display: flex; gap: 8px; flex: 0 0 auto; }
    .icon-btn { padding: 4px 10px; color: var(--fg-dim); border: 1px solid var(--border); border-radius: 8px; }
    @media (max-width: 620px) {
      .announce { flex-wrap: wrap; }
      .announce-actions { width: 100%; }
      .announce-actions .primary, .announce-actions .ghost { flex: 1 1 auto; }
    }
  `],
})
export class AnnounceComponent {
  protected auth = inject(AuthService);
  protected readonly i18n = inject(I18nService);
  protected push = inject(PushClientService);

  protected show = signal(false);
  protected busy = signal(false);
  protected done = signal<string | null>(null);
  private evaluated = false;

  constructor() {
    // Re-evaluate when auth resolves (user() is null on first paint).
    effect(() => {
      const u = this.auth.user();
      if (u && !this.evaluated) {
        this.evaluated = true;
        void this.evaluate();
      }
    });
  }

  private dismissed(): boolean {
    try {
      return localStorage.getItem(ANNOUNCE_KEY) === '1';
    } catch {
      return false;
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(ANNOUNCE_KEY, '1');
    } catch {
      /* private mode — fine, just shows again next load */
    }
  }

  private async evaluate(): Promise<void> {
    if (this.dismissed()) return;
    if (!this.push.supported) return;
    if (this.push.permission === 'denied') return;
    try {
      if (await this.push.isSubscribed()) return;
    } catch {
      /* ignore — show anyway */
    }
    this.show.set(true);
  }

  protected async enable(): Promise<void> {
    this.busy.set(true);
    const r = await this.push.enable();
    this.busy.set(false);
    this.persist();
    if (r === 'ok') {
      this.done.set(this.i18n.t('announce.enabled'));
    } else {
      // denied / unsupported / error — don't nag; they can enable in Settings.
      this.show.set(false);
    }
  }

  protected dismiss(): void {
    this.persist();
    this.show.set(false);
  }

  protected close(): void {
    this.show.set(false);
  }
}
