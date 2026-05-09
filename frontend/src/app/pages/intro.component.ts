import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../api.service';
import { SessionStateService } from '../session-state.service';

@Component({
  selector: 'app-intro',
  standalone: true,
  template: `
    <header class="header">
      <h2>{{ displayName() ?? 'Клієнт' }}</h2>
    </header>

    <div class="intro-text">
      <p>Зараз почнеться тренувальна сесія. Ваше завдання — провести терапевтичну розмову з клієнткою.</p>
      <p>Орієнтовно 20–30 хвилин. Коли захочете завершити — натисніть «Завершити сесію» згори чату.</p>
      <p>Все, що ви напишете, побачить тільки супервізор-AI у фідбеку. Сесії нікуди не передаються.</p>
    </div>

    <div class="actions">
      <button class="primary" [disabled]="starting()" (click)="start()">
        {{ starting() ? 'Анна заходить у кабінет…' : 'Почати' }}
      </button>
      <button class="ghost" (click)="back()">Назад</button>
    </div>

    @if (error()) {
      <p class="hint danger">{{ error() }}</p>
    }
  `,
  styles: [`
    .header h2 { font-size: 22px; margin: 0; font-weight: 500; }
    .intro-text { margin: 28px 0; }
    .intro-text p { color: var(--fg-dim); }
    .intro-text p:first-child { color: var(--fg); }
    .actions { display: flex; gap: 10px; }
    .hint { font-size: 13px; margin-top: 18px; }
    .hint.danger { color: var(--danger); }
  `],
})
export class IntroComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);
  private state = inject(SessionStateService);

  displayName = signal<string | null>(null);
  starting = signal(false);
  error = signal<string | null>(null);
  private characterId = 0;

  ngOnInit() {
    this.characterId = Number(this.route.snapshot.paramMap.get('characterId'));
    const fromState = (history.state as { displayName?: string } | undefined)?.displayName;
    this.displayName.set(fromState ?? null);
  }

  async start() {
    this.starting.set(true);
    this.error.set(null);
    try {
      const data = await this.api.startSession(this.characterId);
      this.state.reset(data.character.displayName);
      this.state.push({ role: 'assistant', content: data.firstMessage });
      void this.router.navigate(['/session', data.sessionId]);
    } catch (e: unknown) {
      this.error.set(this.errMsg(e));
    } finally {
      this.starting.set(false);
    }
  }

  back() {
    void this.router.navigate(['/']);
  }

  private errMsg(e: unknown): string {
    const body = (e as { error?: { message?: string; error?: string } })?.error;
    return body?.message ?? body?.error ?? 'Не вдалося почати сесію.';
  }
}
