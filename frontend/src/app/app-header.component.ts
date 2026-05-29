import { CommonModule } from '@angular/common';
import { Component, Input, inject } from '@angular/core';
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
        </div>
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

    @media (max-width: 720px) {
      .title-row { flex-wrap: wrap; gap: 12px; }
      .user-area { gap: 8px; flex-wrap: wrap; }
      .user-name-link { max-width: 120px; font-size: 12px; }
    }
  `],
})
export class AppHeaderComponent {
  /** Optional page-specific subtitle rendered below the logo. */
  @Input() subtitle = '';

  protected auth = inject(AuthService);
  protected i18n = inject(I18nService);
  private router = inject(Router);

  async logout(): Promise<void> {
    try { await this.auth.logout(); } catch { /* noop */ }
    void this.router.navigate(['/login']);
  }
}
