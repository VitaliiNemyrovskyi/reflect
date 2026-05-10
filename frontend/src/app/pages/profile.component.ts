import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../api.service';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <header class="page-header">
      <a routerLink="/" class="back">← На головну</a>
      <h1>Мій профіль</h1>
    </header>

    @if (auth.user(); as u) {
      <section class="card">
        <header class="card-head">
          <h2>👤 Особисті дані</h2>
        </header>
        <form (ngSubmit)="saveProfile()">
          <div class="field">
            <label for="email">Email</label>
            <input id="email" type="email" [value]="u.email" disabled />
            <span class="hint">
              Email змінити не можна — потребує верифікації, ще не реалізовано.
              Якщо потрібно — створи новий акаунт.
            </span>
          </div>

          <div class="field">
            <label for="displayName">Ім'я (як показувати)</label>
            <input
              id="displayName"
              type="text"
              maxlength="80"
              placeholder="Як до тебе звертатись?"
              [(ngModel)]="displayName"
              name="displayName"
              [disabled]="profileSaving()" />
          </div>

          <div class="field">
            <label for="bio">Біо</label>
            <textarea
              id="bio"
              rows="4"
              maxlength="1000"
              placeholder="Що про себе хочеш розповісти супервайзеру? Курс, на якому вчишся, модальність, інтереси, контекст практики..."
              [(ngModel)]="bio"
              name="bio"
              [disabled]="profileSaving()"></textarea>
            <span class="char-count">{{ bio.length }}/1000</span>
          </div>

          <div class="field readonly">
            <label>Метод входу</label>
            <span class="provider-pill">{{ providerLabel() }}</span>
          </div>

          <div class="form-actions">
            <button type="submit" class="primary" [disabled]="profileSaving() || !profileDirty()">
              {{ profileSaving() ? 'Зберігаю…' : 'Зберегти' }}
            </button>
            @if (profileSaved()) {
              <span class="success">✓ Збережено</span>
            }
            @if (profileError()) {
              <span class="danger">{{ profileError() }}</span>
            }
          </div>
        </form>
      </section>

      <section class="card">
        <header class="card-head">
          <h2>🔒 Зміна пароля</h2>
        </header>
        @if (!u.hasPassword) {
          <p class="hint info">
            Ти увійшов через {{ providerLabel() }} і ще не маєш пароля. Можеш встановити —
            поле «поточний пароль» залиш порожнім. Це додасть можливість входу за email
            (SSO продовжить працювати теж).
          </p>
        }
        <form (ngSubmit)="changePassword()">
          @if (u.hasPassword) {
            <div class="field">
              <label for="currentPassword">Поточний пароль</label>
              <input
                id="currentPassword"
                type="password"
                autocomplete="current-password"
                [(ngModel)]="currentPassword"
                name="currentPassword"
                [disabled]="passwordSaving()" />
            </div>
          }
          <div class="field">
            <label for="newPassword">Новий пароль</label>
            <input
              id="newPassword"
              type="password"
              autocomplete="new-password"
              minlength="8"
              maxlength="120"
              [(ngModel)]="newPassword"
              name="newPassword"
              [disabled]="passwordSaving()" />
            <span class="hint">Мінімум 8 символів.</span>
          </div>
          <div class="field">
            <label for="confirmPassword">Підтвердження</label>
            <input
              id="confirmPassword"
              type="password"
              autocomplete="new-password"
              [(ngModel)]="confirmPassword"
              name="confirmPassword"
              [disabled]="passwordSaving()" />
            @if (confirmPassword && newPassword !== confirmPassword) {
              <span class="hint danger">Паролі не співпадають.</span>
            }
          </div>
          <div class="form-actions">
            <button type="submit" class="primary"
                    [disabled]="passwordSaving() || !canSavePassword()">
              {{ passwordSaving() ? 'Зберігаю…' : 'Змінити пароль' }}
            </button>
            @if (passwordSaved()) {
              <span class="success">✓ Пароль змінено</span>
            }
            @if (passwordError()) {
              <span class="danger">{{ passwordError() }}</span>
            }
          </div>
          <p class="hint">
            Після зміни пароля ти залишишся залогіненим тут, але інші пристрої/сесії
            будуть розлогінені — refresh-токен ротується.
          </p>
        </form>
      </section>
    } @else {
      <p class="hint">Не залогінений.</p>
    }
  `,
  styles: [`
    :host { display: block; max-width: 640px; }

    .page-header { margin-bottom: 24px; }
    .back { color: var(--fg-dim); text-decoration: none; font-size: 13px; }
    .back:hover { color: var(--accent); }
    h1 { margin: 12px 0 0; font-size: 28px; letter-spacing: -0.02em; }

    .card {
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px 24px;
      margin-bottom: 18px;
    }
    .card-head h2 {
      margin: 0 0 16px;
      font-size: 15px;
      font-weight: 500;
      color: var(--fg);
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 16px;
    }
    .field label {
      font-size: 12px;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: .04em;
      font-weight: 500;
    }
    .field input,
    .field textarea {
      padding: 10px 12px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--fg);
      font-size: 14px;
      font-family: inherit;
      line-height: 1.5;
      width: 100%;
      box-sizing: border-box;
    }
    .field input:focus,
    .field textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    .field input:disabled,
    .field textarea:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .field textarea { resize: vertical; min-height: 80px; }

    .field .hint {
      font-size: 11px;
      color: var(--fg-dim);
      line-height: 1.4;
    }
    .field .hint.danger { color: var(--danger); }
    .field .hint.info {
      padding: 10px 12px;
      background: rgba(216, 201, 255, 0.06);
      border: 1px solid rgba(216, 201, 255, 0.2);
      border-radius: 6px;
      font-size: 12px;
      margin-bottom: 12px;
    }
    .char-count {
      font-size: 11px;
      color: var(--fg-dim);
      align-self: flex-end;
    }

    .field.readonly { gap: 8px; }
    .provider-pill {
      align-self: flex-start;
      font-size: 12px;
      padding: 4px 10px;
      background: var(--user-bg);
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--fg-dim);
      letter-spacing: .03em;
    }

    .form-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .form-actions .success { color: #6ee7b7; font-size: 13px; }
    .form-actions .danger { color: var(--danger); font-size: 13px; }

    .hint { color: var(--fg-dim); font-size: 13px; line-height: 1.5; margin: 8px 0 0; }
    .hint.danger { color: var(--danger); }
  `],
})
export class ProfileComponent implements OnInit {
  protected auth = inject(AuthService);
  private api = inject(ApiService);

  // ─── Profile form state ────────────────────────────────────────────────
  displayName = '';
  bio = '';
  private originalDisplayName = '';
  private originalBio = '';

  profileSaving = signal(false);
  profileSaved = signal(false);
  profileError = signal<string | null>(null);

  profileDirty = computed(() => {
    return (
      this.displayName.trim() !== (this.originalDisplayName ?? '') ||
      this.bio.trim() !== (this.originalBio ?? '')
    );
  });

  // ─── Password form state ────────────────────────────────────────────────
  currentPassword = '';
  newPassword = '';
  confirmPassword = '';

  passwordSaving = signal(false);
  passwordSaved = signal(false);
  passwordError = signal<string | null>(null);

  ngOnInit() {
    const u = this.auth.user();
    if (!u) return;
    this.displayName = u.displayName ?? '';
    this.bio = u.bio ?? '';
    this.originalDisplayName = this.displayName;
    this.originalBio = this.bio;
  }

  providerLabel(): string {
    const p = this.auth.user()?.provider;
    return {
      local: 'Email + пароль',
      google: 'Google',
      facebook: 'Facebook',
    }[p ?? 'local'] ?? p ?? '—';
  }

  canSavePassword(): boolean {
    if (!this.newPassword || this.newPassword.length < 8) return false;
    if (this.newPassword !== this.confirmPassword) return false;
    if (this.auth.user()?.hasPassword && !this.currentPassword) return false;
    return true;
  }

  async saveProfile() {
    if (!this.profileDirty()) return;
    this.profileSaving.set(true);
    this.profileSaved.set(false);
    this.profileError.set(null);
    try {
      const updated = await this.api.updateProfile({
        displayName: this.displayName.trim(),
        bio: this.bio.trim(),
      });
      this.auth.applyProfileUpdate(updated);
      this.originalDisplayName = updated.displayName ?? '';
      this.originalBio = updated.bio ?? '';
      this.profileSaved.set(true);
      setTimeout(() => this.profileSaved.set(false), 3000);
    } catch (e: unknown) {
      const msg =
        (e as { error?: { message?: string } })?.error?.message ??
        (e as { message?: string })?.message ??
        'Не вдалось зберегти.';
      this.profileError.set(msg);
    } finally {
      this.profileSaving.set(false);
    }
  }

  async changePassword() {
    if (!this.canSavePassword()) return;
    this.passwordSaving.set(true);
    this.passwordSaved.set(false);
    this.passwordError.set(null);
    try {
      const result = await this.api.changePassword(
        this.currentPassword,
        this.newPassword,
      );
      this.auth.applyAuthResult(result);
      this.currentPassword = '';
      this.newPassword = '';
      this.confirmPassword = '';
      this.passwordSaved.set(true);
      setTimeout(() => this.passwordSaved.set(false), 3000);
    } catch (e: unknown) {
      const msg =
        (e as { error?: { message?: string } })?.error?.message ??
        (e as { message?: string })?.message ??
        'Не вдалось змінити пароль.';
      this.passwordError.set(msg);
    } finally {
      this.passwordSaving.set(false);
    }
  }
}
