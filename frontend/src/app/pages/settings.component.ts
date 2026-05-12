import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { PreferencesService } from '../preferences.service';
import { AuthService } from '../auth.service';
import { ThemeService } from '../theme.service';

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
            Кнопка «💡 Що спитати?» біля поля вводу. Натиснеш —
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
  `],
})
export class SettingsComponent {
  protected prefs = inject(PreferencesService);
  protected auth = inject(AuthService);
  protected theme = inject(ThemeService);

  saving = signal(false);
  error = signal<string | null>(null);

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
