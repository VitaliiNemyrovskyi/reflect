import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { marked } from 'marked';
import { ApiService, AssessmentJson } from '../api.service';
import { SessionStateService } from '../session-state.service';

/**
 * Therapist competency rubric. Each row maps a JSON key from the
 * supervisor's machine-readable assessment to a human label + a short
 * "what does this measure" tooltip. 0-6 scale (the supervisor prompt
 * specifies it).
 *
 * Why expose this beyond the narrative: the markdown feedback tells
 * you WHAT to improve; the rubric tells you HOW WELL you did across
 * the standard dimensions. Trainees can scan the bars in 2 seconds
 * and immediately see "I'm strong on empathy but weak on guided
 * discovery" — that's the kind of cumulative learning signal that
 * makes the simulator a real training tool.
 */
const THERAPIST_RUBRIC: Array<{
  key: keyof NonNullable<AssessmentJson['therapist']>;
  label: string;
  hint: string;
}> = [
  { key: 'empathy', label: 'Емпатія', hint: 'Чи передаєш відчуття того, що тебе по-справжньому почули' },
  { key: 'collaboration', label: 'Співпраця', hint: 'Чи рухаєшся з клієнтом разом, без диктату' },
  { key: 'guidedDiscovery', label: 'Скеровані відкриття', hint: 'Чи допомагаєш клієнту самому дійти інсайтів через сократичні запитання' },
  { key: 'strategyForChange', label: 'Стратегія змін', hint: 'Чи маєш чітку гіпотезу і план, як вести сесію' },
];

/** Patient state metrics — 1-10 scale, clinical readout (not therapist
 *  performance). Shown separately so the trainee can distinguish
 *  "my work was good but the client is in rough shape" from
 *  "the client improved AND I did well". */
const PATIENT_METRICS: Array<{
  key: keyof NonNullable<AssessmentJson['patient']>;
  label: string;
  /** When true, HIGH score = bad (e.g. symptom severity 9 is concerning) */
  highIsBad: boolean;
}> = [
  { key: 'symptomSeverity', label: 'Симптомна тяжкість', highIsBad: true },
  { key: 'insight', label: 'Інсайт', highIsBad: false },
  { key: 'alliance', label: 'Альянс', highIsBad: false },
  { key: 'defensiveness', label: 'Захисність', highIsBad: true },
  { key: 'hopefulness', label: 'Надія', highIsBad: false },
];

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
      <!-- Competency rubric: machine-readable scores from the supervisor
           assessment block, rendered as bars + numerical values. Renders
           ONLY after we have the JSON (streaming end-of-call or cached).
           Therapist competencies (0-6) live on top — that's the trainee
           scorecard. Patient state (1-10) lives below for context. -->
      @if (assessment(); as a) {
        <section class="rubric" aria-label="Оцінка сесії">
          @if (a.therapist) {
            <div class="rubric-group">
              <h3 class="rubric-title">Твоя робота</h3>
              <p class="rubric-sub">Шкала 0–6 по чотирьох ключових компетенціях терапевта</p>
              <dl class="rubric-bars">
                @for (item of therapistRubric; track item.key) {
                  @let s = scoreFor('therapist', item.key);
                  <div class="rubric-row" [class.unmeasured]="s == null"
                       [title]="item.hint">
                    <dt class="rubric-label">{{ item.label }}</dt>
                    <dd class="rubric-value">
                      @if (s != null) { <strong>{{ s }}</strong><span>/6</span> }
                      @else { <span class="dim">—</span> }
                    </dd>
                    <dd class="rubric-bar" aria-hidden="true">
                      <span class="rubric-fill"
                            [style.width.%]="s != null ? (s / 6) * 100 : 0"
                            [class.weak]="s != null && s <= 2"
                            [class.strong]="s != null && s >= 5"></span>
                    </dd>
                  </div>
                }
              </dl>
            </div>
          }
          @if (a.patient) {
            <div class="rubric-group">
              <h3 class="rubric-title">Клінічний стан</h3>
              <p class="rubric-sub">Шкала 1–10 — стан клієнта, а не оцінка твоєї роботи</p>
              <dl class="rubric-bars">
                @for (item of patientMetrics; track item.key) {
                  @let s = scoreFor('patient', item.key);
                  <div class="rubric-row" [class.unmeasured]="s == null">
                    <dt class="rubric-label">{{ item.label }}</dt>
                    <dd class="rubric-value">
                      @if (s != null) { <strong>{{ s }}</strong><span>/10</span> }
                      @else { <span class="dim">—</span> }
                    </dd>
                    <dd class="rubric-bar" aria-hidden="true">
                      <span class="rubric-fill"
                            [style.width.%]="s != null ? (s / 10) * 100 : 0"
                            [class.weak]="s != null && item.highIsBad && s >= 7"
                            [class.strong]="s != null && !item.highIsBad && s >= 7"></span>
                    </dd>
                  </div>
                }
              </dl>
            </div>
          }
        </section>
      }

      <article class="feedback prose"
               [class.streaming]="streaming()"
               [innerHTML]="feedbackHtml()"
               (click)="onFeedbackClick($event)"></article>
    }

    <div class="actions">
      <button class="primary" [disabled]="streaming()" (click)="back()">
        @if (streaming()) {
          Зачекай завершення…
        } @else {
          Зберегти і повернутися
        }
      </button>
      @if (feedback() && !streaming()) {
        <button class="ghost"
                type="button"
                (click)="downloadMarkdown()"
                title="Завантажити фідбек як markdown-файл для портфоліо чи супервізора-людини">
          ↓ Markdown
        </button>
      }
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

    /* Competency rubric — bars + numerical scores, two groups (your
       therapy work, the patient's state). Sits above the markdown
       narrative so the trainee gets the scorecard at a glance before
       reading the prose. */
    .rubric {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 22px;
      margin-bottom: 22px;
    }
    @media (max-width: 760px) {
      .rubric { grid-template-columns: 1fr; gap: 18px; }
    }
    .rubric-group {
      padding: 22px 24px;
      background:
        radial-gradient(ellipse 80% 60% at 50% 0%,
          color-mix(in srgb, var(--accent) 10%, transparent) 0%,
          transparent 60%),
        color-mix(in srgb, var(--accent) 4%, var(--assistant-bg));
      border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border));
      border-radius: 14px;
    }
    .rubric-title {
      margin: 0;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent);
    }
    .rubric-sub {
      margin: 4px 0 18px;
      font-size: 12px;
      color: var(--fg-dim);
      line-height: 1.4;
    }
    .rubric-bars {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .rubric-row {
      display: grid;
      grid-template-columns: 1fr auto;
      grid-template-areas:
        "label value"
        "bar bar";
      column-gap: 14px;
      row-gap: 4px;
      align-items: baseline;
    }
    .rubric-row.unmeasured { opacity: 0.55; }
    .rubric-label {
      grid-area: label;
      font-size: 13px;
      color: var(--fg);
      margin: 0;
      cursor: help;
    }
    .rubric-value {
      grid-area: value;
      margin: 0;
      font-variant-numeric: tabular-nums;
      font-size: 16px;
      color: var(--fg-dim);
      letter-spacing: -0.01em;
    }
    .rubric-value strong {
      color: var(--fg);
      font-weight: 400;
      font-size: 22px;
      margin-right: 2px;
    }
    .rubric-value .dim { color: var(--fg-dim); font-size: 18px; }
    .rubric-bar {
      grid-area: bar;
      margin: 0;
      height: 4px;
      border-radius: 2px;
      background: color-mix(in srgb, var(--accent) 6%, var(--border));
      overflow: hidden;
    }
    .rubric-fill {
      display: block;
      height: 100%;
      background: var(--accent);
      transition: width .8s cubic-bezier(.65, 0, .35, 1);
    }
    .rubric-fill.weak   { background: var(--danger); }
    .rubric-fill.strong { background: var(--success); }

    /* Feedback article gets the Synapse panel treatment — radial wash
       from the top, rotating gradient border via background-clip
       trick (no ::before to avoid scoping edge cases). */
    .feedback {
      position: relative;
      border: 1px solid transparent;
      background:
        radial-gradient(ellipse 80% 60% at 50% 0%,
          color-mix(in srgb, var(--accent) 12%, transparent) 0%,
          transparent 60%) padding-box,
        linear-gradient(
          color-mix(in srgb, var(--accent) 4%, var(--assistant-bg)),
          color-mix(in srgb, var(--accent) 4%, var(--assistant-bg))
        ) padding-box,
        conic-gradient(
          from var(--frame-angle),
          color-mix(in srgb, var(--accent) 42%, var(--border)) 0deg,
          color-mix(in srgb, var(--accent) 16%, var(--border)) 90deg,
          color-mix(in srgb, var(--accent) 36%, var(--border)) 180deg,
          color-mix(in srgb, var(--accent) 16%, var(--border)) 270deg,
          color-mix(in srgb, var(--accent) 42%, var(--border)) 360deg
        ) border-box;
      border-radius: 14px;
      padding: 24px 28px;
      font-size: 15px;
      line-height: 1.65;
      min-height: 120px;
    }
    .feedback.streaming {
      box-shadow: 0 0 32px -8px color-mix(in srgb, var(--accent) 35%, transparent);
    }

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
       a [Lnumber] reference (see supervisor_system.md). Now rendered as
       <a> anchors — clicking them routes to /session/:id/view#msg-<n>
       where session-view scrolls + flashes the matching bubble. */
    .prose .line-ref {
      display: inline-block;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      padding: 1px 6px;
      margin: 0 1px;
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
      border-radius: 999px;
      color: var(--accent);
      vertical-align: 1px;
      white-space: nowrap;
      text-decoration: none;
      cursor: pointer;
      transition: background .15s ease, border-color .15s ease, transform .1s ease;
    }
    .prose .line-ref:hover {
      background: color-mix(in srgb, var(--accent) 22%, transparent);
      border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    }
    .prose .line-ref:active { transform: scale(0.95); }

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
  /** Machine-readable assessment block — drives the rubric UI above
   *  the narrative. Null while feedback is streaming (we only get it
   *  in the 'done' event); also null for legacy sessions saved before
   *  feedbackJson was added. */
  assessment = signal<AssessmentJson | null>(null);
  /** Initial wait before first chunk arrives. */
  waiting = signal(true);
  /** A stream is in flight (chunks may still arrive). */
  streaming = signal(false);
  error = signal<string | null>(null);
  /** Cached session id from the URL — used to build citation links
   *  that route to /session/:id/view#msg-<n> on click. */
  private sessionId = signal<number | null>(null);

  /** Static rubric definitions exposed to the template. */
  readonly therapistRubric = THERAPIST_RUBRIC;
  readonly patientMetrics = PATIENT_METRICS;

  /** Returns the integer score (0-6 for therapist, 1-10 for patient)
   *  or null. Type assertion via dynamic key access — TS can't narrow
   *  a generic key off the union type, so this stays as `unknown`. */
  scoreFor(group: 'therapist' | 'patient', key: string): number | null {
    const a = this.assessment();
    if (!a) return null;
    const groupData = (a[group] ?? {}) as Record<string, number | null | undefined>;
    const v = groupData[key];
    return typeof v === 'number' ? v : null;
  }

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
    // Each [L<n>] becomes an anchor whose href targets the session-view
    // route + hash. We intercept the click below via onFeedbackClick to
    // do an SPA navigation instead of a full reload; the href stays so
    // middle-click / cmd-click "open in new tab" still works.
    const sid = this.sessionId();
    const withRefs = html.replace(/\[L(\d+)\]/g, (_m, n: string) => {
      const href = sid != null ? `/session/${sid}/view#msg-${n}` : '#';
      return `<a class="line-ref" href="${href}" data-line="${n}">[L${n}]</a>`;
    });
    return this.sanitizer.bypassSecurityTrustHtml(withRefs);
  });

  /**
   * Intercept clicks on `.line-ref` anchors. Native navigation would
   * trigger a full page load; we route via the SPA so the session-view
   * component can pick up the #msg-<n> hash and scroll/flash. Cmd/Ctrl
   * + click and middle-click fall through to the browser (open new tab).
   */
  onFeedbackClick(event: MouseEvent) {
    const ref = (event.target as HTMLElement).closest<HTMLElement>('.line-ref');
    if (!ref) return;
    if (event.metaKey || event.ctrlKey || event.button === 1) return; // open-in-new-tab
    const sid = this.sessionId();
    const line = Number(ref.dataset['line']);
    if (!sid || !line) return;
    event.preventDefault();
    void this.router.navigate(['/session', sid, 'view'], { fragment: `msg-${line}` });
  }

  private abort = new AbortController();

  async ngOnInit() {
    const sessionId = Number(this.route.snapshot.paramMap.get('sessionId'));
    if (!sessionId) {
      this.error.set('Невідома сесія.');
      this.waiting.set(false);
      return;
    }
    // Cache for the feedbackHtml computed — drives [L<n>] anchor href.
    this.sessionId.set(sessionId);

    this.streaming.set(true);
    let buffer = '';
    let gotAnyChunk = false;

    try {
      for await (const event of this.api.endSessionStream(sessionId, this.abort.signal)) {
        switch (event.type) {
          case 'cached':
            // Already-finalized session — render saved feedback + the
            // machine-readable assessment so the rubric UI can render.
            this.feedback.set(event.data.feedback);
            this.assessment.set(event.data.assessment ?? null);
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
            // streamed buffer with the canonical narrative + machine-readable
            // assessment so the rubric UI populates.
            this.feedback.set(event.data.feedback);
            this.assessment.set(event.data.assessment ?? null);
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

  /**
   * Download the feedback as a single .md file — useful for trainees
   * who keep portfolios for their human supervisor / coursework.
   *
   * Includes the narrative + a compact rubric table (if assessment
   * data is available) so the export is self-contained. Filename
   * embeds the session id and current date for easy filing.
   */
  downloadMarkdown() {
    const sid = this.sessionId();
    const date = new Date().toISOString().slice(0, 10);
    const rubric = this.formatRubricMarkdown();
    const body = [
      `# Reflect — фідбек ${sid != null ? '(сесія #' + sid + ')' : ''}`,
      `_Згенеровано ${date}_`,
      '',
      rubric,
      this.feedback(),
    ]
      .filter(Boolean)
      .join('\n\n');

    const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reflect-feedback-${sid ?? 'session'}-${date}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revoke a tick so Safari finishes the download trigger.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Renders the assessment scores as a markdown table for the export. */
  private formatRubricMarkdown(): string {
    const a = this.assessment();
    if (!a) return '';
    const sections: string[] = [];
    if (a.therapist) {
      const rows = THERAPIST_RUBRIC.map((it) => {
        const v = this.scoreFor('therapist', it.key);
        return `| ${it.label} | ${v != null ? v + ' / 6' : '—'} |`;
      }).join('\n');
      sections.push(
        ['## Твоя робота (компетенції)', '', '| Параметр | Оцінка |', '|---|---|', rows].join('\n'),
      );
    }
    if (a.patient) {
      const rows = PATIENT_METRICS.map((it) => {
        const v = this.scoreFor('patient', it.key);
        return `| ${it.label} | ${v != null ? v + ' / 10' : '—'} |`;
      }).join('\n');
      sections.push(
        ['## Клінічний стан клієнта', '', '| Параметр | Оцінка |', '|---|---|', rows].join('\n'),
      );
    }
    return sections.join('\n\n');
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
