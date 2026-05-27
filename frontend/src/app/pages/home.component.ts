import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  ApiService,
  DashboardActiveSession,
  DashboardDiaryEntry,
  DashboardPatient,
  DashboardPendingFeedback,
  DashboardResponse,
} from '../api.service';
import { AuthService } from '../auth.service';
import { I18nService } from '../i18n.service';
import { LogoComponent } from '../logo.component';

/**
 * Logged-in home page — the "living world dashboard". Replaces the
 * old direct-to-characters-grid landing with a richer surface that
 * leverages every back-end phase we built:
 *
 *   1. City pulse banner (Phase 1)
 *   2. Continue / pending CTAs (active sessions + feedback retry)
 *   3. Diary feed (Phase 4) — the unique value prop, takes center stage
 *   4. Week stats (Phase 2 alliance pulled from feedbackJson)
 *   5. Compact patient grid (full filtered grid still lives at /clients)
 *
 * One API call (api.dashboard) backs the entire page so the cold
 * landing is snappy. Each section gracefully hides when its data
 * source is empty (no active sessions → no continue card; no diary
 * → fall through to grid).
 */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, DatePipe, RouterLink, LogoComponent],
  template: `
    <header class="home-header">
      <div class="brand-row">
        <app-logo />
        @if (auth.user(); as u) {
          <div class="user-area">
            <a routerLink="/profile" class="user-name-link" [title]="i18n.t('nav.profile')">
              {{ u.displayName ?? u.email }}
            </a>
            <a routerLink="/network"
               class="ghost icon small"
               [title]="i18n.t('nav.network')">🕸</a>
            @if (u.isAdmin) {
              <a routerLink="/admin"
                 class="ghost icon small admin-link"
                 title="Admin">🛡</a>
            }
            <a routerLink="/settings" class="ghost icon small" [title]="i18n.t('nav.settings')">⚙</a>
            <button class="ghost small lang-toggle" (click)="toggleLang()">
              {{ i18n.isEn ? '🇺🇦 UK' : '🇬🇧 EN' }}
            </button>
            <button class="ghost small" (click)="logout()">{{ i18n.t('nav.logout') }}</button>
          </div>
        }
      </div>

      <!-- City pulse — slim banner at the top so it's ambient context,
           not a content card competing with the diary feed below. -->
      @if (data()?.city; as city) {
        <section class="city-pulse synapse-panel">
          <span class="city-icon">📍</span>
          <div class="city-text">
            <strong>{{ city.displayName }}</strong>
            @if (city.weatherSummary) {
              <span class="dim"> · {{ city.weatherSummary }}</span>
            }
            @if (city.weeklyDigest) {
              <p class="city-digest">{{ city.weeklyDigest }}</p>
            }
          </div>
        </section>
      }
    </header>

    @if (loading()) {
      <p class="hint">{{ i18n.t('general.loading') }}</p>
    }
    @if (!loading() && data(); as d) {

      <!-- Continue active session — hero CTA at the very top when
           there's unfinished work. Skipped entirely otherwise. -->
      @if (d.activeSessions.length > 0) {
        <section class="continue-section">
          <h2 class="section-head">{{ i18n.t('home.continue') }}</h2>
          @for (s of d.activeSessions; track s.id) {
            <a [routerLink]="['/session', s.id]" class="continue-card synapse-panel">
              @if (s.character.avatarUrl) {
                <img [src]="s.character.avatarUrl" [alt]="s.character.displayName" class="avatar" />
              } @else {
                <div class="avatar-fallback">{{ initials(s.character.displayName) }}</div>
              }
              <div class="continue-body">
                <div class="continue-name">{{ s.character.displayName }}</div>
                <div class="continue-meta dim">
                  {{ s.messageCount }} {{ i18n.t('home.replies') }} · {{ relativeTime(s.startedAt) }}
                </div>
              </div>
              <span class="continue-arrow">→</span>
            </a>
          }
        </section>
      }

      <!-- Pending feedback — ended sessions without feedback. Compact
           inline cards so they're visible but don't dominate. -->
      @if (d.pendingFeedback.length > 0) {
        <section class="pending-section">
          <h2 class="section-head">{{ i18n.t('home.pending_feedback') }}</h2>
          <ul class="pending-list">
            @for (s of d.pendingFeedback; track s.id) {
              <li>
                <a [routerLink]="['/session', s.id, 'feedback']" class="pending-row">
                  <span>{{ s.character.displayName }} · {{ i18n.t('home.session') }} #{{ s.id }}</span>
                  <span class="pending-action">{{ i18n.t('home.get_feedback') }} →</span>
                </a>
              </li>
            }
          </ul>
        </section>
      }

      <!-- Diary feed — Phase 4 centerpiece. Each card is a first-person
           snippet, tagged. Click on character name → patient detail. -->
      @if (d.recentDiary.length > 0) {
        <section class="diary-section">
          <header class="diary-head">
            <h2 class="section-head">{{ i18n.t('home.diary_title') }}</h2>
            <p class="diary-sub dim">{{ i18n.t('home.diary_sub') }}</p>
          </header>
          <ul class="diary-list">
            @for (entry of d.recentDiary; track entry.id) {
              <li class="diary-card synapse-panel">
                <header class="diary-card-head">
                  @if (entry.character.avatarUrl) {
                    <img [src]="entry.character.avatarUrl" [alt]="entry.character.displayName" class="avatar small" />
                  } @else {
                    <div class="avatar-fallback small">{{ initials(entry.character.displayName) }}</div>
                  }
                  <a [routerLink]="['/patient', entry.character.id]" class="diary-character">
                    {{ entry.character.displayName }}
                  </a>
                  <span class="diary-date dim">{{ entry.createdAt | date: 'd MMMM' : '' : (i18n.isEn ? 'en' : 'uk') }}</span>
                </header>
                <p class="diary-content">{{ entry.content }}</p>
                @if (entry.tags.length > 0) {
                  <footer class="diary-tags">
                    @for (t of entry.tags; track t) {
                      <span class="diary-tag">{{ t }}</span>
                    }
                  </footer>
                }
              </li>
            }
          </ul>
        </section>
      }

      <!-- Week stats — small KPI strip below diary. -->
      <section class="week-stats">
        <div class="stat-card">
          <div class="stat-num">{{ d.weekStats.sessions }}</div>
          <div class="stat-label">{{ i18n.t('home.week_sessions') }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ d.weekStats.withFeedback }}</div>
          <div class="stat-label">{{ i18n.t('home.week_feedback') }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">
            @if (d.weekStats.avgAlliance !== null) {
              {{ d.weekStats.avgAlliance | number: '1.1-1' }}
              <span class="stat-suffix">/10</span>
            } @else {
              —
            }
          </div>
          <div class="stat-label">{{ i18n.t('home.week_alliance') }}</div>
        </div>
      </section>

      <!-- Patient grid — compact rolodex. Full filtered view at /clients. -->
      <section class="patient-section">
        <header class="patient-section-head">
          <h2 class="section-head">{{ i18n.t('home.patients') }}</h2>
          @if (d.hasMorePatients) {
            <a routerLink="/clients" class="see-all">{{ i18n.t('home.see_all') }} →</a>
          }
        </header>
        <div class="patient-grid">
          @for (p of d.patientGrid; track p.id) {
            <a [routerLink]="['/patient', p.id]" class="patient-card synapse-panel">
              @if (p.avatarUrl) {
                <img [src]="p.avatarUrl" [alt]="p.displayName" class="patient-avatar" />
              } @else {
                <div class="avatar-fallback patient">{{ initials(p.displayName) }}</div>
              }
              <div class="patient-name">{{ p.displayName }}</div>
              @if (p.diagnosis) {
                <div class="patient-dx dim">{{ p.diagnosis }}</div>
              }
              @if (p.lastSessionAt) {
                <div class="patient-last dim">{{ relativeTime(p.lastSessionAt) }}</div>
              } @else {
                <div class="patient-last dim">{{ i18n.t('session.no_sessions') }}</div>
              }
            </a>
          }
          <a routerLink="/patient/new" class="patient-card new-card">
            <div class="new-icon">+</div>
            <div>{{ i18n.t('chars.new_patient') }}</div>
          </a>
        </div>
      </section>
    }
  `,
  styles: [`
    :host { display: block; }

    .home-header { margin-bottom: 28px; }
    .brand-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin-bottom: 18px;
      flex-wrap: wrap;
    }
    .user-area { display: flex; gap: 6px; align-items: center; }
    .user-name-link {
      color: var(--fg);
      text-decoration: none;
      font-size: 14px;
      padding: 4px 10px;
      border-radius: 6px;
    }
    .user-name-link:hover { background: var(--user-bg); }
    .lang-toggle, .admin-link { white-space: nowrap; }

    .city-pulse {
      display: flex;
      gap: 14px;
      align-items: flex-start;
      padding: 14px 18px;
    }
    .city-icon { font-size: 20px; line-height: 1; margin-top: 1px; }
    .city-text { flex: 1; min-width: 0; }
    .city-text strong { font-size: 14px; }
    .dim { color: var(--fg-dim); }
    .city-digest {
      margin: 6px 0 0;
      font-size: 13px;
      line-height: 1.55;
      color: var(--fg);
    }

    .section-head {
      margin: 0 0 14px;
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--fg-dim);
    }

    /* Continue section — hero card, accent border */
    .continue-section { margin-bottom: 28px; }
    .continue-card {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 18px;
      text-decoration: none;
      color: var(--fg);
      border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
      transition: border-color .15s ease, transform .15s ease;
    }
    .continue-card:hover {
      border-color: var(--accent);
      transform: translateX(2px);
    }
    .continue-card + .continue-card { margin-top: 8px; }
    .avatar, .patient-avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--user-bg);
      flex-shrink: 0;
    }
    .avatar.small, .avatar-fallback.small { width: 28px; height: 28px; font-size: 11px; }
    .patient-avatar { width: 56px; height: 56px; margin-bottom: 8px; }
    .avatar-fallback {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--accent) 15%, var(--user-bg));
      color: var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 500;
      font-size: 14px;
      flex-shrink: 0;
    }
    .avatar-fallback.patient { width: 56px; height: 56px; font-size: 16px; }
    .continue-body { flex: 1; min-width: 0; }
    .continue-name { font-size: 15px; font-weight: 500; margin-bottom: 2px; }
    .continue-meta { font-size: 12px; }
    .continue-arrow {
      color: var(--accent);
      font-size: 18px;
      transition: transform .15s ease;
    }
    .continue-card:hover .continue-arrow { transform: translateX(3px); }

    /* Pending feedback list */
    .pending-section { margin-bottom: 28px; }
    .pending-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
    .pending-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-left: 3px solid color-mix(in srgb, var(--accent) 50%, transparent);
      border-radius: 8px;
      text-decoration: none;
      color: var(--fg);
      font-size: 13px;
    }
    .pending-row:hover {
      background: color-mix(in srgb, var(--accent) 4%, var(--bg));
      border-left-color: var(--accent);
    }
    .pending-action { color: var(--accent); font-size: 12px; }

    /* Diary feed — the centerpiece */
    .diary-section { margin-bottom: 28px; }
    .diary-head { margin-bottom: 14px; }
    .diary-head .section-head { margin-bottom: 4px; }
    .diary-sub { font-size: 12px; margin: 0; }
    .diary-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 12px;
    }
    .diary-card {
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .diary-card-head {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }
    .diary-character {
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
      font-size: 13px;
    }
    .diary-character:hover { text-decoration: underline; }
    .diary-date { font-size: 11px; margin-left: auto; }
    .diary-content {
      margin: 0;
      font-size: 13px;
      line-height: 1.55;
      color: var(--fg);
    }
    .diary-tags { display: flex; gap: 4px; flex-wrap: wrap; }
    .diary-tag {
      font-size: 10px;
      text-transform: lowercase;
      letter-spacing: 0.04em;
      color: var(--fg-dim);
      background: var(--user-bg);
      padding: 2px 8px;
      border-radius: 999px;
    }

    /* Week stats — three KPI cards */
    .week-stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-bottom: 28px;
    }
    .stat-card {
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
      text-align: center;
    }
    .stat-num {
      font-size: 24px;
      font-weight: 500;
      color: var(--fg);
      line-height: 1;
    }
    .stat-suffix { color: var(--fg-dim); font-size: 14px; font-weight: 400; }
    .stat-label {
      font-size: 11px;
      color: var(--fg-dim);
      margin-top: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    /* Patient grid — compact below diary */
    .patient-section-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 14px;
    }
    .patient-section-head .section-head { margin: 0; }
    .see-all {
      color: var(--accent);
      text-decoration: none;
      font-size: 12px;
    }
    .see-all:hover { text-decoration: underline; }
    .patient-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 10px;
    }
    .patient-card {
      padding: 14px;
      text-decoration: none;
      color: var(--fg);
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      transition: transform .15s ease, border-color .15s ease;
    }
    .patient-card:hover {
      transform: translateY(-2px);
      border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
    }
    .patient-name { font-size: 13px; font-weight: 500; margin-bottom: 4px; }
    .patient-dx, .patient-last { font-size: 11px; }
    .patient-dx {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
    .new-card {
      border-style: dashed;
      justify-content: center;
      min-height: 100%;
    }
    .new-icon {
      font-size: 28px;
      color: var(--accent);
      line-height: 1;
      margin-bottom: 6px;
    }

    .hint { color: var(--fg-dim); font-size: 13px; }

    @media (max-width: 720px) {
      .brand-row { gap: 8px; }
      .user-area { flex-wrap: wrap; justify-content: flex-end; }
      .week-stats { grid-template-columns: repeat(3, 1fr); gap: 6px; }
      .stat-card { padding: 10px 8px; }
      .stat-num { font-size: 20px; }
      .stat-label { font-size: 10px; }
      .diary-list { grid-template-columns: 1fr; }
      .patient-grid { grid-template-columns: repeat(2, 1fr); }
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
    // Diary + city digest are locale-scoped — re-fetch with the new
    // Accept-Language so the dashboard matches the UI language.
    // Manual trigger (not via effect) avoids the loading <-> data
    // re-render loop the earlier effect-based approach caused.
    void this.load();
  }

  async logout(): Promise<void> {
    try { await this.auth.logout(); } catch { /* noop */ }
    void this.router.navigate(['/login']);
  }

  /** Initials fallback for missing avatars. Mostly for non-DiceBear
   *  characters (older system rows that haven't been back-filled). */
  initials(name: string): string {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((s) => s[0] ?? '')
      .join('')
      .toUpperCase();
  }

  /** Human-friendly relative time — "23 хв тому", "вчора", "3 дні тому".
   *  Kept simple instead of pulling a full i18n date library; we cover
   *  what the home page actually needs. */
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
