import { CommonModule } from '@angular/common';
import { Component, HostListener, Input, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from './auth.service';
import { I18nService } from './i18n.service';
import { SessionModeService } from './session-mode.service';
import { LogoComponent } from './logo.component';
import { IconComponent } from './icon.component';

/**
 * Shared application header, mounted once in app.component above the
 * router-outlet. Renders only when a user is logged in — public routes
 * (login, register, safety, pricing) stay chromeless.
 *
 * FORM. The header sits *on* the page, not in a bar bolted over it. At
 * rest it is fully transparent — just the wordmark on the left and a
 * round account avatar on the right, floating on the app's ambient
 * background so it reads as the top of the page. A quiet near-solid
 * backdrop + faint neutral hairline fade in only once content scrolls
 * underneath (`.scrolled`), purely so text stays legible. No permanent
 * frosted strip, no accent underline.
 *
 * NAV. The avatar opens a single labelled dropdown — profile, the
 * secondary nav (progress / network / cohorts / admin / settings) and
 * logout — and it's the same menu on every breakpoint, so desktop and
 * mobile no longer diverge into an inline icon row vs. a hamburger.
 * During a live session a chat/video mode toggle appears to the left of
 * the avatar (gated on SessionModeService.active()).
 *
 * Pages pass an optional `subtitle` rendered under the wordmark.
 */
@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, RouterLink, LogoComponent, IconComponent],
  template: `
    @if (auth.user(); as u) {
      <header class="header" [class.scrolled]="scrolled()">
        <div class="title-row">
          <div class="brand-block">
            <a routerLink="/" class="brand-link" [title]="i18n.t('home.patients')">
              <app-logo />
            </a>
            @if (subtitle) {
              <p class="subtitle">{{ subtitle }}</p>
            }
          </div>

          <div class="header-right">
            @if (sessionMode.active()) {
              <div class="mode-toggle" role="group"
                   [attr.aria-label]="i18n.isEn ? 'Session mode' : 'Режим сесії'">
                <button class="mode-btn" [class.active]="sessionMode.mode() === 'chat'"
                        (click)="sessionMode.set('chat')"
                        [title]="i18n.isEn ? 'Chat' : 'Чат'"
                        [attr.aria-label]="i18n.isEn ? 'Chat' : 'Чат'"><app-icon name="message" /></button>
                <button class="mode-btn" [class.active]="sessionMode.mode() === 'video'"
                        (click)="sessionMode.set('video')"
                        [title]="i18n.isEn ? 'Video call' : 'Відеодзвінок'"
                        [attr.aria-label]="i18n.isEn ? 'Video call' : 'Відеодзвінок'"><app-icon name="video" /></button>
              </div>
            }

            <button type="button"
                    class="account-btn"
                    [class.open]="menuOpen()"
                    (click)="menuOpen.set(!menuOpen())"
                    [attr.aria-expanded]="menuOpen()"
                    aria-haspopup="menu"
                    [attr.aria-label]="i18n.t('nav.profile')">{{ initials() }}</button>
          </div>
        </div>

        @if (menuOpen()) {
          <div class="menu-backdrop" (click)="menuOpen.set(false)"></div>
          <nav class="account-menu fx-fade-up" role="menu">
            <a routerLink="/profile" class="mm-item mm-name" (click)="menuOpen.set(false)">
              <span class="mm-avatar">{{ initials() }}</span>
              <span class="mm-id">
                <span class="mm-id-name">{{ u.displayName ?? u.email }}</span>
                @if (u.displayName) {
                  <span class="mm-id-sub">{{ u.email }}</span>
                }
              </span>
            </a>
            <div class="mm-sep"></div>
            <a routerLink="/progress" class="mm-item" (click)="menuOpen.set(false)">
              <app-icon name="chart-up" /><span>{{ i18n.isEn ? 'Progress' : 'Прогрес' }}</span>
            </a>
            <a routerLink="/network" class="mm-item" (click)="menuOpen.set(false)">
              <app-icon name="network" /><span>{{ i18n.t('nav.network') }}</span>
            </a>
            <a routerLink="/cohorts" class="mm-item" (click)="menuOpen.set(false)">
              <app-icon name="users" /><span>{{ i18n.isEn ? 'Cohorts' : 'Групи' }}</span>
            </a>
            @if (u.isAdmin) {
              <a routerLink="/admin" class="mm-item" (click)="menuOpen.set(false)">
                <app-icon name="shield-check" /><span>{{ i18n.isEn ? 'Admin' : 'Адмін' }}</span>
              </a>
            }
            <a routerLink="/settings" class="mm-item" (click)="menuOpen.set(false)">
              <app-icon name="settings" /><span>{{ i18n.t('nav.settings') }}</span>
            </a>
            <div class="mm-sep"></div>
            <button type="button" class="mm-item mm-logout" (click)="closeAndLogout()">
              <app-icon name="log-out" /><span>{{ i18n.t('nav.logout') }}</span>
            </button>
          </nav>
        }
      </header>
    }
  `,
  styles: [`
    /* display:contents drops the host box so .header becomes a direct child
       of the scrolling shell — position:sticky needs that to have room. */
    :host { display: contents; }

    /* The header rides ON the page: transparent at rest, flush to the very
       top (negative margins cancel the shell's 32px/20px padding). A quiet
       near-solid backdrop + neutral hairline fade in only once content
       scrolls under it, so it never reads as a permanent frosted strip. */
    .header {
      position: sticky;
      top: 0;
      z-index: 100;
      margin: -32px -20px 22px;
      padding: max(16px, var(--safe-top, 0px)) 20px 14px;
      background: transparent;
      border-bottom: 1px solid transparent;
      transition: background .28s ease, border-color .28s ease, backdrop-filter .28s ease;
    }
    .header.scrolled {
      background: color-mix(in srgb, var(--bg) 90%, transparent);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-bottom-color: color-mix(in srgb, var(--border) 65%, transparent);
    }

    .title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .brand-block { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .brand-link {
      display: inline-flex;
      align-items: center;
      text-decoration: none;
      color: inherit;
    }
    .subtitle {
      color: var(--fg-dim);
      margin: 0;
      font-size: 14px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .header-right { display: flex; align-items: center; gap: 12px; }

    /* chat/video segmented toggle — session only */
    .mode-toggle {
      display: inline-flex;
      gap: 2px;
      padding: 2px;
      border: 1px solid var(--border);
      border-radius: 9px;
      background: color-mix(in srgb, var(--accent) 4%, transparent);
    }
    .mode-btn {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 16px;
      line-height: 0;
      padding: 6px 9px;
      border-radius: 7px;
      color: var(--fg-dim);
      transition: background .15s ease, color .15s ease;
    }
    .mode-btn:hover { color: var(--fg); }
    .mode-btn.active {
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      color: var(--accent);
    }

    /* Account avatar — single entry to profile + nav + logout. */
    .account-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      padding: 0;
      border-radius: 50%;
      border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      color: var(--accent);
      font-size: 12.5px;
      font-weight: 600;
      letter-spacing: .02em;
      cursor: pointer;
      transition: border-color .15s ease, background .15s ease, transform .12s ease;
    }
    .account-btn:hover,
    .account-btn.open {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 16%, transparent);
    }
    .account-btn:active { transform: scale(.95); }

    /* Dropdown — anchored under the header on every breakpoint. */
    .menu-backdrop { position: fixed; inset: 0; z-index: 40; }
    .account-menu {
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: -4px;
      z-index: 50;
      min-width: 248px;
      max-width: calc(100vw - 32px);
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px;
      background: var(--assistant-bg);
      border: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border));
      border-radius: 14px;
      box-shadow: 0 18px 44px -14px rgba(0, 0, 0, 0.7);
    }
    .mm-item {
      display: flex;
      align-items: center;
      gap: 11px;
      width: 100%;
      padding: 10px 12px;
      border: none;
      border-radius: 9px;
      background: transparent;
      color: var(--fg);
      font: inherit;
      font-size: 14px;
      text-align: left;
      text-decoration: none;
      cursor: pointer;
    }
    .mm-item app-icon { font-size: 18px; color: var(--fg-dim); flex: 0 0 auto; }
    .mm-item:hover { background: var(--user-bg); }
    .mm-item:hover app-icon { color: var(--accent); }
    .mm-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Identity row at the top of the menu. */
    .mm-name { padding: 8px 12px 10px; }
    .mm-avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      color: var(--accent);
      font-size: 12.5px;
      font-weight: 600;
    }
    .mm-id { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .mm-id-name { font-weight: 500; }
    .mm-id-sub { font-size: 12px; color: var(--fg-dim); }
    .mm-logout { color: var(--fg-dim); }
    .mm-sep { height: 1px; margin: 4px 6px; background: var(--border); }

    @media (max-width: 480px) {
      .subtitle { display: none; }
    }
  `],
})
export class AppHeaderComponent {
  /** Optional page-specific subtitle rendered below the wordmark. */
  @Input() subtitle = '';

  protected auth = inject(AuthService);
  protected i18n = inject(I18nService);
  protected sessionMode = inject(SessionModeService);
  private router = inject(Router);

  /** Account dropdown open state. */
  protected menuOpen = signal(false);
  /** True once the page has scrolled — fades in the header backdrop. */
  protected scrolled = signal(false);

  /** Two-letter monogram from the display name (or email) for the avatar. */
  protected initials = computed(() => {
    const u = this.auth.user();
    const src = (u?.displayName?.trim() || u?.email || '').trim();
    if (!src) return '?';
    const parts = src.split(/[\s@._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return src.slice(0, 2).toUpperCase();
  });

  @HostListener('window:scroll')
  onScroll(): void {
    const s = window.scrollY > 4;
    if (s !== this.scrolled()) this.scrolled.set(s);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.menuOpen()) this.menuOpen.set(false);
  }

  async logout(): Promise<void> {
    try { await this.auth.logout(); } catch { /* noop */ }
    void this.router.navigate(['/login']);
  }

  closeAndLogout(): void {
    this.menuOpen.set(false);
    void this.logout();
  }
}
