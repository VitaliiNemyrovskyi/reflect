import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { marked } from 'marked';
import { ApiService, SessionView } from '../api.service';
import { TestResultCardComponent } from '../test-result-card.component';

marked.setOptions({ gfm: true, breaks: true });

@Component({
  selector: 'app-session-view',
  standalone: true,
  imports: [CommonModule, DatePipe, RouterLink, TestResultCardComponent],
  template: `
    @if (loading()) {
      <p class="hint">Завантаження…</p>
    } @else if (error()) {
      <p class="hint danger">{{ error() }}</p>
      <a routerLink="/" class="link-btn">← На головну</a>
    } @else if (session()) {
      @let s = session()!;
      <header class="view-header">
        <a [routerLink]="['/patient', s.character.id]" class="back">← {{ s.character.displayName }}</a>
        <div class="header-row">
          <div>
            <h1>Сесія #{{ s.id }}</h1>
            <p class="meta">
              {{ s.startedAt | date: 'dd.MM.yyyy HH:mm' }}
              @if (s.endedAt) {
                · завершена {{ s.endedAt | date: 'HH:mm' }}
                @if (durationMin(); as d) { · {{ d }} хв }
              } @else {
                <span class="badge open">у процесі</span>
              }
              · {{ s.messages.length }} реплік
              @if (s.notes.length) { · {{ s.notes.length }} нотаток }
            </p>
          </div>
          <div class="header-actions">
            @if (s.feedback) {
              <button class="ghost" (click)="toggleFeedback()">
                {{ feedbackOpen() ? '× Сховати фідбек' : '📝 Показати фідбек' }}
              </button>
            }
          </div>
        </div>
      </header>

      @if (feedbackOpen() && s.feedback) {
        <article class="feedback-pane prose"
                 [innerHTML]="feedbackHtml()"
                 (click)="onFeedbackClick($event)"></article>
      }

      <section class="transcript">
        @for (m of s.messages; track m.id; let i = $index) {
          <div class="bubble"
               [id]="'msg-' + (i + 1)"
               [class.user]="m.role === 'user'"
               [class.assistant]="m.role === 'assistant'"
               [class.flash]="flashedLine() === i + 1">
            <div class="bubble-meta">
              <span class="line-no">[L{{ i + 1 }}]</span>
              <span class="role">
                {{ m.role === 'user' ? 'Терапевт' : s.character.displayName }}
              </span>
              <span class="time">{{ m.createdAt | date: 'HH:mm:ss' }}</span>
            </div>
            <div class="bubble-text">{{ m.content }}</div>
            @if (notesForMessage(m.id).length > 0) {
              <ul class="bubble-notes">
                @for (n of notesForMessage(m.id); track n.id) {
                  <li>📌 {{ n.noteText }}</li>
                }
              </ul>
            }
          </div>
        }
      </section>

      <!-- Test result cards for any psychological tests administered
           during the session. Rendered in administration order
           (backend sorts by id ascending). Each card has its own
           collapsible answer-by-answer breakdown. -->
      @if (s.tests && s.tests.length > 0) {
        <section class="session-tests">
          <h3>📋 Пройдені тести</h3>
          @for (t of s.tests; track t.id) {
            <app-test-result-card [test]="t" />
          }
        </section>
      }

      @if (orphanNotes().length > 0) {
        <section class="orphan-notes">
          <h3>Нотатки без прив'язки</h3>
          <ul>
            @for (n of orphanNotes(); track n.id) {
              <li>
                <p>{{ n.noteText }}</p>
                <span class="time">{{ n.createdAt | date: 'HH:mm' }}</span>
              </li>
            }
          </ul>
        </section>
      }
    }
  `,
  styles: [`
    :host { display: block; max-width: 820px; margin: 0 auto; }
    .hint { color: var(--fg-dim); }
    .hint.danger { color: var(--danger); }
    .link-btn {
      display: inline-block;
      margin-top: 10px;
      color: var(--accent);
      text-decoration: none;
      font-size: 14px;
    }

    .view-header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 14px;
      margin-bottom: 18px;
    }
    .back { color: var(--fg-dim); text-decoration: none; font-size: 13px; }
    .back:hover { color: var(--accent); }
    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      margin-top: 12px;
      gap: 14px;
      flex-wrap: wrap;
    }
    h1 { margin: 0; font-size: 24px; font-weight: 500; }
    .meta {
      color: var(--fg-dim);
      font-size: 13px;
      margin: 4px 0 0;
      line-height: 1.5;
    }
    .badge.open {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      background: #3c2c14;
      color: #fbbf6e;
      font-size: 11px;
      margin: 0 4px;
    }
    .header-actions { display: flex; gap: 8px; }

    .feedback-pane {
      background: var(--assistant-bg);
      border: 1px solid var(--accent);
      border-radius: 12px;
      padding: 18px 22px;
      margin-bottom: 18px;
      font-size: 14px;
      line-height: 1.6;
      max-height: 60vh;
      overflow-y: auto;
    }
    /* Reuse minimal prose styles for the embedded feedback. Full styling
       lives on /feedback page; here we just need readability. */
    .prose h1, .prose h2, .prose h3 { font-weight: 500; margin: 14px 0 8px; }
    .prose h2 { font-size: 16px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
    .prose h3 { font-size: 14px; }
    .prose p { margin: 0 0 10px; }
    .prose strong { color: var(--accent); }
    /* Clickable citation badge — supervisor references like [L7].
       On click, the parent article handler scrolls + flashes that
       bubble in the transcript below. */
    .prose .line-ref {
      display: inline-block;
      padding: 1px 6px;
      margin: 0 1px;
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
      border-radius: 4px;
      color: var(--accent);
      text-decoration: none;
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      letter-spacing: 0.02em;
      cursor: pointer;
      transition: background .15s ease, border-color .15s ease, transform .1s ease;
    }
    .prose .line-ref:hover {
      background: color-mix(in srgb, var(--accent) 22%, transparent);
      border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    }
    .prose .line-ref:active { transform: scale(0.95); }
    .prose ul, .prose ol { padding-left: 22px; margin: 6px 0 10px; }
    .prose li { margin: 4px 0; }
    .prose table {
      border-collapse: collapse;
      width: 100%;
      margin: 10px 0;
      font-size: 12px;
      display: block;
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .prose th, .prose td {
      padding: 6px 10px;
      border-bottom: 1px solid var(--border);
      text-align: left;
    }
    .prose th { background: var(--user-bg); font-weight: 500; font-size: 11px; }
    .prose hr { border: none; border-top: 1px solid var(--border); margin: 14px 0; }
    .prose details {
      margin: 12px 0;
      padding: 10px 12px;
      background: rgba(255, 191, 110, 0.05);
      border: 1px solid rgba(255, 191, 110, 0.2);
      border-radius: 6px;
    }
    .prose details summary { cursor: pointer; font-size: 13px; }

    .transcript {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    /* Transcript bubbles match chat.component bubbles — accent-tinted
       background with inner radial wash from the corner anchor (right
       for user, left for assistant) and accent-toned border. */
    .bubble {
      padding: 12px 16px;
      border-radius: 14px;
      max-width: 80%;
      word-wrap: break-word;
      border: 1px solid color-mix(in srgb, var(--accent) 12%, var(--border));
    }
    .bubble.user {
      align-self: flex-end;
      background:
        radial-gradient(ellipse 80% 80% at 100% 100%,
          color-mix(in srgb, var(--accent) 14%, transparent) 0%,
          transparent 65%),
        color-mix(in srgb, var(--accent) 5%, var(--user-bg));
      border-color: color-mix(in srgb, var(--accent) 22%, var(--border));
      border-bottom-right-radius: 4px;
    }
    .bubble.assistant {
      align-self: flex-start;
      background:
        radial-gradient(ellipse 80% 80% at 0% 100%,
          color-mix(in srgb, var(--accent) 8%, transparent) 0%,
          transparent 70%),
        color-mix(in srgb, var(--accent) 3%, var(--assistant-bg));
      border-bottom-left-radius: 4px;
    }
    .bubble-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 6px;
      font-size: 11px;
      color: var(--fg-dim);
      letter-spacing: .03em;
    }
    .bubble.user .role { color: var(--accent); }
    /* Line number in the bubble meta — visual anchor that lets the
       reader match supervisor's [L<n>] citation to the right bubble. */
    .line-no {
      font-variant-numeric: tabular-nums;
      color: color-mix(in srgb, var(--accent) 60%, var(--fg-dim));
      font-size: 10px;
      letter-spacing: 0.05em;
    }
    /* Flash highlight applied for ~1.6s when a citation in the feedback
       pane scrolls to this bubble — gives a clear "this is the moment
       the supervisor is talking about" cue without being annoying. */
    .bubble.flash {
      animation: bubble-flash 1.6s ease-out;
    }
    @keyframes bubble-flash {
      0%   {
        outline: 2px solid color-mix(in srgb, var(--accent) 80%, transparent);
        outline-offset: 4px;
        box-shadow: 0 0 28px -4px color-mix(in srgb, var(--accent) 60%, transparent);
      }
      100% {
        outline: 2px solid transparent;
        outline-offset: 4px;
        box-shadow: 0 0 28px -4px transparent;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .bubble.flash { animation: none; outline: 2px solid var(--accent); outline-offset: 4px; }
    }
    .bubble-text {
      white-space: pre-wrap;
      font-size: 14px;
      line-height: 1.55;
    }
    .bubble-notes {
      list-style: none;
      padding: 8px 10px;
      margin: 8px 0 0;
      background: rgba(216, 201, 255, 0.04);
      border-left: 2px solid var(--accent);
      border-radius: 4px;
      font-size: 12px;
      color: var(--fg-dim);
      line-height: 1.5;
    }
    .bubble-notes li { margin: 3px 0; }

    .session-tests {
      margin-top: 24px;
      padding-top: 18px;
      border-top: 1px solid var(--border);
    }
    .session-tests h3 {
      font-size: 13px;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin: 0 0 12px;
      font-weight: 500;
    }

    .orphan-notes {
      margin-top: 24px;
      padding-top: 18px;
      border-top: 1px solid var(--border);
    }
    .orphan-notes h3 {
      font-size: 13px;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: .05em;
      margin: 0 0 10px;
      font-weight: 500;
    }
    .orphan-notes ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .orphan-notes li {
      padding: 8px 12px;
      margin-bottom: 6px;
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 13px;
    }
    .orphan-notes li p { margin: 0 0 4px; }
    .orphan-notes li .time { font-size: 11px; color: var(--fg-dim); }

    @media (max-width: 720px) {
      .bubble { max-width: 95%; }
      h1 { font-size: 20px; }
      .feedback-pane { padding: 14px 16px; }
    }
  `],
})
export class SessionViewComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);
  private sanitizer = inject(DomSanitizer);

  loading = signal(true);
  error = signal<string | null>(null);
  session = signal<SessionView | null>(null);
  feedbackOpen = signal(false);
  /** Line number that's currently flashing (after click on [L<n>] ref).
   *  Drives the .flash class on the matching .bubble — auto-clears 1.6s
   *  later via setTimeout. null = nothing flashing. */
  flashedLine = signal<number | null>(null);

  /** Markdown → HTML for the feedback pane (toggled by user). The
   *  [L<n>] post-process turns each citation into a clickable anchor
   *  bound to #msg-<n>, which onFeedbackClick handles. */
  feedbackHtml = computed<SafeHtml>(() => {
    const fb = this.session()?.feedback;
    if (!fb) return '';
    const html = marked.parse(fb, { async: false }) as string;
    const withRefs = html.replace(
      /\[L(\d+)\]/g,
      (_m, n: string) =>
        `<a class="line-ref" href="#msg-${n}" data-line="${n}">[L${n}]</a>`,
    );
    return this.sanitizer.bypassSecurityTrustHtml(withRefs);
  });

  /**
   * Intercept clicks on `.line-ref` anchors inside the feedback pane.
   * Native href navigation would jam a hash into the URL and trigger
   * a default jump (no smooth scroll, no flash). We hijack: scroll
   * the matching .bubble into view smoothly and flash it for 1.6s.
   */
  onFeedbackClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const ref = target.closest<HTMLElement>('.line-ref');
    if (!ref) return;
    event.preventDefault();
    const line = Number(ref.dataset['line']);
    if (!line) return;
    this.scrollToLine(line);
  }

  private scrollToLine(line: number) {
    const el = document.getElementById(`msg-${line}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.flashedLine.set(line);
    // Clear the flash class after the animation completes so a second
    // click on the same line re-triggers the highlight.
    setTimeout(() => {
      if (this.flashedLine() === line) this.flashedLine.set(null);
    }, 1600);
  }

  /** Duration in minutes (rounded). null if session not ended. */
  durationMin = computed<number | null>(() => {
    const s = this.session();
    if (!s?.endedAt) return null;
    const ms = new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime();
    return Math.max(1, Math.round(ms / 60000));
  });

  /** Notes mapped to anchor messages. Keyed by anchorMessageId. */
  notesForMessage(messageId: number) {
    return this.session()?.notes.filter((n) => n.anchorMessageId === messageId) ?? [];
  }

  /** Notes without an anchor — shown in their own section. */
  orphanNotes = computed(() =>
    this.session()?.notes.filter((n) => n.anchorMessageId == null) ?? [],
  );

  toggleFeedback() {
    this.feedbackOpen.update((v) => !v);
  }

  async ngOnInit() {
    const id = Number(this.route.snapshot.paramMap.get('sessionId'));
    if (!id) {
      this.error.set('Невідома сесія.');
      this.loading.set(false);
      return;
    }
    try {
      const s = await this.api.viewSession(id);
      this.session.set(s);
      // If we landed here from a feedback citation like /session/X/view#msg-7,
      // wait one frame for the bubble DOM to mount, then scroll + flash.
      const hash = location.hash.match(/^#msg-(\d+)$/);
      if (hash) {
        const line = Number(hash[1]);
        requestAnimationFrame(() => requestAnimationFrame(() => this.scrollToLine(line)));
      }
    } catch (e: unknown) {
      const httpErr = e as { status?: number; error?: { message?: string }; message?: string };
      const msg =
        httpErr.error?.message ||
        (httpErr.status === 404 ? 'Сесія не знайдена або у тебе немає доступу.' : null) ||
        httpErr.message ||
        'Не вдалось завантажити сесію.';
      this.error.set(msg);
    } finally {
      this.loading.set(false);
    }
  }
}
