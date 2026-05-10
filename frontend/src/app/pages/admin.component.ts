import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  AdminErrorLog,
  AdminSessionDetail,
  AdminSessionListItem,
  AdminUser,
  ApiService,
} from '../api.service';
import { AuthService } from '../auth.service';

type Tab = 'users' | 'sessions' | 'errors';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [CommonModule, DatePipe, RouterLink],
  template: `
    <header class="admin-header">
      <a routerLink="/" class="back">← На головну</a>
      <h1>Admin panel</h1>
      <p class="subtitle dim">
        Доступ для адмінів. Налаштуй <code>ADMIN_EMAILS</code> у серверному <code>.env</code>.
      </p>

      <nav class="tabs">
        <button [class.active]="tab() === 'users'" (click)="setTab('users')">
          👥 Користувачі
          @if (users().length) { <span class="count">{{ users().length }}</span> }
        </button>
        <button [class.active]="tab() === 'sessions'" (click)="setTab('sessions')">
          💬 Сесії
          @if (sessions().length) { <span class="count">{{ sessions().length }}</span> }
        </button>
        <button [class.active]="tab() === 'errors'" (click)="setTab('errors')">
          🐛 Помилки
          @if (errors().length) { <span class="count">{{ errors().length }}</span> }
        </button>
      </nav>
    </header>

    @if (loading()) {
      <p class="hint">Завантаження…</p>
    } @else if (error()) {
      <p class="hint danger">{{ error() }}</p>
    } @else {

      @if (tab() === 'users') {
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Email</th>
              <th>Ім'я</th>
              <th>Вхід</th>
              <th>Сесій</th>
              <th>Admin</th>
              <th>Створено</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (u of users(); track u.id) {
              <tr>
                <td class="num">{{ u.id }}</td>
                <td>{{ u.email }}</td>
                <td>{{ u.displayName || '—' }}</td>
                <td><code class="provider">{{ u.provider }}</code></td>
                <td class="num">{{ u.sessionCount }}</td>
                <td>@if (u.isAdmin) { <span class="badge admin-badge">admin</span> }</td>
                <td class="dim">{{ u.createdAt | date: 'dd.MM.yyyy' }}</td>
                <td><button class="link-btn" (click)="filterByUser(u.id)">сесії →</button></td>
              </tr>
            }
            @if (users().length === 0) {
              <tr><td colspan="8" class="empty">Ні одного користувача</td></tr>
            }
          </tbody>
        </table>
      }

      @if (tab() === 'sessions') {
        @if (sessionFilter().userId != null) {
          <div class="filter-bar">
            Фільтр: користувач #{{ sessionFilter().userId }}
            <button class="link-btn" (click)="clearSessionFilter()">× очистити</button>
          </div>
        }
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
              <tr><td colspan="6" class="empty">Помилок не зареєстровано 👌</td></tr>
            }
          </tbody>
        </table>
      }
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

    .data-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 16px;
      font-size: 13px;
      display: block;
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
    }
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
    .badge[class*="status-5"] { background: #3c1a1a; color: var(--danger); border: 1px solid #6f2a2a; }
    .badge[class*="status-4"] { background: #3c2c14; color: #fbbf6e; border: 1px solid #6f5a2a; }

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
    .row-actions {
      display: flex;
      gap: 10px;
      align-items: center;
      white-space: nowrap;
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

  selectedSession = signal<AdminSessionDetail | null>(null);
  expandedError = signal<number | null>(null);

  sessionFilter = signal<{ userId?: number }>({});

  isAdmin = computed(() => this.auth.user()?.isAdmin === true);

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
}
