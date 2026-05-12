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

    @if (loading()) {
      <div class="hint">Завантаження…</div>
    } @else if (error()) {
      <div class="hint danger">{{ error() }}</div>
    } @else if (characters().length === 0) {
      <div class="hint">
        Жодного пацієнта в картотеці. Додай профілі в <code>prompts/profiles/</code>
        і перезапусти сервер.
      </div>
    } @else {
      <ul class="patient-grid fx-stagger">
        @for (c of filteredCharacters(); track c.id) {
          <li class="patient-card fx-glow" (click)="open(c)">
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
    .header { margin-bottom: 24px; }
    .brand-block { display: flex; flex-direction: column; gap: 6px; }
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
      align-items: center;
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
