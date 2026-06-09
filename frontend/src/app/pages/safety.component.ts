import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18nService } from '../i18n.service';

/**
 * Safety + disclaimer page.
 *
 * Two audiences, two concerns:
 *
 *   1. The TRAINEE THERAPIST using Reflect — needs to understand the
 *      AI patient is not a clinical encounter and outcomes here don't
 *      transfer 1:1 to real practice. Mitigates the risk of trainees
 *      mistaking confident AI responses for actual clinical wisdom.
 *
 *   2. ANYONE on the platform who is themselves in distress — the
 *      tool deals with sensitive material (suicidality, grief,
 *      addiction). Even though they're "playing therapist", a real
 *      user with their own mental-health needs might land here and
 *      should always have one click to actual human help.
 *
 * Resources are Ukrainian-focused (Reflect's primary audience) with a
 * brief international fallback for English-speaking users.
 */
@Component({
  selector: 'app-safety',
  standalone: true,
  imports: [RouterLink],
  template: `
    <header class="page-head">
      <a routerLink="/" class="back-link">← {{ i18n.t('safety.backHome') }}</a>
      <h1>{{ i18n.t('safety.title') }}</h1>
    </header>

    <section class="synapse-panel safety-block">
      <span class="section-label">DISCLAIMER</span>
      <h2>{{ i18n.t('safety.disclaimerHeading') }}</h2>
      <p>{{ i18n.t('safety.disclaimerIntro') }}</p>
      <ul>
        <li>{{ i18n.t('safety.disclaimerItem1') }}</li>
        <li>{{ i18n.t('safety.disclaimerItem2') }}</li>
        <li>{{ i18n.t('safety.disclaimerItem3') }}</li>
        <li>{{ i18n.t('safety.disclaimerItem4') }}</li>
      </ul>
      <p>{{ i18n.t('safety.disclaimerOutro') }}</p>
    </section>

    <section class="synapse-panel safety-block">
      <span class="section-label">{{ i18n.t('safety.crisisLabel') }}</span>
      <h2>{{ i18n.t('safety.crisisHeading') }}</h2>
      <p class="lead">{{ i18n.t('safety.crisisLead') }}</p>

      <h3>{{ i18n.t('safety.ukraineHeading') }}</h3>
      <dl class="resources">
        <div class="res-row">
          <dt>Lifeline Ukraine</dt>
          <dd>
            <a href="tel:7333">7333</a> — {{ i18n.t('safety.lifelineFree') }}
            <br/>
            <small>{{ i18n.t('safety.lifelineDesc') }}</small>
          </dd>
        </div>
        <div class="res-row">
          <dt>{{ i18n.t('safety.mozTitle') }}</dt>
          <dd>
            <a href="tel:0800600200">0 800 60 02 00</a>
            <br/>
            <small>{{ i18n.t('safety.mozDesc') }}</small>
          </dd>
        </div>
        <div class="res-row">
          <dt>{{ i18n.t('safety.rozkazhyTitle') }}</dt>
          <dd>
            <a href="https://rozkazhy.me" target="_blank" rel="noopener noreferrer">rozkazhy.me</a>
            <br/>
            <small>{{ i18n.t('safety.rozkazhyDesc') }}</small>
          </dd>
        </div>
        <div class="res-row">
          <dt>{{ i18n.t('safety.drugTitle') }}</dt>
          <dd>
            <a href="tel:0800504201">0 800 50 42 01</a>
            <br/>
            <small>{{ i18n.t('safety.drugDesc') }}</small>
          </dd>
        </div>
      </dl>

      <h3>{{ i18n.t('safety.internationalHeading') }}</h3>
      <dl class="resources">
        <div class="res-row">
          <dt>Befrienders Worldwide</dt>
          <dd>
            <a href="https://befrienders.org" target="_blank" rel="noopener noreferrer">befrienders.org</a>
            <br/>
            <small>{{ i18n.t('safety.befriendersDesc') }}</small>
          </dd>
        </div>
        <div class="res-row">
          <dt>IASP Crisis Centres</dt>
          <dd>
            <a href="https://www.iasp.info/resources/Crisis_Centres" target="_blank" rel="noopener noreferrer">iasp.info/resources/Crisis_Centres</a>
            <br/>
            <small>{{ i18n.t('safety.iaspDesc') }}</small>
          </dd>
        </div>
      </dl>
    </section>

    <section class="synapse-panel safety-block">
      <span class="section-label">{{ i18n.t('safety.privacyLabel') }}</span>
      <h2>{{ i18n.t('safety.privacyHeading') }}</h2>
      <ul>
        <li>{{ i18n.t('safety.privacyItem1') }}</li>
        <li>{{ i18n.t('safety.privacyItem2') }}</li>
        <li>{{ i18n.t('safety.privacyItem3') }}</li>
        <li>{{ i18n.t('safety.privacyItem4') }}</li>
      </ul>
      <p>
        {{ i18n.t('safety.privacyShareBefore') }}<strong>{{ i18n.t('safety.privacyShareEmphasis') }}</strong>{{ i18n.t('safety.privacyShareAfter') }}
      </p>
      <p>
        {{ i18n.t('safety.privacyDeleteBefore') }}<a routerLink="/profile">{{ i18n.t('safety.privacyDeleteLink') }}</a>{{ i18n.t('safety.privacyDeleteAfter') }}
      </p>
    </section>
  `,
  styles: [`
    .page-head {
      margin-bottom: 24px;
    }
    .back-link {
      color: var(--accent);
      text-decoration: none;
      font-size: 13px;
      display: inline-block;
      margin-bottom: 12px;
    }
    .back-link:hover { text-decoration: underline; }
    h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 400;
      letter-spacing: -0.01em;
    }

    .safety-block {
      padding: 28px 32px;
      margin-bottom: 18px;
    }
    .safety-block h2 {
      margin: 6px 0 16px;
      font-size: 18px;
      font-weight: 500;
    }
    .safety-block h3 {
      margin: 24px 0 12px;
      font-size: 13px;
      font-weight: 500;
      color: var(--accent);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .safety-block p {
      margin: 12px 0;
      line-height: 1.6;
      color: var(--fg-dim);
    }
    .safety-block p.lead {
      color: var(--fg);
    }
    .safety-block ul {
      margin: 12px 0;
      padding-left: 22px;
      color: var(--fg-dim);
      line-height: 1.65;
    }
    .safety-block strong { color: var(--fg); }
    .safety-block a {
      color: var(--accent);
      text-decoration: none;
    }
    .safety-block a:hover { text-decoration: underline; }
    /* Crisis-page links specifically — these are tap targets a person in
     * acute distress (or shaking hands) must hit. Bumping to ≥44px
     * touch area meets WCAG 2.5.5 and reduces misclicks on mobile. We
     * apply this only to anchors inside resource lists (tel: + http
     * hotline links), not back-link / profile-link in paragraphs. */
    .safety-block .res-row dd a,
    .safety-block ul a {
      display: inline-block;
      min-height: 44px;
      min-width: 44px;
      padding: 12px 10px;
      font-size: 15px;
      line-height: 20px;
      font-weight: 500;
      text-align: center;
      vertical-align: middle;
      box-sizing: border-box;
    }

    .resources {
      margin: 12px 0 0;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .res-row {
      display: grid;
      grid-template-columns: 200px 1fr;
      gap: 16px;
      align-items: baseline;
    }
    .res-row dt {
      font-weight: 500;
      color: var(--fg);
    }
    .res-row dd {
      margin: 0;
      color: var(--fg-dim);
      font-size: 14px;
      line-height: 1.5;
    }
    .res-row dd small {
      color: var(--fg-dim);
      opacity: 0.75;
      font-size: 12px;
    }
    @media (max-width: 600px) {
      .res-row {
        grid-template-columns: 1fr;
        gap: 4px;
      }
    }
  `],
})
export class SafetyComponent {
  protected readonly i18n = inject(I18nService);
}
