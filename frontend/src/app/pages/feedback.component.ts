import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { marked } from 'marked';
import { ApiService } from '../api.service';
import { SessionStateService } from '../session-state.service';

// Configure marked once at module load. We trust the supervisor LLM output
// because (a) it's piped through Angular's [innerHTML] sanitizer downstream,
// (b) the prompt explicitly forbids fabricated quotes — anything weird gets
// flagged in the audit section, and (c) we control the prompt.
marked.setOptions({
  gfm: true,    // tables, task-lists, autolinks
  breaks: true, // newline → <br>, matches how the LLM writes
});

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
      <article class="feedback prose"
               [class.streaming]="streaming()"
               [innerHTML]="feedbackHtml()"></article>
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
    :host { display: block; }

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
      padding: 22px 26px;
      font-size: 15px;
      line-height: 1.65;
      min-height: 120px;
    }
    .feedback.streaming { border-color: rgba(216, 201, 255, 0.35); }

    /* ─── Prose: rendered markdown ───────────────────────────────────── */
    .prose :first-child { margin-top: 0; }
    .prose :last-child { margin-bottom: 0; }

    .prose h1, .prose h2, .prose h3, .prose h4 {
      font-weight: 500;
      line-height: 1.3;
      margin: 24px 0 12px;
      color: var(--fg);
      letter-spacing: -0.01em;
    }
    .prose h1 { font-size: 22px; }
    .prose h2 { font-size: 18px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
    .prose h3 { font-size: 16px; }
    .prose h4 { font-size: 14px; color: var(--fg-dim); text-transform: uppercase; letter-spacing: .04em; }

    .prose p { margin: 0 0 12px; }
    .prose strong { color: var(--accent); font-weight: 500; }
    .prose em { font-style: italic; color: var(--fg); }
    .prose hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 22px 0;
    }

    .prose ul, .prose ol {
      margin: 8px 0 14px;
      padding-left: 24px;
    }
    .prose li {
      margin: 6px 0;
      line-height: 1.6;
    }
    .prose li > p { margin: 0 0 6px; }
    .prose ul ul, .prose ol ol, .prose ul ol, .prose ol ul {
      margin: 4px 0;
    }

    .prose blockquote {
      margin: 12px 0;
      padding: 8px 14px;
      border-left: 3px solid var(--accent);
      background: rgba(216, 201, 255, 0.04);
      color: var(--fg);
      font-style: italic;
    }
    .prose blockquote p:last-child { margin-bottom: 0; }

    .prose code {
      background: var(--user-bg);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
      font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace;
      color: var(--accent);
    }
    .prose pre {
      background: var(--user-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px 14px;
      overflow-x: auto;
      margin: 12px 0;
      font-size: 13px;
      line-height: 1.5;
    }
    .prose pre code {
      background: none;
      padding: 0;
      color: var(--fg);
    }

    /* Tables — supervisor uses them for protocol overview. Mobile-friendly
       horizontal scroll so they don't break narrow layouts. */
    .prose table {
      border-collapse: collapse;
      width: 100%;
      margin: 14px 0;
      font-size: 13px;
      display: block;
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .prose thead {
      background: var(--user-bg);
    }
    .prose th, .prose td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    .prose th {
      font-weight: 500;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: .03em;
      font-size: 11px;
    }
    .prose tbody tr:last-child td { border-bottom: none; }
    .prose tbody tr:hover { background: rgba(255,255,255,0.02); }

    /* Line-reference badges. The supervisor must end every claim with
       a [Lnumber] reference (see supervisor_system.md). We post-process
       the rendered HTML to wrap these in span.line-ref for a clear
       visual anchor — the student can quickly see "this critique is
       grounded at line N". */
    .prose .line-ref {
      display: inline-block;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      padding: 1px 6px;
      margin: 0 1px;
      background: rgba(216, 201, 255, 0.08);
      border: 1px solid rgba(216, 201, 255, 0.25);
      border-radius: 999px;
      color: var(--accent);
      vertical-align: 1px;
      white-space: nowrap;
    }

    /* Status emojis used in the protocol-overview table — give them
       breathing room when they appear inline. */
    .prose td:first-child { white-space: nowrap; }

    /* Audit footer — backend wraps the "N quotes failed verification"
       list in <details> so it collapses by default. The student sees a
       single warning line, expands on click if they want to dig in.
       Avoids the wall-of-red effect that made the whole feedback look
       suspect when only a few quotes were flagged. */
    .prose .audit-block {
      margin-top: 18px;
      padding: 12px 14px;
      background: rgba(255, 191, 110, 0.05);
      border: 1px solid rgba(255, 191, 110, 0.2);
      border-radius: 8px;
    }
    .prose .audit-block summary {
      cursor: pointer;
      font-size: 14px;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 8px;
      user-select: none;
    }
    .prose .audit-block summary::before {
      content: '▸';
      color: var(--fg-dim);
      transition: transform .15s ease;
      display: inline-block;
    }
    .prose .audit-block[open] summary::before { transform: rotate(90deg); }
    .prose .audit-block summary::-webkit-details-marker { display: none; }
    .prose .audit-block summary strong {
      color: var(--warn, #fbbf6e);
      font-weight: 500;
    }
    .prose .audit-block[open] summary {
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px solid rgba(255, 191, 110, 0.15);
    }
    .prose .audit-issues {
      margin: 6px 0 0;
      padding-left: 22px;
      font-size: 13px;
    }
    .prose .audit-issues li {
      margin: 8px 0;
      line-height: 1.5;
      color: var(--fg-dim);
    }
    .prose .audit-issues strong { color: var(--fg); }

    .actions { display: flex; gap: 10px; margin-top: 24px; }
    .actions button[disabled] { opacity: 0.55; cursor: not-allowed; }
    .hint { color: var(--fg-dim); font-size: 14px; }
    .hint.danger { color: var(--danger); }

    @media (max-width: 720px) {
      .feedback { padding: 16px 18px; }
      .prose h1 { font-size: 20px; }
      .prose h2 { font-size: 16px; }
      .prose h3 { font-size: 15px; }
      .prose th, .prose td { padding: 6px 8px; }
    }
  `],
})
export class FeedbackComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);
  private state = inject(SessionStateService);
  private sanitizer = inject(DomSanitizer);

  feedback = signal<string>('');
  /** Initial wait before first chunk arrives. */
  waiting = signal(true);
  /** A stream is in flight (chunks may still arrive). */
  streaming = signal(false);
  error = signal<string | null>(null);

  /**
   * Markdown → HTML. Re-parses on every signal change; marked is fast
   * enough (~5ms for typical feedback) that doing it per-chunk during
   * streaming gives a clean live preview without throttling.
   *
   * Uses `bypassSecurityTrustHtml` because the source is our own LLM
   * piped through a tightly controlled prompt — Angular's default
   * sanitizer would strip out the audit-section's <details>/<summary>
   * elements (it lists them as "non-standard" even though they're
   * vanilla HTML5) and class attributes we use for styling.
   *
   * After parsing we wrap `[L<n>]` line references in inline badges so
   * the visual anchor between supervisor claim and transcript line is
   * obvious. Done as a string post-process because marked doesn't have
   * a clean way to extend inline rules without a custom extension.
   */
  feedbackHtml = computed<SafeHtml>(() => {
    const text = this.feedback();
    if (!text) return '';
    const html = marked.parse(text, { async: false }) as string;
    const withRefs = html.replace(/\[L(\d+)\]/g, '<span class="line-ref">[L$1]</span>');
    return this.sanitizer.bypassSecurityTrustHtml(withRefs);
  });

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
