import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../api.service';
import { AuthService } from '../auth.service';
import { I18nService } from '../i18n.service';
import { IconComponent } from '../icon.component';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, IconComponent],
  template: `
    <header class="page-header">
      <a routerLink="/" class="back">← {{ i18n.t('profile.backHome') }}</a>
      <h1>{{ i18n.t('profile.title') }}</h1>
    </header>

    @if (auth.user(); as u) {
      <section class="card">
        <header class="card-head">
          <h2>👤 {{ i18n.t('profile.personalDataHeading') }}</h2>
        </header>
        <form (ngSubmit)="saveProfile()">
          <div class="field">
            <label for="email">Email</label>
            <input id="email" type="email" [value]="u.email" disabled />
            <span class="hint">
              {{ i18n.t('profile.emailHint') }}
            </span>
          </div>

          <div class="field">
            <label for="displayName">{{ i18n.t('profile.displayNameLabel') }}</label>
            <input
              id="displayName"
              type="text"
              maxlength="80"
              [placeholder]="i18n.t('profile.displayNamePlaceholder')"
              [(ngModel)]="displayName"
              name="displayName"
              [disabled]="profileSaving()" />
          </div>

          <div class="field">
            <label for="bio">{{ i18n.t('profile.bioLabel') }}</label>
            <textarea
              id="bio"
              rows="4"
              maxlength="1000"
              [placeholder]="i18n.t('profile.bioPlaceholder')"
              [(ngModel)]="bio"
              name="bio"
              [disabled]="profileSaving()"></textarea>
            <span class="char-count">{{ bio.length }}/1000</span>
          </div>

          <div class="field readonly">
            <label>{{ i18n.t('profile.loginMethodLabel') }}</label>
            <span class="provider-pill">{{ providerLabel() }}</span>
          </div>

          <div class="form-actions">
            <button type="submit" class="primary" [disabled]="profileSaving() || !profileDirty()">
              {{ profileSaving() ? i18n.t('profile.saving') : i18n.t('profile.save') }}
            </button>
            @if (profileSaved()) {
              <span class="success">✓ {{ i18n.t('profile.saved') }}</span>
            }
            @if (profileError()) {
              <span class="danger">{{ profileError() }}</span>
            }
          </div>
        </form>
      </section>

      <section class="card">
        <header class="card-head">
          <h2><app-icon name="lock" /> {{ i18n.t('profile.changePasswordHeading') }}</h2>
        </header>
        @if (!u.hasPassword) {
          <p class="hint info">
            {{ i18n.t('profile.noPasswordInfo', { provider: providerLabel() }) }}
          </p>
        }
        <form (ngSubmit)="changePassword()">
          @if (u.hasPassword) {
            <div class="field">
              <label for="currentPassword">{{ i18n.t('profile.currentPasswordLabel') }}</label>
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
            <label for="newPassword">{{ i18n.t('profile.newPasswordLabel') }}</label>
            <input
              id="newPassword"
              type="password"
              autocomplete="new-password"
              minlength="8"
              maxlength="120"
              [(ngModel)]="newPassword"
              name="newPassword"
              [disabled]="passwordSaving()" />
            <span class="hint">{{ i18n.t('profile.passwordMinHint') }}</span>
          </div>
          <div class="field">
            <label for="confirmPassword">{{ i18n.t('profile.confirmPasswordLabel') }}</label>
            <input
              id="confirmPassword"
              type="password"
              autocomplete="new-password"
              [(ngModel)]="confirmPassword"
              name="confirmPassword"
              [disabled]="passwordSaving()" />
            @if (confirmPassword && newPassword !== confirmPassword) {
              <span class="hint danger">{{ i18n.t('profile.passwordsMismatch') }}</span>
            }
          </div>
          <div class="form-actions">
            <button type="submit" class="primary"
                    [disabled]="passwordSaving() || !canSavePassword()">
              {{ passwordSaving() ? i18n.t('profile.saving') : i18n.t('profile.changePasswordBtn') }}
            </button>
            @if (passwordSaved()) {
              <span class="success">✓ {{ i18n.t('profile.passwordChanged') }}</span>
            }
            @if (passwordError()) {
              <span class="danger">{{ passwordError() }}</span>
            }
          </div>
          <p class="hint">
            {{ i18n.t('profile.passwordChangeSessionsHint') }}
          </p>
        </form>
      </section>
    } @else {
      <p class="hint">{{ i18n.t('profile.notLoggedIn') }}</p>
    }
  `,
  styles: [`
    :host { display: block; max-width: 640px; }

    .page-header { margin-bottom: 24px; }
    .back { color: var(--fg-dim); text-decoration: none; font-size: 13px; }
    .back:hover { color: var(--accent); }
    h1 { margin: 12px 0 0; font-size: 28px; letter-spacing: -0.02em; }

    /* Profile cards inherit Synapse aesthetic: accent-tinted background,
       gradient border via pseudo (avoids ::before encapsulation issues
       on bare-class pseudo selectors), inner radial wash from top. */
    .card {
      position: relative;
      background:
        radial-gradient(ellipse 80% 60% at 50% 0%,
          color-mix(in srgb, var(--accent) 10%, transparent) 0%,
          transparent 60%),
        color-mix(in srgb, var(--accent) 4%, var(--assistant-bg));
      border: 1px solid transparent;
      border-radius: 14px;
      padding: 24px 28px;
      margin-bottom: 18px;
    }
    .card::before {
      content: '';
      position: absolute;
      inset: -1px;
      border-radius: inherit;
      padding: 1px;
      background: conic-gradient(
        from var(--frame-angle),
        color-mix(in srgb, var(--accent) 38%, var(--border)) 0deg,
        color-mix(in srgb, var(--accent) 14%, var(--border)) 90deg,
        color-mix(in srgb, var(--accent) 32%, var(--border)) 180deg,
        color-mix(in srgb, var(--accent) 14%, var(--border)) 270deg,
        color-mix(in srgb, var(--accent) 38%, var(--border)) 360deg
      );
      -webkit-mask:
        linear-gradient(#fff 0 0) content-box,
        linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
              mask-composite: exclude;
      pointer-events: none;
    }
    .card > * { position: relative; }
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
  protected readonly i18n = inject(I18nService);
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
      local: this.i18n.t('profile.providerLocal'),
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
        this.i18n.t('profile.saveError');
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
        this.i18n.t('profile.changePasswordError');
      this.passwordError.set(msg);
    } finally {
      this.passwordSaving.set(false);
    }
  }
}
