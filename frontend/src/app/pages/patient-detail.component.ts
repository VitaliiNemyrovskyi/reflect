import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, PatientCard, ProgressBadge } from '../api.service';

/**
 * One section of the patient profile, extracted from `## N. Title` headings.
 * Spoiler sections (Прихований шар, Як вона поведеться на сесії, Що НЕ робить)
 * are answer-keys for the simulation — the student SHOULD see them only after
 * trying the case, otherwise it's just reading a script.
 */
interface ProfileSection {
  number: string | null; // "1", "2", etc. — null if unnumbered
  title: string;
  bodyHtml: string; // pre-rendered markdown→HTML
  bodyText: string; // raw markdown (for excerpts)
  isSpoiler: boolean;
  icon: string;
}

type TabKey = 'overview' | 'profile' | 'sessions' | 'notes' | 'progress';

/**
 * Match section titles by keyword to assign an emoji icon. The match is
 * lowercase + Cyrillic-aware. Order matters — first match wins.
 */
const SECTION_ICONS: { test: RegExp; icon: string }[] = [
  { test: /базов[іиое]|відомост/i, icon: '👤' },
  { test: /біографі/i, icon: '📜' },
  { test: /поточн|ситуаці/i, icon: '⏱' },
  { test: /приве|запит|сесі/i, icon: '🎯' },
  { test: /говорит|мов|афект|голос/i, icon: '💬' },
  { test: /прихова|hidden|під[\s-]поверх/i, icon: '🔒' },
  { test: /поведет|першій сесі|першої сесі/i, icon: '🎬' },
  { test: /не робит|чого уник|що.*не/i, icon: '🚫' },
];

const SPOILER_PATTERNS: RegExp[] = [
  /прихован/i,
  /поведет.*сесі|на першій сесі|на 1[-\s]?(й|шій)? сесі/i,
  /\bне робит/i,
  /що.+не озвуч/i,
];

@Component({
  selector: 'app-patient-detail',
  standalone: true,
  imports: [CommonModule, RouterLink, DatePipe],
  template: `
    @if (loading()) {
      <p class="hint">Завантаження…</p>
    } @else if (!patient()) {
      <p class="hint danger">Картку пацієнта не знайдено.</p>
    } @else {
      <header class="patient-header">
        <a routerLink="/" class="back">← Усі пацієнти</a>
        <div class="header-row">
          <div class="header-identity">
            @if (patient()!.avatarUrl) {
              <img class="header-avatar" [src]="patient()!.avatarUrl" [alt]="patient()!.displayName" />
            } @else {
              <div class="header-avatar fallback">{{ patient()!.displayName.charAt(0) }}</div>
            }
            <div class="header-text">
              <h1>{{ patient()!.displayName }}</h1>
              @if (patient()!.diagnosis) {
                <p class="diagnosis-line" [title]="diagnosisTooltip()">
                  <span class="diagnosis-icon">⊕</span>
                  {{ patient()!.diagnosis }}
                  @if (patient()!.diagnosisCode) {
                    <span class="diagnosis-code-hint" aria-hidden="true">ⓘ</span>
                  }
                </p>
              }
              <div class="header-chips">
                <span class="chip-meta">
                  {{ patient()!.sessionCount }} {{ sessionsWord(patient()!.sessionCount) }}
                </span>
                @if (patient()!.sessions[0]; as last) {
                  <span class="chip-meta dim">
                    остання {{ last.startedAt | date: 'dd.MM.yyyy' }}
                  </span>
                }
                <span class="badge" [class]="'badge-' + patient()!.progressBadge">
                  {{ badgeText(patient()!.progressBadge) }}
                </span>
                @if (patient()!.difficulty != null) {
                  <span class="chip-rating"
                        [title]="'Поведінка ' + patient()!.difficulty + '/5 — наскільки складно встановити контакт'">
                    Поведінка
                    <span class="stars">{{ stars(patient()!.difficulty!) }}</span>
                  </span>
                }
                @if (patient()!.complexity != null) {
                  <span class="chip-rating"
                        [title]="'Тяжкість ' + patient()!.complexity + '/5 — клінічна серйозність випадку'">
                    Тяжкість
                    <span class="dots">{{ dots(patient()!.complexity!) }}</span>
                  </span>
                }
              </div>
            </div>
          </div>
          <button class="primary new-session-btn" (click)="newSession()">Нова сесія</button>
        </div>
      </header>

      <nav class="tabs" role="tablist">
        @for (t of tabs; track t.key) {
          <button [class.active]="tab() === t.key"
                  (click)="tab.set(t.key)"
                  [attr.role]="'tab'"
                  [attr.aria-selected]="tab() === t.key">
            <span class="tab-icon" aria-hidden="true">{{ t.icon }}</span>
            <span class="tab-label">{{ t.label }}</span>
            @if (t.count != null && t.count(patient()!) > 0) {
              <span class="tab-count">{{ t.count(patient()!) }}</span>
            }
          </button>
        }
      </nav>

      <section class="tab-content">
        @if (tab() === 'overview') {
          <div class="overview-grid">
            @if (basicsSection()) {
              <article class="card">
                <h3>👤 Базові відомості</h3>
                <div class="card-body" [innerHTML]="basicsSection()!.bodyHtml"></div>
              </article>
            }

            @if (presentingComplaint()) {
              <article class="card">
                <h3>🎯 Запит на терапію</h3>
                <p class="presenting-line">«{{ presentingComplaint() }}»</p>
                <p class="presenting-meta">
                  Як пацієнтка б озвучила його сама на першій сесії.
                </p>
              </article>
            }

            @if (voiceSection()) {
              <article class="card">
                <h3>💬 Як вона говорить</h3>
                <div class="card-body" [innerHTML]="voiceSection()!.bodyHtml"></div>
              </article>
            }

            @if (latestAssessment()) {
              <article class="card">
                <h3>📊 Остання оцінка стану</h3>
                <div class="metrics-mini">
                  @for (m of patientMetricsList; track m.key) {
                    <div class="metric-row">
                      <span class="metric-label">{{ m.label }}</span>
                      <div class="metric-bar">
                        <div class="metric-bar-fill"
                             [style.width.%]="(latestAssessment()?.patient?.[m.key] ?? 0) * 10">
                        </div>
                      </div>
                      <span class="metric-value">{{ latestAssessment()?.patient?.[m.key] ?? '—' }}/10</span>
                    </div>
                  }
                </div>
              </article>
            }

            @if (patient()!.recentFeedback) {
              <article class="card card-wide">
                <h3>📝 Останній фідбек супервізора</h3>
                <pre class="feedback-preview">{{ recentFeedbackPreview() }}</pre>
                @if (patient()!.sessions[0]) {
                  <a [routerLink]="['/session', patient()!.sessions[0].id, 'feedback']" class="link-btn">
                    Повний фідбек →
                  </a>
                }
              </article>
            }
          </div>
        }

        @if (tab() === 'profile') {
          @if (profileSections().length === 0) {
            <p class="hint">Профіль не парситься у структуру — показую сирий текст.</p>
            <article class="card">
              <pre class="profile-fallback">{{ patient()!.profileText }}</pre>
            </article>
          } @else {
            @if (disclaimerHtml()) {
              <aside class="profile-disclaimer">
                <span class="disclaimer-icon">ⓘ</span>
                <div class="disclaimer-body" [innerHTML]="disclaimerHtml()!"></div>
              </aside>
            }
            <div class="profile-sections">
              @for (s of profileSections(); track s.title; let i = $index) {
                <article class="card section-card"
                         [class.spoiler]="s.isSpoiler"
                         [class.collapsed]="!isOpen(i, s.isSpoiler)">
                  <header class="section-head" (click)="toggle(i)">
                    <span class="section-icon" aria-hidden="true">{{ s.icon }}</span>
                    <h3 class="section-title">
                      @if (s.number) { <span class="section-number">{{ s.number }}.</span> }
                      {{ s.title }}
                    </h3>
                    @if (s.isSpoiler) {
                      <span class="spoiler-tag" title="Це — клінічна підказка / відповідь. Дивись після того, як спробуєш кейс самостійно.">
                        🔒 Підказка
                      </span>
                    }
                    <span class="section-toggle" aria-hidden="true">
                      {{ isOpen(i, s.isSpoiler) ? '▾' : '▸' }}
                    </span>
                  </header>
                  @if (isOpen(i, s.isSpoiler)) {
                    <div class="section-body" [innerHTML]="s.bodyHtml"></div>
                  } @else if (s.isSpoiler) {
                    <p class="spoiler-warn">
                      Цей розділ — клінічна підказка (як насправді влаштована пацієнтка
                      і як вона поведеться). Він спойлерить кейс. Розгорни лише якщо
                      хочеш звірити свою гіпотезу або ти вже провела сесію.
                    </p>
                  }
                </article>
              }
            </div>
          }
        }

        @if (tab() === 'sessions') {
          @if (patient()!.sessions.length === 0) {
            <p class="hint">Сесій з цією пацієнткою ще не було. <button class="link-btn" (click)="newSession()">Почати першу</button></p>
          } @else {
            <ul class="sessions-list">
              @for (s of patient()!.sessions; track s.id) {
                <li class="session-item">
                  <header class="session-head">
                    <div>
                      <span class="session-id">Сесія #{{ s.id }}</span>
                      <span class="session-date">{{ s.startedAt | date: 'dd.MM.yyyy HH:mm' }}</span>
                    </div>
                    <div>
                      @if (s.endedAt) {
                        <span class="session-status done">Завершена</span>
                      } @else {
                        <span class="session-status open">У процесі</span>
                      }
                    </div>
                  </header>
                  <div class="session-stats">
                    {{ s.messageCount }} реплік · {{ s.noteCount }} нотаток
                    @if (s.assessment?.patient?.symptomSeverity != null) {
                      · симптоми {{ s.assessment!.patient!.symptomSeverity }}/10
                    }
                  </div>
                  @if (s.feedbackPreview) {
                    <p class="session-preview">{{ s.feedbackPreview }}</p>
                  }
                  <div class="session-actions">
                    <a [routerLink]="['/session', s.id, 'view']" class="link-btn">Транскрипт</a>
                    @if (s.endedAt) {
                      <a [routerLink]="['/session', s.id, 'feedback']" class="link-btn">Повний фідбек</a>
                    } @else {
                      <a [routerLink]="['/session', s.id]" class="link-btn">Продовжити</a>
                    }
                  </div>
                </li>
              }
            </ul>
          }
        }

        @if (tab() === 'notes') {
          @if (patient()!.notes.length === 0) {
            <p class="hint">Жодної нотатки. Виділяй текст під час сесії — нотатки потраплять сюди.</p>
          } @else {
            <ul class="notes-aggregated">
              @for (n of patient()!.notes; track n.id) {
                <li class="note-item">
                  @if (n.anchorText) {
                    <blockquote class="anchor">«{{ n.anchorText }}»</blockquote>
                  }
                  <p class="note-body">{{ n.noteText }}</p>
                  <footer class="note-meta">
                    Сесія #{{ n.sessionId }} · {{ n.createdAt | date: 'dd.MM.yyyy' }}
                  </footer>
                </li>
              }
            </ul>
          }
        }

        @if (tab() === 'progress') {
          @if (chartTrends().length === 0) {
            <p class="hint">Прогрес-графіки з'являться після першої завершеної сесії з фідбеком.</p>
          } @else {
            <div class="charts-section">
              <h3>Стан клієнтки (1-10)</h3>
              <div class="charts-grid">
                @for (t of patientTrends(); track t.metric) {
                  <article class="chart-card">
                    <h4>{{ trendLabel(t.metric) }}</h4>
                    <svg class="chart-svg" viewBox="0 0 200 80" preserveAspectRatio="none">
                      <polyline
                        [attr.points]="trendPolyline(t)"
                        fill="none"
                        stroke="var(--accent)"
                        stroke-width="2" />
                      @for (p of trendCircles(t); track $index) {
                        <circle [attr.cx]="p.x" [attr.cy]="p.y" r="3" fill="var(--accent)" />
                      }
                    </svg>
                    <div class="chart-axis">
                      @for (s of t.series; track s.sessionId) {
                        <span class="axis-tick">{{ s.value ?? '—' }}</span>
                      }
                    </div>
                  </article>
                }
              </div>

              <h3>Компетенції терапевта (0-6)</h3>
              <div class="charts-grid">
                @for (t of therapistTrends(); track t.metric) {
                  <article class="chart-card">
                    <h4>{{ trendLabel(t.metric) }}</h4>
                    <svg class="chart-svg" viewBox="0 0 200 80" preserveAspectRatio="none">
                      <polyline
                        [attr.points]="trendPolyline(t, 6)"
                        fill="none"
                        stroke="var(--accent)"
                        stroke-width="2" />
                    </svg>
                    <div class="chart-axis">
                      @for (s of t.series; track s.sessionId) {
                        <span class="axis-tick">{{ s.value ?? '—' }}</span>
                      }
                    </div>
                  </article>
                }
              </div>
            </div>
          }
        }
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .hint { color: var(--fg-dim); }
    .hint.danger { color: var(--danger); }

    .patient-header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 18px;
      margin-bottom: 18px;
    }
    @media (max-width: 720px) {
      .patient-header {
        position: sticky;
        top: 0;
        background: var(--bg);
        z-index: 5;
        margin: 0 -20px 12px;
        padding: 12px 20px 14px;
        border-bottom: 1px solid var(--border);
      }
    }
    .back {
      color: var(--fg-dim);
      text-decoration: none;
      font-size: 13px;
    }
    .back:hover { color: var(--accent); }

    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-top: 12px;
      gap: 16px;
    }
    .header-identity {
      display: flex;
      gap: 16px;
      align-items: flex-start;
      flex: 1;
      min-width: 0;
    }
    .header-avatar {
      width: 76px;
      height: 76px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--user-bg);
      border: 1px solid var(--border);
      flex-shrink: 0;
    }
    .header-avatar.fallback {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      font-weight: 500;
      color: var(--accent);
    }
    .header-text { min-width: 0; flex: 1; }
    .header-text h1 { margin: 0; font-size: 28px; line-height: 1.15; }
    .diagnosis-line {
      margin: 6px 0 0;
      font-size: 14px;
      color: var(--accent);
      line-height: 1.4;
      cursor: help;
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
    }
    .diagnosis-icon {
      font-size: 11px;
      opacity: 0.7;
    }
    .diagnosis-code-hint {
      color: var(--fg-dim);
      font-size: 11px;
      vertical-align: super;
      margin-left: 2px;
    }
    .header-chips {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
      align-items: center;
    }
    .chip-meta, .chip-rating {
      font-size: 12px;
      padding: 3px 9px;
      background: var(--user-bg);
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--fg);
      letter-spacing: .01em;
    }
    .chip-meta.dim { color: var(--fg-dim); }
    .chip-rating {
      cursor: help;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--fg-dim);
    }
    .chip-rating .stars { color: var(--warn); letter-spacing: 1.5px; }
    .chip-rating .dots { color: var(--danger); letter-spacing: 1px; }

    .new-session-btn { flex-shrink: 0; }

    .badge {
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: .02em;
    }
    .badge-improving { background: #143c2c; color: #6ee7b7; border: 1px solid #2a6f4d; }
    .badge-stable { background: #2a2a32; color: var(--fg-dim); border: 1px solid var(--border); }
    .badge-worsening { background: #3c1a1a; color: var(--danger); border: 1px solid #6f2a2a; }
    .badge-unknown { background: var(--user-bg); color: var(--fg-dim); border: 1px dashed var(--border); }

    @media (max-width: 720px) {
      .header-row {
        flex-direction: column;
        align-items: stretch;
      }
      .header-text h1 { font-size: 22px; }
      .header-avatar { width: 60px; height: 60px; }
      .header-avatar.fallback { font-size: 24px; }
      .new-session-btn { width: 100%; }
    }

    .tabs {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 18px;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
      -ms-overflow-style: none;
      padding: 0 0 0;
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
      flex-shrink: 0;
      min-height: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 6px 6px 0 0;
      transition: color .15s ease, background .15s ease, border-color .15s ease;
    }
    .tabs button:hover {
      color: var(--fg);
      background: var(--user-bg);
    }
    .tabs button.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
      background: rgba(216, 201, 255, 0.06);
    }
    .tab-icon { font-size: 14px; }
    .tab-label { font-weight: 500; }
    .tab-count {
      background: var(--user-bg);
      color: var(--fg-dim);
      font-size: 11px;
      padding: 1px 7px;
      border-radius: 999px;
      margin-left: 2px;
    }
    .tabs button.active .tab-count {
      background: rgba(216, 201, 255, 0.15);
      color: var(--accent);
    }
    @media (max-width: 480px) {
      .tab-label { display: none; }
      .tabs button { padding: 10px 12px 12px; }
      .tab-icon { font-size: 18px; }
    }

    .tab-content { padding-bottom: 40px; }

    .card {
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 20px;
    }
    .card h3 {
      margin: 0 0 12px;
      font-size: 13px;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: .04em;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .overview-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      align-items: start;
    }
    .card-wide { grid-column: 1 / -1; }
    @media (max-width: 720px) {
      .overview-grid { grid-template-columns: 1fr; }
      .card-wide { grid-column: auto; }
    }

    .card-body {
      font-size: 14px;
      line-height: 1.65;
      color: var(--fg);
    }
    .card-body p { margin: 0 0 8px; }
    .card-body p:last-child { margin-bottom: 0; }
    .card-body ul {
      margin: 4px 0 8px;
      padding-left: 22px;
    }
    .card-body li { margin: 3px 0; }
    .card-body strong { color: var(--accent); font-weight: 500; }
    .card-body em { color: var(--fg); font-style: italic; }
    .card-body h4 {
      margin: 14px 0 6px;
      font-size: 13px;
      color: var(--fg);
      font-weight: 500;
    }

    .presenting-line {
      font-size: 15px;
      line-height: 1.55;
      margin: 0 0 10px;
      color: var(--fg);
      font-style: italic;
      border-left: 2px solid var(--accent);
      padding-left: 12px;
    }
    .presenting-meta {
      margin: 0;
      font-size: 12px;
      color: var(--fg-dim);
    }

    .feedback-preview {
      white-space: pre-wrap;
      font: inherit;
      font-size: 13px;
      color: var(--fg-dim);
      margin: 0;
      line-height: 1.6;
    }
    .link-btn {
      display: inline-block;
      margin-top: 10px;
      color: var(--accent);
      text-decoration: none;
      font-size: 13px;
      background: transparent;
      border: none;
      padding: 0;
      cursor: pointer;
    }
    .link-btn:hover { text-decoration: underline; }

    .metrics-mini { display: flex; flex-direction: column; gap: 8px; }
    .metric-row {
      display: grid;
      grid-template-columns: 130px 1fr 50px;
      align-items: center;
      gap: 10px;
      font-size: 13px;
    }
    .metric-label { color: var(--fg-dim); }
    .metric-bar {
      height: 6px;
      background: var(--user-bg);
      border-radius: 3px;
      overflow: hidden;
    }
    .metric-bar-fill {
      height: 100%;
      background: var(--accent);
    }
    .metric-value { color: var(--fg); text-align: right; font-variant-numeric: tabular-nums; }

    .profile-disclaimer {
      display: flex;
      gap: 10px;
      padding: 12px 14px;
      background: rgba(216, 201, 255, 0.05);
      border: 1px solid rgba(216, 201, 255, 0.15);
      border-radius: 8px;
      margin-bottom: 14px;
      font-size: 12px;
      color: var(--fg-dim);
      line-height: 1.5;
    }
    .disclaimer-icon { color: var(--accent); flex-shrink: 0; }
    .disclaimer-body { flex: 1; }
    .disclaimer-body p { margin: 0 0 6px; }
    .disclaimer-body p:last-child { margin-bottom: 0; }

    .profile-sections {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .section-card { padding: 0; }
    .section-card .section-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 18px;
      cursor: pointer;
      user-select: none;
    }
    .section-card.collapsed .section-head:hover {
      background: var(--user-bg);
      border-radius: 10px;
    }
    .section-icon {
      font-size: 20px;
      flex-shrink: 0;
    }
    .section-title {
      flex: 1;
      margin: 0;
      font-size: 15px;
      font-weight: 500;
      text-transform: none;
      letter-spacing: 0;
      color: var(--fg);
      display: inline-flex;
      align-items: baseline;
      gap: 8px;
    }
    .section-number {
      color: var(--fg-dim);
      font-weight: 400;
      font-variant-numeric: tabular-nums;
    }
    .section-toggle {
      color: var(--fg-dim);
      font-size: 14px;
      flex-shrink: 0;
    }
    .section-card .section-body {
      padding: 0 18px 18px;
      font-size: 14px;
      line-height: 1.7;
      color: var(--fg);
    }
    .section-card .section-body p { margin: 0 0 10px; }
    .section-card .section-body p:last-child { margin-bottom: 0; }
    .section-card .section-body ul {
      margin: 6px 0 10px;
      padding-left: 22px;
    }
    .section-card .section-body li { margin: 4px 0; }
    .section-card .section-body strong { color: var(--accent); font-weight: 500; }
    .section-card .section-body em { font-style: italic; }
    .section-card .section-body h4 {
      margin: 14px 0 6px;
      font-size: 14px;
      font-weight: 500;
      color: var(--fg);
    }

    .section-card.spoiler {
      border-color: rgba(216, 201, 255, 0.25);
      border-style: dashed;
      background: rgba(216, 201, 255, 0.03);
    }
    .section-card.spoiler .section-head { color: var(--fg-dim); }
    .section-card.spoiler .section-title { color: var(--fg-dim); font-style: italic; }
    .spoiler-tag {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(216, 201, 255, 0.1);
      border: 1px solid rgba(216, 201, 255, 0.3);
      color: var(--accent);
      letter-spacing: .02em;
      flex-shrink: 0;
    }
    .spoiler-warn {
      padding: 0 18px 16px;
      margin: 0;
      font-size: 12px;
      color: var(--fg-dim);
      line-height: 1.5;
      font-style: italic;
    }

    .profile-fallback {
      white-space: pre-wrap;
      font: inherit;
      font-size: 13px;
      line-height: 1.6;
      margin: 0;
    }

    .sessions-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .session-item {
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 18px;
    }
    .session-head { display: flex; justify-content: space-between; align-items: baseline; }
    .session-id { font-weight: 500; }
    .session-date { color: var(--fg-dim); font-size: 13px; margin-left: 8px; }
    .session-stats { color: var(--fg-dim); font-size: 12px; margin-top: 6px; }
    .session-preview { color: var(--fg-dim); font-size: 13px; line-height: 1.5; margin: 8px 0 0; }
    .session-status { font-size: 12px; padding: 2px 8px; border-radius: 999px; }
    .session-status.done { background: #143c2c; color: #6ee7b7; }
    .session-status.open { background: #3c2c14; color: #fbbf6e; }
    .session-actions { margin-top: 8px; display: flex; gap: 14px; }

    .notes-aggregated { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .note-item {
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
    }
    .anchor {
      margin: 0 0 6px;
      padding: 0 0 0 8px;
      border-left: 2px solid var(--accent);
      color: var(--fg-dim);
      font-size: 12px;
      font-style: italic;
    }
    .note-body { margin: 0; font-size: 14px; }
    .note-meta { color: var(--fg-dim); font-size: 11px; margin-top: 6px; }

    .charts-section h3 {
      margin: 0 0 12px;
      font-size: 13px;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: .05em;
      font-weight: 500;
    }
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .chart-card {
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
    }
    .chart-card h4 { margin: 0 0 10px; font-size: 13px; }
    .chart-svg {
      width: 100%;
      height: 60px;
      display: block;
    }
    .chart-axis {
      display: flex;
      justify-content: space-between;
      gap: 4px;
      font-size: 10px;
      color: var(--fg-dim);
      margin-top: 4px;
      font-variant-numeric: tabular-nums;
    }
  `],
})
export class PatientDetailComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  loading = signal(true);
  patient = signal<PatientCard | null>(null);
  tab = signal<TabKey>('overview');

  /** Tabs config — drives the nav rendering with icons + counts. */
  tabs: { key: TabKey; label: string; icon: string; count?: (p: PatientCard) => number }[] = [
    { key: 'overview', label: 'Огляд', icon: '📋' },
    { key: 'profile', label: 'Профіль', icon: '📜' },
    { key: 'sessions', label: 'Сесії', icon: '💬', count: (p) => p.sessionCount },
    { key: 'notes', label: 'Нотатки', icon: '🔖', count: (p) => p.notes.length },
    { key: 'progress', label: 'Прогрес', icon: '📈' },
  ];

  /** Tracks which collapsible sections are open. Spoiler sections default
   *  to closed; non-spoilers default to open. */
  private sectionOpen = signal<Record<number, boolean>>({});

  patientMetricsList = [
    { key: 'symptomSeverity' as const, label: 'Симптомна тяжкість' },
    { key: 'insight' as const, label: 'Інсайт' },
    { key: 'alliance' as const, label: 'Альянс' },
    { key: 'defensiveness' as const, label: 'Захисність' },
    { key: 'hopefulness' as const, label: 'Надія' },
  ];

  // ─── Derived data ────────────────────────────────────────────────────────

  latestAssessment = computed(() => {
    const p = this.patient();
    if (!p) return null;
    const completed = p.sessions.find((s) => s.assessment);
    return completed?.assessment ?? null;
  });

  recentFeedbackPreview = computed(() => {
    const fb = this.patient()?.recentFeedback;
    if (!fb) return '';
    const stripped = fb.replace(/^#+\s.*$/gm, '').trim();
    return stripped.length > 600 ? stripped.slice(0, 597) + '…' : stripped;
  });

  /** Disclaimer block (the leading `> ...` blockquote) rendered to HTML. */
  disclaimerHtml = computed(() => {
    const text = this.patient()?.profileText;
    if (!text) return null;
    const disclaimer = extractDisclaimer(text);
    return disclaimer ? renderMarkdownBody(disclaimer) : null;
  });

  /** Parsed sections with body pre-rendered to HTML. */
  profileSections = computed<ProfileSection[]>(() => {
    const text = this.patient()?.profileText;
    if (!text) return [];
    return parseSections(text);
  });

  /** Section "1. Базові відомості" — for Overview tab. */
  basicsSection = computed(() => this.profileSections().find((s) => /базов/i.test(s.title)));

  /** Section "5. Як вона говорить" — affect/voice/body description. */
  voiceSection = computed(() => this.profileSections().find((s) => /говорит|голос|афект/i.test(s.title)));

  /** Presenting complaint — extracted from "Що її привело на сесію" section.
   *  Tries to grab the FIRST quoted block (what she'd say on session 1) so
   *  the student sees the "presenting" version, not the "honest under-the-
   *  hood" version which is a spoiler. */
  presentingComplaint = computed<string | null>(() => {
    const sec = this.profileSections().find((s) => /приве|запит/i.test(s.title));
    if (!sec) return null;
    return extractPresentingComplaint(sec.bodyText);
  });

  chartTrends = computed(() => this.patient()?.trends ?? []);
  patientTrends = computed(() =>
    this.chartTrends().filter((t) => t.metric.startsWith('patient.')),
  );
  therapistTrends = computed(() =>
    this.chartTrends().filter((t) => t.metric.startsWith('therapist.')),
  );

  diagnosisTooltip = computed(() => {
    const p = this.patient();
    if (!p?.diagnosis) return '';
    return p.diagnosisCode ? `${p.diagnosis}\n— ${p.diagnosisCode}` : p.diagnosis;
  });

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  async ngOnInit() {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id) {
      this.loading.set(false);
      return;
    }
    try {
      const card = await this.api.patientCard(id);
      this.patient.set(card);
    } catch {
      // patient stays null, error handled by template
    } finally {
      this.loading.set(false);
    }
  }

  // ─── Section toggle ──────────────────────────────────────────────────────

  isOpen(index: number, isSpoiler: boolean): boolean {
    const explicit = this.sectionOpen()[index];
    if (explicit !== undefined) return explicit;
    return !isSpoiler; // non-spoilers open by default; spoilers closed
  }

  toggle(index: number) {
    const state = this.sectionOpen();
    const sec = this.profileSections()[index];
    const currentlyOpen = this.isOpen(index, sec.isSpoiler);
    this.sectionOpen.set({ ...state, [index]: !currentlyOpen });
  }

  // ─── Misc UI helpers ─────────────────────────────────────────────────────

  badgeText(b: ProgressBadge): string {
    return {
      improving: '↑ покращення',
      stable: '→ стабільно',
      worsening: '↓ погіршення',
      unknown: 'нема даних',
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

  trendLabel(metric: string): string {
    const map: Record<string, string> = {
      'patient.symptomSeverity': 'Симптоми',
      'patient.insight': 'Інсайт',
      'patient.alliance': 'Альянс',
      'patient.defensiveness': 'Захисність',
      'patient.hopefulness': 'Надія',
      'therapist.empathy': 'Емпатія',
      'therapist.collaboration': 'Колаборативність',
      'therapist.guidedDiscovery': 'Кероване дослідження',
      'therapist.strategyForChange': 'Стратегія змін',
    };
    return map[metric] ?? metric;
  }

  trendPolyline(t: { series: { value: number | null }[] }, max = 10): string {
    const w = 200;
    const h = 80;
    const pad = 5;
    const n = t.series.length;
    if (n < 2) return '';
    return t.series
      .map((p, i) => {
        const x = (i / (n - 1)) * (w - pad * 2) + pad;
        const v = p.value ?? max / 2;
        const y = h - pad - (v / max) * (h - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }

  trendCircles(t: { series: { value: number | null }[] }): { x: number; y: number }[] {
    const w = 200;
    const h = 80;
    const pad = 5;
    const max = 10;
    const n = t.series.length;
    if (n < 2) return [];
    return t.series.map((p, i) => {
      const x = (i / (n - 1)) * (w - pad * 2) + pad;
      const v = p.value ?? max / 2;
      const y = h - pad - (v / max) * (h - pad * 2);
      return { x, y };
    });
  }

  newSession() {
    const id = this.patient()?.id;
    if (id) void this.router.navigate(['/patient', id, 'intro']);
  }
}

// ─── Profile parsing utilities ─────────────────────────────────────────────

/**
 * Strip HTML comment metadata block from the top of the profile.
 * Returns the rest of the markdown.
 */
function stripMetadata(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/, '').trim();
}

/**
 * Extract the leading `> ...` blockquote (the "this is fictional" disclaimer
 * we put at the top of every profile). Returns the disclaimer text without
 * the leading `>` markers, or null if no blockquote present.
 */
function extractDisclaimer(md: string): string | null {
  const noMeta = stripMetadata(md);
  const lines = noMeta.split('\n');
  // Skip leading `# Profile X` heading and blank lines
  let i = 0;
  while (i < lines.length && (lines[i].startsWith('#') || lines[i].trim() === '')) i++;
  if (i >= lines.length || !lines[i].startsWith('>')) return null;
  const out: string[] = [];
  while (i < lines.length && (lines[i].startsWith('>') || (lines[i].trim() === '' && i + 1 < lines.length && lines[i + 1].startsWith('>')))) {
    out.push(lines[i].replace(/^>\s?/, ''));
    i++;
  }
  return out.join('\n').trim();
}

/**
 * Split profile into sections at `## N. Title` headings.
 * Skips the metadata comment, the H1 heading, and the disclaimer blockquote.
 */
function parseSections(md: string): ProfileSection[] {
  const noMeta = stripMetadata(md);
  // Drop H1 and disclaimer blockquotes — keep only content from first H2 on
  const h2Index = noMeta.indexOf('\n## ');
  if (h2Index === -1) return [];

  const body = noMeta.slice(h2Index + 1);
  const lines = body.split('\n');
  const sections: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      if (current) sections.push(current);
      current = { title: m[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  return sections.map((s) => {
    // Title may be "1. Базові відомості" — split number + title
    const numMatch = s.title.match(/^(\d+)\.\s*(.+)$/);
    const number = numMatch?.[1] ?? null;
    const cleanTitle = numMatch?.[2] ?? s.title;

    const bodyText = s.lines.join('\n').trim();
    const isSpoiler = SPOILER_PATTERNS.some((p) => p.test(cleanTitle));
    const icon = SECTION_ICONS.find((e) => e.test.test(cleanTitle))?.icon ?? '·';

    return {
      number,
      title: cleanTitle,
      bodyHtml: renderMarkdownBody(bodyText),
      bodyText,
      isSpoiler,
      icon,
    };
  });
}

/**
 * Try to extract the "what she'd say on session 1" presenting complaint —
 * usually the SECOND quoted block in the section, after the "honest" version.
 * Falls back to the first block, or first paragraph.
 */
function extractPresentingComplaint(sectionBody: string): string | null {
  // Look for quoted blocks: «...» or "..."
  const quoteRe = /[«"]([^»"]{30,500})[»"]/g;
  const quotes: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = quoteRe.exec(sectionBody)) !== null) quotes.push(m[1].trim());

  // The profile pattern: 1st quote = "what she'd HONESTLY say" (spoiler-ish),
  // 2nd quote = "what she SAYS on session 1" (presenting complaint we want).
  if (quotes.length >= 2) return cap(quotes[1], 320);
  if (quotes.length === 1) return cap(quotes[0], 320);

  // Fallback: first non-empty paragraph
  const firstPara = sectionBody.split(/\n\s*\n/).find((p) => p.trim().length > 50);
  return firstPara ? cap(firstPara.trim(), 320) : null;
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

/**
 * Tiny markdown→HTML renderer. Supports paragraphs, lists (- / *),
 * sub-headings (### → h4), bold (**), italic (* / _), wiki-links
 * ([[name]] → italic). Source is profile markdown we authored, so XSS
 * surface is limited; Angular's [innerHTML] sanitizer also runs.
 */
function renderMarkdownBody(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let listMode: 'ul' | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push('<p>' + renderInline(paragraph.join(' ')) + '</p>');
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listMode) {
      out.push(`</${listMode}>`);
      listMode = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    const trim = line.trim();
    if (!trim) {
      flushParagraph();
      flushList();
      continue;
    }
    // ### h4
    let m: RegExpMatchArray | null;
    if ((m = trim.match(/^###\s+(.+)/))) {
      flushParagraph();
      flushList();
      out.push(`<h4>${renderInline(m[1])}</h4>`);
      continue;
    }
    // - / * list items
    if ((m = trim.match(/^[-*]\s+(.+)/))) {
      flushParagraph();
      if (listMode !== 'ul') {
        flushList();
        out.push('<ul>');
        listMode = 'ul';
      }
      out.push(`<li>${renderInline(m[1])}</li>`);
      continue;
    }
    paragraph.push(trim);
  }
  flushParagraph();
  flushList();
  return out.join('\n');
}

function renderInline(text: string): string {
  // Escape HTML first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Bold
  html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  // Italic — single * or _ not part of bold
  html = html.replace(/(^|\s)\*([^*\s][^*]*?)\*(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>');
  html = html.replace(/(^|\s)_([^_\s][^_]*?)_(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>');
  // Wiki-links [[name]] → <em>name</em>
  html = html.replace(/\[\[([^\]]+)\]\]/g, '<em>$1</em>');
  return html;
}
