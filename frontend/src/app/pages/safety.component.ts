import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

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
      <a routerLink="/" class="back-link">← На головну</a>
      <h1>Безпека та обмеження</h1>
    </header>

    <section class="synapse-panel safety-block">
      <span class="section-label">DISCLAIMER</span>
      <h2>Це навчальний тренажер, не справжня терапія</h2>
      <p>
        Reflect — інструмент для відпрацювання терапевтичних навичок із AI-персонажами.
        Кожен «пацієнт» — це мовна модель, що грає роль за заданим профілем. Розмови з нею:
      </p>
      <ul>
        <li>не є клінічною роботою з реальними людьми</li>
        <li>не замінюють супервізію живою людиною</li>
        <li>не гарантують, що ефективна стратегія тут спрацює з реальним клієнтом</li>
        <li>не є оцінкою твоєї професійної придатності</li>
      </ul>
      <p>
        Якість тренування залежить від твоєї рефлексії та живого супервізора.
        Reflect — це додатковий простір для практики, не заміна формальної освіти.
      </p>
    </section>

    <section class="synapse-panel safety-block">
      <span class="section-label">ЯКЩО ТОБІ ЗАРАЗ ПОТРІБНА ДОПОМОГА</span>
      <h2>Контакти кризових служб</h2>
      <p class="lead">
        Якщо тобі важко — не справжній «пацієнт», а ти сам/-а: ось де можна
        отримати реальну допомогу.
      </p>

      <h3>Україна</h3>
      <dl class="resources">
        <div class="res-row">
          <dt>Lifeline Ukraine</dt>
          <dd>
            <a href="tel:7333">7333</a> — безкоштовно з будь-якого номера
            <br/>
            <small>Цілодобова лінія психологічної підтримки для громадян та
            ветеранів</small>
          </dd>
        </div>
        <div class="res-row">
          <dt>Безкоштовна лінія МОЗ</dt>
          <dd>
            <a href="tel:0800600200">0 800 60 02 00</a>
            <br/>
            <small>Цілодобова, з фіксованих і мобільних</small>
          </dd>
        </div>
        <div class="res-row">
          <dt>Розкажи мені</dt>
          <dd>
            <a href="https://rozkazhy.me" target="_blank" rel="noopener noreferrer">rozkazhy.me</a>
            <br/>
            <small>Безкоштовна онлайн-психологічна підтримка</small>
          </dd>
        </div>
        <div class="res-row">
          <dt>«Друг» (центр громадського здоров'я)</dt>
          <dd>
            <a href="tel:0800504201">0 800 50 42 01</a>
            <br/>
            <small>Психологічна підтримка дітей та підлітків</small>
          </dd>
        </div>
      </dl>

      <h3>Міжнародні</h3>
      <dl class="resources">
        <div class="res-row">
          <dt>Befrienders Worldwide</dt>
          <dd>
            <a href="https://befrienders.org" target="_blank" rel="noopener noreferrer">befrienders.org</a>
            <br/>
            <small>Каталог гарячих ліній по країнах</small>
          </dd>
        </div>
        <div class="res-row">
          <dt>IASP Crisis Centres</dt>
          <dd>
            <a href="https://www.iasp.info/resources/Crisis_Centres" target="_blank" rel="noopener noreferrer">iasp.info/resources/Crisis_Centres</a>
            <br/>
            <small>Каталог Міжнародної асоціації запобігання суїцидам</small>
          </dd>
        </div>
      </dl>
    </section>

    <section class="synapse-panel safety-block">
      <span class="section-label">ПРИВАТНІСТЬ</span>
      <h2>Що ми зберігаємо</h2>
      <ul>
        <li>Email і ім'я акаунта (для входу)</li>
        <li>Профілі пацієнтів, які ти створив/-ла</li>
        <li>Транскрипти сесій (доступні тільки тобі)</li>
        <li>Нотатки і фідбеки супервізора-AI</li>
      </ul>
      <p>
        Сесії <strong>не передаються третім сторонам</strong> крім провайдера LLM
        (Anthropic API) для генерації відповіді AI-пацієнтки. Anthropic не використовує
        вміст наших запитів для тренування своїх моделей.
      </p>
      <p>
        Видалити акаунт + усі дані можна на сторінці
        <a routerLink="/profile">профілю</a>.
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
export class SafetyComponent {}
