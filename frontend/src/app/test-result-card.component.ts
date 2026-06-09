import { CommonModule } from '@angular/common';
import { Component, Input, inject, signal } from '@angular/core';
import { PsychTestSummary, SessionTest } from './api.service';
import { I18nService } from './i18n.service';

/**
 * Inline card rendered in the chat transcript when the AI patient has
 * just completed a test administered by the therapist. Shows the
 * headline score + severity badge front-and-centre, with the
 * per-item breakdown collapsed behind a disclosure toggle.
 *
 * Colour of the score badge maps to the InterpretationBand.color of
 * the band the patient landed in — green for good, neutral, warn,
 * danger. Same palette as the rest of the Reflect aesthetic.
 */
@Component({
  selector: 'app-test-result-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    <article class="test-card" [class.failed]="test.status === 'failed'" [class.pending]="test.status === 'pending'">
      <header class="card-head">
        <div class="head-left">
          <span class="badge">{{ i18n.t('testResultCard.badge') }}</span>
          <h3 class="card-title">{{ summary?.name || test.testKey }}</h3>
        </div>
        @if (test.status === 'completed') {
          <div class="score-block" [class]="'score-' + (severityColor() || 'neutral')">
            <span class="score-value">{{ displayScore() }}</span>
            <span class="score-range">/ {{ displayMax() }}</span>
          </div>
        }
      </header>

      @if (test.status === 'pending') {
        <p class="status-line">{{ i18n.t('testResultCard.statusPending', { suffix: feminineSuffix }) }}</p>
      } @else if (test.status === 'failed') {
        <p class="status-line danger">{{ i18n.t('testResultCard.failedAnswers') }}</p>
      } @else {
        <div class="severity-row">
          <span class="severity-label" [class]="'severity-' + (severityColor() || 'neutral')">
            {{ test.severityLabel }}
          </span>
          @if (summary?.fullNameUa) {
            <span class="full-name">{{ summary?.fullNameUa }}</span>
          }
        </div>

        <button type="button" class="toggle-answers" (click)="toggleAnswers()">
          @if (answersOpen()) {
            {{ i18n.t('testResultCard.hideAnswers') }}
          } @else {
            {{ i18n.t('testResultCard.showAnswers', { count: test.answers?.length || 0 }) }}
          }
        </button>

        @if (answersOpen() && test.answers && test.answers.length) {
          <ul class="answers">
            @for (a of test.answers; track a.itemId) {
              <li class="answer-row">
                <span class="answer-num">{{ a.itemId }}.</span>
                <span class="answer-construct">{{ a.constructUa }}</span>
                <span class="answer-value">
                  <span class="answer-num-badge">{{ a.value }}</span>
                  {{ a.optionLabel }}
                </span>
              </li>
            }
          </ul>
        }
      }
    </article>
  `,
  styles: [`
    .test-card {
      padding: 16px 18px;
      margin: 12px 0;
      background: color-mix(in srgb, var(--accent) 5%, var(--assistant-bg));
      border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border));
      border-left: 3px solid var(--accent);
      border-radius: 12px;
    }
    .test-card.failed { border-left-color: var(--danger); }
    .test-card.pending { opacity: 0.85; }

    .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; }
    .head-left { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .badge {
      display: inline-block;
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 500;
      color: var(--accent);
    }
    .card-title { margin: 0; font-size: 18px; font-weight: 500; }

    .score-block {
      display: flex;
      align-items: baseline;
      gap: 2px;
      padding: 6px 14px;
      border-radius: 10px;
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
      font-variant-numeric: tabular-nums;
    }
    .score-block.score-good {
      background: color-mix(in srgb, var(--success, #2a6f4d) 18%, transparent);
      border-color: color-mix(in srgb, var(--success, #2a6f4d) 40%, transparent);
    }
    .score-block.score-warn {
      background: color-mix(in srgb, #b8860b 18%, transparent);
      border-color: color-mix(in srgb, #b8860b 40%, transparent);
    }
    .score-block.score-danger {
      background: color-mix(in srgb, var(--danger) 16%, transparent);
      border-color: color-mix(in srgb, var(--danger) 38%, transparent);
    }
    .score-value { font-size: 26px; font-weight: 300; color: var(--fg); line-height: 1; }
    .score-range { font-size: 13px; color: var(--fg-dim); }

    .status-line { margin: 12px 0 0; font-size: 13px; color: var(--fg-dim); font-style: italic; }
    .status-line.danger { color: var(--danger); font-style: normal; }

    .severity-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin: 10px 0 6px;
    }
    .severity-label {
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 12px;
      letter-spacing: 0.02em;
      font-weight: 500;
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      color: var(--accent);
    }
    .severity-label.severity-good {
      background: color-mix(in srgb, var(--success, #2a6f4d) 18%, transparent);
      color: var(--success, #2a6f4d);
    }
    .severity-label.severity-warn {
      background: color-mix(in srgb, #b8860b 22%, transparent);
      color: #d4a017;
    }
    .severity-label.severity-danger {
      background: color-mix(in srgb, var(--danger) 18%, transparent);
      color: var(--danger);
    }
    .full-name { font-size: 12px; color: var(--fg-dim); }

    .toggle-answers {
      margin-top: 8px;
      background: transparent;
      border: none;
      color: var(--accent);
      font-size: 12px;
      cursor: pointer;
      padding: 4px 0;
      text-align: left;
    }
    .toggle-answers:hover { text-decoration: underline; }

    .answers {
      list-style: none;
      margin: 8px 0 0;
      padding: 12px 14px;
      background: color-mix(in srgb, var(--accent) 3%, transparent);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .answer-row {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 8px;
      align-items: baseline;
      font-size: 13px;
      line-height: 1.4;
    }
    .answer-num { color: var(--fg-dim); font-variant-numeric: tabular-nums; }
    .answer-construct { color: var(--fg); }
    .answer-value {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--fg-dim);
      white-space: nowrap;
    }
    .answer-num-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px; height: 22px;
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      color: var(--accent);
      border-radius: 50%;
      font-size: 11px;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
    }

    @media (max-width: 600px) {
      .answer-row { grid-template-columns: auto 1fr; }
      .answer-value { grid-column: 2; margin-top: 2px; }
    }
  `],
})
export class TestResultCardComponent {
  protected readonly i18n = inject(I18nService);

  @Input({ required: true }) test!: SessionTest;
  @Input() summary: PsychTestSummary | null = null;
  @Input() feminineSuffix: string = 'ка'; // "Пацієнтка" / "Пацієнт"

  answersOpen = signal(false);

  /** Angular templates don't allow arrow functions in event handlers,
   *  so the toggle lives as a class method instead of an inline
   *  `signal.update(v => !v)`. */
  toggleAnswers() {
    this.answersOpen.update((v) => !v);
  }

  /** Maps the severity level to a colour class (band.color is on the
   *  test definition itself; we infer here from the severity string
   *  for simplicity since the result only carries the level). */
  severityColor(): 'good' | 'neutral' | 'warn' | 'danger' | null {
    const s = this.test.severity;
    if (!s) return null;
    // Heuristic per common test severity terminology.
    if (/(severe|high|depression-likely)/i.test(s)) return 'danger';
    if (/(moderate|moderately|warn|poor)/i.test(s)) return 'warn';
    if (/(minimal|low|good|average)/i.test(s)) return 'good';
    if (/(mild|neutral)/i.test(s)) return 'neutral';
    return null;
  }

  displayScore(): number | null {
    return this.test.scaledScore ?? this.test.rawScore;
  }

  displayMax(): number {
    // We don't have scoreRange on SessionTest directly — fall back to
    // some guesses based on testKey for the headline display. For
    // perfect accuracy, the chat parent should pass summary alongside.
    if (this.summary?.scoreRange) return this.summary.scoreRange[1];
    const guesses: Record<string, number> = {
      phq9: 27, gad7: 21, who5: 100, pss10: 40, audit: 40,
    };
    return guesses[this.test.testKey] ?? 0;
  }
}
