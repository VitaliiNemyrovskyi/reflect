import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiService, Character, ProgressBadge } from '../api.service';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-characters-list',
  standalone: true,
  imports: [CommonModule, DatePipe, RouterLink],
  template: `
    <header class="header">
      <div class="title-row">
        <div>
          <h1>Reflect</h1>
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
      <ul class="patient-grid">
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
    .header { margin-bottom: 24px; }
    .header h1 { font-size: 28px; margin: 0; letter-spacing: -0.02em; }
    .subtitle { color: var(--fg-dim); margin: 4px 0 0; font-size: 14px; }
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
      .header h1 { font-size: 22px; }
      .filters { gap: 4px; }
      .chip { padding: 5px 10px; font-size: 11px; }
    }
    @media (max-width: 720px) {
      .patient-card {
        padding: 14px;
        gap: 12px;
      }
      .avatar { width: 56px; height: 56px; }
    }

    .patient-card {
      display: flex;
      gap: 14px;
      align-items: center;
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      cursor: pointer;
      transition: border-color .15s ease, transform .12s ease, background .15s ease;
    }
    .patient-card:hover {
      border-color: var(--accent);
      background: #18181f;
      transform: translateY(-2px);
    }

    .avatar-wrap {
      position: relative;
      flex-shrink: 0;
    }
    .avatar {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--user-bg);
      border: 1px solid var(--border);
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

    .progress-dot {
      position: absolute;
      bottom: 0;
      right: 0;
      width: 16px;
      height: 16px;
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
