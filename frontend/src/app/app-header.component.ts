import { CommonModule } from '@angular/common';
import { Component, Input, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from './auth.service';
import { I18nService } from './i18n.service';
import { LogoComponent } from './logo.component';
import { IconComponent } from './icon.component';

/**
 * Shared application header. Extracted verbatim from the /clients
 * page (characters-list.component) so every authenticated route gets
 * the exact same chrome: logo + optional page subtitle on the left,
 * user-area on the right: name → /profile, then the <app-icon> nav
 * (progress, network, admin for admins only, settings), the 3-flag
 * segmented lang picker, and the logout button.
 *
 * Mounted once in app.component above the router-outlet. Renders only
 * when a user is logged in — public routes (login, register, safety,
 * pricing) see no chrome.
 *
 * Pages pass an optional `subtitle` input to populate the line under
 * the logo (e.g. "Вибери клієнта для тренування" on /clients). When
 * empty the brand block collapses to just the logo.
 */
@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, RouterLink, LogoComponent, IconComponent],
  template: `
    @if (auth.user(); as u) {
      <header class="header">
        <div class="title-row">
          <div class="brand-block">
            <a routerLink="/" class="brand-link" [title]="i18n.t('home.patients')">
              <app-logo />
            </a>
            @if (subtitle) {
              <p class="subtitle">{{ subtitle }}</p>
            }
          </div>
          <div class="user-area">
            <a routerLink="/profile" class="user-name-link" [title]="i18n.t('nav.profile')">
              {{ u.displayName ?? u.email }}
            </a>
            <a routerLink="/progress"
               class="ghost icon small"
               [title]="i18n.isEn ? 'Progress' : 'Прогрес'"
               [attr.aria-label]="i18n.isEn ? 'Progress' : 'Прогрес'"><app-icon name="chart-up" /></a>
            <a routerLink="/network"
               class="ghost icon small"
               [title]="i18n.t('nav.network')"
               [attr.aria-label]="i18n.t('nav.network')"><app-icon name="network" /></a>
            @if (u.isAdmin) {
              <a routerLink="/admin"
                 class="ghost icon small admin-link"
                 title="Admin panel"
                 aria-label="Admin panel"><app-icon name="shield-check" /></a>
            }
            <a routerLink="/settings"
               class="ghost icon small"
               [title]="i18n.t('nav.settings')"
               [attr.aria-label]="i18n.t('nav.settings')"><app-icon name="settings" /></a>
            <button class="ghost small" (click)="logout()">{{ i18n.t('nav.logout') }}</button>
          </div>

          <!-- Mobile: the whole user-area collapses into this hamburger. -->
          <button type="button"
                  class="hamburger"
                  (click)="menuOpen.set(!menuOpen())"
                  [attr.aria-expanded]="menuOpen()"
                  [attr.aria-label]="i18n.isEn ? 'Menu' : 'Меню'"><app-icon name="menu" /></button>
        </div>

        @if (menuOpen()) {
          <div class="menu-backdrop" (click)="menuOpen.set(false)"></div>
          <nav class="mobile-menu fx-fade-up" role="menu">
            <a routerLink="/profile" class="mm-item mm-name" (click)="menuOpen.set(false)">
              <app-icon name="user" /><span>{{ u.displayName ?? u.email }}</span>
            </a>
            <div class="mm-sep"></div>
            <a routerLink="/progress" class="mm-item" (click)="menuOpen.set(false)">
              <app-icon name="chart-up" /><span>{{ i18n.isEn ? 'Progress' : 'Прогрес' }}</span>
            </a>
            <a routerLink="/network" class="mm-item" (click)="menuOpen.set(false)">
              <app-icon name="network" /><span>{{ i18n.t('nav.network') }}</span>
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
  /* All styles copied verbatim from characters-list.component — single
     source of truth for the chrome across pages. */
  styles: [`
    .header { margin-bottom: 24px; position: relative; z-index: 1; }
    .brand-block { display: flex; flex-direction: column; gap: 6px; }
    .brand-link {
      display: inline-flex;
      align-items: center;
      text-decoration: none;
      color: inherit;
    }
    .subtitle { color: var(--fg-dim); margin: 0; font-size: 14px; }
    .title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 16px;
    }
    .user-area {
      display: flex;
      gap: 12px;
      align-items: center;
      font-size: 13px;
      color: var(--fg-dim);
    }
    .user-name-link {
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--fg-dim);
      text-decoration: none;
      transition: color .15s ease;
      cursor: pointer;
    }
    .user-name-link:hover { color: var(--accent); }
    button.small, .small {
      padding: 6px 12px;
      font-size: 13px;
      min-height: auto;
    }
    a.ghost.icon.small {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      width: 30px;
      padding: 0;
      font-size: 16px;
      color: var(--fg-dim);
      border: 1px solid var(--border);
      border-radius: 6px;
      height: 30px;
      transition: color .15s ease, border-color .15s ease;
    }
    a.ghost.icon.small:hover {
      color: var(--accent);
      border-color: var(--accent);
    }
    .admin-link { color: var(--accent); }

    /* Hamburger — hidden on desktop, shown on phones in place of the row. */
    .hamburger {
      display: none;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: color-mix(in srgb, var(--accent) 3%, transparent);
      color: var(--fg-dim);
      font-size: 19px;
      cursor: pointer;
      transition: color .15s ease, border-color .15s ease;
    }
    .hamburger:hover { color: var(--accent); border-color: var(--accent); }

    /* Dropdown menu — anchored under the header (which is position:relative). */
    .menu-backdrop { position: fixed; inset: 0; z-index: 40; }
    .mobile-menu {
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 2px;
      z-index: 50;
      min-width: 220px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px;
      background: var(--assistant-bg);
      border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
      border-radius: 12px;
      box-shadow: 0 14px 36px -10px rgba(0, 0, 0, 0.6);
    }
    .mm-item {
      display: flex;
      align-items: center;
      gap: 11px;
      width: 100%;
      padding: 11px 12px;
      border: none;
      border-radius: 8px;
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
    .mm-name { font-weight: 500; }
    .mm-logout { color: var(--fg-dim); }
    .mm-sep { height: 1px; margin: 4px 6px; background: var(--border); }

    @media (max-width: 720px) {
      .title-row { flex-wrap: wrap; gap: 12px; }
      .user-area { gap: 8px; flex-wrap: wrap; }
      .user-name-link { max-width: 120px; font-size: 12px; }
    }
    /* Phones: swap the inline row for the hamburger. */
    @media (max-width: 640px) {
      .user-area { display: none; }
      .hamburger { display: inline-flex; }
    }
    /* Safety: if the viewport widens while the menu is open, don't leave it. */
    @media (min-width: 641px) {
      .mobile-menu, .menu-backdrop { display: none; }
    }
  `],
})
export class AppHeaderComponent {
  /** Optional page-specific subtitle rendered below the logo. */
  @Input() subtitle = '';

  protected auth = inject(AuthService);
  protected i18n = inject(I18nService);
  private router = inject(Router);

  /** Mobile hamburger menu open state. */
  protected menuOpen = signal(false);

  async logout(): Promise<void> {
    try { await this.auth.logout(); } catch { /* noop */ }
    void this.router.navigate(['/login']);
  }

  closeAndLogout(): void {
    this.menuOpen.set(false);
    void this.logout();
  }
}
