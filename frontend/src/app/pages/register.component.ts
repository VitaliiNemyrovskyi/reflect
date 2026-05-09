import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <header class="header">
      <h1>Reflect</h1>
      <p class="subtitle">Створити акаунт</p>
    </header>

    <form class="auth-form" (ngSubmit)="submit()">
      <label>
        <span>Email</span>
        <input type="email" name="email" [(ngModel)]="email" required autocomplete="email" />
      </label>
      <label>
        <span>Ім'я (як до тебе звертатись)</span>
        <input type="text" name="displayName" [(ngModel)]="displayName" autocomplete="name" />
      </label>
      <label>
        <span>Пароль (мінімум 8 символів)</span>
        <input type="password" name="password" [(ngModel)]="password" minlength="8" required autocomplete="new-password" />
      </label>
      @if (error()) {
        <p class="hint danger">{{ error() }}</p>
      }
      <button class="primary" type="submit" [disabled]="loading()">
        {{ loading() ? 'Створюю…' : 'Зареєструватись' }}
      </button>
    </form>

    @if (auth.providers().google || auth.providers().facebook) {
      <div class="separator"><span>або</span></div>
      <div class="oauth-buttons">
        @if (auth.providers().google) {
          <button class="oauth google" (click)="oauth('google')">
            <span class="logo">G</span> Через Google
          </button>
        }
        @if (auth.providers().facebook) {
          <button class="oauth facebook" (click)="oauth('facebook')">
            <span class="logo">f</span> Через Facebook
          </button>
        }
      </div>
    }

    <p class="link-row">
      Уже маєш акаунт? <a routerLink="/login">Увійти</a>
    </p>
  `,
  styles: [`
    .header { margin-bottom: 28px; }
    .header h1 { font-size: 28px; margin: 0; letter-spacing: -0.02em; }
    .subtitle { color: var(--fg-dim); margin: 4px 0 0; font-size: 14px; }

    .auth-form { display: flex; flex-direction: column; gap: 14px; max-width: 360px; }
    .auth-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--fg-dim); }
    .auth-form input {
      font: inherit; padding: 10px 12px;
      border: 1px solid var(--border); border-radius: 8px;
      background: transparent; color: var(--fg);
    }
    .auth-form input:focus { outline: none; border-color: var(--accent); }
    .hint.danger { color: var(--danger); margin: 0; font-size: 13px; }

    .separator { max-width: 360px; display: flex; align-items: center; margin: 24px 0 16px; color: var(--fg-dim); font-size: 12px; }
    .separator::before, .separator::after { content: ''; flex: 1; height: 1px; background: var(--border); }
    .separator span { padding: 0 12px; }

    .oauth-buttons { max-width: 360px; display: flex; flex-direction: column; gap: 8px; }
    .oauth {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px; border: 1px solid var(--border);
      background: transparent; color: var(--fg); font: inherit;
      cursor: pointer; border-radius: 8px;
    }
    .oauth:hover { border-color: var(--accent); }
    .oauth .logo { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; font-weight: 700; border-radius: 50%; }
    .oauth.google .logo { background: #fff; color: #4285f4; }
    .oauth.facebook .logo { background: #1877f2; color: #fff; }

    .link-row { max-width: 360px; margin-top: 28px; color: var(--fg-dim); font-size: 13px; }
    .link-row a { color: var(--accent); text-decoration: none; }
    .link-row a:hover { text-decoration: underline; }
  `],
})
export class RegisterComponent implements OnInit {
  protected auth = inject(AuthService);
  private router = inject(Router);

  email = '';
  password = '';
  displayName = '';
  loading = signal(false);
  error = signal<string | null>(null);

  ngOnInit() {
    void this.auth.fetchProviders();
  }

  async submit() {
    if (!this.email || !this.password) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.auth.register(this.email, this.password, this.displayName);
      void this.router.navigate(['/']);
    } catch (e: unknown) {
      const msg = (e as { error?: { message?: string } })?.error?.message;
      this.error.set(Array.isArray(msg) ? msg.join('. ') : (msg ?? 'Не вдалося зареєструватись'));
    } finally {
      this.loading.set(false);
    }
  }

  oauth(provider: 'google' | 'facebook') {
    this.auth.redirectToOAuth(provider);
  }
}
