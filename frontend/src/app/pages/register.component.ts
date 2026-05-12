import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <section class="auth-panel synapse-panel">
      <header class="auth-header">
        <span class="section-label">REFLECT</span>
        <h1>Створити акаунт</h1>
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
    </section>
  `,
  styles: [`
    .auth-panel { max-width: 420px; margin: 32px auto; padding: 32px; }
    .auth-header { margin-bottom: 24px; }
    .auth-header h1 {
      font-size: 24px; margin: 6px 0 0;
      font-weight: 400; letter-spacing: -0.01em;
    }

    .auth-form { display: flex; flex-direction: column; gap: 14px; }
    .auth-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--fg-dim); }
    /* input styling inherits from global styles.scss */
    .hint.danger { color: var(--danger); margin: 0; font-size: 13px; }

    .separator { display: flex; align-items: center; margin: 24px 0 16px; color: var(--fg-dim); font-size: 12px; }
    .separator::before, .separator::after {
      content: ''; flex: 1; height: 1px;
      background: color-mix(in srgb, var(--accent) 18%, var(--border));
    }
    .separator span { padding: 0 12px; }

    .oauth-buttons { display: flex; flex-direction: column; gap: 8px; }
    .oauth {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px;
      border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border));
      background: color-mix(in srgb, var(--accent) 3%, transparent);
      color: var(--fg); font: inherit;
      cursor: pointer; border-radius: 8px;
      transition: border-color .15s ease, background .15s ease;
    }
    .oauth:hover {
      border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
      background: color-mix(in srgb, var(--accent) 7%, transparent);
    }
    .oauth .logo { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; font-weight: 700; border-radius: 50%; }
    .oauth.google .logo { background: #fff; color: #4285f4; }
    .oauth.facebook .logo { background: #1877f2; color: #fff; }

    .link-row { margin-top: 28px; color: var(--fg-dim); font-size: 13px; }
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
