import { CommonModule } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, BillingStatus, PlanConfig } from '../api.service';
import { AuthService } from '../auth.service';

/**
 * Public pricing page. Lists all 4 plans (Trial, Lite, Pro, Master)
 * with prices, features, and a CTA per card.
 *
 * Behaviour:
 *  - Logged-out: CTA → /register
 *  - Logged-in on Trial: CTA on paid plans → /account/billing
 *  - Logged-in on Lite/Pro/Master: CTA on higher tiers → /account/billing
 *      with "Upgrade to <plan>" pre-selected
 *  - Current plan is highlighted with a "Поточний план" badge
 *
 * Until Stripe/LiqPay is wired, the "Upgrade" CTA opens a Telegram
 * link to support — we'll swap to a checkout URL when payments are live.
 */
@Component({
  selector: 'app-pricing',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="pricing-page">
      <header class="hero">
        <h1>Тарифи</h1>
        <p class="subtitle">
          Тренувальник для майбутніх психотерапевтів. AI-супервізор
          розбирає кожну твою сесію за 8 канонічними вимірами інтейку —
          від альянсу до закриття.
        </p>
        <p class="hint">
          Прозоро: усі ціни в гривнях, без прихованих платежів. Скасуй у
          будь-який момент.
        </p>
      </header>

      <div class="tiers">
        @for (plan of plans(); track plan.id) {
          <article
            class="tier"
            [class.tier-popular]="plan.id === 'pro'"
            [class.tier-current]="isCurrent(plan.id)"
          >
            @if (plan.id === 'pro') {
              <span class="badge-popular">Найпопулярніший</span>
            }
            @if (isCurrent(plan.id)) {
              <span class="badge-current">Поточний план</span>
            }

            <header class="tier-head">
              <h2>{{ plan.name }}</h2>
              <p class="tagline">{{ plan.tagline }}</p>
            </header>

            <div class="price">
              @if (plan.priceUah === 0) {
                <span class="price-amount">0 ₴</span>
                <span class="price-period">14 днів</span>
              } @else {
                <span class="price-amount">{{ plan.priceUah }} ₴</span>
                <span class="price-period">/ міс</span>
                @if (plan.annualPriceUah) {
                  <span class="price-annual">
                    або {{ plan.annualPriceUah }} ₴/рік (–17%)
                  </span>
                }
                @if (plan.semesterPriceUah) {
                  <span class="price-annual">
                    семестр (4 міс): {{ plan.semesterPriceUah }} ₴
                  </span>
                }
              }
            </div>

            <ul class="highlights">
              @for (h of plan.highlights; track h) {
                <li>{{ h }}</li>
              }
            </ul>

            <div class="cta">
              @if (!isLoggedIn()) {
                <a routerLink="/register" class="btn btn-primary">
                  Спробувати безкоштовно
                </a>
              } @else if (isCurrent(plan.id)) {
                <a routerLink="/account/billing" class="btn btn-secondary">
                  Управляти підпискою
                </a>
              } @else if (plan.id === 'trial') {
                <a routerLink="/account/billing" class="btn btn-secondary">
                  Поточний trial видно в кабінеті
                </a>
              } @else {
                <a
                  [href]="upgradeContactLink(plan.id)"
                  target="_blank"
                  rel="noopener"
                  class="btn btn-primary"
                >
                  Перейти на {{ plan.name }}
                </a>
              }
            </div>
          </article>
        }
      </div>

      <section class="addons">
        <h3>Add-on (купується окремо)</h3>
        <div class="addon">
          <div>
            <strong>Human Supervisor Review — 800 ₴</strong>
            <p>
              Український практикуючий супервізор переглядає твою сесію + AI-фідбек,
              дає 200-словний коментар. Купуєш разово на будь-якому тарифі.
            </p>
          </div>
        </div>
      </section>

      <section class="faq">
        <h3>Часті запитання</h3>
        <details>
          <summary>Як працює trial?</summary>
          <p>
            14 днів безкоштовно, 3 сесії з базовим фідбеком (Sonnet
            reviewer). Без карти. Після 14-го дня сесії перестають
            створюватись — твої попередні сесії зберігаються.
          </p>
        </details>
        <details>
          <summary>Чим різниця між Pro і Master?</summary>
          <p>
            Pro — необмежені сесії з найкращим супервізором (Opus). Master
            додає custom characters (створи власного пацієнта), advanced
            analytics, експорт у Notion та early access до нових
            персонажів.
          </p>
        </details>
        <details>
          <summary>Що з оплатою? Картка тільки?</summary>
          <p>
            Карти (Visa/Mastercard), Apple/Google Pay, а також разові
            гривневі платежі через LiqPay. Семестровий пакет на Pro можна
            оплатити одним переказом.
          </p>
        </details>
        <details>
          <summary>Якщо вирішу зупинити — що з даними?</summary>
          <p>
            Можна паузнути підписку (до 6 місяців) — дані зберігаються,
            оплат немає. Або скасувати повністю — доступ до сесій до
            кінця оплаченого періоду, потім read-only.
          </p>
        </details>
      </section>
    </div>
  `,
  styles: [`
    .pricing-page {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px 16px 64px;
      color: #ecebf3;
    }

    .hero {
      text-align: center;
      max-width: 720px;
      margin: 24px auto 40px;
    }
    .hero h1 {
      font-size: 36px;
      font-weight: 600;
      margin: 0 0 12px;
    }
    .hero .subtitle {
      font-size: 16px;
      line-height: 1.6;
      color: #a9a3bd;
      margin: 0 0 8px;
    }
    .hero .hint {
      font-size: 13px;
      color: #6a6580;
      margin: 0;
    }

    .tiers {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
      margin-bottom: 48px;
    }

    .tier {
      position: relative;
      background: #15141b;
      border: 1px solid #2a2735;
      border-radius: 12px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .tier-popular {
      border-color: #d8c9ff;
      box-shadow: 0 0 0 1px #d8c9ff inset;
      transform: translateY(-4px);
    }
    .tier-current {
      border-color: #5a8c5a;
    }
    .badge-popular,
    .badge-current {
      position: absolute;
      top: -10px;
      left: 50%;
      transform: translateX(-50%);
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      border-radius: 12px;
      white-space: nowrap;
    }
    .badge-popular {
      background: #d8c9ff;
      color: #0b0b0d;
    }
    .badge-current {
      background: #5a8c5a;
      color: #0b0b0d;
    }

    .tier-head h2 {
      margin: 0 0 6px;
      font-size: 22px;
    }
    .tagline {
      margin: 0;
      font-size: 13px;
      color: #8b859e;
    }

    .price {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 0;
      border-top: 1px solid #2a2735;
      border-bottom: 1px solid #2a2735;
    }
    .price-amount {
      font-size: 28px;
      font-weight: 600;
    }
    .price-period {
      font-size: 13px;
      color: #8b859e;
    }
    .price-annual {
      font-size: 12px;
      color: #d8c9ff;
      margin-top: 4px;
    }

    .highlights {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex: 1;
    }
    .highlights li {
      font-size: 14px;
      line-height: 1.5;
      padding-left: 22px;
      position: relative;
    }
    .highlights li::before {
      content: '✓';
      position: absolute;
      left: 0;
      color: #d8c9ff;
      font-weight: 700;
    }

    .cta { margin-top: auto; }
    .btn {
      display: block;
      text-align: center;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      text-decoration: none;
      transition: background 0.2s;
    }
    .btn-primary {
      background: #d8c9ff;
      color: #0b0b0d;
    }
    .btn-primary:hover { background: #ebdcff; }
    .btn-secondary {
      background: #2a2735;
      color: #ecebf3;
      border: 1px solid #3a3745;
    }
    .btn-secondary:hover { background: #34303f; }

    .addons {
      background: #15141b;
      border: 1px solid #2a2735;
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 32px;
    }
    .addons h3 {
      margin: 0 0 12px;
      font-size: 18px;
    }
    .addon strong {
      display: block;
      font-size: 15px;
      margin-bottom: 4px;
    }
    .addon p {
      font-size: 13px;
      color: #a9a3bd;
      line-height: 1.5;
      margin: 0;
    }

    .faq h3 {
      margin: 0 0 16px;
      font-size: 20px;
    }
    .faq details {
      background: #15141b;
      border: 1px solid #2a2735;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 8px;
    }
    .faq summary {
      cursor: pointer;
      font-weight: 500;
      font-size: 14px;
    }
    .faq p {
      margin: 12px 0 0;
      font-size: 13px;
      color: #a9a3bd;
      line-height: 1.6;
    }

    @media (max-width: 720px) {
      .tiers {
        grid-template-columns: 1fr;
      }
      .tier-popular {
        transform: none;
      }
    }
  `],
})
export class PricingComponent implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  plans = signal<PlanConfig[]>([]);
  status = signal<BillingStatus | null>(null);
  isLoggedIn = computed(() => !!this.auth.accessToken());

  async ngOnInit() {
    // Plans endpoint is auth-gated by the global JwtAuthGuard. For
    // anonymous visitors we'd want a public version; for now we
    // hard-code an unauth'd fallback by skipping the fetch and using
    // a static client-side mirror of the catalog.
    if (this.isLoggedIn()) {
      try {
        const [plans, status] = await Promise.all([
          this.api.listPlans(),
          this.api.billingStatus().catch(() => null),
        ]);
        this.plans.set(plans);
        this.status.set(status);
      } catch {
        this.plans.set(STATIC_PLANS);
      }
    } else {
      this.plans.set(STATIC_PLANS);
    }
  }

  isCurrent(planId: string): boolean {
    return this.status()?.plan === planId;
  }

  upgradeContactLink(planId: string): string {
    // Until Stripe wired, we direct upgrade-intent to support DM.
    const text = encodeURIComponent(
      `Хочу перейти на тариф ${planId.toUpperCase()} у Reflect. Як оплатити?`,
    );
    return `https://t.me/reflect_support?text=${text}`;
  }
}

/**
 * Mirror of the backend PLANS catalog for anonymous visitors who can't
 * hit /api/billing/plans (auth-gated). Update in lockstep with the
 * backend file. Acceptable duplication for static marketing content.
 */
const STATIC_PLANS: PlanConfig[] = [
  {
    id: 'trial',
    name: 'Trial',
    tagline: 'Спробуй, перш ніж зважитися',
    priceUah: 0,
    priceUsd: 0,
    annualPriceUah: null,
    semesterPriceUah: null,
    trialDays: 14,
    sessionLimit: 3,
    softCap: null,
    reviewerModel: 'sonnet',
    charactersAccessibleCount: 3,
    modalitiesAllAccess: false,
    features: {
      psychTests: false, progressGraphs: false, pdfExport: false,
      customCharacters: false, advancedAnalytics: false, notionExport: false,
      earlyAccess: false, prioritySupport: false,
    },
    highlights: [
      '3 сесії за 14 днів',
      '3 з 8 персонажів',
      'Базовий фідбек (Sonnet)',
      'Без експорту, без тестів',
    ],
  },
  {
    id: 'lite',
    name: 'Lite',
    tagline: 'Регулярна практика для студента',
    priceUah: 249, priceUsd: 6,
    annualPriceUah: 2490, semesterPriceUah: null,
    trialDays: null, sessionLimit: 10, softCap: null,
    reviewerModel: 'sonnet',
    charactersAccessibleCount: null,
    modalitiesAllAccess: false,
    features: {
      psychTests: true, progressGraphs: true, pdfExport: false,
      customCharacters: false, advancedAnalytics: false, notionExport: false,
      earlyAccess: false, prioritySupport: false,
    },
    highlights: [
      '10 сесій на місяць',
      'Всі 8 персонажів',
      'Психологічні тести + графіки прогресу',
      'Базовий фідбек (Sonnet)',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'Серйозна підготовка до практики',
    priceUah: 599, priceUsd: 14.5,
    annualPriceUah: 5990, semesterPriceUah: 1799,
    trialDays: null, sessionLimit: null, softCap: 50,
    reviewerModel: 'opus',
    charactersAccessibleCount: null,
    modalitiesAllAccess: true,
    features: {
      psychTests: true, progressGraphs: true, pdfExport: true,
      customCharacters: false, advancedAnalytics: false, notionExport: false,
      earlyAccess: false, prioritySupport: true,
    },
    highlights: [
      'Необмежені сесії',
      'Глибокий фідбек (Opus reviewer)',
      'Всі 5 модальностей (couples, family, crisis, adolescent)',
      'Експорт фідбеку в PDF (для CE/портфоліо)',
      'Priority підтримка',
    ],
  },
  {
    id: 'master',
    name: 'Master',
    tagline: 'Для практикуючих психотерапевтів',
    priceUah: 1499, priceUsd: 36.5,
    annualPriceUah: 14990, semesterPriceUah: null,
    trialDays: null, sessionLimit: null, softCap: null,
    reviewerModel: 'opus',
    charactersAccessibleCount: null,
    modalitiesAllAccess: true,
    features: {
      psychTests: true, progressGraphs: true, pdfExport: true,
      customCharacters: true, advancedAnalytics: true, notionExport: true,
      earlyAccess: true, prioritySupport: true,
    },
    highlights: [
      'Все з Pro',
      'Створи власних персонажів під свою практику',
      'Advanced analytics: alliance tracking, heatmaps',
      'Експорт сесій у Notion',
      'Early access — нові персонажі за 2 тижні до релізу',
      'Голосуй за наступного персонажа (раз на квартал)',
    ],
  },
];
