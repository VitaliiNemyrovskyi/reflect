import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../api.service';
import { SessionStateService } from '../session-state.service';

@Component({
  selector: 'app-feedback',
  standalone: true,
  template: `
    <header class="header">
      <h2>Фідбек супервізора</h2>
    </header>

    @if (loading()) {
      <p class="hint">Готую фідбек…</p>
    } @else if (error()) {
      <p class="hint danger">{{ error() }}</p>
    } @else {
      <article class="feedback">{{ feedback() }}</article>
    }

    <div class="actions">
      <button class="primary" (click)="back()">Зберегти і повернутися</button>
    </div>
  `,
  styles: [`
    .header h2 { font-size: 22px; margin: 0 0 24px; font-weight: 500; }
    .feedback {
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px 24px;
      white-space: pre-wrap;
      font-size: 15px;
      line-height: 1.65;
    }
    .actions { display: flex; gap: 10px; margin-top: 24px; }
    .hint { color: var(--fg-dim); font-size: 14px; }
    .hint.danger { color: var(--danger); }
  `],
})
export class FeedbackComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);
  private state = inject(SessionStateService);

  feedback = signal<string>('');
  loading = signal(true);
  error = signal<string | null>(null);

  async ngOnInit() {
    const sessionId = Number(this.route.snapshot.paramMap.get('sessionId'));
    try {
      const { feedback } = await this.api.endSession(sessionId);
      this.feedback.set(feedback);
    } catch (e: unknown) {
      this.error.set('Не вдалося завантажити фідбек.');
    } finally {
      this.loading.set(false);
    }
  }

  back() {
    this.state.reset();
    void this.router.navigate(['/']);
  }
}
