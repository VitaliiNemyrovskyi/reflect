import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService, Character } from '../api.service';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-characters-list',
  standalone: true,
  template: `
    <header class="header">
      <div class="title-row">
        <div>
          <h1>Reflect</h1>
          <p class="subtitle">Тренувальний кабінет</p>
        </div>
        @if (auth.user(); as u) {
          <div class="user-area">
            <span class="user-name">{{ u.displayName ?? u.email }}</span>
            <button class="ghost small" (click)="logout()">Вийти</button>
          </div>
        }
      </div>
    </header>

    @if (loading()) {
      <div class="hint">Завантаження…</div>
    } @else if (error()) {
      <div class="hint danger">{{ error() }}</div>
    } @else if (characters().length === 0) {
      <div class="hint">
        Жодного персонажа не налаштовано. Заповни
        <code>prompts/anna_profile.md</code> і перезапусти сервер.
      </div>
    } @else {
      <ul class="characters">
        @for (c of characters(); track c.id) {
          <li (click)="open(c)">
            <div class="name">{{ c.displayName }}</div>
            <div class="hint">Натисніть, щоб почати тренувальну сесію</div>
          </li>
        }
      </ul>
    }
  `,
  styles: [`
    .header { margin-bottom: 28px; }
    .header h1 { font-size: 28px; margin: 0; letter-spacing: -0.02em; }
    .subtitle { color: var(--fg-dim); margin: 4px 0 0; font-size: 14px; }
    .title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .user-area {
      display: flex;
      gap: 12px;
      align-items: center;
      font-size: 13px;
      color: var(--fg-dim);
    }
    .user-name { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button.small { padding: 6px 12px; font-size: 13px; }

    .characters { list-style: none; padding: 0; margin: 0; }
    .characters li {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 22px;
      cursor: pointer;
      margin-bottom: 12px;
      transition: border-color .15s ease;
    }
    .characters li:hover { border-color: var(--accent); }
    .name { font-size: 18px; font-weight: 500; }
    .hint { color: var(--fg-dim); font-size: 13px; margin-top: 4px; }
    .hint.danger { color: var(--danger); }
    code { background: var(--user-bg); padding: 2px 6px; border-radius: 4px; }
  `],
})
export class CharactersListComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  protected auth = inject(AuthService);

  characters = signal<Character[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);

  logout() {
    void this.auth.logout();
  }

  async ngOnInit() {
    try {
      this.characters.set(await this.api.listCharacters());
    } catch (e: unknown) {
      this.error.set('Сервер недоступний. Перевір, чи API запущений на :3000.');
    } finally {
      this.loading.set(false);
    }
  }

  open(c: Character) {
    void this.router.navigate(['/intro', c.id], { state: { displayName: c.displayName } });
  }
}
