import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  AdminErrorLog,
  AdminEvent,
  AdminFunnel,
  AdminLlmUsage,
  AdminSessionDetail,
  AdminSessionListItem,
  AdminUser,
  ApiService,
  type TherapistBoardRow,
} from '../api.service';
import { AuthService } from '../auth.service';
import { IconComponent } from '../icon.component';

type PlanId = 'trial' | 'lite' | 'pro' | 'master';

interface GrantPlanDialog {
  user: AdminUser;
  plan: PlanId;
  months: number;
  note: string;
}

type Tab = 'users' | 'sessions' | 'errors' | 'funnel' | 'cost' | 'board';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [CommonModule, DatePipe, FormsModule, RouterLink, IconComponent],
  host: { '(document:keydown.escape)': 'onEscape()' },
  template: `
    <header class="admin-header">
      <a routerLink="/" class="back">← На головну</a>
      <h1>Admin panel</h1>
      <p class="subtitle dim">
        Доступ для адмінів. Гранти й ревоки керуються тут — у вкладці «Користувачі».
        Змінна оточення <code>ADMIN_EMAILS</code> лишається як аварійний bootstrap.
      </p>

      <nav class="tabs">
        <button [class.active]="tab() === 'users'" (click)="setTab('users')">
          <app-icon name="users" /> Користувачі
          @if (users().length) { <span class="count">{{ users().length }}</span> }
        </button>
        <button [class.active]="tab() === 'sessions'" (click)="setTab('sessions')">
          <app-icon name="message" /> Сесії
          @if (sessions().length) { <span class="count">{{ sessions().length }}</span> }
        </button>
        <button [class.active]="tab() === 'errors'" (click)="setTab('errors')">
          <app-icon name="bug" /> Помилки
          @if (errors().length) { <span class="count">{{ errors().length }}</span> }
        </button>
        <button [class.active]="tab() === 'funnel'" (click)="setTab('funnel')">
          <app-icon name="funnel" /> Funnel
        </button>
        <button [class.active]="tab() === 'cost'" (click)="setTab('cost')">
          <app-icon name="coin" /> Витрати
        </button>
        <button class="board-tab" [class.active]="tab() === 'board'" (click)="setTab('board')">
          <app-icon name="trophy" /> Дошка
          @if (board().length) { <span class="count">{{ board().length }}</span> }
        </button>
      </nav>
    </header>

    @if (loading()) {
      <p class="hint">Завантаження…</p>
    } @else if (error()) {
      <p class="hint danger">{{ error() }}</p>
    } @else {

      @if (tab() === 'users') {
        <section class="panel panel-soft frame-bordered">
          <span class="section-label"><app-icon name="users" /> Список користувачів · {{ users().length }}</span>
          <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Email</th>
              <th>Ім'я</th>
              <th>Вхід</th>
              <th>Сесій</th>
              <th>План</th>
              <th>Admin</th>
              <th>Створено</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (u of users(); track u.id) {
              <tr>
                <td class="num">{{ u.id }}</td>
                <td class="email-cell">{{ u.email }}</td>
                <td>{{ u.displayName || '—' }}</td>
                <td><code class="provider">{{ u.provider }}</code></td>
                <td class="num">{{ u.sessionCount }}</td>
                <td>
                  @if (u.plan) {
                    <span class="badge plan-badge plan-{{ u.plan }}">{{ u.plan }}</span>
                    @if (u.planEndsAt) {
                      <span class="plan-expiry">до&nbsp;{{ u.planEndsAt | date: 'dd.MM.yy' }}</span>
                    }
                  } @else {
                    <span class="dim">—</span>
                  }
                </td>
                <td>
                  @if (u.isAdmin) {
                    <span class="badge admin-badge">admin</span>
                    @if (u.id === currentUserId()) { <span class="self-tag">(ти)</span> }
                  }
                  @if (u.isInstructor) { <span class="badge instructor-badge">instructor</span> }
                </td>
                <td class="dim">{{ u.createdAt | date: 'dd.MM.yyyy' }}</td>
                <td class="row-actions">
                  <button class="link-btn" (click)="filterByUser(u.id)">сесії →</button>
                  <button class="link-btn" (click)="openGrantPlan(u)">план →</button>
                  @if (u.isAdmin) {
                    <button
                      class="link-btn danger"
                      [disabled]="adminBusy() === u.id"
                      (click)="revokeAdmin(u)">
                      {{ adminBusy() === u.id ? '…' : '× admin' }}
                    </button>
                  } @else {
                    <button
                      class="link-btn"
                      [disabled]="adminBusy() === u.id"
                      (click)="grantAdmin(u)">
                      {{ adminBusy() === u.id ? '…' : '+ admin' }}
                    </button>
                  }
                  @if (u.isInstructor) {
                    <button
                      class="link-btn danger"
                      [disabled]="instructorBusy() === u.id"
                      (click)="setInstructor(u, false)">
                      {{ instructorBusy() === u.id ? '…' : '× instructor' }}
                    </button>
                  } @else {
                    <button
                      class="link-btn"
                      [disabled]="instructorBusy() === u.id"
                      (click)="setInstructor(u, true)">
                      {{ instructorBusy() === u.id ? '…' : '+ instructor' }}
                    </button>
                  }
                </td>
              </tr>
            }
            @if (users().length === 0) {
              <tr><td colspan="9" class="empty">Ні одного користувача</td></tr>
            }
          </tbody>
          </table>
        </section>
      }

      @if (tab() === 'sessions') {
        @if (sessionFilter().userId != null) {
          <div class="filter-bar">
            Фільтр: користувач #{{ sessionFilter().userId }}
            <button class="link-btn" (click)="clearSessionFilter()">× очистити</button>
          </div>
        }
        <section class="panel panel-soft frame-bordered">
          <span class="section-label"><app-icon name="message" /> Сесії · {{ sessions().length }}</span>
          <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Студент</th>
              <th>Пацієнт</th>
              <th>Реплік</th>
              <th>Стан</th>
              <th>Початок</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (s of sessions(); track s.id) {
              <tr [class.selected]="selectedSession()?.id === s.id" (click)="openSession(s.id)">
                <td class="num">{{ s.id }}</td>
                <td>{{ s.user?.email || '—' }}</td>
                <td>{{ s.character.displayName }}</td>
                <td class="num">{{ s.messageCount }}</td>
                <td>
                  @if (s.endedAt) {
                    @if (s.hasFeedback) {
                      <span class="badge done">завершена + фідбек</span>
                    } @else {
                      <span class="badge done">завершена</span>
                    }
                  } @else {
                    <span class="badge open">у процесі</span>
                  }
                </td>
                <td class="dim">{{ s.startedAt | date: 'dd.MM HH:mm' }}</td>
                <td class="row-actions">
                  <a [routerLink]="['/session', s.id, 'view']"
                     class="link-btn"
                     (click)="$event.stopPropagation()"
                     title="Відкрити транскрипт у читабельному вигляді">
                    відкрити
                  </a>
                  <button class="ghost small" (click)="$event.stopPropagation(); confirmDelete(s.id)">
                    видалити
                  </button>
                </td>
              </tr>
            }
            @if (sessions().length === 0) {
              <tr><td colspan="7" class="empty">Сесій не знайдено</td></tr>
            }
          </tbody>
          </table>
        </section>

        @if (selectedSession(); as s) {
          <article class="session-detail">
            <header>
              <h3>Сесія #{{ s.id }} — {{ s.character.displayName }} / {{ s.user?.email }}</h3>
              <button class="ghost small" (click)="closeSession()">× закрити</button>
            </header>

            <details open>
              <summary><strong>Транскрипт</strong> ({{ s.messages.length }} реплік)</summary>
              <ol class="transcript">
                @for (m of s.messages; track m.id) {
                  <li class="line" [class.user]="m.role === 'user'" [class.assistant]="m.role === 'assistant'">
                    <span class="role">{{ m.role === 'user' ? 'Терапевт' : s.character.displayName }}</span>
                    <span class="text">{{ m.content }}</span>
                  </li>
                }
              </ol>
            </details>

            @if (s.feedback) {
              <details>
                <summary><strong>Фідбек супервайзера</strong></summary>
                <pre class="feedback-raw">{{ s.feedback }}</pre>
              </details>
            }

            @if (s.assessment) {
              <details>
                <summary><strong>Машинна оцінка (JSON)</strong></summary>
                <pre class="json">{{ s.assessment | json }}</pre>
              </details>
            }

            @if (s.errors?.length) {
              <details open>
                <summary><strong>Помилки під час сесії</strong> ({{ s.errors.length }})</summary>
                <ul class="error-list">
                  @for (e of s.errors; track e.id) {
                    <li>
                      <code>{{ e.method }} {{ e.endpoint }} → {{ e.status }}</code>
                      <p>{{ e.message }}</p>
                      <span class="dim">{{ e.createdAt | date: 'dd.MM HH:mm:ss' }}</span>
                    </li>
                  }
                </ul>
              </details>
            }
          </article>
        }
      }

      @if (tab() === 'errors') {
        <section class="panel panel-soft frame-bordered">
          <span class="section-label"><app-icon name="bug" /> Помилки · {{ errors().length }}</span>
          <table class="data-table errors-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Endpoint</th>
              <th>Статус</th>
              <th>Користувач</th>
              <th>Повідомлення</th>
              <th>Коли</th>
            </tr>
          </thead>
          <tbody>
            @for (e of errors(); track e.id) {
              <tr (click)="toggleErrorExpand(e.id)" [class.expanded]="expandedError() === e.id">
                <td class="num">{{ e.id }}</td>
                <td><code>{{ e.method }} {{ e.endpoint }}</code></td>
                <td><span class="badge status-{{ e.status }}">{{ e.status }}</span></td>
                <td>{{ e.user?.email || (e.userId != null ? '#' + e.userId : '—') }}</td>
                <td class="message">{{ e.message }}</td>
                <td class="dim">{{ e.createdAt | date: 'dd.MM HH:mm:ss' }}</td>
              </tr>
              @if (expandedError() === e.id && e.stack) {
                <tr class="stack-row">
                  <td colspan="6"><pre class="stack">{{ e.stack }}</pre></td>
                </tr>
              }
            }
            @if (errors().length === 0) {
              <tr><td colspan="6" class="empty">Помилок не зареєстровано</td></tr>
            }
          </tbody>
          </table>
        </section>
      }

      @if (tab() === 'funnel') {
        @if (funnel(); as f) {
          <div class="funnel">
            <section class="panel panel-soft frame-bordered">
            <span class="section-label"><app-icon name="funnel" /> Воронка · 7 днів</span>
            <p class="hint">
              Останні 7 днів (з {{ f.since | date: 'd MMM, HH:mm' }}).
              Кожен крок — кількість унікальних користувачів (анонімні — за hash IP+UA).
            </p>
            <ol class="funnel-steps">
              <li>
                <div class="step-num">1</div>
                <div class="step-meta">
                  <strong>{{ f.funnel.visited_demo_or_pricing }}</strong>
                  <span>відвідали /demo або /pricing</span>
                </div>
              </li>
              <li>
                <div class="step-num">2</div>
                <div class="step-meta">
                  <strong>{{ f.funnel.registered }}</strong>
                  <span>зареєструвались
                    @if (f.rates.register_per_visit !== null) {
                      <em>· {{ (f.rates.register_per_visit * 100) | number: '1.0-1' }}% від візитів</em>
                    }
                  </span>
                </div>
              </li>
              <li>
                <div class="step-num">3</div>
                <div class="step-meta">
                  <strong>{{ f.funnel.started_first_session }}</strong>
                  <span>почали першу сесію
                    @if (f.rates.session_per_register !== null) {
                      <em>· {{ (f.rates.session_per_register * 100) | number: '1.0-1' }}% від реєстрацій</em>
                    }
                  </span>
                </div>
              </li>
              <li>
                <div class="step-num">4</div>
                <div class="step-meta">
                  <strong>{{ f.funnel.started_third_session }}</strong>
                  <span>дійшли до 3-ї сесії
                    @if (f.rates.retention_3plus_sessions !== null) {
                      <em>· {{ (f.rates.retention_3plus_sessions * 100) | number: '1.0-1' }}% retention</em>
                    }
                  </span>
                </div>
              </li>
              <li>
                <div class="step-num">5</div>
                <div class="step-meta">
                  <strong>{{ f.funnel.viewed_feedback }}</strong>
                  <span>побачили фідбек супервізора
                    @if (f.rates.feedback_per_session !== null) {
                      <em>· {{ (f.rates.feedback_per_session * 100) | number: '1.0-1' }}% від першої сесії</em>
                    }
                  </span>
                </div>
              </li>
            </ol>
            </section>

            <section class="panel panel-soft frame-bordered">
            <span class="section-label"><app-icon name="clock" /> Останні події</span>
            <table class="data-table compact">
              <thead>
                <tr><th>Коли</th><th>Тип</th><th>Користувач</th><th>Дані</th></tr>
              </thead>
              <tbody>
                @for (ev of recentEvents(); track ev.id) {
                  <tr>
                    <td>{{ ev.createdAt | date: 'HH:mm:ss' }}</td>
                    <td><code>{{ ev.eventType }}</code></td>
                    <td>{{ ev.userId ?? 'anon:' + (ev.anonHash?.slice(0,6) ?? '?') }}</td>
                    <td class="dim">{{ ev.props }}</td>
                  </tr>
                }
                @if (recentEvents().length === 0) {
                  <tr><td colspan="4" class="empty">Подій ще немає</td></tr>
                }
              </tbody>
            </table>
            </section>
          </div>
        } @else {
          <p class="hint">Завантаження funnel-даних…</p>
        }
      }

      @if (tab() === 'cost') {
        @if (llmUsage(); as u) {
          <div class="cost-cards">
            <div class="cost-card panel-soft frame-bordered">
              <span class="cost-label">Сьогодні</span>
              <strong class="cost-figure">{{ fmtUsd(u.today.costUsd) }}</strong>
              <span class="cost-sub">{{ u.today.calls }} викликів · {{ u.today.promptTokens + u.today.completionTokens }} токенів</span>
            </div>
            <div class="cost-card panel-soft frame-bordered">
              <span class="cost-label">Останні 7 днів</span>
              <strong class="cost-figure">{{ fmtUsd(u.last7d.costUsd) }}</strong>
              <span class="cost-sub">{{ u.last7d.calls }} викликів · {{ u.last7d.promptTokens + u.last7d.completionTokens }} токенів</span>
            </div>
          </div>
          <section class="panel panel-soft frame-bordered">
          <span class="section-label"><app-icon name="coin" /> За моделлю · 7 днів</span>
          <table class="data-table compact">
            <thead><tr><th>Модель</th><th>Виклики</th><th>Токени</th><th>Вартість</th></tr></thead>
            <tbody>
              @for (m of u.byModel; track m.model) {
                <tr>
                  <td>{{ m.model }}</td>
                  <td class="num">{{ m.calls }}</td>
                  <td class="num">{{ m.tokens }}</td>
                  <td class="num">{{ fmtUsd(m.costUsd) }}</td>
                </tr>
              }
              @if (u.byModel.length === 0) {
                <tr><td colspan="4" class="empty">Поки немає записів використання ШІ</td></tr>
              }
            </tbody>
          </table>
          <p class="hint">OpenRouter — точна вартість від провайдера; Anthropic — оцінка. Враховано і стрімові, і звичайні виклики.</p>
          </section>
        } @else {
          <p class="hint">Завантаження даних про витрати…</p>
        }
      }

      @if (tab() === 'board') {
        <p class="hint board-note">
          Прихована дошка терапевтів (тільки адмін). Сортування — за обсягом
          практики, НЕ за клінічними оцінками. Це насіння майбутнього
          каталогу «обери терапевта»; ачівки тут — тренувальні віхи проти
          AI-пацієнтів, не підтверджена компетентність.
        </p>
        <section class="panel panel-soft frame-bordered">
          <span class="section-label"><app-icon name="trophy" /> Дошка терапевтів · {{ board().length }}</span>
          <table class="data-table board-table">
          <thead>
            <tr>
              <th>Терапевт</th>
              <th>Рівень</th>
              <th class="num">Компетенція</th>
              <th class="num">Сесій</th>
              <th class="num">Бейджів</th>
              <th class="num">Пацієнтів</th>
              <th class="num">Активність</th>
            </tr>
          </thead>
          <tbody>
            @for (r of board(); track r.userId) {
              <tr>
                <td>
                  <div class="board-who">
                    <span class="board-name">{{ r.displayName || r.email }}</span>
                    @if (r.isAdmin) { <span class="board-admin">admin</span> }
                  </div>
                  @if (r.displayName) { <div class="board-email dim">{{ r.email }}</div> }
                </td>
                <td><span class="stage-chip">{{ r.stage }}</span></td>
                <td class="num">
                  <span class="comp-val">{{ r.meanCompetency }}</span><span class="dim">/100</span>
                </td>
                <td class="num">{{ r.sessionsCompleted }}</td>
                <td class="num">{{ r.badgeCount }}<span class="dim">/{{ r.awardableCount }}</span></td>
                <td class="num">
                  {{ r.patients }}
                  @if (r.lapsed > 0) { <span class="lapsed-tag" title="Пацієнтів покинуто (≥6 тиж.)"><span class="lapsed-dot"></span>{{ r.lapsed }}</span> }
                </td>
                <td class="num dim">{{ r.lastActiveAt ? (r.lastActiveAt | date: 'dd.MM.yy') : '—' }}</td>
              </tr>
            }
            @if (board().length === 0) {
              <tr><td colspan="7" class="empty">Поки немає терапевтів із завершеними сесіями</td></tr>
            }
          </tbody>
          </table>
        </section>
      }
    }

    @if (grantDialog(); as g) {
      <div class="modal-backdrop" (click)="closeGrantPlan()"></div>
      <div class="modal-card grant-modal" role="dialog" aria-modal="true" aria-labelledby="grant-title">
        <h3 id="grant-title">Грант плану</h3>
        <p class="grant-target">
          <strong>{{ g.user.email }}</strong>
          @if (g.user.plan) {
            <span class="dim"> · поточний: <code>{{ g.user.plan }}</code></span>
          }
        </p>

        <label class="field">
          <span>План</span>
          <select [ngModel]="g.plan" (ngModelChange)="updateGrantField('plan', $event)">
            <option value="trial">trial — 14 днів, обмежені сесії</option>
            <option value="lite">lite — базовий платний</option>
            <option value="pro">pro — повний доступ</option>
            <option value="master">master — все відкрито</option>
          </select>
        </label>

        <label class="field">
          <span>Місяців ({{ g.months }})</span>
          <input type="range" min="1" max="24" step="1"
                 [ngModel]="g.months"
                 (ngModelChange)="updateGrantField('months', +$event)">
          <span class="dim months-hint">
            Закінчиться: {{ grantExpiryPreview() | date: 'dd.MM.yyyy' }}
          </span>
        </label>

        <label class="field">
          <span>Примітка (для аудиту, опційно)</span>
          <textarea
            rows="2"
            placeholder="напр. «беспл. доступ для університетської групи Q2-2026»"
            [ngModel]="g.note"
            (ngModelChange)="updateGrantField('note', $event)"></textarea>
        </label>

        <div class="modal-actions">
          <button class="ghost" (click)="closeGrantPlan()" [disabled]="grantBusy()">
            Скасувати
          </button>
          <button class="primary" (click)="confirmGrantPlan()" [disabled]="grantBusy()">
            {{ grantBusy() ? '…' : 'Грантнути' }}
          </button>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .admin-header { margin-bottom: 24px; }
    .back { color: var(--fg-dim); text-decoration: none; font-size: 13px; }
    .back:hover { color: var(--accent); }
    h1 { margin: 12px 0 4px; font-size: 28px; }
    .subtitle { font-size: 13px; margin: 0 0 16px; }
    .dim { color: var(--fg-dim); }
    code { background: var(--user-bg); padding: 2px 6px; border-radius: 4px; font-size: 12px; }

    .tabs {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--border);
      overflow-x: auto;
      scrollbar-width: none;
    }
    .tabs::-webkit-scrollbar { display: none; }
    .tabs button {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--fg-dim);
      padding: 10px 14px 12px;
      font-size: 14px;
      cursor: pointer;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .tabs button:hover { color: var(--fg); }
    .tabs button.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    .tabs .count {
      background: var(--user-bg);
      color: var(--fg-dim);
      font-size: 11px;
      padding: 1px 7px;
      border-radius: 999px;
    }

    /* Tables now live inside .panel cards (the library frame provides the
       border/background), so the table itself carries no outer border —
       just the scroll container + row rules. */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 4px;
      font-size: 13px;
      display: block;
      overflow-x: auto;
    }
    /* Library section header inside an admin panel: icon + uppercase label,
       on its own line above the content. Mirrors cohorts/patient-detail. */
    .panel > .section-label {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 14px;
    }
    .section-label app-icon { font-size: 15px; color: var(--accent); }
    .data-table thead { background: var(--user-bg); }
    .data-table th, .data-table td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    .data-table th {
      font-weight: 500;
      color: var(--fg-dim);
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: .04em;
    }
    .data-table tbody tr:last-child td { border-bottom: none; }
    .data-table tbody tr {
      cursor: pointer;
      transition: background .12s ease;
    }
    .data-table tbody tr:hover { background: rgba(255,255,255,0.02); }
    .data-table tbody tr.selected { background: rgba(216, 201, 255, 0.08); }
    .num { font-variant-numeric: tabular-nums; color: var(--fg-dim); }
    .empty { text-align: center; color: var(--fg-dim); padding: 24px; }
    .message { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Cap the email column and let long synthetic addresses break, so the
       users table fits its content column without horizontal scroll. */
    .email-cell { max-width: 180px; overflow-wrap: anywhere; }

    /* ── Therapist board (§14) ── */
    .tabs button.board-tab { display: inline-flex; align-items: center; gap: 6px; }
    .tabs button.board-tab app-icon { font-size: 15px; }
    .board-note {
      max-width: 760px; line-height: 1.5; margin-bottom: 16px;
      padding: 10px 14px; border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border));
      background: color-mix(in srgb, var(--accent) 4%, transparent);
    }
    .board-table th.num, .board-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .board-who { display: flex; align-items: center; gap: 8px; }
    .board-name { font-weight: 500; }
    .board-admin {
      font-size: 10px; letter-spacing: .06em; text-transform: uppercase;
      color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
      border-radius: 999px; padding: 1px 7px;
    }
    .board-email { font-size: 11px; margin-top: 2px; }
    .stage-chip {
      display: inline-block; font-size: 12px; padding: 2px 10px; border-radius: 999px;
      color: var(--accent);
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border));
    }
    .comp-val { font-weight: 500; color: var(--fg); }
    .lapsed-tag { margin-left: 6px; font-size: 11px; color: var(--fg-dim); white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
    .lapsed-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-dim); display: inline-block; }

    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      letter-spacing: .02em;
      white-space: nowrap;
    }
    .badge.done { background: #143c2c; color: #6ee7b7; border: 1px solid #2a6f4d; }
    .badge.open { background: #3c2c14; color: #fbbf6e; border: 1px solid #6f5a2a; }
    .badge.admin-badge { background: rgba(216,201,255,0.15); color: var(--accent); border: 1px solid rgba(216,201,255,0.3); }
    .badge.instructor-badge { background: rgba(110,231,183,0.12); color: #6ee7b7; border: 1px solid #2a6f4d; margin-left: 4px; }
    .badge[class*="status-5"] { background: #3c1a1a; color: var(--danger); border: 1px solid #6f2a2a; }
    .badge[class*="status-4"] { background: #3c2c14; color: #fbbf6e; border: 1px solid #6f5a2a; }
    /* Plan badges: visually rank-ordered — neutral trial, accent for pro,
       brighter accent for master to mark "all-access" at a glance. */
    .plan-badge { text-transform: uppercase; font-weight: 500; font-size: 10px; }
    .plan-badge.plan-trial { background: var(--user-bg); color: var(--fg-dim); border: 1px solid var(--border); }
    .plan-badge.plan-lite { background: rgba(110,231,183,0.1); color: #6ee7b7; border: 1px solid #2a6f4d; }
    .plan-badge.plan-pro { background: rgba(216,201,255,0.15); color: var(--accent); border: 1px solid rgba(216,201,255,0.3); }
    .plan-badge.plan-master {
      background: linear-gradient(135deg, rgba(216,201,255,0.25), rgba(110,231,183,0.15));
      color: var(--accent);
      border: 1px solid var(--accent);
    }
    .plan-expiry { font-size: 11px; color: var(--fg-dim); margin-left: 6px; white-space: nowrap; }

    .filter-bar {
      padding: 8px 12px;
      background: rgba(216,201,255,0.06);
      border: 1px solid rgba(216,201,255,0.15);
      border-radius: 6px;
      font-size: 12px;
      margin-bottom: 12px;
      display: flex;
      gap: 12px;
      align-items: center;
    }

    button.small {
      padding: 4px 10px;
      font-size: 12px;
      min-height: auto;
    }
    /* Fixed-width, wrapping cluster: the four links (sessions, plan, admin
       toggle, instructor toggle) wrap into a tidy 2×2 instead of forcing
       the whole table wider than its column and clipping the toggles
       off-screen-right. Pair with .email-cell breaking to reclaim width. */
    .row-actions {
      display: flex;
      flex-wrap: wrap;
      width: 150px;
      column-gap: 9px;
      row-gap: 5px;
      align-items: center;
      align-content: center;
      justify-content: flex-end;
      white-space: normal;
      font-size: 12px;
    }
    .link-btn {
      background: transparent;
      border: none;
      color: var(--accent);
      cursor: pointer;
      font-size: 12px;
      padding: 0;
      min-height: auto;
    }
    .link-btn:hover { text-decoration: underline; }
    .link-btn:disabled {
      opacity: .5;
      cursor: not-allowed;
      text-decoration: none;
    }
    .link-btn.danger { color: var(--danger); }
    .self-tag {
      font-size: 10px;
      color: var(--fg-dim);
      margin-left: 4px;
      font-style: italic;
    }

    .session-detail {
      margin-top: 18px;
      background: var(--assistant-bg);
      border: 1px solid var(--accent);
      border-radius: 12px;
      padding: 16px 18px;
    }
    .session-detail header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
    }
    .session-detail h3 { margin: 0; font-size: 15px; font-weight: 500; }
    .session-detail details {
      margin-bottom: 12px;
      padding: 10px 12px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .session-detail summary {
      cursor: pointer;
      font-size: 13px;
      color: var(--fg);
      padding: 2px 0;
    }
    .session-detail details[open] summary {
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .transcript { list-style: none; padding: 0; margin: 0; }
    .transcript .line {
      padding: 8px 10px;
      margin: 4px 0;
      border-radius: 6px;
      font-size: 13px;
      line-height: 1.5;
    }
    .transcript .line.user { background: rgba(216,201,255,0.05); border-left: 2px solid var(--accent); }
    .transcript .line.assistant { background: var(--user-bg); border-left: 2px solid var(--fg-dim); }
    .transcript .line .role {
      display: block;
      font-size: 10px;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: .04em;
      margin-bottom: 3px;
    }
    .transcript .line .text { white-space: pre-wrap; }

    .feedback-raw, .json, .stack {
      white-space: pre-wrap;
      font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--fg);
      background: transparent;
      margin: 0;
      max-height: 400px;
      overflow-y: auto;
    }
    .stack { color: var(--fg-dim); }

    .error-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .error-list li {
      padding: 8px 10px;
      margin: 6px 0;
      background: rgba(208,116,116,0.04);
      border-left: 2px solid var(--danger);
      border-radius: 4px;
      font-size: 12px;
    }
    .error-list li code {
      display: block;
      margin-bottom: 4px;
      font-size: 11px;
    }
    .error-list li p { margin: 0 0 4px; color: var(--fg); }

    .stack-row { background: var(--bg); }
    .stack-row td { padding: 0; border: none; }
    .stack-row pre {
      padding: 12px 16px;
      max-height: 400px;
      overflow: auto;
      font-size: 11px;
    }

    .hint { color: var(--fg-dim); font-size: 13px; margin-top: 12px; }
    .hint.danger { color: var(--danger); }

    .provider {
      font-size: 10px;
      letter-spacing: .04em;
      text-transform: uppercase;
    }

    /* Cost dashboard */
    .cost-cards {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      margin: 8px 0 24px;
    }
    .cost-card {
      flex: 1;
      min-width: 200px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 18px 20px;
      border-radius: 14px;
    }
    .cost-label {
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--fg-dim);
    }
    .cost-figure {
      font-size: 28px;
      font-weight: 300;
      color: var(--accent);
      letter-spacing: -0.02em;
    }
    .cost-sub {
      font-size: 12px;
      color: var(--fg-dim);
    }

    /* Funnel widget */
    .funnel {
      max-width: 720px;
    }
    .funnel-steps {
      list-style: none;
      counter-reset: step;
      padding: 0;
      margin: 24px 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .funnel-steps li {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px 20px;
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
    }
    .step-num {
      width: 36px;
      height: 36px;
      flex-shrink: 0;
      border-radius: 50%;
      background: rgba(216, 201, 255, 0.12);
      color: var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 16px;
    }
    .step-meta {
      display: flex;
      flex-direction: column;
    }
    .step-meta strong {
      font-size: 22px;
      font-weight: 600;
    }
    .step-meta span {
      font-size: 13px;
      color: var(--fg-dim);
    }
    .step-meta em {
      color: var(--accent);
      font-style: normal;
      margin-left: 6px;
    }

    .data-table.compact th,
    .data-table.compact td {
      padding: 6px 10px;
      font-size: 12px;
    }

    /* Grant-plan modal — backdrop blocks the underlying list so clicks
       to close are obvious, card centers via fixed positioning + transform.
       Uses native HTML controls (select/input/textarea) for keyboard +
       a11y for free; the styling makes them match the dark shell. */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(2px);
      z-index: 100;
    }
    .modal-card {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 101;
      width: min(440px, calc(100vw - 32px));
      background: var(--assistant-bg);
      border: 1px solid var(--accent);
      border-radius: 14px;
      padding: 22px 24px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.55);
    }
    .modal-card h3 { margin: 0 0 4px; font-size: 18px; font-weight: 500; }
    .grant-target { font-size: 13px; margin: 0 0 18px; color: var(--fg); }
    .grant-target code { font-size: 11px; }

    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 16px;
    }
    .field > span:first-child {
      font-size: 12px;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .field select,
    .field input[type="range"],
    .field textarea {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--fg);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 14px;
      font-family: inherit;
    }
    .field select { cursor: pointer; }
    .field textarea { resize: vertical; min-height: 56px; }
    .field input[type="range"] {
      padding: 0;
      accent-color: var(--accent);
      cursor: pointer;
    }
    .months-hint { font-size: 11px; }

    .modal-actions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      margin-top: 8px;
    }
    .modal-actions button { padding: 8px 18px; font-size: 14px; }

    /* ── Responsive & touch ──────────────────────────────────────────────
       This dashboard is desktop-first (the operator is usually on a laptop),
       but it must not break on a phone. Data tables already scroll
       horizontally (.data-table is display:block; overflow-x:auto); below we
       trim chrome at narrow widths and—critically—grow the row-action
       tap targets on touch input, where the 12px mouse-scanning links are
       far below the 44px guideline (skill §2). */
    @media (max-width: 640px) {
      h1 { font-size: 22px; }
      .subtitle { font-size: 12px; }
      .data-table th, .data-table td { padding: 7px 10px; }
      .row-actions { width: auto; justify-content: flex-start; column-gap: 16px; }
      .cost-figure { font-size: 24px; }
      .session-detail { padding: 14px; }
      .funnel-steps li { padding: 12px 14px; gap: 12px; }
      .step-meta strong { font-size: 19px; }
    }
    /* Touch input (phone/tablet): the row-action text-links are intentionally
       12px for mouse scanning; on touch they must clear the 44px target and
       sit ≥8px apart (WCAG / Apple HIG / Material). */
    @media (pointer: coarse) {
      .link-btn, button.small {
        min-height: 44px;
        display: inline-flex;
        align-items: center;
      }
      .row-actions { row-gap: 8px; column-gap: 18px; }
      .tabs button { min-height: 44px; }
    }
    /* Remove the 300ms tap delay on the dashboard's interactive controls. */
    .tabs button,
    .link-btn,
    button.small,
    .modal-actions button,
    .data-table tbody tr { touch-action: manipulation; }
  `],
})
export class AdminComponent implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  tab = signal<Tab>('users');
  loading = signal(false);
  error = signal<string | null>(null);

  users = signal<AdminUser[]>([]);
  sessions = signal<AdminSessionListItem[]>([]);
  errors = signal<AdminErrorLog[]>([]);
  funnel = signal<AdminFunnel | null>(null);
  recentEvents = signal<AdminEvent[]>([]);
  llmUsage = signal<AdminLlmUsage | null>(null);
  board = signal<TherapistBoardRow[]>([]);

  /** Format a USD cost for display — keeps the `$` out of the backtick
   *  template (where `${` would start a JS interpolation). */
  fmtUsd(n: number): string {
    return '$' + (n ?? 0).toFixed(4);
  }

  selectedSession = signal<AdminSessionDetail | null>(null);
  expandedError = signal<number | null>(null);

  sessionFilter = signal<{ userId?: number }>({});

  /** id of the user whose admin toggle is currently in-flight — used to
   *  disable just that row's button without locking the rest of the table. */
  adminBusy = signal<number | null>(null);

  /** Same idea for the instructor-role toggle (independent of adminBusy so
   *  the two buttons on a row don't disable each other). */
  instructorBusy = signal<number | null>(null);

  /** Grant-plan modal state. null = closed. The whole dialog object lives
   *  here so the modal can read/write all four fields (user, plan, months,
   *  note) without four separate signals. */
  grantDialog = signal<GrantPlanDialog | null>(null);
  /** In-flight grant call — disables modal buttons. */
  grantBusy = signal(false);

  /** Reactive preview of when the granted plan will expire — recomputes
   *  whenever the modal's `months` slider moves. */
  grantExpiryPreview = computed(() => {
    const g = this.grantDialog();
    if (!g) return null;
    const d = new Date();
    d.setMonth(d.getMonth() + g.months);
    return d;
  });

  isAdmin = computed(() => this.auth.user()?.isAdmin === true);
  currentUserId = computed(() => this.auth.user()?.id ?? null);

  ngOnInit() {
    if (!this.isAdmin()) {
      this.error.set('Доступ заборонено. Цей розділ — тільки для адмінів.');
      return;
    }
    void this.loadCurrentTab();
  }

  setTab(t: Tab) {
    this.tab.set(t);
    void this.loadCurrentTab();
  }

  async loadCurrentTab() {
    this.error.set(null);
    this.loading.set(true);
    try {
      switch (this.tab()) {
        case 'users':
          this.users.set(await this.api.adminListUsers());
          break;
        case 'sessions':
          this.sessions.set(await this.api.adminListSessions(this.sessionFilter()));
          break;
        case 'errors':
          this.errors.set(await this.api.adminListErrors({ limit: 200 }));
          break;
        case 'funnel':
          const [f, recent] = await Promise.all([
            this.api.adminFunnel(),
            this.api.adminRecentEvents(50),
          ]);
          this.funnel.set(f);
          this.recentEvents.set(recent);
          break;
        case 'cost':
          this.llmUsage.set(await this.api.adminLlmUsage());
          break;
        case 'board':
          this.board.set(await this.api.adminTherapistBoard());
          break;
      }
    } catch (e: unknown) {
      const msg = (e as { error?: { message?: string }; message?: string })?.error?.message
        ?? (e as { message?: string })?.message
        ?? 'Не вдалось завантажити';
      this.error.set(msg);
    } finally {
      this.loading.set(false);
    }
  }

  filterByUser(userId: number) {
    this.sessionFilter.set({ userId });
    this.tab.set('sessions');
    void this.loadCurrentTab();
  }

  clearSessionFilter() {
    this.sessionFilter.set({});
    void this.loadCurrentTab();
  }

  async openSession(id: number) {
    if (this.selectedSession()?.id === id) {
      this.selectedSession.set(null);
      return;
    }
    try {
      const detail = await this.api.adminGetSession(id);
      this.selectedSession.set(detail);
    } catch (e: unknown) {
      this.error.set('Не вдалось отримати деталі сесії.');
    }
  }

  closeSession() {
    this.selectedSession.set(null);
  }

  async confirmDelete(id: number) {
    if (!confirm(`Видалити сесію #${id}? Ця дія незворотна — каскадно видаляться повідомлення, нотатки, фідбек, пам'ять.`)) return;
    try {
      await this.api.adminDeleteSession(id);
      this.sessions.update((list) => list.filter((s) => s.id !== id));
      if (this.selectedSession()?.id === id) this.selectedSession.set(null);
    } catch {
      this.error.set('Не вдалось видалити сесію.');
    }
  }

  toggleErrorExpand(id: number) {
    this.expandedError.set(this.expandedError() === id ? null : id);
  }

  /**
   * Grant admin rights to the target user. Confirms first so a misclick
   * on someone's row doesn't quietly hand them the keys. Updates the
   * local row in-place — no full reload, the rest of the table stays put.
   */
  async grantAdmin(user: AdminUser) {
    if (!confirm(`Зробити ${user.email} адміністратором?\n\nВін отримає доступ до сесій усіх користувачів, помилок та може видавати/відкликати адмін-права іншим.`)) return;
    this.adminBusy.set(user.id);
    try {
      const updated = await this.api.adminGrantAdmin(user.id);
      this.users.update((list) =>
        list.map((u) => (u.id === user.id ? { ...u, isAdmin: updated.isAdmin } : u)),
      );
    } catch (e: unknown) {
      const msg = (e as { error?: { message?: string } })?.error?.message ?? 'Не вдалось видати права.';
      alert(msg);
    } finally {
      this.adminBusy.set(null);
    }
  }

  /**
   * Revoke admin rights. Confirms because losing admin is non-trivial
   * (the user is signed in right now and will lose access on next
   * /admin* request). Backend refuses to remove the last admin — that
   * error bubbles up via alert so the caller sees why nothing happened.
   */
  async revokeAdmin(user: AdminUser) {
    const isSelf = user.id === this.currentUserId();
    const msg = isSelf
      ? 'Відкликати власні адмін-права? Ти більше не зможеш керувати адмінкою.'
      : `Відкликати адмін-права в ${user.email}?`;
    if (!confirm(msg)) return;
    this.adminBusy.set(user.id);
    try {
      const updated = await this.api.adminRevokeAdmin(user.id);
      this.users.update((list) =>
        list.map((u) => (u.id === user.id ? { ...u, isAdmin: updated.isAdmin } : u)),
      );
    } catch (e: unknown) {
      const errMsg = (e as { error?: { message?: string } })?.error?.message ?? 'Не вдалось відкликати права.';
      alert(errMsg);
    } finally {
      this.adminBusy.set(null);
    }
  }

  /**
   * Grant or revoke the instructor role (can create teaching cohorts).
   * Lower-stakes than admin — no confirm dialog, no last-instructor guard.
   * Updates the row in-place so the badge flips without a full reload.
   */
  async setInstructor(user: AdminUser, value: boolean) {
    this.instructorBusy.set(user.id);
    try {
      const updated = await this.api.adminSetInstructor(user.id, value);
      this.users.update((list) =>
        list.map((u) => (u.id === user.id ? { ...u, isInstructor: updated.isInstructor } : u)),
      );
      // If the admin toggled their OWN role, patch the cached auth user so
      // instructor features (the /cohorts block + nav) take effect at once,
      // without waiting for the next token refresh or a re-login.
      if (updated.id === this.currentUserId()) {
        const cur = this.auth.user();
        if (cur) this.auth.applyProfileUpdate({ ...cur, isInstructor: updated.isInstructor });
      }
    } catch (e: unknown) {
      const msg = (e as { error?: { message?: string } })?.error?.message ?? 'Не вдалось змінити роль інструктора.';
      alert(msg);
    } finally {
      this.instructorBusy.set(null);
    }
  }

  /**
   * Open the grant-plan modal. Pre-fills the plan with what the user
   * already has so a misclick on someone's row doesn't accidentally
   * change anything — admin has to flip the dropdown to confirm intent.
   * Falls back to 'pro' as the most common grant when subscription
   * data is missing (shouldn't happen post-bootstrap, but defensive).
   */
  openGrantPlan(user: AdminUser) {
    this.grantDialog.set({
      user,
      plan: (user.plan ?? 'pro') as PlanId,
      months: 12,
      note: '',
    });
  }

  closeGrantPlan() {
    if (this.grantBusy()) return;  // don't lose in-flight context on backdrop click
    this.grantDialog.set(null);
  }

  /** Escape closes the grant-plan modal (a11y: every modal needs a keyboard
   *  escape route). Guarded by closeGrantPlan() so an in-flight grant isn't
   *  abandoned mid-request. No-op when no modal is open. */
  onEscape() {
    if (this.grantDialog()) this.closeGrantPlan();
  }

  /**
   * Patch a single field of the grant dialog. Avoids the awkwardness of
   * deep ngModel binding on a signal'd object — child controls call this
   * with the new value, we rebuild the object immutably.
   */
  updateGrantField<K extends keyof GrantPlanDialog>(key: K, value: GrantPlanDialog[K]) {
    const current = this.grantDialog();
    if (!current) return;
    this.grantDialog.set({ ...current, [key]: value });
  }

  async confirmGrantPlan() {
    const g = this.grantDialog();
    if (!g) return;
    this.grantBusy.set(true);
    try {
      const result = await this.api.adminGrantPlan(
        g.user.id,
        g.plan,
        g.months,
        g.note.trim() || undefined,
      );
      // Update the row in-place so the operator sees confirmation without
      // a full table reload — full reload would lose scroll position and
      // any filters they had set.
      this.users.update((list) =>
        list.map((u) =>
          u.id === g.user.id
            ? {
                ...u,
                plan: result.plan,
                planStatus: result.status,
                planEndsAt: result.currentPeriodEnd,
                // Reset session counter — grantPlan starts a fresh period.
                sessionsThisPeriod: 0,
              }
            : u,
        ),
      );
      this.grantDialog.set(null);
    } catch (e: unknown) {
      const errMsg = (e as { error?: { message?: string } })?.error?.message ?? 'Не вдалось грантнути план.';
      alert(errMsg);
    } finally {
      this.grantBusy.set(false);
    }
  }
}
