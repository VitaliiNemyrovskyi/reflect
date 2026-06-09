import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AnalyticsService } from '../analytics.service';
import { I18nService } from '../i18n.service';

/**
 * Public landing demo — shows a real Opus reviewer output on a
 * sample session so prospective users see the product's actual value
 * before being asked to register. No auth required.
 *
 * Content is a curated excerpt from a real test session with
 * "Olesya" (composite depression case with passive suicidal
 * ideation) — chosen because the supervisor's catch on the missed
 * risk screening is the most clinically striking demonstration of
 * what the AI does well.
 */
@Component({
  selector: 'app-demo',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="demo-page">
      <!-- Hero -->
      <header class="hero">
        <p class="kicker">{{ i18n.isEn ? 'REFLECT — DEMO' : i18n.t('demo.kicker') }}</p>
        @if (demoContent) {
          <h1>{{ demoContent.heroTitle }}</h1>
          <p class="subtitle">{{ demoContent.heroSubtitle }}</p>
        } @else {
          <h1>{{ i18n.t('demo.heroTitle') }}</h1>
          <p class="subtitle">
            {{ i18n.t('demo.heroSubtitlePart1') }} <strong>{{ i18n.t('demo.heroSubtitleStrong') }}</strong>{{ i18n.t('demo.heroSubtitlePart2') }}
          </p>
        }
      </header>

      <!-- Split: transcript | feedback -->
      <div class="split">
        @if (demoContent) {
          <!-- English demo: Emma Clarke findings -->
          <section class="transcript-pane">
            <h2 class="pane-title">Client</h2>
            <div class="client-card">
              <p class="client-name">{{ demoContent.clientName }}</p>
              <p class="client-context">{{ demoContent.clientContext }}</p>
            </div>
            <p class="note">
              The session transcript has been reviewed by the Opus supervisor.
              <strong>Three representative findings</strong> from the 14-dimension
              analysis are shown on the right.
            </p>
          </section>

          <section class="feedback-pane">
            <h2 class="pane-title">Opus Supervisor Feedback</h2>
            @for (finding of demoContent.findings; track finding.title) {
              <article class="catch" [class.critical]="finding.icon === '⚠️'">
                <div class="catch-head">
                  <span class="catch-icon" aria-hidden="true">{{ finding.icon }}</span>
                  <span class="catch-label">{{ finding.title }}</span>
                </div>
                <p>{{ finding.text }}</p>
              </article>
            }
          </section>
        } @else {
          <!-- Ukrainian demo: Olesya session -->
          <section class="transcript-pane">
            <h2 class="pane-title">{{ i18n.t('demo.transcriptTitle') }}</h2>

            <div class="bubble therapist">
              <span class="line-ref">L3</span>
              <strong>{{ i18n.t('demo.roleTherapist') }}</strong>
              <p>{{ i18n.t('demo.l3Therapist') }}</p>
            </div>

            <div class="bubble client">
              <span class="line-ref">L4</span>
              <strong>{{ i18n.t('demo.roleOlesya') }}</strong>
              <p>
                {{ i18n.t('demo.l4Client') }}
              </p>
            </div>

            <div class="bubble therapist">
              <span class="line-ref">L5</span>
              <strong>{{ i18n.t('demo.roleTherapist') }}</strong>
              <p>{{ i18n.t('demo.l5Therapist') }}</p>
            </div>

            <div class="bubble client">
              <span class="line-ref">L6</span>
              <strong>{{ i18n.t('demo.roleOlesya') }}</strong>
              <p>
                {{ i18n.t('demo.l6Client') }}
              </p>
            </div>

            <div class="bubble therapist">
              <span class="line-ref">L13</span>
              <strong>{{ i18n.t('demo.roleTherapist') }}</strong>
              <p>
                {{ i18n.t('demo.l13Therapist') }}
              </p>
            </div>

            <div class="bubble client">
              <span class="line-ref">L14</span>
              <strong>{{ i18n.t('demo.roleOlesya') }}</strong>
              <p>
                {{ i18n.t('demo.l14ClientPart1') }} <em>{{ i18n.t('demo.l14ClientEm') }}</em>
              </p>
            </div>

            <p class="note">
              {{ i18n.t('demo.transcriptNotePart1') }} <strong>{{ i18n.t('demo.transcriptNoteStrong') }}</strong>{{ i18n.t('demo.transcriptNotePart2') }}
            </p>
          </section>

          <section class="feedback-pane">
            <h2 class="pane-title">{{ i18n.t('demo.feedbackTitle') }}</h2>

            <!-- Most striking catch first -->
            <article class="catch critical">
              <div class="catch-head">
                <span class="catch-icon" aria-hidden="true">⚠</span>
                <span class="catch-label">{{ i18n.t('demo.catch1Label') }}</span>
              </div>
              <h3>{{ i18n.t('demo.catch1Title') }}</h3>
              <p>
                {{ i18n.t('demo.catch1Para1Part1') }} <strong>{{ i18n.t('demo.catch1Para1Strong') }}</strong>{{ i18n.t('demo.catch1Para1Part2') }}
              </p>
              <p>
                {{ i18n.t('demo.catch1Para2Part1') }} <span class="line-tag">[L14]</span> {{ i18n.t('demo.catch1Para2Part2') }} «<strong>{{ i18n.t('demo.catch1Para2Strong') }}</strong>» {{ i18n.t('demo.catch1Para2Part3') }}
              </p>
              <div class="rewrite">
                <p class="rewrite-label">{{ i18n.t('demo.rewriteLabel') }}</p>
                <blockquote>
                  {{ i18n.t('demo.rewriteQuote') }}
                </blockquote>
                <p class="rewrite-hint">
                  {{ i18n.t('demo.rewriteHintPart1') }} <strong>{{ i18n.t('demo.rewriteHintStrong') }}</strong>{{ i18n.t('demo.rewriteHintPart2') }}
                </p>
              </div>
            </article>

            <article class="catch">
              <div class="catch-head">
                <span class="catch-icon" aria-hidden="true">🔍</span>
                <span class="catch-label">{{ i18n.t('demo.catch2Label') }}</span>
              </div>
              <h3>{{ i18n.t('demo.catch2Title') }}</h3>
              <p>
                {{ i18n.t('demo.catch2Para1Part1') }} <span class="line-tag">[L11]</span> {{ i18n.t('demo.catch2Para1Part2') }} («<em>{{ i18n.t('demo.catch2Para1Em') }}</em>»). {{ i18n.t('demo.catch2Para1Part3') }} <strong>{{ i18n.t('demo.catch2Para1Strong') }}</strong>{{ i18n.t('demo.catch2Para1Part4') }}
              </p>
            </article>

            <article class="catch">
              <div class="catch-head">
                <span class="catch-icon" aria-hidden="true">📐</span>
                <span class="catch-label">{{ i18n.t('demo.catch3Label') }}</span>
              </div>
              <h3>{{ i18n.t('demo.catch3Title') }}</h3>
              <p>{{ i18n.t('demo.catch3Intro') }}</p>
              <ul class="dims">
                <li>{{ i18n.t('demo.dimAlliance') }} <span class="dim-tag warn">{{ i18n.t('demo.dimAllianceTag') }}</span></li>
                <li>{{ i18n.t('demo.dimPresenting') }} <span class="dim-tag warn">{{ i18n.t('demo.dimPresentingTag') }}</span></li>
                <li>{{ i18n.t('demo.dimSelfDiagnosis') }} <span class="dim-tag bad">{{ i18n.t('demo.dimSelfDiagnosisTag') }}</span></li>
                <li>{{ i18n.t('demo.dimRisk') }} <span class="dim-tag bad">{{ i18n.t('demo.dimRiskTag') }}</span></li>
                <li>{{ i18n.t('demo.dimHypothesis') }} <span class="dim-tag bad">{{ i18n.t('demo.dimHypothesisTag') }}</span></li>
                <li>{{ i18n.t('demo.dimClosing') }} <span class="dim-tag bad">{{ i18n.t('demo.dimClosingTag') }}</span></li>
              </ul>
            </article>
          </section>
        }
      </div>

      <!-- CTA strip -->
      <section class="cta-band">
        <div class="cta-inner">
          <div class="cta-copy">
            @if (i18n.isEn) {
              <h2>Start your own session</h2>
              <p>14 days free. 3 sessions with training feedback. No card required.</p>
            } @else {
              <h2>{{ i18n.t('demo.ctaTitle') }}</h2>
              <p>
                {{ i18n.t('demo.ctaSubtitle') }}
              </p>
            }
          </div>
          <div class="cta-actions">
            <a routerLink="/register" class="btn btn-primary">
              {{ i18n.isEn ? 'Start free' : i18n.t('demo.ctaStartBtn') }}
            </a>
            <a routerLink="/pricing" class="btn btn-secondary">
              {{ i18n.t('nav.pricing') }}
            </a>
          </div>
        </div>
      </section>

      <footer class="demo-footer">
        @if (i18n.isEn) {
          <p>
            Emma Clarke is a <strong>fictional composite</strong> synthesised from
            public clinical descriptions. Not a real person.
          </p>
        } @else {
          <p>
            {{ i18n.t('demo.footerDisclaimerPart1') }} <strong>{{ i18n.t('demo.footerDisclaimerStrong') }}</strong>{{ i18n.t('demo.footerDisclaimerPart2') }}
          </p>
        }
        <p>
          <a routerLink="/safety">{{ i18n.t('nav.safety') }}</a>
        </p>
      </footer>
    </div>
  `,
  styles: [`
    .demo-page {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px 16px 48px;
      color: #ecebf3;
    }

    /* Hero */
    .hero {
      max-width: 760px;
      margin: 24px auto 40px;
      text-align: center;
    }
    .kicker {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      color: #d8c9ff;
      margin: 0 0 14px;
    }
    .hero h1 {
      font-size: 32px;
      font-weight: 600;
      letter-spacing: -0.01em;
      margin: 0 0 18px;
      line-height: 1.2;
    }
    .hero .subtitle {
      font-size: 16px;
      line-height: 1.6;
      color: #a9a3bd;
      margin: 0;
    }
    .hero strong { color: #ecebf3; }

    /* Split: transcript | feedback */
    .split {
      display: grid;
      grid-template-columns: 1fr 1.1fr;
      gap: 24px;
      margin-bottom: 48px;
    }
    @media (max-width: 880px) {
      .split { grid-template-columns: 1fr; gap: 16px; }
    }

    .pane-title {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #8b859e;
      margin: 0 0 16px;
    }

    /* Transcript bubbles */
    .transcript-pane {
      background: #15141b;
      border: 1px solid #2a2735;
      border-radius: 12px;
      padding: 20px;
    }
    .bubble {
      position: relative;
      padding: 12px 14px 12px 50px;
      margin-bottom: 12px;
      border-radius: 10px;
      font-size: 14px;
      line-height: 1.55;
    }
    .bubble.therapist {
      background: rgba(216, 201, 255, 0.06);
      border: 1px solid rgba(216, 201, 255, 0.15);
    }
    .bubble.client {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid #2a2735;
    }
    .line-ref {
      position: absolute;
      left: 12px;
      top: 12px;
      font-size: 10px;
      font-weight: 600;
      font-family: 'SF Mono', Menlo, monospace;
      color: #d8c9ff;
      padding: 2px 5px;
      border-radius: 4px;
      background: rgba(216, 201, 255, 0.1);
    }
    .bubble strong { display: block; font-size: 12px; color: #8b859e; margin-bottom: 4px; }
    .bubble p { margin: 0; color: #c8c3da; }
    .bubble em { font-style: italic; color: #ecebf3; }

    .note {
      margin: 20px 0 0;
      padding: 12px 16px;
      background: rgba(240, 200, 100, 0.06);
      border-left: 3px solid #ddc880;
      border-radius: 4px;
      font-size: 13px;
      line-height: 1.6;
      color: #c8c3da;
    }
    .note strong { color: #ecebf3; }

    /* Feedback catches */
    .feedback-pane { display: flex; flex-direction: column; gap: 16px; }

    .catch {
      background: #15141b;
      border: 1px solid #2a2735;
      border-radius: 12px;
      padding: 20px;
    }
    .catch.critical {
      border-color: rgba(220, 100, 100, 0.4);
      box-shadow: 0 0 0 1px rgba(220, 100, 100, 0.2) inset;
    }
    .catch-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .catch-icon { font-size: 18px; }
    .catch.critical .catch-icon { color: #dd8888; }
    .catch-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #8b859e;
    }
    .catch.critical .catch-label { color: #dd8888; }

    .catch h3 {
      font-size: 17px;
      font-weight: 600;
      margin: 0 0 12px;
    }
    .catch p {
      font-size: 14px;
      line-height: 1.6;
      color: #c8c3da;
      margin: 0 0 12px;
    }
    .catch p:last-child { margin-bottom: 0; }
    .catch strong { color: #ecebf3; }
    .catch em { font-style: italic; color: #d8c9ff; }
    .line-tag {
      font-family: 'SF Mono', Menlo, monospace;
      font-size: 12px;
      color: #d8c9ff;
      background: rgba(216, 201, 255, 0.1);
      padding: 1px 6px;
      border-radius: 4px;
    }

    .rewrite {
      margin-top: 12px;
      padding: 14px;
      background: rgba(120, 200, 130, 0.06);
      border-left: 3px solid #8edd8e;
      border-radius: 4px;
    }
    .rewrite-label {
      font-size: 11px !important;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #8edd8e !important;
      margin: 0 0 8px !important;
    }
    .rewrite blockquote {
      margin: 0 0 8px;
      padding: 0;
      font-size: 14px;
      line-height: 1.55;
      font-style: italic;
      color: #ecebf3;
      border: none;
    }
    .rewrite-hint {
      font-size: 12px !important;
      color: #8b859e !important;
      margin: 0 !important;
    }
    .rewrite-hint strong { color: #c8c3da; }

    .dims {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .dims li {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 6px;
      font-size: 14px;
      color: #c8c3da;
    }
    .dim-tag {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .dim-tag.warn { background: rgba(220, 180, 80, 0.15); color: #ddc880; }
    .dim-tag.bad { background: rgba(220, 100, 100, 0.15); color: #dd8888; }

    /* CTA band */
    .cta-band {
      background: linear-gradient(135deg,
        rgba(216, 201, 255, 0.12) 0%,
        rgba(216, 201, 255, 0.04) 100%);
      border: 1px solid rgba(216, 201, 255, 0.2);
      border-radius: 16px;
      padding: 32px;
      margin-bottom: 24px;
    }
    .cta-inner {
      display: flex;
      gap: 24px;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
    }
    .cta-copy { flex: 1; min-width: 240px; }
    .cta-copy h2 {
      font-size: 24px;
      font-weight: 600;
      margin: 0 0 8px;
    }
    .cta-copy p {
      font-size: 15px;
      color: #a9a3bd;
      margin: 0;
    }
    .cta-actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-block;
      padding: 14px 22px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      text-decoration: none;
      min-height: 48px;
      box-sizing: border-box;
      transition: background 0.15s, transform 0.1s;
    }
    .btn:active { transform: scale(0.98); }
    .btn-primary { background: #d8c9ff; color: #0b0b0d; }
    .btn-primary:hover { background: #ebdcff; }
    .btn-secondary {
      background: transparent;
      color: #ecebf3;
      border: 1px solid #3a3745;
    }
    .btn-secondary:hover { background: #2a2735; }

    /* Footer */
    .demo-footer {
      text-align: center;
      color: #6a6580;
      font-size: 13px;
      line-height: 1.7;
    }
    .demo-footer p { margin: 6px 0; }
    .demo-footer strong { color: #8b859e; }
    .demo-footer a { color: #d8c9ff; text-decoration: none; }
    .demo-footer a:hover { text-decoration: underline; }

    /* English demo: client card */
    .client-card {
      background: rgba(216, 201, 255, 0.06);
      border: 1px solid rgba(216, 201, 255, 0.15);
      border-radius: 10px;
      padding: 16px 20px;
      margin-bottom: 16px;
    }
    .client-name {
      font-size: 18px;
      font-weight: 600;
      color: #ecebf3;
      margin: 0 0 6px;
    }
    .client-context {
      font-size: 13px;
      color: #a9a3bd;
      margin: 0;
    }

    @media (max-width: 480px) {
      .hero h1 { font-size: 24px; }
      .hero .subtitle { font-size: 14px; }
      .transcript-pane, .catch { padding: 16px; }
      .cta-band { padding: 24px 18px; }
      .cta-actions { width: 100%; }
      .cta-actions .btn { flex: 1; text-align: center; }
    }
  `],
})
export class DemoComponent implements OnInit {
  private analytics = inject(AnalyticsService);
  i18n = inject(I18nService);

  ngOnInit() {
    this.analytics.track('page.demo');
  }

  get demoContent() {
    if (this.i18n.isEn) {
      return {
        clientName: 'Emma Clarke',
        clientContext: '29, UX Designer, London — anxiety, grief after breakup',
        findings: [
          { icon: '⚠️', title: 'Critical Miss: Safety Screening', text: 'At L12, Emma says «everything feels pointless». This is passive suicidal ideation — requires direct screening. The therapist missed it entirely.' },
          { icon: '🔍', title: 'Defence Mechanism Named', text: 'Emma uses intellectualisation throughout [L10, L14]. She explains her grief academically to avoid feeling it. The supervisor names this pattern and shows how to work with it.' },
          { icon: '💔', title: 'Grief Unaddressed', text: 'Emma ended a 3-year relationship out of fear [L16] — the first time she said this out loud. The therapist pivoted to CBT homework instead of staying with the disclosure.' },
        ],
        heroTitle: 'Supervisor-level feedback after every session',
        heroSubtitle: 'Reflect analyses 14 clinical dimensions in parallel — suicidality, defences, alliance, differential diagnosis, CBT technique quality, and more.',
      };
    }
    return null; // use existing Ukrainian content
  }
}
