import { CommonModule } from '@angular/common';
import { Component, OnInit, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ApiService,
  type CaseloadNudge,
  DashboardPatient,
  DashboardResponse,
  type PatientWellbeing,
} from '../api.service';
import { AuthService } from '../auth.service';
import { I18nService } from '../i18n.service';
import { IconComponent } from '../icon.component';

/**
 * Logged-in home page — the living world dashboard.
 *
 * Visual hierarchy:
 *   1. Compact top bar: greeting + date + city pill (city pulse
 *      expandable on click, NOT dominating the page)
 *   2. Continue / pending CTAs as slim banners (only if relevant)
 *   3. Diary feed — masonry grid of patient first-person cards. THIS
 *      is the centerpiece. Avatars + character names + tagged content.
 *   4. Stats strip — inline pills at the bottom, not big cards
 *   5. Patient grid — avatar-first mosaic
 *
 * Backed by a single /api/dashboard call. ngOnInit fires it; the
 * language toggle calls load() explicitly so we don't depend on an
 * effect (an earlier effect-based approach caused a load→loading→
 * load infinite loop because the effect read `loading()`).
 */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterLink, IconComponent],
  template: `
    <header class="home-header">
      <div class="title-row">
        <!-- City frame: small thumbnail-sized photo of the active
             locale's city, framed in the site's accent border. Sits
             top-left of the dashboard, alongside the greeting. Click
             to expand the weekly digest below (preserves the previous
             pill behavior). Hidden on narrow phones to save space. -->
        @if (data()?.city; as city) {
          <button
            type="button"
            class="city-frame"
            [class.expanded]="cityExpanded()"
            [class.has-digest]="!!city.weeklyDigest"
            (click)="city.weeklyDigest && cityExpanded.set(!cityExpanded())"
            [attr.aria-expanded]="cityExpanded()"
            [attr.aria-label]="city.displayName">
            <img [src]="cityImgSrc()" [alt]="city.displayName" class="city-frame-img" />
            <div class="city-frame-overlay">
              <span class="city-frame-pin"><app-icon name="map-pin" /></span>
              <span class="city-frame-name">{{ city.displayName }}</span>
              @if (city.weatherSummary) {
                <span class="city-frame-weather">· {{ city.weatherSummary }}</span>
              }
              @if (city.weeklyDigest) {
                <span class="city-frame-toggle">{{ cityExpanded() ? '–' : '+' }}</span>
              }
            </div>
          </button>
        }

        <div class="greeting">
          @if (auth.user(); as u) {
            <h1>
              {{ i18n.t('home.greeting') }}{{ greetingName() }}<span class="comma">,</span>
            </h1>
          }
          <p class="date dim">{{ today() }}</p>
        </div>
      </div>

      <!-- Weekly digest panel — opens beneath the title-row when the
           framed city image is clicked. Uses the same .panel.panel-soft
           .callout pattern as the MENTOR FEEDBACK card on patient-detail
           (small left accent rail, subtle accent tint on the interior,
           uppercase tracked title row). -->
      @if (cityExpanded() && data()?.city?.weeklyDigest; as digest) {
        <article class="panel panel-soft callout fx-fade-up city-digest-panel">
          <header class="panel-head">
            <h3 class="panel-title">{{ i18n.t('home.city_expand') }}</h3>
            @if (data()?.city; as city) {
              <span class="panel-meta">{{ city.displayName }}</span>
            }
          </header>
          <p class="city-digest-text">{{ digest }}</p>
        </article>
      }
    </header>

    <!-- While the dashboard payload is in flight, show ONE centered
         spinner instead of skeleton cards. The user explicitly asked
         for cards to appear already filled — never half-rendered. So
         the @if guard below only enters once data() is non-null, which
         is set atomically in the same change-detection tick the
         response arrives. No structural cards visible without their
         content. -->
    @if (!data()) {
      <div class="loader">
        <div class="spinner"></div>
      </div>
    }

    @if (data(); as d) {

      <!-- Continue session: vital-row pattern from patient-detail.
           Same hover/active treatment, accent glow on hover, link-btn
           "→ Продовжити" trailing. -->
      @if (d.activeSessions.length > 0) {
        <div class="continue-stack">
          @for (s of d.activeSessions; track s.id) {
            <a [routerLink]="['/session', s.id]" class="vital-row continue-row">
              @if (s.character.avatarUrl) {
                <img [src]="s.character.avatarUrl" [alt]="s.character.displayName" class="row-avatar" />
              } @else {
                <div class="row-avatar fallback">{{ initials(s.character.displayName) }}</div>
              }
              <div class="row-body">
                <span class="vital-label">{{ i18n.t('home.continue') }}</span>
                <span class="vital-value">{{ s.character.displayName }}</span>
                <span class="vital-meta">{{ s.messageCount }} {{ i18n.t('home.replies') }} · {{ relativeTime(s.startedAt) }}</span>
              </div>
              <span class="link-btn row-cta">→</span>
            </a>
          }
        </div>
      }

      <!-- Pending feedback: panel callout with link-btn rows -->
      @if (d.pendingFeedback.length > 0) {
        <article class="panel callout panel-soft pending-panel">
          <header class="panel-head">
            <h2 class="panel-title">{{ i18n.t('home.pending_feedback') }}</h2>
            <span class="panel-meta">{{ d.pendingFeedback.length }}</span>
          </header>
          <ul class="pending-list">
            @for (s of d.pendingFeedback; track s.id) {
              <li>
                <a [routerLink]="['/session', s.id, 'feedback']" class="link-btn">
                  {{ s.character.displayName }} <span class="dim">#{{ s.id }}</span> →
                </a>
              </li>
            }
          </ul>
        </article>
      }

      <!-- Patient catalog — panel container hosting city-grouped grid.
           Same .panel surface as patient-detail uses, so the home and
           the patient page now share a visual language. -->
      <article class="panel patient-panel">
        <header class="panel-head">
          <h2 class="panel-title">{{ i18n.t('home.patients') }}</h2>
          @if (d.hasMorePatients) {
            <a routerLink="/clients" class="link-btn">{{ i18n.t('home.see_all') }} →</a>
          }
        </header>

        <!-- One gentle care-loop nudge (§12): most-idle slipping patient. -->
        @if (d.caseloadNudge; as n) {
          <a [routerLink]="['/patient', n.characterId]"
             class="caseload-nudge"
             [class.at-risk]="n.stage === 'at_risk'">
            <span class="nudge-dot"></span>
            <span class="nudge-text">{{ nudgeText(n) }}</span>
            <span class="nudge-cta">{{ i18n.isEn ? 'Open' : 'Відкрити' }} →</span>
          </a>
        }

        @for (group of groupedPatients(d.patientGrid); track group.key; let first = $first) {
          <div class="patient-city-block">
            <div class="patient-city-head">
              <span class="patient-city-pin"><app-icon name="map-pin" /></span>
              <span class="patient-city-name">{{ group.displayName }}</span>
              <span class="patient-city-count dim">· {{ group.characters.length }}</span>
            </div>
            <div class="patient-grid">
              @for (p of group.characters; track p.id) {
                <a [routerLink]="['/patient', p.id]"
                   class="patient-card"
                   [class.lapsed]="p.wellbeing?.stage === 'lapsed'">
                  @if (p.wellbeing && p.wellbeing.stage !== 'active') {
                    <span class="wb-dot"
                          [class]="'wb-' + p.wellbeing.stage"
                          [title]="wellbeingTitle(p.wellbeing)"></span>
                  }
                  @if (p.avatarUrl) {
                    <img [src]="p.avatarUrl" [alt]="p.displayName" class="patient-avatar" />
                  } @else {
                    <div class="avatar-fallback patient">{{ initials(p.displayName) }}</div>
                  }
                  <div class="patient-card-body">
                    <div class="patient-name">{{ p.displayName }}</div>
                    @if (p.lastSessionAt) {
                      <div class="patient-last dim">{{ relativeTime(p.lastSessionAt) }}</div>
                    }
                  </div>
                </a>
              }
              @if (first) {
                <a routerLink="/patient/new" class="patient-card new-card">
                  <div class="new-icon">+</div>
                  <div class="patient-card-body">
                    <div class="dim">{{ i18n.t('chars.new_patient') }}</div>
                  </div>
                </a>
              }
            </div>
          </div>
        }
      </article>

      <!-- Week stats — same .panel + .facts-row pattern as the
           sector-detail-table on patient-detail. Uniform label / big
           number / units, evenly distributed. Replaces the floating
           pills from the previous version. -->
      <article class="panel panel-soft stats-panel">
        <header class="panel-head">
          <h2 class="panel-title">{{ i18n.t('home.week_sessions') }}</h2>
          <span class="panel-meta">{{ i18n.isFr ? '7 derniers jours' : (i18n.isEn ? 'last 7 days' : 'останні 7 днів') }}</span>
        </header>
        <div class="facts-row">
          <div class="facts-cell">
            <span class="facts-label">{{ i18n.isFr ? 'Séances' : (i18n.isEn ? 'Sessions' : 'Сесій') }}</span>
            <span class="facts-value">{{ d.weekStats.sessions }}</span>
          </div>
          <div class="facts-cell">
            <span class="facts-label">{{ i18n.t('home.week_feedback') }}</span>
            <span class="facts-value">{{ d.weekStats.withFeedback }}<small> / {{ d.weekStats.sessions }}</small></span>
          </div>
          <div class="facts-cell">
            <span class="facts-label">{{ i18n.t('home.week_alliance') }}</span>
            <span class="facts-value">
              @if (d.weekStats.avgAlliance !== null) {
                {{ d.weekStats.avgAlliance | number: '1.1-1' }}<small> / 10</small>
              } @else { — }
            </span>
          </div>
        </div>
      </article>
    }
  `,
  styles: [`
    :host { display: block; }

    .home-header { margin-bottom: 24px; }

    .brand-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 22px;
      flex-wrap: wrap;
    }
    .user-area { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
    .user-name-link {
      color: var(--fg);
      text-decoration: none;
      font-size: 13px;
      padding: 4px 10px;
      border-radius: 6px;
      white-space: nowrap;
    }
    .user-name-link:hover { background: var(--user-bg); }

    /* Force the language + sign-out buttons to match the icon-button
       size (icons sit at ~28px square). Global .ghost button styling
       has a min-height for accessibility that makes them taller than
       the icons by default — overriding here to keep the header tight. */
    .user-area button.ghost,
    .user-area a.ghost {
      padding: 4px 10px;
      font-size: 12px;
      min-height: 0;
      line-height: 1.4;
      height: 28px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .user-area .ghost.icon {
      width: 28px;
      padding: 0;
      justify-content: center;
      font-size: 13px;
    }

    /* Lang flag span lives inside the global .reflect-segmented chip */
    .lang-flag { font-size: 13px; line-height: 1; }

    /* Title row: framed city image on the left, greeting on the right.
       The image is the ambient "where you are" anchor; click expands
       the weekly digest beneath the row. */
    .title-row {
      display: flex;
      align-items: flex-start;
      gap: 22px;
      flex-wrap: wrap;
    }
    .greeting {
      flex: 1 1 280px;
      min-width: 0;
    }
    .greeting h1 {
      margin: 0;
      font-size: 26px;
      font-weight: 400;
      letter-spacing: -0.015em;
      line-height: 1.2;
    }
    .greeting h1 .comma { color: var(--fg-dim); }
    .greeting .date {
      margin: 6px 0 0;
      font-size: 13px;
    }
    .dim { color: var(--fg-dim); }

    /* Framed city image — same two-layer rotating-conic-border trick
       as .hero-photo on patient-detail. The 1px border slot is
       transparent; padding-box gets a solid user-bg, border-box gets
       a conic-gradient that rotates via --frame-angle. Result: the
       border itself slowly cycles in sync with all the other framed
       elements in the app. */
    .city-frame {
      position: relative;
      flex: 0 0 auto;
      width: 260px;
      aspect-ratio: 16 / 10;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 14px;
      overflow: hidden;
      cursor: default;
      background:
        linear-gradient(var(--user-bg), var(--user-bg)) padding-box,
        conic-gradient(
          from var(--frame-angle),
          color-mix(in srgb, var(--accent) 100%, transparent) 0deg,
          color-mix(in srgb, var(--accent) 18%, transparent) 90deg,
          color-mix(in srgb, var(--accent) 95%, transparent) 180deg,
          color-mix(in srgb, var(--accent) 18%, transparent) 270deg,
          color-mix(in srgb, var(--accent) 100%, transparent) 360deg
        ) border-box;
      transition: transform .18s ease, filter .18s ease;
    }
    .city-frame.has-digest { cursor: pointer; }
    .city-frame.has-digest:hover {
      transform: translateY(-1px);
      filter: drop-shadow(0 14px 28px color-mix(in srgb, var(--accent) 40%, transparent));
    }
    .city-frame.expanded {
      filter: drop-shadow(0 14px 22px color-mix(in srgb, var(--accent) 55%, transparent));
    }
    .city-frame-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      filter: saturate(95%) contrast(102%);
    }
    .city-frame-overlay {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      padding: 26px 12px 10px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #fff;
      background: linear-gradient(to top, rgba(0, 0, 0, 0.78) 0%, rgba(0, 0, 0, 0.45) 55%, transparent 100%);
      pointer-events: none;
    }
    .city-frame-pin { font-size: 11px; line-height: 1; }
    .city-frame-name {
      font-weight: 500;
      letter-spacing: 0.01em;
    }
    .city-frame-weather {
      font-size: 11px;
      opacity: 0.85;
    }
    .city-frame-toggle {
      margin-left: auto;
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: color-mix(in srgb, var(--accent) 80%, transparent);
      color: var(--bg);
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
    }

    /* Digest panel overrides — sits below the title row, slightly
       tighter padding than the global .panel default so the city
       frame and digest read as a paired unit. The text inside is
       just a regular paragraph; all the visual treatment (subtle
       border, callout left rail, panel-head) comes from the global
       .panel.panel-soft.callout primitives. */
    .city-digest-panel {
      margin: 16px 0 24px;
    }
    .city-digest-text {
      margin: 0;
      font-size: 14px;
      line-height: 1.65;
      color: var(--fg);
      white-space: pre-wrap;
    }

    @media (max-width: 480px) {
      /* On phones, show the city photo as a full-width banner (it's the
         first child of .title-row, so it wraps onto its own line above the
         greeting). Shorter 16/7 aspect so it sets the scene without eating
         the whole hero. Previously hidden — which left a blank top gap. */
      .city-frame {
        width: 100%;
        aspect-ratio: 16 / 7;
      }
      .title-row { gap: 12px; }
    }

    /* Continue-stack — vertical list of vital-row cards (one per
       active session). Uses the global .vital-row treatment so the
       hover/active state matches patient-detail. The row-internals
       below are home-specific (avatar + body + cta layout). */
    .continue-stack {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 22px;
    }
    .continue-row {
      /* Override the global 1fr/auto grid for the 3-column layout
         (avatar | body | cta). The .vital-row base provides border,
         padding, hover/active states. */
      grid-template-columns: 44px 1fr auto;
      align-items: center;
      gap: 14px;
      padding: 12px 16px;
    }
    .row-avatar {
      width: 44px; height: 44px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--user-bg);
      border: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border));
    }
    .row-avatar.fallback {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--accent);
      font-weight: 500;
      font-size: 14px;
    }
    .row-body { min-width: 0; }
    .row-cta { font-size: 18px; }

    /* Pending feedback — uses the global .panel.callout pattern. */
    .pending-panel { margin-bottom: 22px; }
    .pending-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 4px 14px;
    }
    .pending-list li { padding: 2px 0; }

    /* Patient panel — wraps the city-grouped grid in the standard
       .panel surface so the home page reads as the same design system
       as patient-detail. */
    .patient-panel { margin-bottom: 22px; }
    .stats-panel { margin-bottom: 32px; }

    /* City block — wraps each per-city patient grid. Light header
       above the cards: pin + city name + count, intentionally quiet
       so the avatars stay the focus. */
    .patient-city-block {
      margin-bottom: 18px;
    }
    .patient-city-block:last-child { margin-bottom: 0; }
    .patient-city-head {
      display: inline-flex;
      align-items: baseline;
      gap: 5px;
      margin-bottom: 8px;
      font-size: 12px;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .patient-city-pin { font-size: 12px; opacity: 0.7; line-height: 1; }
    .patient-city-name {
      color: var(--fg);
      font-weight: 500;
      letter-spacing: 0.02em;
      text-transform: none;
      font-size: 13px;
    }
    .patient-city-count {
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.02em;
    }

    /* Patient mosaic — bigger photo + content centered in the card,
       both horizontally and vertically. Grid track grew from 120px to
       180px so the avatar can breathe; .patient-card itself is a
       flex column with center alignment so the avatar + name + last-
       session stack stays middle-aligned regardless of card height. */
    .patient-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 12px;
    }
    .patient-card {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      min-height: 200px;
      padding: 18px 14px;
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 14px;
      text-decoration: none;
      color: var(--fg);
      text-align: center;
      transition: transform .15s ease, border-color .15s ease, opacity .2s ease;
    }
    .patient-card:hover {
      transform: translateY(-2px);
      border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
    }

    /* ── Wellbeing care-loop (§12) ── ambient, never alarming. The dot
       appears ONLY for patients needing attention; healthy/active cards
       stay clean. Lapsed patients fade + desaturate (they "went cold"). */
    .wb-dot {
      position: absolute;
      top: 12px; right: 12px;
      width: 9px; height: 9px;
      border-radius: 50%;
      box-shadow: 0 0 0 3px var(--assistant-bg);
    }
    .wb-slipping {
      background: var(--warn);
      box-shadow: 0 0 0 3px var(--assistant-bg), 0 0 8px color-mix(in srgb, var(--warn) 60%, transparent);
    }
    .wb-at_risk {
      background: color-mix(in srgb, var(--danger) 55%, var(--warn));
      box-shadow: 0 0 0 3px var(--assistant-bg), 0 0 9px color-mix(in srgb, var(--danger) 50%, transparent);
    }
    .wb-lapsed { background: var(--fg-dim); }
    .patient-card.lapsed { opacity: 0.5; }
    .patient-card.lapsed .patient-avatar,
    .patient-card.lapsed .avatar-fallback.patient { filter: grayscale(0.9); }
    .patient-card.lapsed:hover { opacity: 0.8; }

    /* Single caseload nudge — a quiet, accent-tinted row. Informational,
       not a guilt-trip; at most one shows. */
    .caseload-nudge {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 16px;
      padding: 10px 14px;
      border: 1px solid color-mix(in srgb, var(--warn) 28%, var(--border));
      border-radius: 10px;
      background: color-mix(in srgb, var(--warn) 7%, var(--assistant-bg));
      text-decoration: none;
      color: var(--fg);
      font-size: 13px;
      transition: border-color .15s ease, background .15s ease;
    }
    .caseload-nudge:hover {
      border-color: color-mix(in srgb, var(--warn) 50%, var(--border));
      background: color-mix(in srgb, var(--warn) 11%, var(--assistant-bg));
    }
    .caseload-nudge.at-risk {
      border-color: color-mix(in srgb, var(--danger) 30%, var(--border));
      background: color-mix(in srgb, var(--danger) 7%, var(--assistant-bg));
    }
    .caseload-nudge .nudge-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--warn); flex: 0 0 auto;
    }
    .caseload-nudge.at-risk .nudge-dot { background: color-mix(in srgb, var(--danger) 55%, var(--warn)); }
    .caseload-nudge .nudge-text { flex: 1 1 auto; min-width: 0; }
    .caseload-nudge .nudge-cta { color: var(--fg-dim); font-size: 12px; white-space: nowrap; }
    .patient-avatar {
      width: 112px;
      height: 112px;
      border-radius: 50%;
      object-fit: cover;
      display: block;
      background: var(--user-bg);
      border: 1px solid color-mix(in srgb, var(--accent) 12%, var(--border));
    }
    .avatar-fallback.patient {
      width: 112px;
      height: 112px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      background: color-mix(in srgb, var(--accent) 15%, var(--user-bg));
      color: var(--accent);
      font-weight: 500;
    }
    .patient-card-body {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      width: 100%;
    }
    .patient-name {
      display: block;
      max-width: 100%;
      font-size: 14px;
      font-weight: 500;
      color: var(--fg);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .patient-last {
      display: block;
      font-size: 11px;
    }
    .new-card {
      border-style: dashed;
    }
    .new-icon {
      width: 112px;
      height: 112px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--accent) 12%, var(--user-bg));
      color: var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 44px;
      line-height: 1;
    }
    @media (max-width: 720px) {
      .patient-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
      .patient-avatar,
      .avatar-fallback.patient,
      .new-icon { width: 88px; height: 88px; }
      .avatar-fallback.patient { font-size: 24px; }
      .new-icon { font-size: 32px; }
      .patient-card { min-height: 170px; }
    }

    .hint { color: var(--fg-dim); font-size: 13px; margin-top: 16px; }

    /* Loader visible until the dashboard API resolves. Centered on
       the page so the user sees a deliberate "loading" state rather
       than half-rendered cards. */
    .loader {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 60px 20px;
    }
    .spinner {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 2.5px solid color-mix(in srgb, var(--accent) 25%, transparent);
      border-top-color: var(--accent);
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    @media (max-width: 720px) {
      .brand-row { gap: 8px; }
      .user-area { gap: 4px; }
      .greeting h1 { font-size: 22px; }
      .title-row { flex-direction: column; align-items: flex-start; }
      /* In a column flex, the row flex-basis (280px) becomes a HEIGHT, so the
         greeting stretched ~280px tall and left a big empty gap below the text.
         Reset to content height when stacked. */
      .greeting { flex: 0 0 auto; width: 100%; }
      .patient-grid { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); }
      .continue-row { grid-template-columns: 40px 1fr auto; padding: 10px 12px; }
      .row-avatar { width: 40px; height: 40px; }
      .facts-value { font-size: 18px; }
    }
  `],
})
export class HomeComponent implements OnInit {
  private api = inject(ApiService);
  protected auth = inject(AuthService);
  protected i18n = inject(I18nService);

  data = signal<DashboardResponse | null>(null);
  loading = signal(true);
  // Expanded by default — the weekly digest is the most-asked-about
  // bit of context for the trainee on landing. The click on the city
  // frame still toggles it shut for users who want a tighter view.
  cityExpanded = signal(true);

  constructor() {
    // Re-fetch the dashboard whenever the locale changes. The
    // AppHeader's lang picker calls i18n.setLang() globally; this
    // effect is how the home page picks that up. The effect also
    // serves as the initial load on mount, so ngOnInit doesn't need
    // to call load() separately.
    //
    // Subscribe to lang() only — reading loading() inside this effect
    // would create a load→loading→load loop (see the comment block at
    // the top of this file).
    effect(() => {
      this.i18n.lang();
      void this.load();
    });
  }

  /** Maps the active locale to its home-page city image. Lavender-
   *  tinted blue-hour cityscapes in frontend/public/cities/. */
  private readonly cityImgByLang: Record<string, string> = {
    uk: '/cities/kyiv.webp',
    en: '/cities/london.webp',
    fr: '/cities/paris.webp',
  };
  cityImgSrc(): string {
    return this.cityImgByLang[this.i18n.lang()] ?? '/cities/london.webp';
  }

  async ngOnInit() {
    // Initial dashboard load is driven by the constructor effect, which
    // fires on first change-detection tick. Leaving ngOnInit as a no-op
    // for future hook needs.
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.data.set(await this.api.dashboard());
    } catch {
      // Render gracefully — sections all guard on data() being present
    } finally {
      this.loading.set(false);
    }
  }

  /** "Доброго дня, Vitalii" — strip the surname for warmth. */
  greetingName(): string {
    const u = this.auth.user();
    if (!u) return '';
    const full = u.displayName ?? u.email;
    // Take just the first token — surname-less greeting feels more
    // personal, like a friend addressing you.
    const first = full.split(/[\s,@]/)[0];
    return ` ${first}`;
  }

  today(): string {
    return new Date().toLocaleDateString(this.i18n.isEn ? 'en-GB' : 'uk-UA', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  }

  /**
   * Localized short date — "27 трав." / "27 May". Uses native
   * Intl.DateTimeFormat so we don't depend on Angular's
   * registerLocaleData (which would be required for the date pipe
   * with locale 'uk' — without it the pipe silently broke the
   * surrounding template bindings, blanking every diary card after
   * the first one).
   */
  formatShortDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(
        this.i18n.isEn ? 'en-GB' : 'uk-UA',
        { day: 'numeric', month: 'short' },
      );
    } catch {
      return iso.slice(0, 10);
    }
  }

  initials(name: string): string {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((s) => s[0] ?? '')
      .join('')
      .toUpperCase();
  }

  relativeTime(iso: string): string {
    const date = new Date(iso);
    const diffMs = Date.now() - date.getTime();
    const min = Math.floor(diffMs / 60_000);
    const hr = Math.floor(min / 60);
    const day = Math.floor(hr / 24);
    if (this.i18n.isEn) {
      if (min < 1) return 'just now';
      if (min < 60) return `${min} min ago`;
      if (hr < 24) return `${hr} h ago`;
      if (day === 1) return 'yesterday';
      if (day < 7) return `${day} days ago`;
      return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    }
    if (min < 1) return 'щойно';
    if (min < 60) return `${min} хв тому`;
    if (hr < 24) return `${hr} год тому`;
    if (day === 1) return 'вчора';
    if (day < 7) return `${day} ${day < 5 ? 'дні' : 'днів'} тому`;
    return date.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
  }

  /** Tooltip on a patient card's wellbeing dot — gentle, informational. */
  wellbeingTitle(wb: PatientWellbeing): string {
    const w = Math.max(1, Math.round(wb.weeksIdle));
    if (wb.stage === 'lapsed') {
      return this.i18n.isEn ? 'Stopped coming — reach out to re-engage' : 'Припинив(ла) ходити — варто відновити контакт';
    }
    return this.i18n.isEn ? `Not seen in ~${w} wk${w === 1 ? '' : 's'}` : `Не було на сесії ~${w} тиж.`;
  }

  /** Copy for the single caseload nudge — informational, never guilt. */
  nudgeText(n: CaseloadNudge): string {
    const w = Math.max(1, Math.round(n.weeksIdle));
    return this.i18n.isEn
      ? `Haven't seen ${n.displayName} in ~${w} week${w === 1 ? '' : 's'}`
      : `${n.displayName} давно не було на сесії — ~${w} тиж.`;
  }

  /**
   * Group the home compact patientGrid by city.
   *
   * Order rules — same as /clients but lighter:
   *   1. Cities the user is most recently active in float to the top
   *      (max lastSessionAt across the bucket).
   *   2. Larger buckets next (so the city with the most patients
   *      shows first when there's no session history yet).
   *   3. "Other" (legacy rows without cityId) always at the bottom.
   *
   * Keeps cards in their original order within each bucket — the
   * backend already sorted them by lastSessionAt desc.
   */
  groupedPatients(patients: DashboardPatient[]): Array<{
    key: string;
    displayName: string;
    characters: DashboardPatient[];
    lastActiveMs: number;
  }> {
    const OTHER_KEY = '__other__';
    const buckets = new Map<string, {
      key: string;
      displayName: string;
      characters: DashboardPatient[];
      lastActiveMs: number;
    }>();
    for (const p of patients) {
      const key = p.city?.key ?? OTHER_KEY;
      const displayName = p.city?.displayName ?? this.i18n.t('home.city_other');
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { key, displayName, characters: [], lastActiveMs: 0 };
        buckets.set(key, bucket);
      }
      bucket.characters.push(p);
      const ts = p.lastSessionAt ? new Date(p.lastSessionAt).getTime() : 0;
      if (ts > bucket.lastActiveMs) bucket.lastActiveMs = ts;
    }
    const arr = Array.from(buckets.values());
    arr.sort((a, b) => {
      if (a.key === OTHER_KEY) return 1;
      if (b.key === OTHER_KEY) return -1;
      if (a.lastActiveMs !== b.lastActiveMs) return b.lastActiveMs - a.lastActiveMs;
      if (a.characters.length !== b.characters.length) return b.characters.length - a.characters.length;
      return a.displayName.localeCompare(b.displayName);
    });
    return arr;
  }
}
