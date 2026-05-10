import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../api.service';
import { SessionStateService } from '../session-state.service';

@Component({
  selector: 'app-feedback',
  standalone: true,
  template: `
    <header class="header">
      <h2>Фідбек супервізора</h2>
      @if (streaming()) {
        <span class="streaming-badge" aria-live="polite">
          <span class="dot"></span> Генерується…
        </span>
      }
    </header>

    @if (error()) {
      <p class="hint danger">{{ error() }}</p>
    }

    @if (waiting() && !feedback()) {
      <p class="hint">Готую фідбек…</p>
    } @else {
      <article class="feedback" [class.streaming]="streaming()">{{ feedback() }}<span
          class="caret"
          *ngIf="streaming()"
          aria-hidden="true"
        ></span></article>
    }

    <div class="actions">
      <button class="primary" [disabled]="streaming()" (click)="back()">
        @if (streaming()) {
          Зачекай завершення…
        } @else {
          Зберегти і повернутися
        }
      </button>
    </div>
  `,
  styles: [`
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 0 0 24px;
    }
    .header h2 { font-size: 22px; margin: 0; font-weight: 500; }
    .streaming-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--accent, #d8c9ff);
      background: rgba(216, 201, 255, 0.08);
      border: 1px solid rgba(216, 201, 255, 0.25);
      padding: 4px 10px;
      border-radius: 999px;
    }
    .streaming-badge .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      animation: pulse 1.2s infinite ease-in-out;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.35; transform: scale(0.85); }
      50% { opacity: 1; transform: scale(1); }
    }
    .feedback {
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px 24px;
      white-space: pre-wrap;
      font-size: 15px;
      line-height: 1.65;
      min-height: 120px;
    }
    .feedback.streaming { border-color: rgba(216, 201, 255, 0.35); }
    .caret {
      display: inline-block;
      width: 8px;
      height: 1em;
      margin-left: 2px;
      vertical-align: text-bottom;
      background: var(--accent, #d8c9ff);
      animation: blink 1s steps(2, start) infinite;
    }
    @keyframes blink { to { visibility: hidden; } }
    .actions { display: flex; gap: 10px; margin-top: 24px; }
    .actions button[disabled] { opacity: 0.55; cursor: not-allowed; }
    .hint { color: var(--fg-dim); font-size: 14px; }
    .hint.danger { color: var(--danger); }
  `],
})
export class FeedbackComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);
  private state = inject(SessionStateService);

  feedback = signal<string>('');
  /** Initial wait before first chunk arrives. */
  waiting = signal(true);
  /** A stream is in flight (chunks may still arrive). */
  streaming = signal(false);
  error = signal<string | null>(null);

  private abort = new AbortController();

  async ngOnInit() {
    const sessionId = Number(this.route.snapshot.paramMap.get('sessionId'));
    if (!sessionId) {
      this.error.set('Невідома сесія.');
      this.waiting.set(false);
      return;
    }

    this.streaming.set(true);
    let buffer = '';
    let gotAnyChunk = false;

    try {
      for await (const event of this.api.endSessionStream(sessionId, this.abort.signal)) {
        switch (event.type) {
          case 'cached':
            // Already-finalized session — render saved feedback in one go.
            this.feedback.set(event.data.feedback);
            this.waiting.set(false);
            this.streaming.set(false);
            return;
          case 'chunk':
            if (!gotAnyChunk) {
              this.waiting.set(false);
              gotAnyChunk = true;
            }
            buffer += event.data.text;
            // Strip the supervisor's trailing ```json {...} ``` block as it
            // streams in — users shouldn't see the machine-readable assessment
            // in the narrative pane (it's already split on the backend for the
            // 'done' event, but during streaming we get the raw concatenation).
            this.feedback.set(stripTrailingJsonBlock(buffer));
            break;
          case 'done':
            // Backend has post-processed (quote-audit + JSON split). Replace
            // streamed buffer with the canonical narrative.
            this.feedback.set(event.data.feedback);
            this.streaming.set(false);
            return;
          case 'error':
            this.error.set(event.data.message || 'Не вдалося завершити фідбек.');
            this.streaming.set(false);
            return;
        }
      }
      // Stream ended without a 'done' event — keep what we have.
      this.streaming.set(false);
    } catch (e: unknown) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      const msg = (e as { message?: string })?.message || 'Не вдалося завантажити фідбек.';
      this.error.set(msg);
      this.streaming.set(false);
    } finally {
      this.waiting.set(false);
    }
  }

  ngOnDestroy() {
    this.abort.abort();
  }

  back() {
    if (this.streaming()) return;
    this.state.reset();
    void this.router.navigate(['/']);
  }
}

/**
 * Hides the supervisor's trailing ```json { ... } ``` machine-readable block
 * during streaming so the user only sees narrative text. Once the backend
 * emits the final 'done' event we replace the buffer with the canonical
 * post-processed narrative anyway.
 */
function stripTrailingJsonBlock(text: string): string {
  // Find the last ```json (case-insensitive) — if the closing ``` hasn't
  // arrived yet, we still hide the open fence and partial JSON.
  const re = /```json[\s\S]*?(?:```|$)/i;
  return text.replace(re, '').trimEnd();
}
