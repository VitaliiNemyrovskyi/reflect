import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../api.service';
import { PreferencesService } from '../preferences.service';
import { AuthService } from '../auth.service';
import { ThemeService } from '../theme.service';
import { I18nService, Lang, SUPPORTED_LANGS } from '../i18n.service';
import { PushClientService, type PushEnableResult } from '../push.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <header class="settings-header">
      <a routerLink="/" class="back">← На головну</a>
      <h1>Налаштування</h1>
      @if (auth.user(); as u) {
        <p class="account-line">
          <span class="dim">Акаунт:</span>
          <span class="account-name">{{ u.displayName ?? u.email }}</span>
        </p>
      }
    </header>

    <section class="settings-group">
      <h2>Сесія з клієнткою</h2>

      <label class="setting-row" [class.saving]="saving()">
        <div class="setting-text">
          <span class="setting-title">Підказки під час сесії</span>
          <span class="setting-desc">
            Кнопка «Що спитати?» біля поля вводу. Натиснеш —
            модель запропонує 3 strategic-варіанти наступної репліки
            (open-question, reflection, here-and-now тощо), орієнтуючись
            на транскрипт сесії й профіль клієнтки. Можна вимкнути,
            якщо ти хочеш практикувати без помічі.
          </span>
        </div>
        <input
          type="checkbox"
          class="toggle"
          [checked]="prefs.hintsEnabled()"
          [disabled]="saving()"
          (change)="setHints($any($event.target).checked)" />
      </label>
    </section>

    <section class="settings-group">
      <h2>Нагадування про пацієнтів</h2>
      <p class="group-hint">
        Reflect раз на день може надіслати ОДНЕ делікатне нагадування у браузер
        про пацієнта, якого давно не було на сесії. Без спаму: щонайбільше одне
        на пацієнта на тиждень, голосом супервізора — не «пацієнт пише тобі».
        Вимкнути можна будь-коли.
      </p>
      @if (!push.supported) {
        <p class="group-hint dim">Цей браузер не підтримує push-сповіщення.</p>
      } @else {
        <label class="setting-row" [class.saving]="pushBusy()">
          <div class="setting-text">
            <span class="setting-title">Push-нагадування</span>
            <span class="setting-desc">{{ pushStatusText() }}</span>
          </div>
          <input
            type="checkbox"
            class="toggle"
            [checked]="pushOn()"
            [disabled]="pushBusy() || push.permission === 'denied'"
            (change)="togglePush($any($event.target).checked)" />
        </label>
        @if (pushOn()) {
          <button type="button" class="ghost small test-push" [disabled]="pushBusy()" (click)="sendTestPush()">
            Надіслати тестове сповіщення
          </button>
        }
        @if (pushMsg(); as m) {
          <p class="group-hint" [class.danger]="pushErr()">{{ m }}</p>
        }
      }
    </section>

    <section class="settings-group">
      <h2>Мова інтерфейсу</h2>
      <p class="group-hint">
        Перемикач мови інтерфейсу + регіону пацієнтів. Кожна мова
        прив'язана до одного міста: 🇺🇦 → Київ, 🇬🇧 → London,
        🇫🇷 → Paris. Зберігається в браузері, на іншому пристрої
        треба вибрати знов.
      </p>
      <div class="lang-grid">
        @for (l of supportedLangs; track l.key) {
          <button type="button"
                  class="lang-card"
                  [class.active]="i18n.lang() === l.key"
                  (click)="setLang(l.key)">
            <span class="lang-card-flag">{{ l.flag }}</span>
            <span class="lang-card-body">
              <span class="lang-card-label">{{ l.label }}</span>
              <span class="lang-card-city dim">{{ langCity(l.key) }}</span>
            </span>
            @if (i18n.lang() === l.key) {
              <span class="lang-check" aria-hidden="true">✓</span>
            }
          </button>
        }
      </div>
    </section>

    <section class="settings-group">
      <h2>Зовнішній вигляд</h2>
      <p class="group-hint">
        Тема впливає на акцентний колір (кнопки, посилання, активні
        стани) і трохи на фон. Зберігається у браузері — на іншому
        пристрої треба буде вибрати знов.
      </p>
      <div class="theme-grid">
        @for (opt of theme.options; track opt.key) {
          <button type="button"
                  class="theme-card"
                  [class.active]="theme.current() === opt.key"
                  (click)="theme.set(opt.key)">
            <span class="theme-swatch" [style.background]="opt.swatch"></span>
            <span class="theme-card-body">
              <span class="theme-label">{{ opt.label }}</span>
              <span class="theme-desc">{{ opt.description }}</span>
            </span>
            @if (theme.current() === opt.key) {
              <span class="theme-check" aria-hidden="true">✓</span>
            }
          </button>
        }
      </div>
    </section>

    @if (error()) {
      <p class="hint danger">{{ error() }}</p>
    }
  `,
  styles: [`
    :host { display: block; max-width: 640px; }

    .settings-header { margin-bottom: 28px; }
    .back {
      color: var(--fg-dim);
      text-decoration: none;
      font-size: 13px;
    }
    .back:hover { color: var(--accent); }
    h1 {
      margin: 12px 0 6px;
      font-size: 28px;
      letter-spacing: -0.02em;
    }
    .account-line {
      margin: 0;
      font-size: 13px;
      color: var(--fg);
    }
    .account-line .dim { color: var(--fg-dim); }
    .account-line .account-name {
      margin-left: 6px;
    }

    .settings-group {
      margin-bottom: 32px;
    }
    .settings-group h2 {
      margin: 0 0 14px;
      font-size: 13px;
      font-weight: 500;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: .05em;
    }

    .setting-row {
      display: flex;
      align-items: flex-start;
      gap: 16px;
      padding: 16px 18px;
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      cursor: pointer;
      transition: border-color .15s ease, opacity .15s ease;
    }
    .setting-row:hover { border-color: var(--accent); }
    .setting-row.saving { opacity: 0.6; pointer-events: none; }

    .setting-text {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .setting-title {
      font-size: 15px;
      font-weight: 500;
      color: var(--fg);
    }
    .setting-desc {
      font-size: 13px;
      color: var(--fg-dim);
      line-height: 1.55;
    }

    /* Native checkbox styled as a toggle pill. */
    .toggle {
      flex-shrink: 0;
      appearance: none;
      width: 42px;
      height: 24px;
      background: var(--user-bg);
      border: 1px solid var(--border);
      border-radius: 999px;
      position: relative;
      cursor: pointer;
      transition: background .15s ease, border-color .15s ease;
      margin-top: 2px;
    }
    .toggle::after {
      content: '';
      position: absolute;
      top: 2px; left: 2px;
      width: 18px; height: 18px;
      background: var(--fg-dim);
      border-radius: 50%;
      transition: transform .18s ease, background .15s ease;
    }
    .toggle:checked {
      background: var(--accent);
      border-color: var(--accent);
    }
    .toggle:checked::after {
      transform: translateX(18px);
      background: var(--accent-ink);
    }
    .toggle:disabled { cursor: not-allowed; }

    .hint { color: var(--fg-dim); font-size: 13px; margin-top: 8px; }
    .hint.danger { color: var(--danger); }

    /* Theme picker — card grid, accent swatch + meta. */
    .group-hint {
      margin: 0 0 14px;
      font-size: 13px;
      color: var(--fg-dim);
      line-height: 1.55;
    }
    .theme-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
    }
    @media (min-width: 640px) {
      .theme-grid { grid-template-columns: 1fr 1fr 1fr; }
    }
    .theme-card {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 16px;
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      cursor: pointer;
      text-align: left;
      color: var(--fg);
      transition: border-color .15s ease, background .15s ease, transform .12s ease;
      position: relative;
      min-height: auto;
    }
    .theme-card:hover { border-color: var(--accent); }
    .theme-card:active { transform: scale(0.99); }
    .theme-card.active {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 8%, var(--assistant-bg));
    }
    .theme-swatch {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      box-shadow: 0 0 0 2px var(--bg), 0 0 0 3px var(--border);
      margin-top: 2px;
    }
    .theme-card-body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .theme-label {
      font-size: 14px;
      font-weight: 500;
      color: var(--fg);
    }
    .theme-desc {
      font-size: 12px;
      color: var(--fg-dim);
      line-height: 1.5;
    }
    .theme-check {
      flex-shrink: 0;
      color: var(--accent);
      font-size: 16px;
      font-weight: 600;
      align-self: center;
    }

    /* Language picker — same card shape as theme picker so the two
       settings groups feel like one design language. Active card gets
       the accent border + bg tint. */
    .lang-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
    }
    @media (min-width: 640px) {
      .lang-grid { grid-template-columns: 1fr 1fr 1fr; }
    }
    .lang-card {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      cursor: pointer;
      text-align: left;
      color: var(--fg);
      transition: border-color .15s ease, background .15s ease, transform .12s ease;
      min-height: auto;
    }
    .lang-card:hover { border-color: var(--accent); }
    .lang-card:active { transform: scale(0.99); }
    .lang-card.active {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 8%, var(--assistant-bg));
    }
    .lang-card-flag {
      font-size: 24px;
      line-height: 1;
      flex-shrink: 0;
    }
    .lang-card-body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .lang-card-label {
      font-size: 14px;
      font-weight: 500;
      color: var(--fg);
    }
    .lang-card-city {
      font-size: 12px;
      line-height: 1.4;
    }
    .lang-check {
      flex-shrink: 0;
      color: var(--accent);
      font-size: 16px;
      font-weight: 600;
    }
  `],
})
export class SettingsComponent implements OnInit {
  protected prefs = inject(PreferencesService);
  protected auth = inject(AuthService);
  protected theme = inject(ThemeService);
  protected i18n = inject(I18nService);
  protected push = inject(PushClientService);
  private api = inject(ApiService);

  saving = signal(false);
  error = signal<string | null>(null);

  // Push opt-in state.
  pushOn = signal(false);
  pushBusy = signal(false);
  pushMsg = signal<string | null>(null);
  pushErr = signal(false);

  async ngOnInit(): Promise<void> {
    try {
      this.pushOn.set(await this.push.isSubscribed());
    } catch {
      /* leave off */
    }
  }

  pushStatusText(): string {
    if (this.push.permission === 'denied') {
      return 'Сповіщення заблоковані в браузері — увімкни їх у налаштуваннях сайту.';
    }
    return this.pushOn() ? 'Увімкнено на цьому пристрої.' : 'Вимкнено.';
  }

  async togglePush(on: boolean): Promise<void> {
    this.pushBusy.set(true);
    this.pushMsg.set(null);
    this.pushErr.set(false);
    try {
      if (on) {
        const r = await this.push.enable();
        if (r === 'ok') {
          this.pushOn.set(true);
          this.pushMsg.set('Готово — нагадування увімкнено на цьому пристрої.');
        } else {
          this.pushOn.set(false);
          this.pushErr.set(true);
          this.pushMsg.set(this.pushEnableError(r));
        }
      } else {
        await this.push.disable();
        this.pushOn.set(false);
        this.pushMsg.set('Нагадування вимкнено.');
      }
    } finally {
      this.pushBusy.set(false);
    }
  }

  async sendTestPush(): Promise<void> {
    this.pushBusy.set(true);
    this.pushMsg.set(null);
    this.pushErr.set(false);
    try {
      const r = await this.api.pushTest(this.i18n.lang());
      if (!r.enabled) {
        this.pushErr.set(true);
        this.pushMsg.set('Сервер: VAPID не налаштований (push вимкнений на сервері).');
      } else if (r.subscriptions === 0) {
        this.pushErr.set(true);
        this.pushMsg.set('Підписки на цьому акаунті немає — пристрій не зареєструвався. Перевір дозвіл у браузері; на iPhone у вкладці Safari не працює (треба «На екран Домівки»).');
      } else if (r.sent === 0) {
        this.pushErr.set(true);
        this.pushMsg.set(`Підписка є (${r.subscriptions}), але відправка не вдалась — проблема з ключами/мережею на сервері. Скажи мені — гляну.`);
      } else {
        this.pushMsg.set(`Надіслано на ${r.sent} прист. Якщо не бачиш — увімкни сповіщення браузера в налаштуваннях ОС (на Mac: Системні налаштування → Сповіщення → твій браузер).`);
      }
    } catch {
      this.pushErr.set(true);
      this.pushMsg.set('Не вдалося надіслати тест.');
    } finally {
      this.pushBusy.set(false);
    }
  }

  private pushEnableError(r: PushEnableResult): string {
    switch (r) {
      case 'denied':
        return 'Дозвіл на сповіщення відхилено. Можна змінити в налаштуваннях сайту.';
      case 'unsupported':
        return 'Цей браузер не підтримує push-сповіщення.';
      case 'no-keys':
        return 'Push поки недоступний на сервері. Спробуй пізніше.';
      default:
        return 'Не вдалося увімкнути. Спробуй ще раз.';
    }
  }

  readonly supportedLangs = SUPPORTED_LANGS;

  /** Each lang anchors to a single city in our content model. */
  langCity(l: Lang): string {
    return { uk: 'Київ', en: 'London', fr: 'Paris' }[l] ?? '';
  }

  setLang(l: Lang): void {
    if (this.i18n.lang() === l) return;
    this.i18n.setLang(l);
  }

  async setHints(enabled: boolean) {
    this.error.set(null);
    this.saving.set(true);
    try {
      await this.prefs.update({ hintsEnabled: enabled });
    } catch {
      this.error.set('Не вдалося зберегти налаштування. Перевір з\'єднання й спробуй ще.');
    } finally {
      this.saving.set(false);
    }
  }
}
