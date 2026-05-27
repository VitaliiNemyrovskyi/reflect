import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  ApiService,
  DashboardResponse,
} from '../api.service';
import { AuthService } from '../auth.service';
import { I18nService } from '../i18n.service';
import { LogoComponent } from '../logo.component';

/**
 * Logged-in home page — the living world dashboard.
 *
 * Visual hierarchy:
 *   1. Compact top bar: greeting + date + city pill (city pulse
 *      expandable on click, NOT dominating the page)
 *   2. Continue / pending CTAs as slim banners (only if relevant)
 *   3. Diary feed — masonry grid of patient first-person cards. THIS
 *      is the centerpiece. Avatars + character names + tagged content.
 *   4. Stats strip — inline pills at the bottom, not big cards
 *   5. Patient grid — avatar-first mosaic
 *
 * Backed by a single /api/dashboard call. ngOnInit fires it; the
 * language toggle calls load() explicitly so we don't depend on an
 * effect (an earlier effect-based approach caused a load→loading→
 * load infinite loop because the effect read `loading()`).
 */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterLink, LogoComponent],
  template: `
    <header class="home-header">
      <div class="brand-row">
        <app-logo />
        @if (auth.user(); as u) {
          <div class="user-area">
            <a routerLink="/profile" class="user-name-link" [title]="i18n.t('nav.profile')">
              {{ u.displayName ?? u.email }}
            </a>
            <a routerLink="/network" class="ghost icon small" [title]="i18n.t('nav.network')">🕸</a>
            @if (u.isAdmin) {
              <a routerLink="/admin" class="ghost icon small admin-link" title="Admin">🛡</a>
            }
            <a routerLink="/settings" class="ghost icon small" [title]="i18n.t('nav.settings')">⚙</a>
            <button class="ghost small lang-toggle" (click)="toggleLang()">
              {{ i18n.isEn ? '🇺🇦 UK' : '🇬🇧 EN' }}
            </button>
            <button class="ghost small" (click)="logout()">{{ i18n.t('nav.logout') }}</button>
          </div>
        }
      </div>

      <div class="title-row">
        <div class="greeting">
          @if (auth.user(); as u) {
            <h1>
              {{ i18n.t('home.greeting') }}{{ greetingName() }}<span class="comma">,</span>
            </h1>
          }
          <p class="date dim">{{ today() }}</p>
        </div>

        <!-- City pill: one-line ambient pulse. Click expands to show the
             full week digest as a small popover-style panel. Default
             collapsed so the digest doesn't dominate the screen. -->
        @if (data()?.city; as city) {
          <button
            class="city-pill"
            [class.expanded]="cityExpanded()"
            (click)="cityExpanded.set(!cityExpanded())"
            [attr.aria-expanded]="cityExpanded()">
            <span class="city-icon">📍</span>
            <span class="city-name">{{ city.displayName }}</span>
            @if (city.weatherSummary) {
              <span class="city-weather dim">· {{ city.weatherSummary }}</span>
            }
            @if (city.weeklyDigest) {
              <span class="city-toggle">{{ cityExpanded() ? '–' : i18n.t('home.city_expand') }}</span>
            }
          </button>
          @if (cityExpanded() && city.weeklyDigest) {
            <p class="city-digest synapse-panel">{{ city.weeklyDigest }}</p>
          }
        }
      </div>
    </header>

    @if (loading() && !data()) {
      <p class="hint">{{ i18n.t('general.loading') }}</p>
    }

    @if (data(); as d) {

      <!-- Continue session: slim accent banner. -->
      @if (d.activeSessions.length > 0) {
        @for (s of d.activeSessions; track s.id) {
          <a [routerLink]="['/session', s.id]" class="continue-bar">
            <div class="continue-icon">▶</div>
            @if (s.character.avatarUrl) {
              <img [src]="s.character.avatarUrl" [alt]="s.character.displayName" class="avatar" />
            } @else {
              <div class="avatar-fallback">{{ initials(s.character.displayName) }}</div>
            }
            <div class="continue-body">
              <strong>{{ i18n.t('home.continue') }}</strong> ·
              <span>{{ s.character.displayName }}</span>
              <span class="dim"> · {{ s.messageCount }} {{ i18n.t('home.replies') }}, {{ relativeTime(s.startedAt) }}</span>
            </div>
            <span class="continue-arrow">→</span>
          </a>
        }
      }

      <!-- Pending feedback: even slimmer, secondary. -->
      @if (d.pendingFeedback.length > 0) {
        <div class="pending-strip">
          <span class="pending-icon">🆕</span>
          <span class="pending-label">{{ i18n.t('home.pending_feedback') }}:</span>
          @for (s of d.pendingFeedback; track s.id; let last = $last) {
            <a [routerLink]="['/session', s.id, 'feedback']" class="pending-link">
              {{ s.character.displayName }} #{{ s.id }}
            </a>
            @if (!last) {<span class="dim sep">·</span>}
          }
        </div>
      }

      <!-- DIARY FEED — the centerpiece. Simple text-first structure
           to guarantee content always renders: bold name + dot + dim
           date in a header line, then content as a plain paragraph,
           then tags as small chips. No nested flex / image branching
           to misbehave. -->
      @if (d.recentDiary.length > 0) {
        <section class="diary-section">
          <h2 class="section-head">
            <span class="head-icon">📖</span>
            {{ i18n.t('home.diary_title') }}
          </h2>
          <p class="diary-sub dim">{{ i18n.t('home.diary_sub') }}</p>
          <ul class="diary-grid">
            @for (entry of d.recentDiary; track entry.id) {
              <li class="diary-card">
                <div class="diary-meta">
                  <a [routerLink]="['/patient', entry.character.id]" class="diary-name">
                    {{ entry.character.displayName }}
                  </a>
                  <span class="diary-dot dim">·</span>
                  <span class="diary-date dim">{{ formatShortDate(entry.createdAt) }}</span>
                  @for (t of entry.tags; track $index) {
                    <span class="diary-tag">{{ t }}</span>
                  }
                </div>
                <p class="diary-content">{{ entry.content }}</p>
              </li>
            }
          </ul>
        </section>
      } @else {
        <p class="empty-hint dim">{{ i18n.t('home.diary_empty') }}</p>
      }

      <!-- Inline stats pills — one row, compact. -->
      <div class="stats-row">
        <div class="stat-pill">
          <span class="stat-num">{{ d.weekStats.sessions }}</span>
          <span class="stat-label dim">{{ i18n.t('home.week_sessions') }}</span>
        </div>
        <div class="stat-pill">
          <span class="stat-num">{{ d.weekStats.withFeedback }}</span>
          <span class="stat-label dim">{{ i18n.t('home.week_feedback') }}</span>
        </div>
        <div class="stat-pill">
          <span class="stat-num">
            @if (d.weekStats.avgAlliance !== null) {
              {{ d.weekStats.avgAlliance | number: '1.1-1' }}<span class="stat-of dim">/10</span>
            } @else {
              —
            }
          </span>
          <span class="stat-label dim">{{ i18n.t('home.week_alliance') }}</span>
        </div>
      </div>

      <!-- Patient grid — avatar-first mosaic. Click goes to detail. -->
      <section class="patient-section">
        <header class="patient-section-head">
          <h2 class="section-head no-icon">{{ i18n.t('home.patients') }}</h2>
          @if (d.hasMorePatients) {
            <a routerLink="/clients" class="see-all">{{ i18n.t('home.see_all') }} →</a>
          }
        </header>
        <div class="patient-grid">
          @for (p of d.patientGrid; track p.id) {
            <a [routerLink]="['/patient', p.id]" class="patient-card">
              @if (p.avatarUrl) {
                <img [src]="p.avatarUrl" [alt]="p.displayName" class="patient-avatar" />
              } @else {
                <div class="avatar-fallback patient">{{ initials(p.displayName) }}</div>
              }
              <div class="patient-name">{{ p.displayName }}</div>
              @if (p.lastSessionAt) {
                <div class="patient-last dim">{{ relativeTime(p.lastSessionAt) }}</div>
              }
            </a>
          }
          <a routerLink="/patient/new" class="patient-card new-card">
            <div class="new-icon">+</div>
            <div class="dim">{{ i18n.t('chars.new_patient') }}</div>
          </a>
        </div>
      </section>
    }
  `,
  styles: [`
    :host { display: block; }

    .home-header { margin-bottom: 24px; }

    .brand-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 22px;
      flex-wrap: wrap;
    }
    .user-area { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
    .user-name-link {
      color: var(--fg);
      text-decoration: none;
      font-size: 13px;
      padding: 4px 10px;
      border-radius: 6px;
      white-space: nowrap;
    }
    .user-name-link:hover { background: var(--user-bg); }

    /* Force the language + sign-out buttons to match the icon-button
       size (icons sit at ~28px square). Global .ghost button styling
       has a min-height for accessibility that makes them taller than
       the icons by default — overriding here to keep the header tight. */
    .user-area button.ghost,
    .user-area a.ghost {
      padding: 4px 10px;
      font-size: 12px;
      min-height: 0;
      line-height: 1.4;
      height: 28px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .user-area .ghost.icon {
      width: 28px;
      padding: 0;
      justify-content: center;
      font-size: 13px;
    }

    /* Title row: greeting on the left, city pill on the right. The
       greeting anchors the page in time + identity; the city pill is
       ambient context, click to expand. */
    .title-row {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 18px;
      flex-wrap: wrap;
    }
    .greeting h1 {
      margin: 0;
      font-size: 26px;
      font-weight: 400;
      letter-spacing: -0.015em;
      line-height: 1.2;
    }
    .greeting h1 .comma { color: var(--fg-dim); }
    .greeting .date {
      margin: 6px 0 0;
      font-size: 13px;
    }
    .dim { color: var(--fg-dim); }

    .city-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      background: color-mix(in srgb, var(--bg) 70%, transparent);
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 13px;
      color: var(--fg);
      cursor: pointer;
      transition: border-color .15s ease, background .15s ease;
      max-width: 100%;
    }
    .city-pill:hover {
      border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
      background: var(--bg);
    }
    .city-pill.expanded {
      border-color: var(--accent);
    }
    .city-icon { font-size: 13px; line-height: 1; }
    .city-name { font-weight: 500; }
    .city-weather { font-size: 12px; }
    .city-toggle {
      margin-left: 4px;
      font-size: 11px;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .city-digest {
      margin: 12px 0 0;
      padding: 14px 18px;
      font-size: 13px;
      line-height: 1.6;
      color: var(--fg);
      animation: slideDown .2s ease-out;
    }
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Continue bar — slim, accent. */
    .continue-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: color-mix(in srgb, var(--accent) 6%, var(--assistant-bg));
      border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border));
      border-radius: 10px;
      text-decoration: none;
      color: var(--fg);
      margin-bottom: 12px;
      font-size: 14px;
      transition: border-color .15s ease, transform .15s ease;
    }
    .continue-bar:hover {
      border-color: var(--accent);
      transform: translateX(2px);
    }
    .continue-icon {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--bg);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      flex-shrink: 0;
    }
    .avatar, .avatar-fallback {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
    }
    .avatar-fallback {
      background: color-mix(in srgb, var(--accent) 15%, var(--user-bg));
      color: var(--accent);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 500;
      font-size: 12px;
    }
    .continue-body { flex: 1; min-width: 0; }
    .continue-arrow { color: var(--accent); font-size: 16px; flex-shrink: 0; }

    /* Pending strip — inline, tight. */
    .pending-strip {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: var(--user-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    .pending-icon { font-size: 14px; }
    .pending-label { font-weight: 500; }
    .pending-link {
      color: var(--accent);
      text-decoration: none;
    }
    .pending-link:hover { text-decoration: underline; }
    .sep { font-size: 10px; }

    /* DIARY — the centerpiece. */
    .section-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 6px;
      font-size: 16px;
      font-weight: 500;
      letter-spacing: -0.005em;
    }
    .section-head.no-icon { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-dim); font-weight: 500; }
    .head-icon { font-size: 18px; }
    .diary-sub { font-size: 13px; margin: 0 0 16px; }
    .diary-section { margin-bottom: 32px; }
    .diary-grid {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 12px;
    }
    .diary-card {
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-left: 3px solid color-mix(in srgb, var(--accent) 55%, var(--border));
      border-radius: 10px;
      padding: 14px 16px;
      color: var(--fg);
      transition: border-color .15s ease, transform .15s ease, background .15s ease;
    }
    .diary-card:hover {
      border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
      border-left-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 3%, var(--assistant-bg));
      transform: translateY(-1px);
    }
    .diary-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 8px;
      font-size: 12px;
    }
    .diary-name {
      color: var(--fg);
      text-decoration: none;
      font-weight: 500;
      font-size: 14px;
    }
    .diary-name:hover { color: var(--accent); text-decoration: underline; }
    .diary-dot { font-size: 11px; }
    .diary-date { font-size: 11px; }
    .diary-tag {
      font-size: 10px;
      text-transform: lowercase;
      letter-spacing: 0.04em;
      background: color-mix(in srgb, var(--accent) 10%, var(--user-bg));
      color: var(--accent);
      padding: 1px 7px;
      border-radius: 999px;
      line-height: 1.5;
    }
    .diary-content {
      margin: 0;
      font-size: 14px;
      line-height: 1.55;
      color: var(--fg);
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .empty-hint {
      text-align: center;
      padding: 32px;
      font-size: 13px;
      margin-bottom: 32px;
    }

    /* Stats — inline pills, slim. */
    .stats-row {
      display: flex;
      gap: 10px;
      margin-bottom: 32px;
      flex-wrap: wrap;
    }
    .stat-pill {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 8px 16px;
      background: var(--user-bg);
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 12px;
    }
    .stat-num {
      font-size: 18px;
      font-weight: 500;
      color: var(--fg);
    }
    .stat-of { font-size: 12px; }
    .stat-label {
      font-size: 11px;
      text-transform: lowercase;
      letter-spacing: 0.02em;
    }

    /* Patient grid — avatar mosaic. */
    .patient-section-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 14px;
    }
    .see-all {
      color: var(--accent);
      text-decoration: none;
      font-size: 12px;
    }
    .see-all:hover { text-decoration: underline; }
    .patient-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      gap: 10px;
    }
    .patient-card {
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 10px;
      text-decoration: none;
      color: var(--fg);
      text-align: center;
      transition: transform .15s ease, border-color .15s ease;
    }
    .patient-card:hover {
      transform: translateY(-2px);
      border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
    }
    .patient-avatar {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      object-fit: cover;
      display: block;
      margin: 0 auto 8px;
      background: var(--user-bg);
    }
    .avatar-fallback.patient {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 8px;
      font-size: 15px;
      background: color-mix(in srgb, var(--accent) 15%, var(--user-bg));
      color: var(--accent);
      font-weight: 500;
    }
    .patient-name {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: var(--fg);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .patient-last {
      display: block;
      font-size: 10px;
      margin-top: 4px;
    }
    .new-card {
      border-style: dashed;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .new-icon {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--accent) 12%, var(--user-bg));
      color: var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      line-height: 1;
      margin-bottom: 8px;
    }

    .hint { color: var(--fg-dim); font-size: 13px; margin-top: 16px; }

    @media (max-width: 720px) {
      .brand-row { gap: 8px; }
      .user-area { gap: 4px; }
      .greeting h1 { font-size: 22px; }
      .title-row { flex-direction: column; align-items: flex-start; }
      .diary-grid { grid-template-columns: 1fr; }
      .patient-grid { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); }
      .stats-row { gap: 6px; }
      .stat-pill { padding: 6px 12px; }
      .stat-num { font-size: 16px; }
    }
  `],
})
export class HomeComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  protected auth = inject(AuthService);
  protected i18n = inject(I18nService);

  data = signal<DashboardResponse | null>(null);
  loading = signal(true);
  cityExpanded = signal(false);

  async ngOnInit() {
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.data.set(await this.api.dashboard());
    } catch {
      // Render gracefully — sections all guard on data() being present
    } finally {
      this.loading.set(false);
    }
  }

  toggleLang(): void {
    this.i18n.setLang(this.i18n.isEn ? 'uk' : 'en');
    void this.load();
  }

  async logout(): Promise<void> {
    try { await this.auth.logout(); } catch { /* noop */ }
    void this.router.navigate(['/login']);
  }

  /** "Доброго дня, Vitalii" — strip the surname for warmth. */
  greetingName(): string {
    const u = this.auth.user();
    if (!u) return '';
    const full = u.displayName ?? u.email;
    // Take just the first token — surname-less greeting feels more
    // personal, like a friend addressing you.
    const first = full.split(/[\s,@]/)[0];
    return ` ${first}`;
  }

  today(): string {
    return new Date().toLocaleDateString(this.i18n.isEn ? 'en-GB' : 'uk-UA', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  }

  /**
   * Localized short date — "27 трав." / "27 May". Uses native
   * Intl.DateTimeFormat so we don't depend on Angular's
   * registerLocaleData (which would be required for the date pipe
   * with locale 'uk' — without it the pipe silently broke the
   * surrounding template bindings, blanking every diary card after
   * the first one).
   */
  formatShortDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(
        this.i18n.isEn ? 'en-GB' : 'uk-UA',
        { day: 'numeric', month: 'short' },
      );
    } catch {
      return iso.slice(0, 10);
    }
  }

  initials(name: string): string {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((s) => s[0] ?? '')
      .join('')
      .toUpperCase();
  }

  relativeTime(iso: string): string {
    const date = new Date(iso);
    const diffMs = Date.now() - date.getTime();
    const min = Math.floor(diffMs / 60_000);
    const hr = Math.floor(min / 60);
    const day = Math.floor(hr / 24);
    if (this.i18n.isEn) {
      if (min < 1) return 'just now';
      if (min < 60) return `${min} min ago`;
      if (hr < 24) return `${hr} h ago`;
      if (day === 1) return 'yesterday';
      if (day < 7) return `${day} days ago`;
      return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    }
    if (min < 1) return 'щойно';
    if (min < 60) return `${min} хв тому`;
    if (hr < 24) return `${hr} год тому`;
    if (day === 1) return 'вчора';
    if (day < 7) return `${day} ${day < 5 ? 'дні' : 'днів'} тому`;
    return date.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
  }
}
