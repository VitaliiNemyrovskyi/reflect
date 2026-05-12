import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, CharacterShare, PatientCard, ProgressBadge } from '../api.service';

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
  imports: [CommonModule, RouterLink, DatePipe, FormsModule],
  template: `
    @if (loading()) {
      <p class="hint">Завантаження…</p>
    } @else if (!patient()) {
      <p class="hint danger">Картку пацієнта не знайдено.</p>
    } @else {
      <a routerLink="/" class="back">← Усі пацієнти</a>

      <!-- ╔═══ HERO ═══╗
           Portrait photo on the left + identity (name/diagnosis) +
           vertical stack of vital rows on the right + a hover-detail
           panel below. Cleaner, reads more like a clinical chart. -->
      <section class="hero dot-grid-bg fx-fade-up"
               (mouseleave)="activeSector.set(null)">

        <!-- Rectangular portrait, wrapped in a Synapse-style accent
             backplate with a notched top-right corner. Frame colour
             follows the active theme (lavender / blue / Synapse-orange). -->
        <div class="photo-frame">
          <div class="hero-photo">
            @if (patient()!.avatarUrl) {
              <img [src]="patient()!.avatarUrl" [alt]="patient()!.displayName" />
            } @else {
              <div class="hero-photo-fallback">{{ patient()!.displayName.charAt(0) }}</div>
            }
          </div>
        </div>

        <div class="hero-info">
          <h1 class="hero-title">{{ patient()!.displayName }}</h1>
          @if (patient()!.diagnosis) {
            <p class="hero-caption" [title]="diagnosisTooltip()">
              {{ patient()!.diagnosis }}
              @if (patient()!.diagnosisCode) {
                <span class="hero-caption-code"> · {{ patient()!.diagnosisCode }}</span>
              }
            </p>
          }
          <div class="hero-actions">
            @if (patient()!.isMine) {
              <a [routerLink]="['/patient', patient()!.id, 'edit']"
                 class="ghost icon small"
                 title="Редагувати профіль"
                 aria-label="Редагувати">✎</a>
              <button class="ghost icon small"
                      title="Поділитися доступом"
                      aria-label="Доступ"
                      (click)="openShareModal()">👥</button>
              <button class="ghost icon small danger-icon"
                      title="Видалити профіль"
                      [disabled]="deleting()"
                      (click)="confirmDelete()">🗑</button>
            }
            <button class="primary new-session-btn fx-glow" (click)="newSession()">
              Нова сесія
            </button>
          </div>
        </div>

        <!-- Vertical stack of vital rows, anchored to the right of the
             photo. Each row is a button so it's keyboard-focusable; on
             hover/click it lights up + drives the detail panel below. -->
        <aside class="vitals-stack fx-stagger">
          <button type="button"
                  class="vital-row"
                  [class.active]="activeSector() === 'sessions'"
                  (mouseenter)="activeSector.set('sessions')"
                  (click)="toggleSector('sessions')">
            <span class="vital-label">СЕСІЇ</span>
            <span class="vital-value">{{ patient()!.sessionCount }}</span>
            <span class="vital-meta">{{ patient()!.completedCount }} завершено</span>
          </button>

          <button type="button"
                  class="vital-row"
                  [class.active]="activeSector() === 'state'"
                  [class.vital-warn]="patient()!.progressBadge === 'worsening'"
                  (mouseenter)="activeSector.set('state')"
                  (click)="toggleSector('state')">
            <span class="vital-label">СТАН</span>
            <span class="vital-value">{{ stateGlyph(patient()!.progressBadge) }}</span>
            <span class="vital-meta">{{ badgeText(patient()!.progressBadge) }}</span>
          </button>

          @if (patient()!.difficulty != null) {
            <button type="button"
                    class="vital-row"
                    [class.active]="activeSector() === 'behavior'"
                    (mouseenter)="activeSector.set('behavior')"
                    (click)="toggleSector('behavior')">
              <span class="vital-label">ПОВЕДІНКА</span>
              <span class="vital-value">{{ patient()!.difficulty }}<small>/5</small></span>
              <span class="vital-meta">{{ stars(patient()!.difficulty!) }}</span>
            </button>
          }

          @if (patient()!.complexity != null) {
            <button type="button"
                    class="vital-row"
                    [class.active]="activeSector() === 'severity'"
                    (mouseenter)="activeSector.set('severity')"
                    (click)="toggleSector('severity')">
              <span class="vital-label">ТЯЖКІСТЬ</span>
              <span class="vital-value">{{ patient()!.complexity }}<small>/5</small></span>
              <span class="vital-meta">{{ dots(patient()!.complexity!) }}</span>
            </button>
          }
        </aside>

        <!-- Detail panel below — placement at the bottom of the hero
             grid (spans full width). -->
        @if (sectorDetail(); as d) {
          <article class="sector-detail">
            <header class="sector-detail-head">
              <span class="sector-detail-title">{{ d.title }}</span>
              <span class="sector-detail-meta">{{ d.meta }}</span>
            </header>
            <div class="sector-detail-body">
              @for (row of d.rows; track row.label) {
                <div class="sector-detail-row">
                  <span class="sector-detail-row-label">{{ row.label }}</span>
                  <span class="sector-detail-row-value">{{ row.value }}</span>
                </div>
              }
            </div>
          </article>
        } @else {
          <div class="sector-detail empty">
            <span>Наведи на показник справа — побачиш деталі.</span>
          </div>
        }
      </section>

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
          <!-- Synapse-style overview: editorial quote block on top, then
               a row of "stat tile" cards, then a metrics panel.
               No more uniform grid of feature-equal cards — instead a
               hierarchy that mimics the Synapse dashboard composition. -->

          @if (presentingComplaint()) {
            <article class="quote-block fx-fade-up">
              <span class="quote-mark">"</span>
              <p class="quote-body">{{ presentingComplaint() }}</p>
              <footer class="quote-foot">
                <span class="quote-bar"></span>
                @if (feminine()) {
                  Як пацієнтка озвучила б це сама на першій сесії
                } @else {
                  Як пацієнт озвучив би це сам на першій сесії
                }
              </footer>
            </article>
          }

          @if (latestAssessment() || quickFacts().length) {
            <section class="panel">
              <header class="panel-head">
                <h3 class="panel-title">PATIENT STATE</h3>
                <span class="panel-meta">
                  @if (patient()!.sessions[0]; as last) {
                    Останнє оновлення: {{ last.startedAt | date: 'dd.MM.yyyy' }}
                  } @else {
                    Чекає на першу сесію
                  }
                </span>
              </header>

              <div class="metrics-grid fx-stagger">
                @for (m of patientMetricsList; track m.key) {
                  @let val = latestAssessment()?.patient?.[m.key] ?? null;
                  <article class="metric-card">
                    <div class="metric-card-label">{{ m.label }}</div>
                    <div class="metric-card-value">
                      @if (val != null) {
                        {{ val }}<small>/10</small>
                      } @else {
                        <span class="dim">—</span>
                      }
                    </div>
                    <div class="metric-card-bar">
                      <div class="metric-card-fill"
                           [style.width.%]="(val ?? 0) * 10"
                           [class.warn]="val != null && m.warnHigh && val >= 7"
                           [class.good]="val != null && !m.warnHigh && val >= 7">
                      </div>
                    </div>
                  </article>
                }
              </div>
            </section>
          }

          <div class="overview-split fx-stagger">
            @if (quickFacts().length) {
              <article class="panel panel-soft">
                <header class="panel-head">
                  <h3 class="panel-title">DEMOGRAPHICS</h3>
                  <span class="panel-meta">
                    <a (click)="tab.set('profile')" class="link-btn">Повний профіль →</a>
                  </span>
                </header>
                <dl class="facts">
                  @for (f of quickFacts(); track f.label) {
                    <div class="facts-row">
                      <dt>{{ f.label }}</dt>
                      <dd>{{ f.value }}</dd>
                    </div>
                  }
                </dl>
              </article>
            }

            @if (patient()!.recentFeedback) {
              <article class="panel panel-soft callout">
                <header class="panel-head">
                  <h3 class="panel-title">MENTOR AI · LAST FEEDBACK</h3>
                  <span class="panel-meta">
                    @if (patient()!.sessions[0]; as last) {
                      Сесія #{{ last.id }}
                    }
                  </span>
                </header>
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
                      Цей розділ — клінічна підказка (як насправді
                      влаштован{{ feminine() ? 'а' : 'ий' }} пацієнт{{ feminine() ? 'ка' : '' }}
                      і як {{ feminine() ? 'вона поведеться' : 'він поведеться' }}).
                      Він спойлерить кейс. Розгорни лише якщо хочеш звірити свою
                      гіпотезу або ти вже провів{{ feminine() ? 'ла' : '' }} сесію.
                    </p>
                  }
                </article>
              }
            </div>
          }
        }

        @if (tab() === 'sessions') {
          @if (patient()!.sessions.length === 0) {
            <p class="hint">
              Сесій з {{ feminine() ? 'цією пацієнткою' : 'цим пацієнтом' }} ще не було.
              <button class="link-btn" (click)="newSession()">Почати першу</button>
            </p>
          } @else {
            <ul class="sessions-list fx-stagger">
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
            <ul class="notes-aggregated fx-stagger">
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
              <h3>{{ feminine() ? 'Стан клієнтки' : 'Стан клієнта' }} (1-10)</h3>
              <div class="charts-grid">
                @for (t of patientTrends(); track t.metric) {
                  <article class="chart-card">
                    <h4>{{ trendLabel(t.metric) }}</h4>
                    <svg class="chart-svg" viewBox="0 0 200 80" preserveAspectRatio="none">
                      <polyline class="fx-draw"
                        [attr.points]="trendPolyline(t)"
                        pathLength="100"
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
                      <polyline class="fx-draw"
                        [attr.points]="trendPolyline(t, 6)"
                        pathLength="100"
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

      @if (showShareModal()) {
        <div class="modal-backdrop" (click)="closeShareModal()"></div>
        <div class="modal-card" role="dialog" aria-labelledby="share-title">
          <header class="modal-head">
            <h2 id="share-title">Доступ до профілю</h2>
            <button class="modal-close" (click)="closeShareModal()" aria-label="Закрити">×</button>
          </header>
          <div class="modal-body">
            <p class="modal-intro">
              Профіль приватний: бачиш лише ти + ті, кому надано доступ.
              Колеги зможуть запускати сесії й читати свої транскрипти, але
              не зможуть редагувати чи видалити профіль.
            </p>

            <form class="share-form" (ngSubmit)="addShare()">
              <input type="email"
                     name="shareEmail"
                     placeholder="email колеги"
                     [ngModel]="shareEmail()"
                     (ngModelChange)="shareEmail.set($event)"
                     [disabled]="sharing()"
                     required />
              <button type="submit"
                      class="primary"
                      [disabled]="sharing() || !shareEmail().trim()">
                {{ sharing() ? 'Додаю…' : 'Додати' }}
              </button>
            </form>
            @if (shareError()) {
              <p class="share-error">{{ shareError() }}</p>
            }

            <div class="share-list">
              @if (sharesLoading()) {
                <p class="hint">Завантаження…</p>
              } @else if (shares().length === 0) {
                <p class="hint">Поки що нікому не надано доступ.</p>
              } @else {
                <h3 class="share-list-head">З ким поділено ({{ shares().length }})</h3>
                <ul>
                  @for (s of shares(); track s.id) {
                    <li class="share-row">
                      <div class="share-identity">
                        <strong>{{ s.displayName || s.email.split('@')[0] }}</strong>
                        <span class="share-email">{{ s.email }}</span>
                      </div>
                      <button class="ghost icon small danger-icon"
                              [disabled]="removingShareId() === s.id"
                              (click)="removeShare(s)"
                              title="Забрати доступ"
                              aria-label="Забрати доступ">×</button>
                    </li>
                  }
                </ul>
              }
            </div>
          </div>
        </div>
      }
    }
  `,
  styles: [`
    :host { display: block; }
    .hint { color: var(--fg-dim); }
    .hint.danger { color: var(--danger); }

    .back {
      color: var(--fg-dim);
      text-decoration: none;
      font-size: 13px;
    }
    .back:hover { color: var(--accent); }

    /* ═══════════════════ SYNAPSE HERO ═══════════════════ */
    .dot-grid-bg {
      background-image:
        radial-gradient(circle at 50% 0%,
          color-mix(in srgb, var(--accent) 10%, transparent) 0%,
          transparent 60%),
        radial-gradient(circle, color-mix(in srgb, var(--accent) 18%, transparent) 0.6px, transparent 1px);
      background-size: auto, 18px 18px;
      background-position: 0 0, 0 0;
      background-attachment: local;
    }

    .hero {
      position: relative;
      padding: 28px;
      margin: 16px -20px 28px;
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      display: grid;
      grid-template-columns: 220px 1fr 220px;
      grid-template-rows: auto auto;
      gap: 22px 28px;
      align-items: start;
    }
    /* Accent backplate — Synapse-style frame behind the photo, with
       a clipped diagonal corner at top-right and an ANIMATED conic
       gradient that rotates slowly through the accent colour. Read
       it as a "spotlight" sweeping around the frame.
       Colour follows the active theme accent automatically. */
    @property --frame-angle {
      syntax: "<angle>";
      initial-value: 0deg;
      inherits: false;
    }
    .photo-frame {
      grid-column: 1;
      grid-row: 1;
      width: 100%;
      padding: 8px;
      border-radius: 14px;
      position: relative;
      clip-path: polygon(
        0 0,
        calc(100% - 28px) 0,
        100% 28px,
        100% 100%,
        0 100%
      );
      isolation: isolate;
      /* Base layer: solid muted accent so there's always something
         visible behind the spotlight even at low-opacity stops. */
      background: color-mix(in srgb, var(--accent) 32%, var(--bg));
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent),
        0 14px 56px -18px color-mix(in srgb, var(--accent) 50%, transparent);
    }
    /* Conic-gradient spotlight layer — rotates via @property animation.
       The bright accent peaks alternate with darker mid-tone, so as it
       turns it looks like a soft light traveling around the frame. */
    .photo-frame::before {
      content: '';
      position: absolute;
      inset: 0;
      z-index: -1;
      background: conic-gradient(
        from var(--frame-angle),
        color-mix(in srgb, var(--accent) 95%, transparent) 0deg,
        color-mix(in srgb, var(--accent) 35%, var(--bg)) 90deg,
        color-mix(in srgb, var(--accent) 80%, transparent) 180deg,
        color-mix(in srgb, var(--accent) 40%, var(--bg)) 270deg,
        color-mix(in srgb, var(--accent) 95%, transparent) 360deg
      );
      @media (prefers-reduced-motion: no-preference) {
        animation: frame-rotate 8s linear infinite;
      }
    }
    @keyframes frame-rotate {
      to { --frame-angle: 360deg; }
    }
    /* Photo lives inside the frame. Same row as identity + vitals,
       so the hero "head" is one tidy band. Detail panel sits in row 2
       below, full width.
       Photo gets a theme-locked duotone treatment so DiceBear's pastel
       backgrounds (peach, lavender, mint…) don't clash with whatever
       --accent the user picked in Settings:
         1. The <img> itself is desaturated + slightly darkened.
         2. An accent-tinted gradient is overlaid via mix-blend-mode,
            recolouring the photo to match the theme.
         3. A subtle vertical gradient on top adds depth and helps the
            name on the right read against the photo edge. */
    .hero-photo {
      width: 100%;
      height: 284px;
      border-radius: 8px;
      overflow: hidden;
      background: var(--user-bg);
      position: relative;
      isolation: isolate;
      /* Mirror the frame's notch so the photo edge stays flush
         with the inside of the cut corner. Cut is 20px on the photo
         (vs 28px on the frame), leaving an 8px accent triangle in
         the corner gap — same as the all-around 8px padding. */
      clip-path: polygon(
        0 0,
        calc(100% - 20px) 0,
        100% 20px,
        100% 100%,
        0 100%
      );
    }
    .hero-photo img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center top; /* keep faces, crop chin/torso */
      display: block;
      filter: grayscale(0.55) saturate(0.7) brightness(0.85) contrast(1.05);
      transition: filter .3s ease;
    }
    .hero-photo::before {
      /* Accent tint — colour-mixes with the desaturated photo. */
      content: '';
      position: absolute;
      inset: 0;
      background: color-mix(in srgb, var(--accent) 38%, transparent);
      mix-blend-mode: color;
      pointer-events: none;
      z-index: 1;
      transition: opacity .3s ease;
    }
    .hero-photo::after {
      /* Vertical depth gradient — darkens the bottom edge so the
         photo doesn't fight the dark hero background. */
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(
        180deg,
        transparent 0%,
        transparent 55%,
        color-mix(in srgb, var(--bg) 50%, transparent) 100%
      );
      pointer-events: none;
      z-index: 2;
    }
    .hero-photo:hover img {
      /* On hover, dial the duotone down so the original photo shows
         through — a small detail that signals interactivity. */
      filter: grayscale(0.2) saturate(0.95) brightness(0.95);
    }
    .hero-photo:hover::before {
      opacity: 0.55;
    }
    .hero-photo-fallback {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 72px;
      font-weight: 300;
      color: var(--accent);
      position: relative;
      z-index: 0;
    }

    /* ─── Vital orbit (4 SVG arcs around the avatar) ─── */
    .orbit-wrap {
      position: relative;
      width: 280px;
      height: 280px;
      flex-shrink: 0;
    }
    .orbit-svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible; /* labels at y=46 / x=252 sit outside the box */
    }
    .orbit-trace {
      fill: none;
      stroke: var(--border);
      stroke-width: 0.5;
      opacity: 0.6;
    }

    /* Each arc is a <g class="arc-group">: a dim trace path under
       the active fill path, plus value + label text. Hover lights up
       the fill, scales the group, and colours the text. */
    .arc-group {
      cursor: pointer;
      transform-origin: 140px 140px;
      transition: transform .25s cubic-bezier(.16, 1, .3, 1);
    }
    .arc-trace-bg {
      fill: none;
      stroke: var(--border);
      stroke-width: 18;
      stroke-linecap: butt;
      opacity: 0.55;
      transition: opacity .2s ease, stroke .2s ease;
    }
    .arc-fill {
      fill: none;
      stroke: var(--accent);
      stroke-width: 18;
      stroke-linecap: butt;
      stroke-dasharray: 0 1000;
      filter: drop-shadow(0 0 8px color-mix(in srgb, var(--accent) 55%, transparent));
      transition: stroke-dasharray .35s cubic-bezier(.65, 0, .35, 1),
                  opacity .2s ease,
                  stroke .2s ease;
      opacity: 0;
    }
    .arc-text {
      fill: var(--fg);
      font-size: 20px;
      font-weight: 300;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
      transition: fill .2s ease;
      pointer-events: none;
      dominant-baseline: middle;
    }
    .arc-text-sub {
      font-size: 11px;
      fill: var(--fg-dim);
    }
    .arc-text-glyph { font-size: 22px; }
    /* Curved label following the visible arc itself (r=75 on the
       stroke centerline). dominant-baseline:middle vertically centers
       glyphs on the 18px-wide stroke. Default state: light text on
       the dim grey trace. Active state (arc filled with accent):
       text flips to --accent-ink so it's dark on the bright fill. */
    .arc-curved-label {
      fill: var(--fg);
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      transition: fill .2s ease;
      pointer-events: none;
      dominant-baseline: middle;
    }
    /* Hover / active: fill the arc, scale up, recolour text. */
    .arc-group:hover, .arc-group.active {
      transform: scale(1.06);
    }
    .arc-group:hover .arc-trace-bg,
    .arc-group.active .arc-trace-bg {
      opacity: 0.25;
    }
    .arc-group:hover .arc-fill,
    .arc-group.active .arc-fill {
      stroke-dasharray: 200 0;
      opacity: 1;
    }
    .arc-group:hover .arc-text,
    .arc-group.active .arc-text {
      fill: var(--accent);
    }
    .arc-group:hover .arc-curved-label,
    .arc-group.active .arc-curved-label {
      /* On the bright accent fill, the label needs to flip dark for
         contrast — same dark colour the .primary button uses on its
         accent background. */
      fill: var(--accent-ink);
    }
    /* Worsening-state arc uses the danger palette instead. */
    .arc-group.arc-warn:hover .arc-fill,
    .arc-group.arc-warn.active .arc-fill {
      stroke: var(--danger);
      filter: drop-shadow(0 0 8px color-mix(in srgb, var(--danger) 55%, transparent));
    }
    .arc-group.arc-warn:hover .arc-text,
    .arc-group.arc-warn.active .arc-text {
      fill: var(--danger);
    }
    .arc-group.arc-warn:hover .arc-curved-label,
    .arc-group.arc-warn.active .arc-curved-label {
      /* On danger-coloured fill, keep text white for contrast. */
      fill: #fff;
    }

    /* Avatar sits dead-center inside the orbit (the 100px hole inside
       the arcs). pointer-events:none on the img so we don't block
       hover events meant for the arc <g>s when cursor passes over the
       avatar pixel area. */
    .orbit-avatar {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 116px;
      height: 116px;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      object-fit: cover;
      background: var(--user-bg);
      border: 1px solid var(--border);
      pointer-events: none;
    }
    .orbit-avatar.fallback {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 44px;
      font-weight: 300;
      color: var(--accent);
    }

    /* Identity block: middle column of the hero grid. Stacks display
       title + diagnosis caption + actions, top-aligned. */
    .hero-info {
      grid-column: 2;
      grid-row: 1;
      align-self: start;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }
    /* Vital stack: right column of the hero grid, vertical column of
       data rows. Each row is a button (keyboard-focusable, hoverable). */
    .vitals-stack {
      grid-column: 3;
      grid-row: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-self: stretch;
    }
    .vital-row {
      appearance: none;
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      cursor: pointer;
      display: grid;
      grid-template-columns: 1fr auto;
      grid-template-rows: auto auto;
      column-gap: 10px;
      align-items: baseline;
      text-align: left;
      color: var(--fg);
      min-height: auto;
      transition: background .15s ease, border-color .15s ease, transform .15s ease,
                  box-shadow .2s ease;
    }
    .vital-row .vital-label {
      grid-column: 1;
      grid-row: 1;
      font-size: 10px;
      letter-spacing: 0.16em;
      color: var(--fg-dim);
      text-transform: uppercase;
      font-weight: 500;
    }
    .vital-row .vital-value {
      grid-column: 2;
      grid-row: 1 / span 2;
      font-size: 28px;
      font-weight: 300;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
      color: var(--fg);
      align-self: center;
    }
    .vital-row .vital-value small {
      font-size: 13px;
      color: var(--fg-dim);
      margin-left: 1px;
    }
    .vital-row .vital-meta {
      grid-column: 1;
      grid-row: 2;
      font-size: 11px;
      color: var(--fg-dim);
      letter-spacing: 0.02em;
    }
    .vital-row:hover, .vital-row.active {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 8%, var(--assistant-bg));
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent),
                  0 4px 18px -8px color-mix(in srgb, var(--accent) 35%, transparent);
    }
    .vital-row.active .vital-value { color: var(--accent); }
    .vital-row.vital-warn .vital-value { color: var(--danger); }
    .vital-row.vital-warn:hover, .vital-row.vital-warn.active {
      border-color: var(--danger);
      background: color-mix(in srgb, var(--danger) 8%, var(--assistant-bg));
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--danger) 25%, transparent),
                  0 4px 18px -8px color-mix(in srgb, var(--danger) 35%, transparent);
    }
    .sector-detail, .sector-detail.empty {
      grid-column: 1 / -1;
      grid-row: 2;
    }
    /* Legacy .hero-content / .orbit-wrap classes kept for safety in
       case any descendant template still references them. */
    .hero-content {
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    .orbit-wrap { display: none; }

    /* Sector detail row — fixed min-height so the layout doesn't jump
       between idle and hovered states. */
    .sector-detail {
      align-self: stretch;
      margin-top: 4px;
      padding: 16px 20px;
      background: color-mix(in srgb, var(--accent) 5%, var(--assistant-bg));
      border: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border));
      border-radius: 10px;
      min-height: 96px;
      animation: fx-fade-up .25s cubic-bezier(.16, 1, .3, 1);
    }
    .sector-detail.empty {
      background: transparent;
      border: 1px dashed var(--border);
      color: var(--fg-dim);
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      animation: none;
    }
    .sector-detail-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 10px;
    }
    .sector-detail-title {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.18em;
      color: var(--accent);
      text-transform: uppercase;
    }
    .sector-detail-meta {
      font-size: 11px;
      color: var(--fg-dim);
      letter-spacing: 0.04em;
    }
    .sector-detail-body {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .sector-detail-row {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 14px;
      font-size: 13px;
      line-height: 1.45;
    }
    .sector-detail-row-label {
      color: var(--fg-dim);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      padding-top: 2px;
    }
    .sector-detail-row-value { color: var(--fg); }

    /* Avatar with orbital state-ring */
    .hero-avatar-frame {
      position: relative;
      width: 168px;
      height: 168px;
      flex-shrink: 0;
    }
    .hero-avatar {
      position: absolute;
      inset: 18px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--user-bg);
      border: 1px solid var(--border);
    }
    .hero-avatar.fallback {
      display: flex; align-items: center; justify-content: center;
      font-size: 56px; font-weight: 300; color: var(--accent);
    }
    .state-ring {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      transform: rotate(-90deg);
      pointer-events: none;
    }
    .state-ring .ring-trace {
      fill: none;
      stroke: var(--border);
      stroke-width: 1.5;
      opacity: 0.7;
    }
    .state-ring .ring-arc {
      fill: none;
      stroke-width: 2.5;
      stroke-linecap: butt;
      filter: drop-shadow(0 0 6px color-mix(in srgb, currentColor 50%, transparent));
      transition: stroke-dasharray .8s cubic-bezier(.65, 0, .35, 1);
    }
    .state-ring .ring-dot {
      transform-origin: 110px 110px;
      @media (prefers-reduced-motion: no-preference) {
        animation: ring-orbit 8s linear infinite;
      }
    }
    @keyframes ring-orbit {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }

    .hero-body { min-width: 0; }
    .hero-eyebrow {
      display: inline-flex; align-items: center; gap: 8px;
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.18em;
      color: var(--fg-dim);
      text-transform: uppercase;
      margin-bottom: 14px;
    }
    .eyebrow-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      box-shadow: 0 0 8px currentColor;
      @media (prefers-reduced-motion: no-preference) {
        animation: fx-pulse 1.8s ease-in-out infinite;
      }
    }
    .hero-title {
      margin: 0;
      font-size: clamp(36px, 5vw, 56px);
      font-weight: 300;
      letter-spacing: -0.025em;
      line-height: 1.02;
      color: var(--fg);
    }
    .hero-caption {
      margin: 14px 0 22px;
      font-size: 14px;
      line-height: 1.5;
      color: var(--accent);
      letter-spacing: 0.01em;
    }
    .hero-caption-code { color: var(--fg-dim); font-variant-numeric: tabular-nums; }

    .hero-actions {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .hero-actions .icon.small {
      width: 36px; height: 36px;
      padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 14px;
      text-decoration: none;
      color: var(--fg-dim);
      border: 1px solid var(--border);
      background: transparent;
      border-radius: 6px;
    }
    .hero-actions .icon.small:hover {
      color: var(--accent);
      border-color: var(--accent);
    }
    .hero-actions .icon.danger-icon:hover {
      color: var(--danger);
      border-color: var(--danger);
    }
    .new-session-btn { padding: 12px 22px; }

    /* Vital tiles — Synapse-style data strip across the bottom of the
       hero. Always one horizontal row on desktop; gracefully reflows
       to two rows on narrow tablets and a 2x2 stack on phones. */
    .hero-vitals {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      padding-top: 24px;
      margin-top: 8px;
      border-top: 1px dashed var(--border);
    }
    .vital-tile {
      padding: 14px 16px;
      background: color-mix(in srgb, var(--accent) 5%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border));
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 120px;
    }
    .vital-tile.tile-warn {
      background: color-mix(in srgb, var(--danger) 8%, transparent);
      border-color: color-mix(in srgb, var(--danger) 30%, var(--border));
    }
    .vital-label {
      font-size: 9px;
      letter-spacing: 0.16em;
      color: var(--fg-dim);
      font-weight: 500;
      text-transform: uppercase;
    }
    .vital-value {
      font-size: 28px;
      font-weight: 300;
      color: var(--fg);
      line-height: 1;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
    }
    .vital-value small {
      font-size: 14px;
      color: var(--fg-dim);
      font-weight: 400;
    }
    .vital-meta {
      font-size: 11px;
      color: var(--fg-dim);
      letter-spacing: 0.02em;
    }

    @media (max-width: 1000px) {
      .hero {
        grid-template-columns: 180px 1fr;
        grid-template-rows: auto auto auto;
        gap: 18px 22px;
        padding: 22px 20px;
      }
      .photo-frame {
        grid-column: 1;
        grid-row: 1 / span 2;
      }
      .hero-photo { height: 244px; }
      .hero-info {
        grid-column: 2;
        grid-row: 1;
      }
      .vitals-stack {
        grid-column: 2;
        grid-row: 2;
        flex-direction: row;
        flex-wrap: wrap;
      }
      .vital-row {
        flex: 1 1 calc(50% - 4px);
        min-width: 140px;
      }
      .sector-detail, .sector-detail.empty {
        grid-row: 3;
      }
    }
    /* Phones: photo on top, identity below, vitals as 2x2 grid, detail
       at the very bottom. */
    @media (max-width: 540px) {
      .hero {
        grid-template-columns: 1fr;
        padding: 18px 16px 18px;
        margin: 12px -16px 20px;
      }
      .photo-frame {
        grid-column: 1;
        grid-row: 1;
      }
      .hero-photo { height: 224px; }
      .hero-info {
        grid-column: 1;
        grid-row: 2;
      }
      .vitals-stack {
        grid-column: 1;
        grid-row: 3;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .vital-row { min-width: 0; }
      .sector-detail, .sector-detail.empty {
        grid-row: 4;
      }
    }

    /* ═══════════════════ PANELS ═══════════════════ */
    .panel {
      margin: 0 0 22px;
      padding: 22px 26px 24px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--assistant-bg);
    }
    .panel-soft {
      background: color-mix(in srgb, var(--accent) 3%, var(--assistant-bg));
    }
    .panel.callout {
      position: relative;
    }
    .panel.callout::before {
      content: '';
      position: absolute;
      left: -1px; top: 16px;
      width: 3px; height: 32px;
      background: var(--accent);
      border-radius: 2px;
    }
    .panel-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 16px;
      margin-bottom: 18px;
      padding-bottom: 12px;
      border-bottom: 1px dashed var(--border);
    }
    .panel-title {
      margin: 0;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.18em;
      color: var(--fg-dim);
      text-transform: uppercase;
    }
    .panel-meta {
      font-size: 11px;
      color: var(--fg-dim);
      letter-spacing: 0.04em;
    }

    /* Metrics grid (PATIENT STATE panel) */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 14px;
    }
    .metric-card {
      padding: 12px 14px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .metric-card-label {
      font-size: 10px;
      letter-spacing: 0.12em;
      color: var(--fg-dim);
      text-transform: uppercase;
      font-weight: 500;
    }
    .metric-card-value {
      font-size: 26px;
      font-weight: 300;
      color: var(--fg);
      line-height: 1;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
    }
    .metric-card-value small {
      font-size: 13px;
      color: var(--fg-dim);
      margin-left: 1px;
    }
    .metric-card-value .dim { color: var(--fg-dim); font-size: 18px; }
    .metric-card-bar {
      height: 4px;
      background: var(--border);
      border-radius: 2px;
      overflow: hidden;
    }
    .metric-card-fill {
      height: 100%;
      background: var(--accent);
      transition: width .8s cubic-bezier(.65, 0, .35, 1);
    }
    .metric-card-fill.warn { background: var(--danger); }
    .metric-card-fill.good { background: var(--success); }

    /* ═══════════════════ QUOTE BLOCK ═══════════════════ */
    .quote-block {
      position: relative;
      padding: 28px 32px 28px 64px;
      margin: 0 0 22px;
      background: color-mix(in srgb, var(--accent) 4%, var(--assistant-bg));
      border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border));
      border-radius: 12px;
    }
    .quote-mark {
      position: absolute;
      top: 8px; left: 18px;
      font-family: 'Georgia', 'Cambria', serif;
      font-size: 72px;
      font-weight: 700;
      line-height: 1;
      color: var(--accent);
      opacity: 0.65;
    }
    .quote-body {
      margin: 0;
      font-size: 18px;
      line-height: 1.55;
      font-style: italic;
      color: var(--fg);
      letter-spacing: -0.005em;
    }
    .quote-foot {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 16px 0 0;
      font-size: 11px;
      letter-spacing: 0.12em;
      color: var(--fg-dim);
      text-transform: uppercase;
    }
    .quote-bar {
      display: inline-block;
      width: 22px; height: 1px;
      background: var(--accent);
    }

    /* Two-column split for Demographics + Mentor feedback */
    .overview-split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
    }
    @media (max-width: 720px) {
      .overview-split { grid-template-columns: 1fr; gap: 14px; }
    }

    /* Facts list inside Demographics panel */
    .facts {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .facts-row {
      display: grid;
      grid-template-columns: 110px 1fr;
      gap: 12px;
      align-items: baseline;
      font-size: 13px;
      line-height: 1.4;
    }
    .facts-row dt {
      color: var(--fg-dim);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-weight: 500;
      margin: 0;
    }
    .facts-row dd { margin: 0; color: var(--fg); }

    .feedback-preview {
      white-space: pre-wrap;
      font: inherit;
      font-size: 13px;
      line-height: 1.6;
      color: var(--fg-dim);
      margin: 0 0 12px;
    }

    /* Legacy class — keep for now; remaining tabs still reference it */
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
    .header-cta {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .header-cta .icon.small {
      width: 36px;
      height: 36px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      text-decoration: none;
      color: var(--fg-dim);
      border: 1px solid var(--border);
      background: transparent;
      border-radius: 6px;
    }
    .header-cta .icon.small:hover {
      color: var(--accent);
      border-color: var(--accent);
    }
    .header-cta .icon.danger-icon:hover {
      color: var(--danger);
      border-color: var(--danger);
    }

    .badge {
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: .02em;
    }
    .badge-improving { background: #143c2c; color: #6ee7b7; border: 1px solid #2a6f4d; }
    .badge-stable { background: #2a2a32; color: var(--fg-dim); border: 1px solid var(--border); }
    .badge-worsening {
      background: #3c1a1a; color: var(--danger); border: 1px solid #6f2a2a;
      // Persistent gentle pulse — this is a flag, it should keep tugging
      // at the supervisor's attention. Honour reduced-motion globally.
      @media (prefers-reduced-motion: no-preference) {
        animation: fx-pulse 1.8s ease-in-out infinite;
      }
    }
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

    /* Compact key-value list used in the Overview "Коротко" card. */
    .facts {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .facts-row {
      display: grid;
      grid-template-columns: 110px 1fr;
      gap: 10px;
      align-items: baseline;
      font-size: 13px;
      line-height: 1.4;
    }
    .facts-row dt {
      color: var(--fg-dim);
      font-weight: 500;
      margin: 0;
    }
    .facts-row dd {
      margin: 0;
      color: var(--fg);
    }
    .facts-link {
      margin: 12px 0 0;
      font-size: 12px;
      color: var(--fg-dim);
    }
    .facts-link .link-btn {
      margin: 0;
      cursor: pointer;
    }
    @media (max-width: 480px) {
      .facts-row {
        grid-template-columns: 95px 1fr;
        font-size: 12.5px;
      }
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
    .session-status.open {
      background: #3c2c14; color: #fbbf6e;
      // "In progress" — gentle breathe to signal it's a live state.
      @media (prefers-reduced-motion: no-preference) {
        animation: fx-pulse 2.2s ease-in-out infinite;
      }
    }
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

    /* Share modal */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      z-index: 50;
      animation: fadeIn .12s ease;
    }
    .modal-card {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(440px, calc(100vw - 32px));
      max-height: calc(100vh - 64px);
      overflow-y: auto;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.55);
      z-index: 51;
      animation: popIn .14s ease;
    }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes popIn {
      from { opacity: 0; transform: translate(-50%, -48%); }
      to { opacity: 1; transform: translate(-50%, -50%); }
    }
    .modal-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px 12px;
      border-bottom: 1px solid var(--border);
    }
    .modal-head h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 500;
    }
    .modal-close {
      background: transparent;
      border: none;
      color: var(--fg-dim);
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      padding: 0 4px;
      min-height: auto;
    }
    .modal-close:hover { color: var(--fg); }
    .modal-body { padding: 16px 20px 20px; }
    .modal-intro {
      margin: 0 0 16px;
      font-size: 13px;
      color: var(--fg-dim);
      line-height: 1.55;
    }

    .share-form {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
    }
    .share-form input {
      flex: 1;
      padding: 9px 12px;
      background: var(--user-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--fg);
      font-size: 14px;
    }
    .share-form input:focus {
      outline: none;
      border-color: var(--accent);
    }
    .share-form button { flex-shrink: 0; }
    .share-error {
      margin: 6px 0 12px;
      color: var(--danger);
      font-size: 12px;
    }

    .share-list { margin-top: 16px; }
    .share-list-head {
      margin: 0 0 8px;
      font-size: 11px;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: .05em;
      font-weight: 500;
    }
    .share-list ul {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .share-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 9px 12px;
      background: var(--user-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .share-identity {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }
    .share-identity strong {
      font-weight: 500;
      font-size: 13px;
    }
    .share-email {
      font-size: 11px;
      color: var(--fg-dim);
    }
    @media (max-width: 480px) {
      .share-form { flex-direction: column; }
      .share-form button { width: 100%; }
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

  /**
   * Each metric carries a `warnHigh` flag: true if a HIGH score means
   * "bad" (e.g. symptom severity 9/10 is a problem), false if HIGH is
   * "good" (e.g. insight 9/10 is excellent). Used to colour the bar
   * fill — warn-coloured when crossing the threshold in the bad
   * direction, good-coloured otherwise.
   */
  patientMetricsList = [
    { key: 'symptomSeverity' as const, label: 'Симптомна тяжкість', warnHigh: true },
    { key: 'insight' as const, label: 'Інсайт', warnHigh: false },
    { key: 'alliance' as const, label: 'Альянс', warnHigh: false },
    { key: 'defensiveness' as const, label: 'Захисність', warnHigh: true },
    { key: 'hopefulness' as const, label: 'Надія', warnHigh: false },
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

  /** Section "1. Базові відомості" — kept for compute access (powers
   *  quickFacts below). NOT rendered as a card in Overview anymore —
   *  the full markdown lives in the Profile tab; here we extract a few
   *  fields as a compact summary so the two tabs don't show the same
   *  thing twice. */
  basicsSection = computed(() => this.profileSections().find((s) => /базов/i.test(s.title)));

  /** Section "5. Як вона говорить" — affect/voice/body description.
   *  Used elsewhere; the Overview tab does NOT render this anymore (was
   *  a duplicate of the Profile-tab section). */
  voiceSection = computed(() => this.profileSections().find((s) => /говорит|голос|афект/i.test(s.title)));

  /**
   * Compact key-value pairs extracted from the basics section bullets
   * so the Overview tab gives a scannable summary instead of mirroring
   * the Profile-tab block verbatim. Keys are matched case-insensitively
   * against common Ukrainian labels; missing rows just don't appear.
   */
  quickFacts = computed<{ label: string; value: string }[]>(() => {
    const body = this.basicsSection()?.bodyText;
    if (!body) return [];
    const wanted: { key: RegExp; label: string }[] = [
      { key: /^вік$/i, label: 'Вік' },
      { key: /^місто.*район|^місто$/i, label: 'Місто' },
      { key: /^сімейний стан$/i, label: 'Сімейний стан' },
      { key: /^освіта$/i, label: 'Освіта' },
      { key: /^робота($|\s|\b)/i, label: 'Робота' },
    ];
    const facts: { label: string; value: string }[] = [];
    for (const raw of body.split('\n')) {
      const m = raw.match(/^[-*]\s+([^:]+):\s*(.+)$/);
      if (!m) continue;
      const [, key, value] = m;
      const cleanKey = key.trim();
      const w = wanted.find((x) => x.key.test(cleanKey));
      if (!w) continue;
      // Don't repeat if we already grabbed this label (some profiles
      // have "Робота до 2022" + "Робота зараз" — keep first match).
      if (facts.some((f) => f.label === w.label)) continue;
      facts.push({ label: w.label, value: value.trim() });
    }
    return facts;
  });

  /** True if avatar style is `lorelei` — used as a gender proxy so the
   *  presenting-complaint sub-caption agrees with the patient's gender. */
  feminine = computed(() => {
    const url = this.patient()?.avatarUrl ?? '';
    return url.includes('/lorelei/');
  });

  // ─── Hero sectors (radial vital readouts) ───────────────────────────

  /**
   * Which radial vital sector around the avatar is currently focused.
   * Bound to mouseenter for hover-reveal on desktop; click toggles for
   * touch devices where hover doesn't fire. `null` = nothing focused.
   */
  activeSector = signal<string | null>(null);

  toggleSector(key: string) {
    this.activeSector.set(this.activeSector() === key ? null : key);
  }

  /**
   * Detail content for the panel below the hero. Switches based on
   * which sector is hovered/tapped. Returns null when nothing's
   * active, so the panel can show its idle placeholder.
   */
  sectorDetail = computed(() => {
    const key = this.activeSector();
    const p = this.patient();
    if (!key || !p) return null;
    switch (key) {
      case 'sessions': {
        const last = p.sessions[0];
        const open = p.sessions.filter((s) => !s.endedAt).length;
        return {
          title: 'Сесії',
          meta: last ? this.formatDate(last.startedAt) : 'ще не починалися',
          rows: [
            { label: 'Усього', value: String(p.sessionCount) },
            { label: 'Завершено', value: `${p.completedCount} з ${p.sessionCount}` },
            { label: 'Відкритих', value: open ? `${open} (не завершено)` : '0' },
            {
              label: 'Остання',
              value: last ? this.formatDate(last.startedAt) : '—',
            },
          ],
        };
      }
      case 'state': {
        return {
          title: 'Стан клієнт' + (this.feminine() ? 'ки' : 'а'),
          meta: this.badgeText(p.progressBadge),
          rows: [
            {
              label: 'Тренд',
              value:
                {
                  improving: '↑ Покращення — метрики поліпшуються між останніми сесіями',
                  stable: '→ Стабільно — без значимих змін, тримається поточний рівень',
                  worsening: '↓ Погіршення — метрики падають, варто переглянути план',
                  unknown: 'Недостатньо даних — потрібна щонайменше 2 завершені сесії',
                }[p.progressBadge],
            },
            {
              label: 'Останні оцінки',
              value: this.latestAssessmentSummary(),
            },
          ],
        };
      }
      case 'behavior': {
        const d = p.difficulty ?? 0;
        return {
          title: 'Поведінкова складність',
          meta: `${d} / 5`,
          rows: [
            { label: 'Рівень', value: `${this.stars(d)} ${d}/5` },
            {
              label: 'Що це означає',
              value: this.difficultyDescription(d),
            },
          ],
        };
      }
      case 'severity': {
        const c = p.complexity ?? 0;
        return {
          title: 'Клінічна тяжкість',
          meta: `${c} / 5`,
          rows: [
            { label: 'Рівень', value: `${this.dots(c)} ${c}/5` },
            {
              label: 'Що це означає',
              value: this.severityDescription(c),
            },
          ],
        };
      }
      default:
        return null;
    }
  });

  private formatDate(d: string): string {
    return new Date(d).toLocaleDateString('uk-UA', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  }

  private latestAssessmentSummary(): string {
    const a = this.latestAssessment();
    if (!a?.patient) return 'нема даних';
    const bits: string[] = [];
    if (a.patient.symptomSeverity != null) bits.push(`симпт. ${a.patient.symptomSeverity}/10`);
    if (a.patient.insight != null) bits.push(`інсайт ${a.patient.insight}/10`);
    if (a.patient.alliance != null) bits.push(`альянс ${a.patient.alliance}/10`);
    return bits.length ? bits.join(' · ') : 'нема даних';
  }

  private difficultyDescription(d: number): string {
    return [
      'Дуже відкрита, готова до контакту, чесно відповідає на питання',
      'Загалом відкрита, інколи захищається на болючих темах',
      'Помірний рівень опору — є зона комфорту, потребує м\'якого підходу',
      'Високий опір — закривається, інтелектуалізує, тестує терапевта',
      'Глухий опір — мінімум контакту, маніпуляції, потребує особливої уваги',
    ][Math.max(0, Math.min(4, d - 1))] ?? '—';
  }

  private severityDescription(c: number): string {
    return [
      'Легка форма — без значних наслідків для функціонування',
      'Помірна — впливає на роботу/стосунки, але без гострого ризику',
      'Виражена — функціонування суттєво порушене, моніторинг важливий',
      'Тяжка — є ознаки декомпенсації, можливі коморбідні стани',
      'Гостра — ризики (суїцид/психоз/насильство), потрібна координація',
    ][Math.max(0, Math.min(4, c - 1))] ?? '—';
  }

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

  /**
   * Short glyph for the STATE vital tile — single character that
   * captures the trajectory at a glance.
   */
  stateGlyph(b: ProgressBadge): string {
    return { improving: '↑', stable: '→', worsening: '↓', unknown: '∙' }[b];
  }

  /**
   * The orbital "state ring" around the hero avatar.
   * Returns an SVG stroke-dasharray that fills a portion of the
   * circumference proportional to (completedCount / sessionCount).
   * No sessions → mostly empty trace; lots of completed sessions →
   * mostly filled ring.
   *
   * Circumference at r=102 is roughly 640.6 — keep dash + gap totals
   * matching that so the gap eats whatever the dash doesn't cover.
   */
  ringDasharray(): string {
    const p = this.patient();
    const total = p?.sessionCount ?? 0;
    const done = p?.completedCount ?? 0;
    if (!total) return '4 12'; // dashed trace when there are no sessions yet
    const fraction = Math.max(0.05, Math.min(1, done / Math.max(total, 4)));
    const C = 640.6;
    const fill = C * fraction;
    return `${fill.toFixed(1)} ${(C - fill).toFixed(1)}`;
  }

  /**
   * Tint the ring + eyebrow dot by the patient's overall trajectory.
   * Falls back to accent when state is unknown so the ring is still
   * visible (just neutral).
   */
  ringColor(): string {
    const b = this.patient()?.progressBadge ?? 'unknown';
    return {
      improving: '#6ee7b7',
      stable: 'var(--accent)',
      worsening: 'var(--danger)',
      unknown: 'var(--fg-dim)',
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

  deleting = signal(false);

  /**
   * Delete a user-created patient. Cascades through schema to sessions
   * + messages + notes — pop a confirm because this is irreversible.
   */
  async confirmDelete() {
    const p = this.patient();
    if (!p?.isMine) return;
    const fem = this.feminine();
    const ok = confirm(
      `Видалити ${fem ? 'пацієнтку' : 'пацієнта'} ${p.displayName}?\n\nЗникнуть ВСІ сесії з ${fem ? 'нею' : 'ним'}, нотатки, фідбеки, пам'ять. Це незворотно.`,
    );
    if (!ok) return;
    this.deleting.set(true);
    try {
      await this.api.deleteCharacter(p.id);
      void this.router.navigate(['/']);
    } catch (e: unknown) {
      this.deleting.set(false);
      alert(
        (e as { error?: { message?: string } })?.error?.message ??
          'Не вдалось видалити.',
      );
    }
  }

  // ─── Share modal ─────────────────────────────────────────────────────────

  showShareModal = signal(false);
  shares = signal<CharacterShare[]>([]);
  sharesLoading = signal(false);
  sharing = signal(false);
  shareError = signal<string | null>(null);
  shareEmail = signal('');
  removingShareId = signal<number | null>(null);

  async openShareModal() {
    const p = this.patient();
    if (!p?.isMine) return;
    this.showShareModal.set(true);
    this.shareError.set(null);
    this.shareEmail.set('');
    this.sharesLoading.set(true);
    try {
      const list = await this.api.listShares(p.id);
      this.shares.set(list);
    } catch {
      this.shareError.set('Не вдалось завантажити список доступу.');
    } finally {
      this.sharesLoading.set(false);
    }
  }

  closeShareModal() {
    this.showShareModal.set(false);
    this.shareError.set(null);
  }

  async addShare() {
    const p = this.patient();
    const email = this.shareEmail().trim();
    if (!p || !email || this.sharing()) return;
    this.sharing.set(true);
    this.shareError.set(null);
    try {
      const share = await this.api.addShare(p.id, email);
      // Upsert into list — backend collapses duplicates by (charId, userId),
      // so we de-dupe locally too in case it was already there.
      this.shares.update((curr) => {
        const filtered = curr.filter((s) => s.id !== share.id);
        return [share, ...filtered];
      });
      this.shareEmail.set('');
    } catch (e: unknown) {
      this.shareError.set(
        (e as { error?: { message?: string } })?.error?.message ??
          'Не вдалось додати доступ.',
      );
    } finally {
      this.sharing.set(false);
    }
  }

  async removeShare(share: CharacterShare) {
    const p = this.patient();
    if (!p) return;
    if (!confirm(`Забрати доступ у ${share.email}?`)) return;
    this.removingShareId.set(share.id);
    try {
      await this.api.removeShare(p.id, share.id);
      this.shares.update((curr) => curr.filter((s) => s.id !== share.id));
    } catch (e: unknown) {
      alert(
        (e as { error?: { message?: string } })?.error?.message ??
          'Не вдалось забрати доступ.',
      );
    } finally {
      this.removingShareId.set(null);
    }
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
