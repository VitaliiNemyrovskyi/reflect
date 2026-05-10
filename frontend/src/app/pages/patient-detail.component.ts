import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, PatientCard, ProgressBadge } from '../api.service';

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
          <div>
            <h1>{{ patient()!.displayName }}</h1>
            <p class="meta">
              {{ patient()!.sessionCount }} сесій
              @if (patient()!.sessions[0]) {
                · остання {{ patient()!.sessions[0].startedAt | date: 'dd.MM.yyyy' }}
              }
            </p>
          </div>
          <div class="header-actions">
            <span class="badge" [class]="'badge-' + patient()!.progressBadge">
              {{ badgeText(patient()!.progressBadge) }}
            </span>
            <button class="primary" (click)="newSession()">Нова сесія</button>
          </div>
        </div>
      </header>

      <nav class="tabs">
        <button [class.active]="tab() === 'overview'" (click)="tab.set('overview')">Огляд</button>
        <button [class.active]="tab() === 'profile'" (click)="tab.set('profile')">Профіль</button>
        <button [class.active]="tab() === 'sessions'" (click)="tab.set('sessions')">
          Сесії ({{ patient()!.sessionCount }})
        </button>
        <button [class.active]="tab() === 'notes'" (click)="tab.set('notes')">
          Нотатки ({{ patient()!.notes.length }})
        </button>
        <button [class.active]="tab() === 'progress'" (click)="tab.set('progress')">Прогрес</button>
      </nav>

      <section class="tab-content">
        @if (tab() === 'overview') {
          <div class="overview-grid">
            <article class="card">
              <h3>Презентація</h3>
              <p class="profile-excerpt">{{ profileExcerpt() }}</p>
            </article>
            @if (patient()!.recentFeedback) {
              <article class="card">
                <h3>Останній фідбек супервізора</h3>
                <pre class="feedback-preview">{{ recentFeedbackPreview() }}</pre>
                @if (patient()!.sessions[0]) {
                  <a [routerLink]="['/session', patient()!.sessions[0].id, 'feedback']" class="link-btn">
                    Повний фідбек →
                  </a>
                }
              </article>
            }
            @if (latestAssessment()) {
              <article class="card">
                <h3>Остання оцінка</h3>
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
          </div>
        }

        @if (tab() === 'profile') {
          <article class="card">
            <pre class="profile-full">{{ patient()!.profileText }}</pre>
          </article>
        }

        @if (tab() === 'sessions') {
          @if (patient()!.sessions.length === 0) {
            <p class="hint">Сесій з цим пацієнтом ще не було. <button class="link-btn" (click)="newSession()">Почати першу</button></p>
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
      h1 { font-size: 22px; }
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
      align-items: flex-end;
      margin-top: 12px;
    }
    h1 { margin: 0; font-size: 28px; }
    .meta { color: var(--fg-dim); margin: 4px 0 0; font-size: 14px; }
    .header-actions { display: flex; gap: 12px; align-items: center; }

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

    .tabs {
      display: flex;
      gap: 6px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 18px;
      // Mobile: horizontal scroll instead of wrap
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
      -ms-overflow-style: none;
      &::-webkit-scrollbar { display: none; }
    }
    .tabs button {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--fg-dim);
      padding: 10px 14px;
      font-size: 14px;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      min-height: auto;
    }
    .tabs button:hover { color: var(--fg); }
    .tabs button.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    @media (max-width: 720px) {
      .header-row {
        flex-direction: column;
        align-items: flex-start;
        gap: 12px;
      }
      .header-actions {
        width: 100%;
        justify-content: space-between;
      }
      .charts-grid {
        grid-template-columns: 1fr !important;
      }
    }

    .tab-content { padding-bottom: 40px; }

    .card {
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 20px;
    }
    .card h3 { margin: 0 0 12px; font-size: 14px; color: var(--fg-dim); text-transform: uppercase; letter-spacing: .05em; font-weight: 500; }

    .overview-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    .overview-grid .card:first-child { grid-column: 1 / -1; }
    @media (max-width: 720px) {
      .overview-grid { grid-template-columns: 1fr; }
    }

    .profile-excerpt {
      white-space: pre-wrap;
      margin: 0;
      max-height: 220px;
      overflow: auto;
      font-size: 14px;
      line-height: 1.6;
    }
    .profile-full {
      white-space: pre-wrap;
      font: inherit;
      font-size: 14px;
      line-height: 1.65;
      margin: 0;
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
    .session-actions { margin-top: 8px; }

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
  tab = signal<'overview' | 'profile' | 'sessions' | 'notes' | 'progress'>('overview');

  patientMetricsList = [
    { key: 'symptomSeverity' as const, label: 'Симптомна тяжкість' },
    { key: 'insight' as const, label: 'Інсайт' },
    { key: 'alliance' as const, label: 'Альянс' },
    { key: 'defensiveness' as const, label: 'Захисність' },
    { key: 'hopefulness' as const, label: 'Надія' },
  ];

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

  profileExcerpt = computed(() => {
    const txt = this.patient()?.profileText ?? '';
    // Skip the disclaimer block at top (lines starting with >), take next 600 chars
    const noDisclaimer = txt.replace(/^>.*$/gm, '').replace(/^#+.*$/gm, '').trim();
    return noDisclaimer.length > 600 ? noDisclaimer.slice(0, 597) + '…' : noDisclaimer;
  });

  chartTrends = computed(() => this.patient()?.trends ?? []);
  patientTrends = computed(() =>
    this.chartTrends().filter((t) => t.metric.startsWith('patient.')),
  );
  therapistTrends = computed(() =>
    this.chartTrends().filter((t) => t.metric.startsWith('therapist.')),
  );

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

  badgeText(b: ProgressBadge): string {
    return {
      improving: '↑ покращення',
      stable: '→ стабільно',
      worsening: '↓ погіршення',
      unknown: 'нема даних',
    }[b];
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
      'therapist.guidedDiscovery': 'Guided discovery',
      'therapist.strategyForChange': 'Strategy for change',
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
