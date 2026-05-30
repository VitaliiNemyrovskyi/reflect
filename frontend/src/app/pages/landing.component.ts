import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18nService } from '../i18n.service';
import { LogoComponent } from '../logo.component';
import { IconComponent } from '../icon.component';

/**
 * Public marketing landing at `''` — prerendered to static HTML for SEO
 * (see app.routes.server.ts). Guests see this; authenticated users are
 * redirected to /dashboard by `landingGuard`, so this component never needs
 * to know about auth. Fully presentational + SSR-safe (no browser APIs at
 * init): renders identically on the server (prerender) and the client.
 *
 * Copy is Ukrainian-primary (the prerendered language) with an English
 * variant via `tr()`; French falls back to Ukrainian until per-language
 * prerendering lands.
 */
@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [RouterLink, LogoComponent, IconComponent],
  template: `
    <div class="landing">
      <!-- Guest top bar (the global app-header only renders when logged in). -->
      <header class="lnav">
        <a routerLink="/" class="lnav-brand" aria-label="Reflect"><app-logo /></a>
        <nav class="lnav-actions">
          <a routerLink="/login" class="lnav-login">{{ tr('Увійти', 'Sign in') }}</a>
          <a routerLink="/register" class="cta cta-sm">{{ tr('Спробувати', 'Try it') }}</a>
        </nav>
      </header>

      <!-- Hero -->
      <section class="lhero">
        <span class="eyebrow">{{ tr('AI-тренажер психотерапії', 'AI psychotherapy trainer') }}</span>
        <h1>{{ tr('Стань кращим терапевтом — сесія за сесією', 'Become a better therapist, session by session') }}</h1>
        <p class="lead">
          {{ tr(
            'Reflect — симулятор для майбутніх психотерапевтів. Проводь реалістичні сесії з AI-клієнтами, отримуй розбір рівня супервізора після кожної та відстежуй свій прогрес.',
            'Reflect is a simulator for trainee psychotherapists. Run realistic sessions with AI clients, get supervisor-level feedback after each one, and track your growth.'
          ) }}
        </p>
        <div class="lcta-row">
          <a routerLink="/register" class="cta">{{ tr('Спробувати безкоштовно', 'Try it free') }}</a>
          <a routerLink="/demo" class="cta cta-ghost">{{ tr('Подивитися демо', 'See a demo') }}</a>
        </div>
        <p class="lcta-note">{{ tr('3 безкоштовні сесії · без картки', '3 free sessions · no card required') }}</p>
      </section>

      <!-- The learn-by-doing loop -->
      <section class="lsteps" [attr.aria-label]="tr('Як це працює', 'How it works')">
        <article class="lstep synapse-panel">
          <span class="lstep-ic"><app-icon name="video" /></span>
          <h3>{{ tr('Практикуй', 'Practise') }}</h3>
          <p>{{ tr(
            'Відеосесія з AI-пацієнтом: живі запити, емоції й спротив. Реалістичні клієнти різної складності та модальностей.',
            'A video session with an AI patient — real concerns, emotions and resistance. Realistic clients across difficulties and modalities.'
          ) }}</p>
        </article>
        <article class="lstep synapse-panel">
          <span class="lstep-ic"><app-icon name="clipboard" /></span>
          <h3>{{ tr('Отримуй фідбек', 'Get feedback') }}</h3>
          <p>{{ tr(
            'AI-супервізор розбирає сесію за 8+ клінічними вимірами — альянс, емпатія, скринінг ризику, формулювання — як справжній наставник.',
            'An AI supervisor reviews the session across 8+ clinical dimensions — alliance, empathy, risk screening, formulation — like a real mentor.'
          ) }}</p>
        </article>
        <article class="lstep synapse-panel">
          <span class="lstep-ic"><app-icon name="chart-up" /></span>
          <h3>{{ tr('Зростай', 'Grow') }}</h3>
          <p>{{ tr(
            'Радар компетенцій, бейджі та спеціалізації показують, де ти сильний і над чим попрацювати. Скоро — курси-скілпаси.',
            'A competency radar, badges and specialisations show your strengths and what to work on. Skill-path courses coming soon.'
          ) }}</p>
        </article>
      </section>

      <!-- Trust strip -->
      <section class="ltrust">
        <div class="ltrust-item"><app-icon name="users" /><span>{{ tr('Реалістичні кейси з Києва, Лондона й Парижа', 'Realistic cases from Kyiv, London and Paris') }}</span></div>
        <div class="ltrust-item"><app-icon name="clipboard" /><span>{{ tr('Психологічні тести: PHQ-9, GAD-7, WHO-5', 'Built-in screeners: PHQ-9, GAD-7, WHO-5') }}</span></div>
        <div class="ltrust-item"><app-icon name="shield-check" /><span>{{ tr('Безпечне середовище — це навчання, не справжня терапія', 'A safe space — this is training, not real therapy') }}</span></div>
      </section>

      <!-- Pricing teaser + final CTA -->
      <section class="lfinal synapse-panel">
        <h2>{{ tr('Готовий провести першу сесію?', 'Ready for your first session?') }}</h2>
        <p>{{ tr('Почни безкоштовно — 3 сесії. Далі від ₴249/міс.', 'Start free — 3 sessions. Then from ₴249/mo.') }}</p>
        <div class="lcta-row">
          <a routerLink="/register" class="cta">{{ tr('Спробувати безкоштовно', 'Try it free') }}</a>
          <a routerLink="/pricing" class="cta cta-ghost">{{ tr('Дивитися тарифи', 'See pricing') }}</a>
        </div>
      </section>
    </div>
  `,
  styles: [`
    .landing { display: flex; flex-direction: column; gap: 72px; padding-bottom: 24px; }

    /* Guest nav */
    .lnav {
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px; padding-top: 4px;
    }
    .lnav-brand { display: inline-flex; text-decoration: none; }
    .lnav-actions { display: flex; align-items: center; gap: 14px; }
    .lnav-login { color: var(--fg-dim); text-decoration: none; font-size: 14px; transition: color .15s ease; }
    .lnav-login:hover { color: var(--fg); }

    /* Shared CTA button */
    .cta {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 13px 22px; border-radius: 12px;
      background: var(--accent); color: var(--accent-ink, #15151b);
      font-weight: 600; font-size: 15px; text-decoration: none;
      border: 1px solid var(--accent);
      transition: transform .12s ease, box-shadow .15s ease, background .15s ease;
      box-shadow: 0 10px 30px -12px color-mix(in srgb, var(--accent) 60%, transparent);
    }
    .cta:hover { transform: translateY(-1px); box-shadow: 0 14px 34px -12px color-mix(in srgb, var(--accent) 70%, transparent); }
    .cta-sm { padding: 9px 16px; font-size: 14px; border-radius: 10px; }
    .cta-ghost {
      background: transparent; color: var(--fg);
      border: 1px solid var(--border); box-shadow: none;
    }
    .cta-ghost:hover { border-color: var(--accent); color: var(--accent); transform: translateY(-1px); }

    /* Hero */
    .lhero { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 18px; padding: 40px 0 8px; }
    .eyebrow {
      font-size: 12px; letter-spacing: .14em; text-transform: uppercase;
      color: var(--accent); font-weight: 600;
      padding: 5px 12px; border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
      border-radius: 999px; background: color-mix(in srgb, var(--accent) 8%, transparent);
    }
    .lhero h1 {
      margin: 6px 0 0; max-width: 16ch;
      font-size: clamp(30px, 6vw, 52px); line-height: 1.08; font-weight: 600;
      letter-spacing: -0.02em;
      background: linear-gradient(180deg, var(--fg), color-mix(in srgb, var(--fg) 72%, var(--accent)));
      -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    }
    .lead { max-width: 60ch; margin: 0; font-size: clamp(16px, 2.2vw, 19px); line-height: 1.55; color: var(--fg-dim); }
    .lcta-row { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; margin-top: 8px; }
    .lcta-note { margin: 2px 0 0; font-size: 13px; color: var(--fg-dim); }

    /* Steps */
    .lsteps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
    .lstep { padding: 28px 24px; display: flex; flex-direction: column; gap: 10px; }
    .lstep-ic {
      display: inline-flex; align-items: center; justify-content: center;
      width: 46px; height: 46px; border-radius: 12px; font-size: 22px;
      color: var(--accent);
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
      margin-bottom: 4px;
    }
    .lstep h3 { margin: 0; font-size: 19px; font-weight: 600; }
    .lstep p { margin: 0; color: var(--fg-dim); line-height: 1.55; font-size: 15px; }

    /* Trust */
    .ltrust { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .ltrust-item { display: flex; align-items: center; gap: 11px; color: var(--fg-dim); font-size: 14px; line-height: 1.4; }
    .ltrust-item app-icon { color: var(--accent); font-size: 20px; flex: 0 0 auto; }

    /* Final CTA */
    .lfinal { text-align: center; padding: 44px 28px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .lfinal h2 { margin: 0; font-size: clamp(24px, 4vw, 34px); font-weight: 600; letter-spacing: -0.01em; }
    .lfinal p { margin: 0; color: var(--fg-dim); font-size: 16px; }
    .lfinal .lcta-row { margin-top: 10px; }

    @media (max-width: 760px) {
      .landing { gap: 52px; }
      .lsteps, .ltrust { grid-template-columns: 1fr; }
      .lhero { padding-top: 24px; }
    }
  `],
})
export class LandingComponent {
  private i18n = inject(I18nService);

  /** uk-primary, en variant; fr falls back to uk for now. */
  protected tr(uk: string, en: string): string {
    return this.i18n.isEn ? en : uk;
  }
}
