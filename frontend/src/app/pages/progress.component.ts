import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, type ProgressData } from '../api.service';
import { I18nService } from '../i18n.service';

/**
 * /progress — the trainee's growth page (gamification Phase 1a).
 *
 * Three blocks, all built from the shared block library (styles.scss):
 *   1. Hero  — progression stage + a 4-pip stage track + headline facts
 *              (.panel.panel-soft.frame-bordered + .facts-row).
 *   2. Radar — a self-contained SVG spider chart of the 4 therapist
 *              competencies (no charting dependency — drawn from our own
 *              tokens), with a numbered legend showing recent-vs-all-time.
 *   3. Badges— a medallion grid; earned ones wear the rotating conic ring
 *              (.frame-bordered), locked ones are dimmed, "coming soon"
 *              flagships are shown as goals so the trainee sees what's next.
 *
 * Everything renders from a single GET /api/progress. The page never
 * writes — opening it just triggers the server's idempotent re-award.
 */
@Component({
  selector: 'app-progress',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="progress-page fx-fade-up">
      <header class="page-head">
        <a routerLink="/" class="back">← {{ tr('На головну', 'Home') }}</a>
        <h1>{{ tr('Прогрес', 'Progress') }}</h1>
        <p class="sub">{{ tr('Твій шлях розвитку як терапевта', 'Your growth as a therapist') }}</p>
      </header>

      @if (loading()) {
        <div class="panel skel">
          <div class="fx-shimmer skel-line w40"></div>
          <div class="fx-shimmer skel-line w70"></div>
          <div class="fx-shimmer skel-block"></div>
        </div>
      } @else if (error()) {
        <div class="panel callout panel-soft">
          <p class="err">{{ error() }}</p>
          <button class="ghost small" (click)="reload()">{{ tr('Спробувати знову', 'Retry') }}</button>
        </div>
      } @else {
       @if (data(); as d) {

        <!-- ── Hero: stage + headline facts ─────────────────────────── -->
        <section class="panel panel-soft frame-bordered hero">
          <div class="hero-stage">
            <span class="section-label">{{ tr('Рівень', 'Stage') }}</span>
            <div class="stage-name">{{ stageLabel(d.stage) }}</div>
            <div class="stage-track" role="list">
              @for (s of stageView(); track s.key) {
                <div class="pip"
                     role="listitem"
                     [class.done]="s.done"
                     [class.current]="s.current"
                     [class.locked]="s.locked"
                     [title]="s.label">
                  <span class="pip-dot">@if (s.locked) {🔒}</span>
                  <span class="pip-label">{{ s.label }}</span>
                </div>
              }
            </div>
          </div>
          <div class="facts-row hero-facts">
            <div class="facts-cell">
              <span class="facts-label">{{ tr('Середня компетенція', 'Mean competency') }}</span>
              <span class="facts-value">{{ d.meanCompetency }}<small>/100</small></span>
            </div>
            <div class="facts-cell">
              <span class="facts-label">{{ tr('Сесій з фідбеком', 'Scored sessions') }}</span>
              <span class="facts-value">{{ d.sessionsCompleted }}</span>
            </div>
            <div class="facts-cell">
              <span class="facts-label">{{ tr('Бейджів', 'Badges') }}</span>
              <span class="facts-value">{{ earnedCount() }}<small>/{{ awardableCount() }}</small></span>
            </div>
          </div>
        </section>

        <!-- ── Radar: 4 competencies ────────────────────────────────── -->
        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title">{{ tr('Компетенції', 'Competencies') }}</h2>
            <span class="panel-meta">{{ tr('останні / усе', 'recent / all-time') }}</span>
          </div>

          @if (d.sessionsCompleted === 0) {
            <p class="empty">
              {{ tr('Проведи першу сесію й отримай фідбек — тут зʼявиться твій профіль компетенцій.',
                    'Run your first session and get feedback — your competency profile will appear here.') }}
            </p>
          } @else {
           @if (radar(); as r) {
            <div class="radar-wrap">
              <svg class="radar" [attr.viewBox]="r.viewBox" role="img"
                   [attr.aria-label]="tr('Радар компетенцій', 'Competency radar')">
                <!-- grid rings -->
                @for (ring of r.rings; track $index) {
                  <polygon class="grid-ring" [attr.points]="ring" />
                }
                <!-- spokes -->
                @for (sp of r.spokes; track $index) {
                  <line class="spoke" [attr.x1]="r.cx" [attr.y1]="r.cy"
                        [attr.x2]="sp.x2" [attr.y2]="sp.y2" />
                }
                <!-- all-time area -->
                <polygon class="area-all" [attr.points]="r.allTimePoly" />
                <!-- recent area (drawn-in outline) -->
                <polygon class="area-recent fx-draw" pathLength="100" [attr.points]="r.recentPoly" />
                <!-- recent vertices -->
                @for (dot of r.recentDots; track $index) {
                  <circle class="vtx" [attr.cx]="dot.x" [attr.cy]="dot.y" r="3" />
                }
                <!-- numbered axis chips -->
                @for (chip of r.chips; track $index) {
                  <g class="chip">
                    <circle [attr.cx]="chip.x" [attr.cy]="chip.y" r="9" />
                    <text [attr.x]="chip.x" [attr.y]="chip.y" dy="0.34em" text-anchor="middle">{{ $index + 1 }}</text>
                  </g>
                }
              </svg>

              <ol class="radar-legend">
                @for (a of d.radar; track a.key) {
                  <li class="leg">
                    <span class="leg-idx">{{ $index + 1 }}</span>
                    <div class="leg-main">
                      <div class="leg-top">
                        <span class="leg-label">{{ a.label }}</span>
                        <span class="leg-num">{{ a.recent }}<i>/{{ a.allTime }}</i></span>
                      </div>
                      <div class="leg-bar">
                        <span class="leg-bar-all" [style.width.%]="a.allTime"></span>
                        <span class="leg-bar-recent" [style.width.%]="a.recent"></span>
                      </div>
                    </div>
                  </li>
                }
              </ol>
            </div>
           }
          }
        </section>

        <!-- ── Badges ───────────────────────────────────────────────── -->
        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title">{{ tr('Бейджі', 'Badges') }}</h2>
            <span class="panel-meta">{{ earnedCount() }} / {{ awardableCount() }}</span>
          </div>
          <div class="badge-grid fx-stagger">
            @for (b of data()!.badges; track b.key) {
              <div class="badge"
                   [class.earned]="b.earned"
                   [class.locked]="!b.earned && !b.comingSoon"
                   [class.soon]="b.comingSoon && !b.earned"
                   [class.flagship]="b.flagship"
                   [title]="b.description">
                <div class="medal" [class.frame-bordered]="b.earned">
                  <span class="glyph">{{ glyph(b.key) }}</span>
                  @if (b.flagship) { <span class="star">★</span> }
                </div>
                <div class="badge-body">
                  <div class="badge-title">{{ b.title }}</div>
                  <div class="badge-desc">{{ b.description }}</div>
                  @if (b.earned && b.earnedAt) {
                    <div class="badge-foot earned-on">{{ b.earnedAt | date: 'dd.MM.yy' }}</div>
                  } @else if (b.comingSoon) {
                    <div class="badge-foot"><span class="tag soon-tag">{{ tr('скоро', 'soon') }}</span></div>
                  } @else {
                    <div class="badge-foot"><span class="tag locked-tag">{{ tr('не відкрито', 'locked') }}</span></div>
                  }
                </div>
              </div>
            }
          </div>
          <p class="badge-note">
            {{ tr('Бейджі за справжнє клінічне вміння (тихий сигнал, відновлення альянсу, заземлення травми) зʼявляться, щойно тренажер почне фіксувати ці сигнали по сесіях.',
                  'Badges for genuine clinical skill (quiet signal, alliance repair, trauma grounding) unlock once the simulator records those signals per session.') }}
          </p>
        </section>
       }
      }
    </div>
  `,
  styles: [`
    .progress-page { position: relative; z-index: 1; }

    /* Page head — mirrors settings.component's back/title/sub rhythm. */
    .page-head { margin-bottom: 24px; }
    .back {
      display: inline-block;
      color: var(--fg-dim);
      text-decoration: none;
      font-size: 13px;
      margin-bottom: 10px;
      transition: color .15s ease;
    }
    .back:hover { color: var(--accent); }
    .page-head h1 { margin: 0; font-size: 26px; font-weight: 400; letter-spacing: -0.01em; }
    .page-head .sub { margin: 6px 0 0; color: var(--fg-dim); font-size: 14px; }

    /* ── Hero ──────────────────────────────────────────────────────── */
    .hero { display: flex; flex-direction: column; gap: 22px; }
    .hero-stage { display: flex; flex-direction: column; gap: 10px; }
    .stage-name {
      font-size: 30px; font-weight: 300; letter-spacing: -0.01em;
      color: var(--accent);
      text-shadow: 0 0 22px color-mix(in srgb, var(--accent) 30%, transparent);
      line-height: 1.1;
    }
    .stage-track {
      display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px;
    }
    .pip {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 12px 5px 9px;
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 11.5px;
      color: var(--fg-dim);
      background: color-mix(in srgb, var(--accent) 3%, transparent);
      transition: border-color .2s ease, color .2s ease, background .2s ease;
    }
    .pip .pip-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--border);
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 8px; flex: 0 0 auto;
    }
    .pip.done { color: var(--fg); border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); }
    .pip.done .pip-dot { background: color-mix(in srgb, var(--accent) 55%, var(--border)); }
    .pip.current {
      color: var(--accent);
      border-color: color-mix(in srgb, var(--accent) 55%, transparent);
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      box-shadow: 0 0 16px -4px color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .pip.current .pip-dot { background: var(--accent); }
    .pip.locked { opacity: 0.6; }
    .pip.locked .pip-dot { background: transparent; width: auto; height: auto; }

    .hero-facts { border-top: 1px dashed var(--border); padding-top: 18px; }

    /* ── Radar ─────────────────────────────────────────────────────── */
    .radar-wrap {
      display: grid;
      grid-template-columns: minmax(220px, 300px) 1fr;
      gap: 26px;
      align-items: center;
    }
    .radar { width: 100%; height: auto; overflow: visible; }
    .grid-ring { fill: none; stroke: var(--border); stroke-width: 1; }
    .spoke { stroke: var(--border); stroke-width: 1; }
    .area-all {
      fill: color-mix(in srgb, var(--accent) 12%, transparent);
      stroke: color-mix(in srgb, var(--accent) 30%, transparent);
      stroke-width: 1;
    }
    .area-recent {
      fill: color-mix(in srgb, var(--accent) 16%, transparent);
      stroke: var(--accent);
      stroke-width: 2;
      stroke-linejoin: round;
      filter: drop-shadow(0 0 8px color-mix(in srgb, var(--accent) 35%, transparent));
    }
    .vtx { fill: var(--accent); }
    .chip circle { fill: var(--user-bg); stroke: color-mix(in srgb, var(--accent) 30%, var(--border)); stroke-width: 1; }
    .chip text { fill: var(--fg-dim); font-size: 10px; font-weight: 600; }

    .radar-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
    .leg { display: flex; gap: 11px; align-items: flex-start; }
    .leg-idx {
      flex: 0 0 auto; width: 20px; height: 20px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 600;
      color: var(--fg-dim);
      border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
      background: color-mix(in srgb, var(--accent) 5%, transparent);
      margin-top: 1px;
    }
    .leg-main { flex: 1 1 auto; min-width: 0; }
    .leg-top { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
    .leg-label { font-size: 13px; color: var(--fg); }
    .leg-num { font-size: 13px; font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 500; }
    .leg-num i { color: var(--fg-dim); font-style: normal; font-weight: 400; }
    .leg-bar {
      position: relative; height: 5px; margin-top: 6px; border-radius: 3px;
      background: var(--user-bg); overflow: hidden;
    }
    .leg-bar-all, .leg-bar-recent {
      position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px;
      transition: width .5s cubic-bezier(.16,1,.3,1);
    }
    .leg-bar-all { background: color-mix(in srgb, var(--accent) 22%, transparent); }
    .leg-bar-recent { background: var(--accent); box-shadow: 0 0 8px -1px color-mix(in srgb, var(--accent) 50%, transparent); }

    .empty { color: var(--fg-dim); font-size: 14px; margin: 4px 0; line-height: 1.6; }

    /* ── Badges ────────────────────────────────────────────────────── */
    .badge-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 14px;
    }
    .badge {
      display: flex; flex-direction: column; align-items: center; text-align: center;
      gap: 10px; padding: 18px 14px 16px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--assistant-bg);
      transition: border-color .2s ease, transform .12s ease, box-shadow .25s ease;
    }
    .badge.earned {
      border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
      box-shadow: 0 6px 24px -14px color-mix(in srgb, var(--accent) 45%, transparent);
    }
    .badge.earned:hover { transform: translateY(-2px); }
    .badge.locked { opacity: 0.5; }
    .badge.soon { opacity: 0.78; border-style: dashed; }

    .medal {
      width: 60px; height: 60px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      position: relative;
      background: var(--user-bg);
      border: 1px solid var(--border);
    }
    /* earned medals borrow the rotating conic ring from the block library;
       .frame-bordered needs a non-transparent inner — round it off here. */
    .medal.frame-bordered { border-radius: 50%; }
    .badge.earned .medal {
      background:
        radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 70%),
        var(--user-bg);
    }
    .glyph { font-size: 26px; line-height: 1; filter: grayscale(0.15); }
    .badge.locked .glyph, .badge.soon .glyph { filter: grayscale(1); opacity: 0.8; }
    .star {
      position: absolute; right: -2px; top: -2px;
      font-size: 12px; color: var(--accent);
      text-shadow: 0 0 8px color-mix(in srgb, var(--accent) 60%, transparent);
    }

    .badge-body { display: flex; flex-direction: column; gap: 5px; }
    .badge-title { font-size: 14px; font-weight: 500; color: var(--fg); }
    .badge.earned .badge-title { color: var(--accent); }
    .badge-desc { font-size: 11.5px; color: var(--fg-dim); line-height: 1.45; }
    .badge-foot { margin-top: 3px; }
    .earned-on { font-size: 11px; color: var(--fg-dim); font-variant-numeric: tabular-nums; }
    .tag {
      display: inline-block; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
      padding: 2px 9px; border-radius: 999px;
    }
    .soon-tag { color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--border)); }
    .locked-tag { color: var(--fg-dim); border: 1px solid var(--border); }

    .badge-note {
      margin: 18px 0 0; font-size: 12px; color: var(--fg-dim);
      line-height: 1.6; border-top: 1px dashed var(--border); padding-top: 14px;
    }

    /* ── Skeleton / error ──────────────────────────────────────────── */
    .skel-line { height: 14px; border-radius: 6px; margin-bottom: 12px; }
    .skel-block { height: 180px; border-radius: 10px; }
    .w40 { width: 40%; } .w70 { width: 70%; }
    .err { color: var(--danger); margin: 0 0 12px; }

    /* ── Mobile ────────────────────────────────────────────────────── */
    @media (max-width: 620px) {
      .radar-wrap { grid-template-columns: 1fr; gap: 18px; }
      .radar { max-width: 280px; margin: 0 auto; }
      .page-head h1 { font-size: 22px; }
      .stage-name { font-size: 26px; }
    }
  `],
})
export class ProgressComponent {
  private api = inject(ApiService);
  protected i18n = inject(I18nService);

  protected loading = signal(true);
  protected error = signal<string | null>(null);
  protected data = signal<ProgressData | null>(null);

  /** UK stage order → localized labels for the 4-pip track. */
  private readonly STAGE_KEYS = ['Стажер', 'Практик', 'Досвідчений', 'Майстер'];
  private readonly STAGE_EN: Record<string, string> = {
    'Стажер': 'Trainee', 'Практик': 'Practitioner', 'Досвідчений': 'Experienced', 'Майстер': 'Master',
  };

  /** Per-badge glyph. Backend doesn't ship icons (keeps the catalog text-only),
   *  so the visual lives here next to the rest of the presentation. */
  private readonly GLYPHS: Record<string, string> = {
    first_contact: '🌱',
    attuned: '💟',
    stayed_course: '⚓',
    three_cities: '🗺️',
    full_palette: '🎨',
    polyglot: '🌐',
    on_the_rise: '📈',
    quiet_signal: '🛟',
    drew_it_out: '🔦',
    repaired: '🧵',
    safe_container: '🫂',
    tough_room: '🧗',
  };

  protected earnedCount = computed(() => this.data()?.badges.filter((b) => b.earned).length ?? 0);
  protected awardableCount = computed(
    () => this.data()?.badges.filter((b) => !b.comingSoon).length ?? 0,
  );

  /** 4-pip progression track view-model derived from the current stage. */
  protected stageView = computed(() => {
    const cur = this.STAGE_KEYS.indexOf(this.data()?.stage ?? 'Стажер');
    return this.STAGE_KEYS.map((key, i) => ({
      key,
      label: this.stageLabel(key),
      done: i < cur,
      current: i === cur,
      // Master is intentionally ungated in Phase 1a — always shown as a locked goal.
      locked: key === 'Майстер' && cur < 3,
    }));
  });

  /** SVG spider-chart geometry, recomputed when data changes. Pure trig from
   *  our own tokens — no charting library. 4 axes → a diamond. */
  protected radar = computed(() => {
    const d = this.data();
    if (!d || d.radar.length === 0) return null;
    const axes = d.radar;
    const N = axes.length;
    const cx = 140, cy = 140, R = 108;
    const pt = (i: number, val: number): [number, number] => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / N;
      const r = (R * Math.max(0, Math.min(100, val))) / 100;
      return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
    };
    const poly = (vals: number[]) =>
      vals.map((v, i) => pt(i, v).map((n) => n.toFixed(1)).join(',')).join(' ');

    const rings = [25, 50, 75, 100].map((lvl) => poly(axes.map(() => lvl)));
    const spokes = axes.map((_, i) => {
      const [x, y] = pt(i, 100);
      return { x2: x.toFixed(1), y2: y.toFixed(1) };
    });
    const chips = axes.map((_, i) => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / N;
      const lr = R + 16;
      return { x: (cx + lr * Math.cos(ang)).toFixed(1), y: (cy + lr * Math.sin(ang)).toFixed(1) };
    });
    const recentDots = axes.map((a, i) => {
      const [x, y] = pt(i, a.recent);
      return { x: x.toFixed(1), y: y.toFixed(1) };
    });

    return {
      viewBox: '0 0 280 280',
      cx, cy,
      rings,
      spokes,
      chips,
      recentDots,
      allTimePoly: poly(axes.map((a) => a.allTime)),
      recentPoly: poly(axes.map((a) => a.recent)),
    };
  });

  constructor() {
    void this.reload();
  }

  protected tr(uk: string, en: string): string {
    return this.i18n.isEn ? en : uk;
  }

  protected stageLabel(stage: string): string {
    return this.i18n.isEn ? (this.STAGE_EN[stage] ?? stage) : stage;
  }

  protected glyph(key: string): string {
    return this.GLYPHS[key] ?? '◆';
  }

  protected async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.data.set(await this.api.getProgress());
    } catch {
      this.error.set(this.tr('Не вдалося завантажити прогрес.', 'Could not load progress.'));
    } finally {
      this.loading.set(false);
    }
  }
}
