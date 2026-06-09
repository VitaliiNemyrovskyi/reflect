import { CommonModule, DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, BillingStatus } from '../api.service';
import { I18nService } from '../i18n.service';

/**
 * Self-service billing page for logged-in users.
 *
 * Shows: current plan, status, sessions-used meter, period end date,
 *        upgrade/downgrade CTAs, pause/cancel buttons.
 *
 * Until Stripe is wired, all upgrade actions deep-link to a Telegram
 * support handle; cancel and pause work end-to-end (they just mutate
 * Subscription state).
 */
@Component({
  selector: 'app-account-billing',
  standalone: true,
  imports: [CommonModule, RouterLink, DatePipe],
  template: `
    @if (loading()) {
      <p class="loading">{{ i18n.t('accountBilling.loading') }}</p>
    } @else {
      @if (status(); as s) {
      <div class="billing-page">
        <header>
          <h1>{{ i18n.t('accountBilling.title') }}</h1>
          <p class="hint">
            <a routerLink="/pricing">{{ i18n.t('accountBilling.compareAllPlans') }}</a>
          </p>
        </header>

        <section class="plan-card">
          <div class="plan-head">
            <div>
              <div class="plan-label">{{ i18n.t('accountBilling.currentPlan') }}</div>
              <h2>{{ s.config.name }}</h2>
              <p class="tagline">{{ s.config.tagline }}</p>
            </div>
            <div class="plan-status" [attr.data-status]="s.status">
              {{ statusLabel(s.status) }}
            </div>
          </div>

          <div class="plan-meta">
            @if (s.plan === 'trial') {
              <div class="meta-row">
                <span>{{ i18n.t('accountBilling.trialEnds') }}</span>
                <strong>{{ s.currentPeriodEnd | date: 'd MMM y' }}</strong>
                <span class="meta-aux">{{ i18n.t('accountBilling.inDays', { days: s.daysUntilPeriodEnd }) }}</span>
              </div>
            } @else if (s.status === 'active') {
              <div class="meta-row">
                <span>{{ i18n.t('accountBilling.nextCharge') }}</span>
                <strong>{{ s.currentPeriodEnd | date: 'd MMM y' }}</strong>
                @if (s.config.priceUah > 0) {
                  <span class="meta-aux">{{ s.config.priceUah }} ₴</span>
                }
              </div>
            } @else if (s.status === 'paused') {
              <div class="meta-row">
                <span>{{ i18n.t('accountBilling.pausedSince') }}</span>
                <strong>{{ s.pausedAt | date: 'd MMM y' }}</strong>
                @if (s.resumesAt) {
                  <span class="meta-aux">
                    {{ i18n.t('accountBilling.autoResume') }} {{ s.resumesAt | date: 'd MMM y' }}
                  </span>
                }
              </div>
            } @else if (s.status === 'canceled') {
              <div class="meta-row">
                <span>{{ i18n.t('accountBilling.canceledLabel') }}</span>
                <strong>{{ s.canceledAt | date: 'd MMM y' }}</strong>
                <span class="meta-aux">
                  {{ i18n.t('accountBilling.accessUntil') }} {{ s.currentPeriodEnd | date: 'd MMM y' }}
                </span>
              </div>
            }
          </div>

          <div class="usage">
            <div class="usage-head">
              <span>{{ i18n.t('accountBilling.sessionsThisPeriod') }}</span>
              @if (s.sessionLimit !== null) {
                <strong>{{ s.sessionsUsed }} / {{ s.sessionLimit }}</strong>
              } @else if (s.softCap) {
                <strong>
                  {{ s.sessionsUsed }} <span class="meta-aux">(soft cap {{ s.softCap }})</span>
                </strong>
              } @else {
                <strong>{{ s.sessionsUsed }} <span class="meta-aux">/ ∞</span></strong>
              }
            </div>
            @if (s.sessionLimit !== null) {
              <div class="meter">
                <div
                  class="meter-fill"
                  [style.width.%]="meterPercent(s)"
                  [class.meter-warn]="meterPercent(s) > 80"
                  [class.meter-danger]="meterPercent(s) >= 100"
                ></div>
              </div>
              @if (s.sessionsRemaining === 0) {
                <p class="warn">
                  {{ i18n.t('accountBilling.limitReachedBefore') }} {{ s.currentPeriodEnd | date: 'd MMM y' }}{{ i18n.t('accountBilling.limitReachedAfter') }}
                </p>
              }
            } @else if (s.softCap && s.sessionsUsed >= s.softCap * 0.8) {
              <p class="warn">
                {{ i18n.t('accountBilling.softCapNearing') }}
                <a routerLink="/pricing">{{ i18n.t('accountBilling.seeMasterTier') }}</a>
              </p>
            }
          </div>
        </section>

        <section class="actions">
          <h3>{{ i18n.t('accountBilling.manageSubscription') }}</h3>
          <div class="action-grid">
            @if (s.plan === 'trial' || s.status === 'expired') {
              <a [href]="upgradeLink('pro')" target="_blank" class="btn btn-primary">
                {{ i18n.t('accountBilling.switchToPro') }}
              </a>
              <a [href]="upgradeLink('lite')" target="_blank" class="btn btn-secondary">
                {{ i18n.t('accountBilling.orLite') }}
              </a>
            } @else if (s.plan === 'lite' && s.status === 'active') {
              <a [href]="upgradeLink('pro')" target="_blank" class="btn btn-primary">
                {{ i18n.t('accountBilling.upgradeToPro') }}
              </a>
              <button (click)="pause(30)" class="btn btn-ghost">
                {{ i18n.t('accountBilling.pause30Days') }}
              </button>
              <button (click)="cancel()" class="btn btn-ghost">
                {{ i18n.t('accountBilling.cancel') }}
              </button>
            } @else if (s.plan === 'pro' && s.status === 'active') {
              <a [href]="upgradeLink('master')" target="_blank" class="btn btn-primary">
                {{ i18n.t('accountBilling.upgradeToMaster') }}
              </a>
              <button (click)="pause(30)" class="btn btn-ghost">
                {{ i18n.t('accountBilling.pause30Days') }}
              </button>
              <button (click)="cancel()" class="btn btn-ghost">
                {{ i18n.t('accountBilling.cancel') }}
              </button>
            } @else if (s.plan === 'master' && s.status === 'active') {
              <button (click)="pause(30)" class="btn btn-ghost">
                {{ i18n.t('accountBilling.pause30Days') }}
              </button>
              <button (click)="cancel()" class="btn btn-ghost">
                {{ i18n.t('accountBilling.cancel') }}
              </button>
            } @else if (s.status === 'paused') {
              <button (click)="resume()" class="btn btn-primary">
                {{ i18n.t('accountBilling.resumeSubscription') }}
              </button>
            } @else if (s.status === 'canceled') {
              <p class="hint">
                {{ i18n.t('accountBilling.canceledAccessBefore') }} {{ s.currentPeriodEnd | date: 'd MMM y' }}{{ i18n.t('accountBilling.canceledAccessAfter') }}
              </p>
              <a [href]="upgradeLink(planSlug())" target="_blank" class="btn btn-primary">
                {{ i18n.t('accountBilling.restoreSubscription') }}
              </a>
            }
          </div>
          @if (actionMessage()) {
            <p class="action-msg">{{ actionMessage() }}</p>
          }
        </section>
      </div>
      } @else {
        <p class="loading">{{ i18n.t('accountBilling.loadFailed') }}</p>
      }
    }
  `,
  styles: [`
    .loading { padding: 32px; text-align: center; color: #8b859e; }
    .billing-page {
      max-width: 720px;
      margin: 0 auto;
      padding: 24px 16px 64px;
      color: #ecebf3;
    }
    header h1 { margin: 0 0 4px; font-size: 28px; }
    header .hint { margin: 0 0 24px; }
    header .hint a { color: #d8c9ff; }

    .plan-card {
      background: #15141b;
      border: 1px solid #2a2735;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .plan-head {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 16px;
      margin-bottom: 16px;
    }
    .plan-label {
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #8b859e;
      margin-bottom: 4px;
    }
    .plan-head h2 { margin: 0; font-size: 24px; }
    .plan-head .tagline {
      margin: 4px 0 0;
      font-size: 13px;
      color: #8b859e;
    }
    .plan-status {
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 12px;
      background: #2a2735;
      color: #a9a3bd;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .plan-status[data-status="active"] { background: rgba(120, 200, 130, 0.15); color: #8edd8e; }
    .plan-status[data-status="paused"] { background: rgba(220, 180, 80, 0.15); color: #ddc880; }
    .plan-status[data-status="canceled"] { background: rgba(220, 100, 100, 0.15); color: #dd8888; }
    .plan-status[data-status="expired"] { background: rgba(120, 120, 120, 0.15); color: #aaa; }

    .plan-meta { padding: 12px 0; border-top: 1px solid #2a2735; border-bottom: 1px solid #2a2735; margin-bottom: 16px; }
    .meta-row { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 14px; }
    .meta-row span { color: #8b859e; }
    .meta-row strong { color: #ecebf3; }
    .meta-row .meta-aux { color: #6a6580; font-size: 12px; }

    .usage-head {
      display: flex; justify-content: space-between;
      font-size: 14px; margin-bottom: 8px;
    }
    .usage-head span { color: #8b859e; }
    .meter {
      height: 8px;
      background: #2a2735;
      border-radius: 4px;
      overflow: hidden;
    }
    .meter-fill {
      height: 100%;
      background: #d8c9ff;
      transition: width 0.3s;
    }
    .meter-warn { background: #ddc880; }
    .meter-danger { background: #dd8888; }

    .warn {
      margin: 8px 0 0;
      font-size: 13px;
      color: #ddc880;
    }
    .warn a { color: #d8c9ff; }

    .actions {
      background: #15141b;
      border: 1px solid #2a2735;
      border-radius: 12px;
      padding: 20px;
    }
    .actions h3 { margin: 0 0 16px; font-size: 16px; }

    .action-grid {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .btn {
      display: block;
      text-align: center;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      text-decoration: none;
      border: none;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn-primary { background: #d8c9ff; color: #0b0b0d; }
    .btn-primary:hover { background: #ebdcff; }
    .btn-secondary { background: #2a2735; color: #ecebf3; border: 1px solid #3a3745; }
    .btn-secondary:hover { background: #34303f; }
    .btn-ghost { background: transparent; color: #a9a3bd; border: 1px solid #3a3745; }
    .btn-ghost:hover { background: #2a2735; }

    .action-msg {
      margin: 16px 0 0;
      padding: 12px;
      border-radius: 8px;
      background: rgba(216, 201, 255, 0.1);
      color: #d8c9ff;
      font-size: 13px;
    }
  `],
})
export class AccountBillingComponent implements OnInit {
  private api = inject(ApiService);
  protected readonly i18n = inject(I18nService);

  status = signal<BillingStatus | null>(null);
  loading = signal(true);
  actionMessage = signal<string | null>(null);
  planSlug = computed(() => this.status()?.plan ?? 'pro');

  async ngOnInit() {
    await this.reload();
  }

  async reload() {
    this.loading.set(true);
    try {
      const s = await this.api.billingStatus();
      this.status.set(s);
    } catch {
      this.status.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  statusLabel(s: string): string {
    return ({
      active: this.i18n.t('accountBilling.statusActive'),
      paused: this.i18n.t('accountBilling.statusPaused'),
      canceled: this.i18n.t('accountBilling.statusCanceled'),
      expired: this.i18n.t('accountBilling.statusExpired'),
    } as Record<string, string>)[s] ?? s;
  }

  meterPercent(s: BillingStatus): number {
    if (s.sessionLimit === null) return 0;
    return Math.min(100, Math.round((s.sessionsUsed / s.sessionLimit) * 100));
  }

  upgradeLink(planId: string): string {
    const text = encodeURIComponent(
      this.i18n.t('accountBilling.upgradeMessage', { plan: planId.toUpperCase() }),
    );
    return `https://t.me/reflect_support?text=${text}`;
  }

  async pause(days: number) {
    try {
      await this.api.pauseSubscription(days);
      this.actionMessage.set(this.i18n.t('accountBilling.pauseSuccess', { date: this.formatFutureDate(days) }));
      await this.reload();
    } catch {
      this.actionMessage.set(this.i18n.t('accountBilling.pauseError'));
    }
  }

  async resume() {
    try {
      await this.api.resumeSubscription();
      this.actionMessage.set(this.i18n.t('accountBilling.resumeSuccess'));
      await this.reload();
    } catch {
      this.actionMessage.set(this.i18n.t('accountBilling.resumeError'));
    }
  }

  async cancel() {
    if (!confirm(this.i18n.t('accountBilling.cancelConfirm'))) return;
    try {
      await this.api.cancelSubscription();
      this.actionMessage.set(this.i18n.t('accountBilling.cancelSuccess'));
      await this.reload();
    } catch {
      this.actionMessage.set(this.i18n.t('accountBilling.cancelError'));
    }
  }

  private formatFutureDate(days: number): string {
    const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
  }
}
