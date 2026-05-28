import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiService, Character, ModalityInfo, ModalityKey, ProgressBadge } from '../api.service';
import { AuthService } from '../auth.service';
import { I18nService, Lang, SUPPORTED_LANGS } from '../i18n.service';
import { LogoComponent } from '../logo.component';
import { WelcomeModalComponent } from '../welcome-modal.component';

@Component({
  selector: 'app-characters-list',
  standalone: true,
  imports: [CommonModule, DatePipe, RouterLink, LogoComponent, WelcomeModalComponent],
  template: `
    @if (showWelcome()) {
      <app-welcome-modal (dismissed)="dismissWelcome()" />
    }

    <!-- Cinematic hero background. Empty by default — drops in once a
         file lands at /hero-bg.webp (or .jpg/.png). The image is fixed,
         dimmed, and fades to transparent at the edges so it lights the
         page without competing with the patient cards.
         On phones the layer is hidden entirely (perf + readability). -->
    <div class="hero-bg" aria-hidden="true"></div>

    <header class="header">
      @if (characters().length > 0) {
        <!-- Modality filter row: pinned ABOVE the difficulty filter so
             the trainee picks a therapy type first ("I want couples
             work"), then narrows by difficulty within that pool.
             Only shows chips for modalities that actually have at
             least one patient — keeps the row tight on first-runs. -->
        @if (visibleModalities().length > 1) {
          <div class="filters filters-modality">
            <button
              class="chip"
              [class.active]="modalityFilter() === null"
              (click)="modalityFilter.set(null)">
              {{ i18n.isEn ? 'All types' : 'Усі типи' }} ({{ characters().length }})
            </button>
            @for (m of visibleModalities(); track m.key) {
              <button
                class="chip modality-chip"
                [class.active]="modalityFilter() === m.key"
                [title]="m.description"
                (click)="toggleModality(m.key)">
                <span class="modality-icon">{{ m.icon }}</span>
                {{ i18n.t('modality.' + m.key) }} ({{ countByModality(m.key) }})
              </button>
            }
          </div>
        }
        <div class="filters">
          <button
            class="chip"
            [class.active]="difficultyFilter() === null"
            (click)="difficultyFilter.set(null)">
            {{ i18n.isEn ? 'All' : 'Усі' }} ({{ characters().length }})
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
            {{ i18n.t('chars.new_patient') }}
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
          <span class="stat-label">{{ i18n.isEn ? 'Sessions total' : 'Сесій усього' }}</span>
          <span class="stat-value">{{ st.totalSessions }}</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">{{ i18n.isEn ? 'Active cases' : 'Активних кейсів' }}</span>
          <span class="stat-value">{{ st.activeCases }}<small> / {{ characters().length }}</small></span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">{{ i18n.isEn ? 'Last session' : 'Остання сесія' }}</span>
          <span class="stat-value">{{ st.lastSessionAgo }}</span>
        </div>
      </section>
    }

    @if (loading()) {
      <div class="hint">{{ i18n.t('general.loading') }}</div>
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
          {{ i18n.t('chars.new_patient') }}
        </a>
      </section>
    } @else if (filteredCharacters().length === 0) {
      <!-- Has patients but the active filters excluded all of them.
           Offer a one-click reset of EVERY active filter (both
           modality and difficulty) — easier than figuring out which
           chip is at fault. -->
      <section class="empty-state synapse-panel filtered">
        <h2>Під ці фільтри ніхто не підпадає</h2>
        <p>
          Спробуй скинути активні фільтри —
          @if (modalityFilter()) {
            модальність ({{ modalityInfo(modalityFilter())?.label }})
          }
          @if (modalityFilter() && difficultyFilter() != null) { · }
          @if (difficultyFilter() != null) {
            складність {{ difficultyFilter() }}/5
          }
        </p>
        <button class="primary" type="button" (click)="resetAllFilters()">
          Скинути фільтри
        </button>
      </section>
    } @else {
      @for (group of groupedByCity(); track group.key) {
        <section class="city-group fx-fade-up">
          <header class="city-group-head">
            <h2 class="city-group-title">
              <span class="city-group-pin">📍</span>
              {{ group.displayName }}
            </h2>
            <span class="city-group-count dim">
              {{ group.characters.length }} {{ patientsWord(group.characters.length) }}
            </span>
          </header>
          <ul class="patient-grid fx-stagger">
            @for (c of group.characters; track c.id) {
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
                  <div class="name-row">
                    <h3 class="name">{{ c.displayName }}</h3>
                    @if (modalityInfo(c.modality); as m) {
                      @if (m.key !== 'individual') {
                        <span class="modality-badge"
                              [class]="'modality-' + m.key"
                              [title]="m.description">
                          <span class="modality-badge-icon">{{ m.icon }}</span>
                          <span class="modality-badge-label">{{ m.label }}</span>
                        </span>
                      }
                    }
                  </div>
                  @if (c.diagnosis) {
                    <p class="diagnosis" [title]="diagnosisTooltip(c)">{{ c.diagnosis }}</p>
                  }
                  <div class="metrics">
                    @if (c.difficulty != null) {
                      <div class="metric"
                           [title]="i18n.t('chars.difficulty') + ' ' + c.difficulty + '/5'">
                        <span class="metric-label">{{ i18n.t('chars.difficulty') }}</span>
                        <span class="stars stars-behavior">{{ stars(c.difficulty) }}</span>
                      </div>
                    }
                    @if (c.complexity != null) {
                      <div class="metric"
                           [title]="i18n.t('chars.complexity') + ' ' + c.complexity + '/5'">
                        <span class="metric-label">{{ i18n.t('chars.complexity') }}</span>
                        <span class="dots dots-clinical">{{ dots(c.complexity) }}</span>
                      </div>
                    }
                  </div>
                  <div class="card-stats">
                    @if (c.sessionCount && c.sessionCount > 0) {
                      <span class="meta-stat">{{ c.sessionCount }} {{ sessionsWord(c.sessionCount) }}</span>
                      @if (c.lastSessionAt) {
                        <span class="dot">·</span>
                        <span class="meta-stat dim">{{ c.lastSessionAt | date: 'dd.MM' }}</span>
                      }
                    } @else {
                      <span class="meta-stat dim">{{ i18n.t('session.no_sessions') }}</span>
                    }
                  </div>
                </div>
              </li>
            }
          </ul>
        </section>
      }
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
    /* Modality filter row variant — sits above the difficulty filter,
       gets its own bottom border to read as a separate filter group. */
    .filters-modality {
      border-top: none;
      padding-top: 14px;
      margin-bottom: 4px;
    }
    .chip.modality-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .chip.modality-chip .modality-icon {
      font-size: 14px;
      line-height: 1;
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
    /* Name + optional modality badge sit on one row. Badge is allowed
       to shrink and ellipsize before the name does so a really long
       label (sometimes happens for couples/family in narrow cards)
       doesn't squeeze the name to a stub. */
    .name-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .name {
      margin: 0;
      font-size: 16px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1 1 auto;
      min-width: 0;
    }
    /* Modality badge — small accent pill with icon + label. The icon
       carries most of the meaning so on narrow cards we let the label
       text drop to "…" via overflow-ellipsis on .modality-badge-label. */
    .modality-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
      color: var(--accent);
      font-size: 10px;
      letter-spacing: 0.02em;
      flex-shrink: 0;
      max-width: 50%;
    }
    .modality-badge-icon { font-size: 11px; line-height: 1; }
    .modality-badge-label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* Crisis modality gets a danger-tinted variant so it stands out
       from couples/family/adolescent — same shape, different colour. */
    .modality-badge.modality-crisis {
      background: color-mix(in srgb, var(--danger) 14%, transparent);
      border-color: color-mix(in srgb, var(--danger) 35%, transparent);
      color: var(--danger);
    }
    @media (max-width: 480px) {
      /* Hide the label on narrow phones — the icon alone is enough
         once you know the icon→modality mapping. */
      .modality-badge-label { display: none; }
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

    /* City grouping — one section per city, quiet header with accent
       hairline below, then per-city patient grid. */
    .city-group { margin-bottom: 32px; }
    .city-group:last-child { margin-bottom: 0; }
    .city-group-head {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin: 0 0 14px;
      padding-bottom: 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border));
    }
    .city-group-title {
      margin: 0;
      font-size: 15px;
      font-weight: 500;
      letter-spacing: -0.005em;
      color: var(--fg);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .city-group-pin { font-size: 13px; opacity: 0.75; }
    .city-group-count {
      font-size: 12px;
      letter-spacing: 0.02em;
      font-variant-numeric: tabular-nums;
    }
    .lang-flag { font-size: 13px; line-height: 1; }

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
  readonly i18n = inject(I18nService);

  characters = signal<Character[]>([]);

  constructor() {
    // Re-fetch the character list whenever the locale changes so the
    // card grid immediately shows the right-language patients without
    // a manual page refresh.
    effect(() => {
      void this.i18n.lang(); // subscribe — runs again on every lang change
      void this.loadCharacters();
    });
  }

  private async loadCharacters() {
    this.loading.set(true);
    try {
      this.characters.set(await this.api.listCharacters());
    } catch {
      // Keep existing list; error surface stays in ngOnInit
    } finally {
      this.loading.set(false);
    }
  }
  loading = signal(true);
  error = signal<string | null>(null);
  difficultyFilter = signal<number | null>(null);

  /** Modality filter — null means "all types". Independent of the
   *  difficulty filter; the two compose in filteredCharacters(). */
  modalityFilter = signal<ModalityKey | null>(null);

  /** Static modality catalog fetched from /api/characters/modalities
   *  on init. Used by the filter row (icons + labels) and by the
   *  card badge component. Empty until the fetch resolves. */
  modalityCatalog = signal<ModalityInfo[]>([]);

  /** Subset of the catalog that actually has at least 1 patient.
   *  Hides chips like "крізова" when no one in the library is in
   *  that modality yet — keeps the filter row from looking sparse. */
  visibleModalities = computed(() =>
    this.modalityCatalog().filter((m) => this.countByModality(m.key) > 0),
  );

  filteredCharacters = computed(() => {
    const dFilter = this.difficultyFilter();
    const mFilter = this.modalityFilter();
    let result = this.characters();
    if (mFilter !== null) result = result.filter((c) => (c.modality ?? 'individual') === mFilter);
    if (dFilter !== null) result = result.filter((c) => c.difficulty === dFilter);
    return result;
  });

  /** Filtered characters bucketed by city. Order: cities with the most
   *  recently active session first, then by bucket size desc, then
   *  "Other" (legacy rows w/o cityId) pinned to the bottom. */
  groupedByCity = computed<Array<{ key: string; displayName: string; characters: Character[]; lastActiveMs: number }>>(() => {
    const OTHER = '__other__';
    const buckets = new Map<string, { key: string; displayName: string; characters: Character[]; lastActiveMs: number }>();
    for (const c of this.filteredCharacters()) {
      const key = c.city?.key ?? OTHER;
      const displayName = c.city?.displayName ?? this.i18n.t('chars.city_other');
      let b = buckets.get(key);
      if (!b) { b = { key, displayName, characters: [], lastActiveMs: 0 }; buckets.set(key, b); }
      b.characters.push(c);
      const ts = c.lastSessionAt ? new Date(c.lastSessionAt).getTime() : 0;
      if (ts > b.lastActiveMs) b.lastActiveMs = ts;
    }
    const arr = Array.from(buckets.values());
    arr.sort((a, b) => {
      if (a.key === OTHER) return 1;
      if (b.key === OTHER) return -1;
      if (a.lastActiveMs !== b.lastActiveMs) return b.lastActiveMs - a.lastActiveMs;
      if (a.characters.length !== b.characters.length) return b.characters.length - a.characters.length;
      return a.displayName.localeCompare(b.displayName);
    });
    return arr;
  });

  /** Plural form for "пацієнт" — UK 1/few/many; EN one/other. */
  patientsWord(n: number): string {
    if (this.i18n.isEn) {
      return n === 1 ? this.i18n.t('chars.city_count_one') : this.i18n.t('chars.city_count_few');
    }
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return this.i18n.t('chars.city_count_one');
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return this.i18n.t('chars.city_count_few');
    return this.i18n.t('chars.city_count_many');
  }

  readonly supportedLangs = SUPPORTED_LANGS;
  setLang(l: Lang) {
    if (this.i18n.lang() === l) return;
    this.i18n.setLang(l);
  }

  countByModality(key: ModalityKey): number {
    return this.characters().filter((c) => (c.modality ?? 'individual') === key).length;
  }

  /** Lookup a modality info by key — used by templates that need the
   *  icon/label for a single patient (badges on cards and hero). */
  modalityInfo(key: ModalityKey | undefined | null): ModalityInfo | null {
    return this.modalityCatalog().find((m) => m.key === (key ?? 'individual')) ?? null;
  }

  toggleModality(key: ModalityKey) {
    this.modalityFilter.set(this.modalityFilter() === key ? null : key);
  }

  /** Clears every active filter at once — wired to the "Скинути
   *  фільтри" button on the filtered-empty state. */
  resetAllFilters() {
    this.modalityFilter.set(null);
    this.difficultyFilter.set(null);
  }

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

  toggleLang() {
    this.i18n.setLang(this.i18n.isEn ? 'uk' : 'en');
  }

  setDifficulty(d: number) {
    this.difficultyFilter.set(this.difficultyFilter() === d ? null : d);
  }

  countByDifficulty(d: number): number {
    return this.characters().filter((c) => c.difficulty === d).length;
  }

  /** Welcome-modal visibility. Set on init if this is the user's first
   *  visit (no localStorage flag) AND they have not yet started any
   *  session — gates the modal so existing users don't see it. */
  showWelcome = signal(false);

  async ngOnInit() {
    // First-time onboarding gate. We use localStorage (per-device) so
    // returning users on the same browser don't get nagged. New
    // browser / incognito → repeat — that's fine for now; sync via
    // user.preferencesJson can land later if it becomes annoying.
    const onboarded = localStorage.getItem('reflect.onboarded');
    if (!onboarded) {
      this.showWelcome.set(true);
    }

    // Modality catalog kicks off in parallel — chips render as soon as
    // the response arrives without blocking the main listing fetch.
    void this.api.listModalities()
      .then((ms) => this.modalityCatalog.set(ms))
      .catch(() => { /* silent: filter row + badges fall back to "no labels" */ });

    try {
      // loadCharacters() is also called by the lang effect, but that
      // fires after the first render; here we explicitly load on init
      // to satisfy the loading → character list flow.
      this.characters.set(await this.api.listCharacters());
    } catch {
      this.error.set(this.i18n.isEn
        ? 'Server unavailable. Check that the API is running.'
        : 'Сервер недоступний. Перевір, чи API запущений на :3000.');
    } finally {
      this.loading.set(false);
    }
  }

  dismissWelcome() {
    this.showWelcome.set(false);
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
