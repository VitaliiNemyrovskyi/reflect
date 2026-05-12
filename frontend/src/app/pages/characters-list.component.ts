import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiService, Character, ProgressBadge } from '../api.service';
import { AuthService } from '../auth.service';
import { LogoComponent } from '../logo.component';

@Component({
  selector: 'app-characters-list',
  standalone: true,
  imports: [CommonModule, DatePipe, RouterLink, LogoComponent],
  template: `
    <!-- Cinematic hero background. Empty by default — drops in once a
         file lands at /hero-bg.webp (or .jpg/.png). The image is fixed,
         dimmed, and fades to transparent at the edges so it lights the
         page without competing with the patient cards.
         On phones the layer is hidden entirely (perf + readability). -->
    <div class="hero-bg" aria-hidden="true"></div>

    <header class="header">
      <div class="title-row">
        <div class="brand-block">
          <app-logo />
          <p class="subtitle">Картотека пацієнтів</p>
        </div>
        @if (auth.user(); as u) {
          <div class="user-area">
            <a routerLink="/profile" class="user-name-link" title="Мій профіль">
              {{ u.displayName ?? u.email }}
            </a>
            @if (u.isAdmin) {
              <a routerLink="/admin"
                 class="ghost icon small admin-link"
                 title="Admin panel"
                 aria-label="Admin panel">🛡</a>
            }
            <a routerLink="/settings"
               class="ghost icon small"
               title="Налаштування"
               aria-label="Налаштування">⚙</a>
            <button class="ghost small" (click)="logout()">Вийти</button>
          </div>
        }
      </div>
      @if (characters().length > 0) {
        <div class="filters">
          <button
            class="chip"
            [class.active]="difficultyFilter() === null"
            (click)="difficultyFilter.set(null)">
            Усі ({{ characters().length }})
          </button>
          @for (d of [1, 2, 3, 4, 5]; track d) {
            @if (countByDifficulty(d) > 0) {
              <button
                class="chip"
                [class.active]="difficultyFilter() === d"
                (click)="setDifficulty(d)">
                {{ stars(d) }} ({{ countByDifficulty(d) }})
              </button>
            }
          }
          <a routerLink="/patient/new" class="chip new-patient-chip">
            + Створити пацієнтку
          </a>
        </div>
      }
    </header>

    <!-- Quick stats strip — only renders when there's at least one
         logged session anywhere. Three readouts side-by-side: total
         sessions (sense of practice volume), active cases (how many
         patients you've actually worked with), last session date
         (have you slipped into a gap?). Computed on the frontend from
         the same character data we already have — no extra API call. -->
    @if (stats(); as st) {
      <section class="stats-strip fx-fade-up">
        <div class="stat-cell">
          <span class="stat-label">Сесій усього</span>
          <span class="stat-value">{{ st.totalSessions }}</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">Активних кейсів</span>
          <span class="stat-value">{{ st.activeCases }}<small> / {{ characters().length }}</small></span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">Остання сесія</span>
          <span class="stat-value">{{ st.lastSessionAgo }}</span>
        </div>
      </section>
    }

    @if (loading()) {
      <div class="hint">Завантаження…</div>
    } @else if (error()) {
      <div class="hint danger">{{ error() }}</div>
    } @else if (characters().length === 0) {
      <!-- Zero patients ever — show the "create your first" empty state.
           The friendly copy + big primary CTA replaces the old technical
           "edit prompts/profiles/" hint, which only made sense to devs. -->
      <section class="empty-state synapse-panel">
        <div class="empty-illustration" aria-hidden="true">⊙</div>
        <h2>Поки що порожньо</h2>
        <p>
          Створи першого пацієнта — заповни короткий бриф, і AI допоможе
          згенерувати повноцінний клінічний профіль. Далі — перша тренувальна
          сесія в кілька кліків.
        </p>
        <a routerLink="/patient/new" class="primary">
          + Створити пацієнтку
        </a>
      </section>
    } @else if (filteredCharacters().length === 0) {
      <!-- Has patients but the active filter excluded all of them. Offer
           a one-click way to drop the filter rather than leaving the
           user to figure out where the chips reset. -->
      <section class="empty-state synapse-panel filtered">
        <h2>Під цей фільтр ніхто не підпадає</h2>
        <p>
          За поточним фільтром «{{ stars(difficultyFilter()!) }}» ({{ difficultyFilter() }}/5)
          у тебе немає жодного пацієнта.
        </p>
        <button class="primary" type="button" (click)="difficultyFilter.set(null)">
          Скинути фільтр
        </button>
      </section>
    } @else {
      <ul class="patient-grid fx-stagger">
        @for (c of filteredCharacters(); track c.id) {
          <li class="patient-card" (click)="open(c)">
            <div class="avatar-wrap">
              @if (c.avatarUrl) {
                <img class="avatar" [src]="c.avatarUrl" [alt]="c.displayName" />
              } @else {
                <div class="avatar fallback">{{ c.displayName.charAt(0) }}</div>
              }
              @if (c.progressBadge && c.progressBadge !== 'unknown') {
                <span class="progress-dot" [class]="'progress-' + c.progressBadge"
                      [title]="badgeText(c.progressBadge)"></span>
              }
            </div>

            <div class="card-body">
              <h3 class="name">{{ c.displayName }}</h3>
              @if (c.diagnosis) {
                <p class="diagnosis"
                   [title]="diagnosisTooltip(c)">
                  {{ c.diagnosis }}
                </p>
              }
              <div class="metrics">
                @if (c.difficulty != null) {
                  <div class="metric"
                       [title]="'Поведінка ' + c.difficulty + '/5 — наскільки складно встановити контакт з пацієнткою'">
                    <span class="metric-label">Поведінка</span>
                    <span class="stars stars-behavior">{{ stars(c.difficulty) }}</span>
                  </div>
                }
                @if (c.complexity != null) {
                  <div class="metric"
                       [title]="'Тяжкість ' + c.complexity + '/5 — клінічна серйозність випадку'">
                    <span class="metric-label">Тяжкість</span>
                    <span class="dots dots-clinical">{{ dots(c.complexity) }}</span>
                  </div>
                }
              </div>
              <div class="card-stats">
                @if (c.sessionCount && c.sessionCount > 0) {
                  <span class="meta-stat">
                    {{ c.sessionCount }} {{ sessionsWord(c.sessionCount) }}
                  </span>
                  @if (c.lastSessionAt) {
                    <span class="dot">·</span>
                    <span class="meta-stat dim">
                      {{ c.lastSessionAt | date: 'dd.MM' }}
                    </span>
                  }
                } @else {
                  <span class="meta-stat dim">сесій ще не було</span>
                }
              </div>
            </div>
          </li>
        }
      </ul>
    }
  `,
  styles: [`
    /* Hero-bg layer — drop a file at /hero-bg.webp (or .jpg/.png) in
       frontend/public/ and the layer lights up automatically. No
       file = silent no-op (background-image just resolves to nothing).
       Positioning: fixed full-viewport, z-index:0 — sits ABOVE the
       body's gradient wash + dot grid but BELOW the floating blobs
       (z:0, later in source order) and the main content (z:1+).
       Mobile: hidden — too much GPU work on small phones plus the
       composition (wide cinematic) breaks at narrow widths. */
    .hero-bg {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 0;
      background-image: url('/hero-bg.webp');
      background-position: center;
      background-size: cover;
      background-repeat: no-repeat;
      opacity: 0.32;
      /* Fade edges + top/bottom so the image lights the centre without
         creating a hard rectangle against the body wash. */
      -webkit-mask-image: radial-gradient(ellipse 90% 70% at 50% 45%, #000 0%, #000 50%, transparent 100%);
              mask-image: radial-gradient(ellipse 90% 70% at 50% 45%, #000 0%, #000 50%, transparent 100%);
      /* Tone the image toward the accent so it doesn't clash with
         whichever theme is active (lavender / blue / Synapse orange). */
      filter: saturate(85%) contrast(105%);
    }
    @media (max-width: 720px) {
      .hero-bg { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      /* No motion reduction needed — the image itself is static. */
    }

    .header { margin-bottom: 24px; position: relative; z-index: 1; }
    .brand-block { display: flex; flex-direction: column; gap: 6px; }
    .subtitle { color: var(--fg-dim); margin: 0; font-size: 14px; }

    /* Aggregate stats strip — quiet, monospaced numeric readouts.
       Three equal-width cells with an accent-tinted divider between.
       Sits above the patient grid as a "sense of progress" anchor. */
    .stats-strip {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0;
      margin-bottom: 22px;
      padding: 14px 22px;
      background: color-mix(in srgb, var(--accent) 4%, var(--assistant-bg));
      border: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border));
      border-radius: 12px;
    }
    .stat-cell {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 0 12px;
      border-left: 1px solid color-mix(in srgb, var(--accent) 12%, var(--border));
    }
    .stat-cell:first-child { border-left: none; padding-left: 0; }
    .stat-label {
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--fg-dim);
      font-weight: 500;
    }
    .stat-value {
      font-size: 22px;
      font-weight: 300;
      letter-spacing: -0.01em;
      color: var(--fg);
      font-variant-numeric: tabular-nums;
      line-height: 1.1;
    }
    .stat-value small {
      font-size: 13px;
      color: var(--fg-dim);
      margin-left: 1px;
    }
    @media (max-width: 540px) {
      .stats-strip { padding: 12px 16px; }
      .stat-cell { padding: 0 8px; }
      .stat-value { font-size: 18px; }
    }

    /* Empty-state panel — full-width Synapse card with a centred CTA.
       Two flavours: blank "first run" (cosmic circle illustration +
       create button) and "filter has zero results" (reset button). */
    .empty-state {
      padding: 48px 32px;
      text-align: center;
      max-width: 540px;
      margin: 40px auto;
    }
    .empty-illustration {
      font-size: 64px;
      line-height: 1;
      color: color-mix(in srgb, var(--accent) 70%, transparent);
      margin-bottom: 12px;
      filter: drop-shadow(0 0 20px color-mix(in srgb, var(--accent) 35%, transparent));
    }
    .empty-state h2 {
      font-size: 20px;
      font-weight: 400;
      margin: 0 0 10px;
    }
    .empty-state p {
      color: var(--fg-dim);
      margin: 0 0 22px;
      line-height: 1.55;
    }
    .empty-state .primary {
      display: inline-block;
      text-decoration: none;
      padding: 12px 26px;
    }
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

    .filters {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      padding-top: 8px;
      border-top: 1px solid var(--border);
    }
    .chip {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg-dim);
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 12px;
      letter-spacing: .02em;
      cursor: pointer;
      min-height: auto;
      transition: border-color .15s ease, color .15s ease;
    }
    .chip:hover { color: var(--fg); border-color: var(--fg-dim); }
    .chip.active {
      background: var(--accent);
      color: #15151b;
      border-color: var(--accent);
      font-weight: 500;
    }
    a.chip {
      text-decoration: none;
      display: inline-flex;
      align-items: center;
    }
    .new-patient-chip {
      margin-left: auto;
      border-color: var(--accent);
      color: var(--accent);
    }
    .new-patient-chip:hover {
      background: rgba(216, 201, 255, 0.1);
    }

    .patient-grid {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 16px;
    }
    @media (max-width: 480px) {
      .patient-grid {
        grid-template-columns: 1fr;
      }
      .user-name-link { max-width: 120px; font-size: 12px; }
      .filters { gap: 4px; }
      .chip { padding: 5px 10px; font-size: 11px; }
    }
    @media (max-width: 720px) {
      .patient-card {
        padding: 14px;
        gap: 12px;
      }
      .avatar { width: 56px; height: 70px; }
    }

    /* Synapse card with a notched top-right corner — same dual-pseudo
       construction as the patient-detail tabs:
         ::before paints the rotating conic gradient + clip-path notch
                  (visible "border" along all edges including the cut)
         ::after  paints the inner fill (1px inset, same clip-path so
                  the gradient strip is visible along the diagonal too)
         children are hoisted to z-index 2 above both pseudos.
       The parent itself has no bg / border / clip — the pseudos are
       the visible card surface. Hover uses filter:drop-shadow so the
       glow follows the notched shape (box-shadow would be clipped). */
    .patient-card {
      position: relative;
      display: flex;
      gap: 14px;
      /* Top-align so the avatar hugs the top edge of the card and the
         card-body flows downward from the same baseline — keeps the
         portrait from floating in the vertical centre when the body
         content is taller than the avatar. */
      align-items: flex-start;
      background: transparent;
      border: none;
      padding: 16px;
      cursor: pointer;
      transition: transform .12s ease, filter .25s ease;
    }
    .patient-card::before {
      content: '';
      position: absolute;
      inset: 0;
      z-index: 0;
      background: conic-gradient(
        from var(--frame-angle),
        color-mix(in srgb, var(--accent) 42%, var(--border)) 0deg,
        color-mix(in srgb, var(--accent) 16%, var(--border)) 90deg,
        color-mix(in srgb, var(--accent) 36%, var(--border)) 180deg,
        color-mix(in srgb, var(--accent) 16%, var(--border)) 270deg,
        color-mix(in srgb, var(--accent) 42%, var(--border)) 360deg
      );
      clip-path: polygon(
        0 0,
        calc(100% - 18px) 0,
        100% 18px,
        100% 100%,
        0 100%
      );
      border-radius: 14px;
    }
    .patient-card::after {
      content: '';
      position: absolute;
      inset: 1px;
      z-index: 1;
      background:
        radial-gradient(ellipse 80% 60% at 50% 0%,
          color-mix(in srgb, var(--accent) 12%, transparent) 0%,
          transparent 60%),
        color-mix(in srgb, var(--accent) 4%, var(--assistant-bg));
      clip-path: polygon(
        0 0,
        calc(100% - 18px) 0,
        100% 18px,
        100% 100%,
        0 100%
      );
      border-radius: 13px;
      transition: background .2s ease;
    }
    .patient-card > * { position: relative; z-index: 2; }
    .patient-card:hover {
      transform: translateY(-2px);
      filter: drop-shadow(0 14px 22px color-mix(in srgb, var(--accent) 32%, transparent));
    }
    .patient-card:hover::after {
      background:
        radial-gradient(ellipse 80% 60% at 50% 0%,
          color-mix(in srgb, var(--accent) 18%, transparent) 0%,
          transparent 60%),
        color-mix(in srgb, var(--accent) 7%, var(--assistant-bg));
    }

    .avatar-wrap {
      position: relative;
      flex-shrink: 0;
    }
    /* Portrait-style 4:5 rectangle with rounded corners — matches the
       patient-detail hero photo treatment. object-fit:cover keeps the
       face roughly framed at any source aspect. */
    .avatar {
      width: 64px;
      height: 80px;
      border-radius: 10px;
      object-fit: cover;
      background: var(--user-bg);
      border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border));
    }
    .avatar.fallback {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      font-weight: 500;
      color: var(--accent);
      background: var(--user-bg);
    }

    /* Progress dot now sits on the rounded-rect corner — keep it
       circular (it's still a status dot, not a corner marker) and
       nudge it inward so it doesn't get clipped by border-radius. */
    .progress-dot {
      position: absolute;
      bottom: 4px;
      right: 4px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 2px solid var(--assistant-bg);
    }
    .progress-improving { background: #2a6f4d; }
    .progress-stable { background: var(--fg-dim); }
    .progress-worsening { background: #6f2a2a; }

    .card-body {
      flex: 1;
      min-width: 0;
    }
    .name {
      margin: 0;
      font-size: 16px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .diagnosis {
      color: var(--accent);
      font-size: 12px;
      line-height: 1.35;
      margin: 3px 0 6px;
      opacity: 0.85;
      /* Ukrainian translations are 30-50 chars (vs 4-6 for "GAD"/"MDD"),
         so allow up to 2 lines instead of single-line ellipsis. Tooltip
         on hover carries the full label + DSM-5 code. */
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      cursor: help;
    }

    .metrics {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin: 4px 0 6px;
    }
    .metric {
      display: grid;
      grid-template-columns: 70px 1fr;
      align-items: center;
      gap: 6px;
      font-size: 11px;
    }
    .metric-label {
      color: var(--fg-dim);
      text-transform: lowercase;
      letter-spacing: .02em;
    }
    .stars, .dots {
      letter-spacing: 2px;
      font-size: 12px;
      line-height: 1;
    }
    .stars-behavior { color: var(--warn); }
    .dots-clinical { color: var(--danger); letter-spacing: 1px; }

    .card-stats {
      display: flex;
      gap: 6px;
      font-size: 11px;
      color: var(--fg-dim);
      align-items: center;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    .meta-stat.dim { opacity: 0.7; }
    .dot { opacity: .4; }

    .hint { color: var(--fg-dim); font-size: 13px; margin-top: 12px; }
    .hint.danger { color: var(--danger); }
    code {
      background: var(--user-bg);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
    }
  `],
})
export class CharactersListComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  protected auth = inject(AuthService);

  characters = signal<Character[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  difficultyFilter = signal<number | null>(null);

  filteredCharacters = computed(() => {
    const filter = this.difficultyFilter();
    if (filter === null) return this.characters();
    return this.characters().filter((c) => c.difficulty === filter);
  });

  /**
   * Aggregate quick-stats for the strip above the list. Returns null
   * when there's nothing to show (no sessions logged anywhere yet) so
   * the template can skip the whole panel.
   *
   * Three readouts:
   *   • totalSessions   — sum of c.sessionCount across all patients,
   *                       a sense of practice volume.
   *   • activeCases     — how many patients you've actually worked
   *                       with (sessionCount > 0). The ratio against
   *                       total patients hints at content underuse.
   *   • lastSessionAgo  — human-readable "x days ago" for the latest
   *                       lastSessionAt, so you can sense if you've
   *                       slipped into a gap (Reflect is a habit tool).
   */
  stats = computed<{
    totalSessions: number;
    activeCases: number;
    lastSessionAgo: string;
  } | null>(() => {
    const all = this.characters();
    if (all.length === 0) return null;
    const totalSessions = all.reduce((s, c) => s + (c.sessionCount ?? 0), 0);
    if (totalSessions === 0) return null;
    const activeCases = all.filter((c) => (c.sessionCount ?? 0) > 0).length;
    const lastTs = all.reduce<number | null>((latest, c) => {
      if (!c.lastSessionAt) return latest;
      const t = new Date(c.lastSessionAt).getTime();
      return latest == null || t > latest ? t : latest;
    }, null);
    return {
      totalSessions,
      activeCases,
      lastSessionAgo: lastTs != null ? this.relativeTime(lastTs) : '—',
    };
  });

  /** Returns a short "x хв/год/дн тому" label for a past timestamp.
   *  Falls back to ISO date for very old timestamps (>30 days). */
  private relativeTime(ts: number): string {
    const ms = Date.now() - ts;
    const min = Math.floor(ms / 60_000);
    if (min < 1) return 'щойно';
    if (min < 60) return `${min} хв тому`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} год тому`;
    const day = Math.floor(hr / 24);
    if (day === 1) return 'учора';
    if (day < 30) return `${day} дн тому`;
    return new Date(ts).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
  }

  logout() {
    void this.auth.logout();
  }

  setDifficulty(d: number) {
    this.difficultyFilter.set(this.difficultyFilter() === d ? null : d);
  }

  countByDifficulty(d: number): number {
    return this.characters().filter((c) => c.difficulty === d).length;
  }

  async ngOnInit() {
    try {
      this.characters.set(await this.api.listCharacters());
    } catch {
      this.error.set('Сервер недоступний. Перевір, чи API запущений на :3000.');
    } finally {
      this.loading.set(false);
    }
  }

  open(c: Character) {
    void this.router.navigate(['/patient', c.id]);
  }

  badgeText(b: ProgressBadge): string {
    return {
      improving: '↑ покращення',
      stable: '→ стабільно',
      worsening: '↓ погіршення',
      unknown: '',
    }[b];
  }

  sessionsWord(n: number): string {
    if (n === 1) return 'сесія';
    if (n >= 2 && n <= 4) return 'сесії';
    return 'сесій';
  }

  stars(n: number): string {
    return '★'.repeat(n) + '☆'.repeat(5 - n);
  }

  dots(n: number): string {
    return '●'.repeat(n) + '○'.repeat(5 - n);
  }

  /**
   * Tooltip text for the (often truncated) diagnosis label on the patient
   * card. Always includes the full Ukrainian label; appends the DSM-5/ICD
   * code on a second line if present so students who want to look up
   * literature have the original term handy.
   */
  diagnosisTooltip(c: Character): string {
    const ua = c.diagnosis ?? '';
    const code = c.diagnosisCode;
    return code ? `${ua}\n— ${code}` : ua;
  }
}
