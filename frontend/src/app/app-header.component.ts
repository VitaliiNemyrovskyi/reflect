import { CommonModule, isPlatformBrowser } from '@angular/common';
import { Component, HostListener, Input, OnDestroy, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from './auth.service';
import { I18nService } from './i18n.service';
import { ApiService, type AppNotification } from './api.service';
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
            <button type="button"
                    class="bell-btn"
                    [class.open]="notifOpen()"
                    (click)="toggleNotif()"
                    aria-haspopup="menu"
                    [attr.aria-expanded]="notifOpen()"
                    [attr.aria-label]="bellLabel()">
              <app-icon name="bell" />
              @if (unread() > 0) {
                <span class="bell-dot" aria-hidden="true"></span>
              }
            </button>
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
              <app-icon name="chart-up" /><span>{{ i18n.t('appHeader.navProgress') }}</span>
            </a>
            <a routerLink="/courses" class="mm-item" (click)="menuOpen.set(false)">
              <app-icon name="lightbulb" /><span>{{ i18n.t('appHeader.navCourses') }}</span>
            </a>
            <a routerLink="/glossary" class="mm-item" (click)="menuOpen.set(false)">
              <app-icon name="clipboard" /><span>{{ i18n.t('appHeader.navGlossary') }}</span>
            </a>
            <a routerLink="/network" class="mm-item" (click)="menuOpen.set(false)">
              <app-icon name="network" /><span>{{ i18n.t('nav.network') }}</span>
            </a>
            <a routerLink="/cohorts" class="mm-item" (click)="menuOpen.set(false)">
              <app-icon name="users" /><span>{{ i18n.t('appHeader.navCohorts') }}</span>
            </a>
            @if (u.isAdmin) {
              <a routerLink="/admin" class="mm-item" (click)="menuOpen.set(false)">
                <app-icon name="shield-check" /><span>{{ i18n.t('appHeader.navAdmin') }}</span>
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

        @if (notifOpen()) {
          <div class="menu-backdrop" (click)="notifOpen.set(false)"></div>
          <div class="notif-panel fx-fade-up" role="menu">
            <div class="np-head">
              <strong>{{ i18n.t('appHeader.notifications') }}</strong>
              @if (unread() > 0) {
                <button type="button" class="np-readall" (click)="markAllRead()">
                  {{ i18n.t('appHeader.markAllRead') }}
                </button>
              }
            </div>
            <div class="np-list">
              @if (notifs().length === 0) {
                <p class="np-empty">{{ i18n.t('appHeader.noNotificationsYet') }}</p>
              } @else {
                @for (n of notifs(); track n.id) {
                  <button type="button" class="np-item" [class.unread]="!n.read" (click)="openNotif(n)">
                    <app-icon [name]="iconFor(n.type)" class="np-icon" />
                    <span class="np-text">
                      <span class="np-body">{{ n.body }}</span>
                      <span class="np-time">{{ relTime(n.createdAt) }}</span>
                    </span>
                    @if (!n.read) { <span class="np-dot" aria-hidden="true"></span> }
                  </button>
                }
              }
            </div>
            <a routerLink="/notifications" class="np-all" (click)="notifOpen.set(false)">
              {{ i18n.t('appHeader.seeAllNotifications') }} →
            </a>
          </div>
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

    /* Account avatar — single entry to profile + nav + logout. */
    .account-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      min-height: 0;   /* override the global @media button min-height that was ovalising it on mobile */
      flex: 0 0 auto;  /* never let the flex row compress the circle */
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

    /* ── Notification bell + dropdown ─────────────────────────────────── */
    .bell-btn {
      position: relative;
      display: inline-flex; align-items: center; justify-content: center;
      width: 34px; height: 34px;
      min-height: 0; flex: 0 0 auto; padding: 0;
      border-radius: 50%;
      border: 1px solid transparent;
      background: transparent;
      color: var(--fg-dim);
      font-size: 18px;
      cursor: pointer;
      transition: color .15s ease, background .15s ease, border-color .15s ease;
    }
    .bell-btn:hover, .bell-btn.open {
      color: var(--accent);
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      border-color: color-mix(in srgb, var(--accent) 24%, var(--border));
    }
    /* GitHub-style unread indicator — small red dot on the bell. */
    .bell-dot {
      position: absolute; top: 5px; right: 5px;
      width: 9px; height: 9px; border-radius: 50%;
      background: var(--danger);
      border: 2px solid var(--bg);
    }

    .notif-panel {
      position: absolute; top: 100%; right: 0; margin-top: -4px;
      z-index: 50;
      width: 340px; max-width: calc(100vw - 32px);
      display: flex; flex-direction: column;
      background: var(--assistant-bg);
      border: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border));
      border-radius: 14px;
      box-shadow: 0 18px 44px -14px rgba(0, 0, 0, 0.7);
      overflow: hidden;
    }
    .np-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 14px; border-bottom: 1px solid var(--border);
    }
    .np-head strong { font-size: 13px; letter-spacing: .02em; }
    .np-readall {
      background: none; border: none; color: var(--accent);
      font-size: 12px; cursor: pointer; padding: 0; min-height: 0;
    }
    .np-readall:hover { text-decoration: underline; }
    .np-list { max-height: min(60vh, 420px); overflow-y: auto; }
    .np-empty { color: var(--fg-dim); font-size: 13px; text-align: center; padding: 28px 16px; margin: 0; }
    .np-item {
      display: flex; align-items: flex-start; gap: 10px;
      width: 100%; text-align: left;
      padding: 11px 14px;
      border: none;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
      background: transparent; color: var(--fg);
      cursor: pointer; min-height: 0;
      transition: background .12s ease;
    }
    .np-item:hover { background: rgba(255, 255, 255, 0.03); }
    .np-item.unread { background: color-mix(in srgb, var(--accent) 6%, transparent); }
    .np-icon { font-size: 16px; color: var(--accent); margin-top: 1px; flex: 0 0 auto; }
    .np-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
    .np-body { font-size: 13px; line-height: 1.4; }
    .np-time { font-size: 11px; color: var(--fg-dim); }
    .np-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--accent); flex: 0 0 auto; margin-top: 5px;
    }
    .np-all {
      display: block; text-align: center; padding: 11px;
      font-size: 13px; color: var(--accent); text-decoration: none;
      border-top: 1px solid var(--border);
    }
    .np-all:hover { background: rgba(255, 255, 255, 0.03); }

    @media (max-width: 480px) {
      .subtitle { display: none; }
    }
  `],
})
export class AppHeaderComponent implements OnDestroy {
  /** Optional page-specific subtitle rendered below the wordmark. */
  @Input() subtitle = '';

  protected auth = inject(AuthService);
  protected i18n = inject(I18nService);
  private router = inject(Router);
  private api = inject(ApiService);
  private platformId = inject(PLATFORM_ID);

  /** Account dropdown open state. */
  protected menuOpen = signal(false);
  /** Notification dropdown open state. */
  protected notifOpen = signal(false);
  /** Unread notification count — drives the bell's red dot. */
  protected unread = signal(0);
  /** Recent notifications, loaded when the panel opens. */
  protected notifs = signal<AppNotification[]>([]);
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Poll the cheap unread-count endpoint so the bell indicator stays live.
    // Browser-only (the header never renders for the logged-out / prerender
    // case anyway, but guard so SSR/prerender can't start a timer).
    if (isPlatformBrowser(this.platformId)) {
      void this.refreshUnread();
      this.pollTimer = setInterval(() => void this.refreshUnread(), 60_000);
    }
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  protected bellLabel = computed(() => {
    const u = this.unread();
    return u > 0
      ? this.i18n.t('appHeader.notificationsWithCount', { count: u })
      : this.i18n.t('appHeader.notifications');
  });

  private async refreshUnread(): Promise<void> {
    if (!this.auth.user()) { this.unread.set(0); return; }
    try {
      this.unread.set((await this.api.getUnreadCount()).count);
    } catch {
      /* offline / 401 — leave the last known count */
    }
  }

  async toggleNotif(): Promise<void> {
    const open = !this.notifOpen();
    this.notifOpen.set(open);
    if (open) {
      this.menuOpen.set(false);
      try {
        this.notifs.set(await this.api.getNotifications(20));
      } catch {
        /* noop */
      }
    }
  }

  /** Open a notification: mark it read locally + server-side, then deep-link. */
  async openNotif(n: AppNotification): Promise<void> {
    if (!n.read) {
      this.notifs.update((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      this.unread.update((c) => Math.max(0, c - 1));
      void this.api.markNotificationRead(n.id).catch(() => undefined);
    }
    this.notifOpen.set(false);
    if (n.url) void this.router.navigateByUrl(n.url);
  }

  async markAllRead(): Promise<void> {
    this.notifs.update((list) => list.map((x) => ({ ...x, read: true })));
    this.unread.set(0);
    try {
      await this.api.markAllNotificationsRead();
    } catch {
      /* noop */
    }
  }

  /** type → Tabler glyph for the row icon. */
  protected iconFor(type: string): string {
    switch (type) {
      case 'feedback': return 'message';
      case 'badge': return 'trophy';
      case 'reminder': return 'heart-handshake';
      case 'announcement': return 'bell';
      default: return 'bell';
    }
  }

  /** Compact relative time for a notification row. */
  protected relTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return this.i18n.t('appHeader.timeJustNow');
    if (m < 60) return this.i18n.t('appHeader.timeMinutes', { count: m });
    const h = Math.floor(m / 60);
    if (h < 24) return this.i18n.t('appHeader.timeHours', { count: h });
    const d = Math.floor(h / 24);
    return this.i18n.t('appHeader.timeDays', { count: d });
  }
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
    if (this.notifOpen()) this.notifOpen.set(false);
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
