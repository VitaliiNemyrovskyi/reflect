import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  ApiService,
  CourseDetail,
  CourseListItem,
  CourseModule,
  CourseStep,
  GlossaryTerm,
  LessonBlock,
  QuizQuestion,
} from '../api.service';
import { I18nService } from '../i18n.service';
import { IconComponent } from '../icon.component';

/**
 * Skill-path courses. Two views in one component (like /cohorts):
 *  - `/courses`        → catalog of published courses with progress
 *  - `/courses/:key`   → the course: modules (with learning objectives), each a
 *                        stepper of lessons (structured blocks), quizzes (graded
 *                        client-side) and practice steps that launch a real
 *                        session and flip to ✓ once the feedback meets the bar.
 * Steps unlock sequentially across the whole course. Authed route, so the
 * global app-header provides the chrome.
 */
@Component({
  selector: 'app-courses',
  standalone: true,
  imports: [RouterLink, IconComponent],
  template: `
    <section class="wrap">
      @if (loading()) {
        <p class="muted">{{ tr('Завантаження…', 'Loading…') }}</p>
      } @else if (error()) {
        <p class="danger">{{ error() }}</p>
      } @else {
        @if (detail(); as d) {
        <!-- ── Course view ── -->
        <a routerLink="/courses" class="back">← {{ tr('Усі курси', 'All courses') }}</a>
        <header class="track-head">
          <h1>{{ i18n.isEn ? d.titleEn : d.titleUk }}</h1>
          <p class="muted">{{ i18n.isEn ? d.descEn : d.descUk }}</p>
          <div class="course-progress" [class.complete]="d.completed">
            <div class="cp-bar"><span [style.width.%]="coursePct()"></span></div>
            <span class="cp-label">
              @if (d.completed) {
                <app-icon name="shield-check" /> {{ tr('Курс пройдено', 'Course complete') }}
              } @else {
                {{ tr('Пройдено', 'Done') }} {{ courseDone() }} / {{ courseTotal() }} {{ tr('кроків', 'steps') }}
              }
            </span>
          </div>
        </header>

        @for (m of d.modules; track m.id) {
          <section class="module">
            <div class="module-head">
              <div class="module-eyebrow-row">
                <span class="module-eyebrow">{{ tr('Модуль', 'Module') }} {{ m.order + 1 }}</span>
                <span class="module-progress" [class.done]="moduleDone(m) === m.steps.length">
                  {{ moduleDone(m) }} / {{ m.steps.length }}
                </span>
              </div>
              <h2>{{ i18n.isEn ? m.titleEn : m.titleUk }}</h2>
              @if (objectivesOf(m).length) {
                <div class="objectives">
                  <span class="obj-label">{{ tr('Чого навчишся', 'What you will learn') }}</span>
                  <ul>
                    @for (o of objectivesOf(m); track $index) { <li>{{ o }}</li> }
                  </ul>
                </div>
              }
            </div>

            <ol class="steps">
              @for (s of m.steps; track s.id) {
                <li class="step" [class.done]="s.done" [class.locked]="!s.available && !s.done">
                  <div class="step-rail">
                    <span class="step-dot">
                      @if (s.done) { <app-icon name="shield-check" /> }
                      @else { {{ s.order + 1 }} }
                    </span>
                  </div>
                  <div class="step-body">
                    <div class="step-top">
                      <span class="step-kind" [attr.data-kind]="s.kind">{{ kindLabel(s) }}</span>
                      <h3>{{ i18n.isEn ? s.titleEn : s.titleUk }}</h3>
                    </div>

                    @if (!s.available && !s.done) {
                      <p class="step-status muted">{{ tr('Відкриється після попереднього кроку', 'Unlocks after the previous step') }}</p>
                    } @else {
                      @if (s.done) {
                        <div class="done-head">
                          <span class="step-status ok">✓ {{ tr('Зараховано', 'Completed') }}</span>
                          @if (s.kind === 'practice') {
                            @if (s.sessionId) {
                              <a class="ghost-link" [routerLink]="['/session', s.sessionId]">{{ tr('Відкрити сесію', 'Open session') }}</a>
                            }
                          } @else {
                            <button type="button" class="link-btn" (click)="toggleReview(s.id)">
                              {{ isReviewing(s.id) ? tr('Згорнути', 'Collapse') : tr('Переглянути', 'Review') }}
                            </button>
                          }
                        </div>
                      }

                      @if (showContent(s)) {
                        <!-- Shared lesson / practice body blocks -->
                        @if (blocksOf(s).length) {
                          <div class="lesson">
                            @for (b of blocksOf(s); track $index) {
                              @switch (b.type) {
                                @case ('h') { <h4 class="lb-h">{{ b.text }}</h4> }
                                @case ('quote') { <p class="lb-quote">{{ b.text }}</p> }
                                @case ('list') {
                                  <ul class="lb-list">
                                    @for (it of (b.items ?? []); track $index) {
                                      <li>@if (it.term) { <strong>{{ it.term }}</strong> — }{{ it.text }}</li>
                                    }
                                  </ul>
                                }
                                @case ('dialogue') {
                                  <div class="lb-dialogue">
                                    @for (ln of (b.lines ?? []); track $index) {
                                      <p class="lb-line"><strong>{{ ln.who }}:</strong> {{ ln.text }}</p>
                                    }
                                  </div>
                                }
                                @default { <p class="lb-p">{{ b.text }}</p> }
                              }
                            }
                          </div>
                        }

                        @if (lessonTerms(s).length) {
                          <details class="lesson-terms">
                            <summary>{{ tr('Терміни в цьому уроці', 'Terms in this lesson') }} ({{ lessonTerms(s).length }})</summary>
                            <dl>
                              @for (t of lessonTerms(s); track t.slug) {
                                <div>
                                  <dt>{{ i18n.isEn ? t.termEn : t.termUk }}</dt>
                                  <dd>{{ i18n.isEn ? t.defEn : t.defUk }}</dd>
                                </div>
                              }
                            </dl>
                            <a routerLink="/glossary" class="lt-all">{{ tr('Повний словник →', 'Full glossary →') }}</a>
                          </details>
                        }

                        @if (s.kind === 'quiz') {
                          @if (s.done) {
                            <!-- Review mode: correct answers + explanations, non-interactive -->
                            <div class="quiz">
                              @for (q of quizFor(s); track $index; let qi = $index) {
                                <div class="quiz-q">
                                  <p class="q-text">{{ qi + 1 }}. {{ q.q }}</p>
                                  <div class="q-opts">
                                    @for (opt of q.options; track $index; let oi = $index) {
                                      <div class="q-opt static" [class.correct]="oi === q.correct">{{ opt }}</div>
                                    }
                                  </div>
                                  @if (q.explain) { <p class="q-explain">{{ q.explain }}</p> }
                                </div>
                              }
                            </div>
                          } @else {
                            <!-- Interactive quiz -->
                            <div class="quiz">
                              @for (q of quizFor(s); track $index; let qi = $index) {
                                <div class="quiz-q">
                                  <p class="q-text">{{ qi + 1 }}. {{ q.q }}</p>
                                  <div class="q-opts">
                                    @for (opt of q.options; track $index; let oi = $index) {
                                      <button type="button" class="q-opt"
                                        [class.sel]="selectedAnswer(s.id, qi) === oi"
                                        [class.correct]="isChecked(s.id) && oi === q.correct"
                                        [class.wrong]="isChecked(s.id) && selectedAnswer(s.id, qi) === oi && oi !== q.correct"
                                        [disabled]="isChecked(s.id)"
                                        (click)="selectQuizOption(s.id, qi, oi)">
                                        {{ opt }}
                                      </button>
                                    }
                                  </div>
                                  @if (isChecked(s.id) && q.explain) { <p class="q-explain">{{ q.explain }}</p> }
                                </div>
                              }
                              @if (!isChecked(s.id)) {
                                <button class="primary" [disabled]="!quizComplete(s) || busy() === s.id" (click)="checkQuiz(s)">
                                  {{ tr('Перевірити', 'Check answers') }}
                                </button>
                              } @else {
                                <p class="quiz-score">{{ quizScoreLabel(s) }}</p>
                                <button class="primary" (click)="retryQuiz(s)">{{ tr('Спробувати ще раз', 'Try again') }}</button>
                              }
                            </div>
                          }
                        } @else if (s.kind === 'lesson') {
                          @if (!s.done) {
                            <button class="primary" [disabled]="busy() === s.id" (click)="finishStep(s)">
                              {{ busy() === s.id ? '…' : tr('Зрозуміло, далі', 'Got it, next') }}
                            </button>
                          }
                        } @else {
                          @if (!s.done) {
                            <div class="practice-row">
                              @if (s.patient; as p) {
                                <span class="patient">
                                  @if (p.avatarUrl) { <img [src]="p.avatarUrl" [alt]="p.displayName" /> }
                                  {{ p.displayName }}
                                </span>
                              }
                              <button class="primary" [disabled]="busy() === s.id" (click)="startPractice(s)">
                                {{ busy() === s.id ? '…' : tr('Почати практику', 'Start practice') }}
                              </button>
                              @if (s.sessionId) {
                                <a class="ghost-link" [routerLink]="['/session', s.sessionId]">{{ tr('Продовжити сесію', 'Resume session') }}</a>
                              }
                            </div>
                            <p class="hint">{{ tr('Крок зараховується після того, як завершиш сесію й отримаєш фідбек.', 'The step is credited once you finish the session and get feedback.') }}</p>
                          }
                        }
                      }
                    }
                  </div>
                </li>
              }
            </ol>
          </section>
        }

        @if (d.glossary.length) {
          <section class="glossary-section">
            <h2>{{ tr('Словник курсу', 'Course glossary') }}</h2>
            <dl class="g-terms">
              @for (t of d.glossary; track t.slug) {
                <div class="g-term">
                  <dt>{{ i18n.isEn ? t.termEn : t.termUk }}</dt>
                  <dd>{{ i18n.isEn ? t.defEn : t.defUk }}</dd>
                </div>
              }
            </dl>
            <a routerLink="/glossary" class="g-all">{{ tr('Повний словник →', 'Full glossary →') }}</a>
          </section>
        }
      } @else {
        <!-- ── Catalog ── -->
        <a routerLink="/dashboard" class="back">← {{ tr('На головну', 'Home') }}</a>
        <header class="cat-head">
          <h1>{{ tr('Курси', 'Courses') }}</h1>
          <p class="muted">{{ tr('Повноцінні курси: модулі з теорією → квізи → практика з AI-пацієнтом і фідбек.', 'Full courses: modules of theory → quizzes → practice with an AI patient and feedback.') }}</p>
        </header>

        @if (list().length === 0) {
          <p class="muted">{{ tr('Курсів поки немає.', 'No courses yet.') }}</p>
        } @else {
          <div class="cards">
            @for (c of list(); track c.key) {
              <a class="card synapse-panel" [routerLink]="['/courses', c.key]">
                <h3>{{ i18n.isEn ? c.titleEn : c.titleUk }}</h3>
                <p class="muted">{{ i18n.isEn ? c.descEn : c.descUk }}</p>
                <div class="bar"><span [style.width.%]="pct(c)"></span></div>
                <span class="bar-label">
                  {{ c.doneSteps }} / {{ c.totalSteps }} {{ tr('кроків', 'steps') }}
                  · {{ c.moduleCount }} {{ tr('модулів', 'modules') }}
                </span>
              </a>
            }
          </div>
        }
        }
      }
    </section>
  `,
  styles: [`
    .wrap { display: flex; flex-direction: column; gap: 18px; }
    .back { color: var(--fg-dim); text-decoration: none; font-size: 14px; align-self: flex-start; }
    .back:hover { color: var(--accent); }
    .muted { color: var(--fg-dim); }
    .danger { color: var(--danger); }
    h1 { font-size: 26px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }

    /* Catalog */
    .cat-head, .track-head { display: flex; flex-direction: column; gap: 8px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
    .card { display: flex; flex-direction: column; gap: 8px; padding: 20px; text-decoration: none; color: inherit;
      transition: border-color .15s ease, transform .12s ease; }
    .card:hover { border-color: var(--accent); transform: translateY(-2px); }
    .card h3 { margin: 0; font-size: 18px; font-weight: 600; }
    .card .muted { font-size: 14px; line-height: 1.45; flex: 1; }
    .bar { height: 6px; border-radius: 999px; background: var(--user-bg); overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--accent); border-radius: 999px; transition: width .3s ease; }
    .bar-label { font-size: 12px; color: var(--fg-dim); }

    /* Track header */
    .done-pill { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
      padding: 5px 12px; border-radius: 999px; font-size: 13px; color: var(--accent);
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--border)); }

    /* Course progress (header) */
    .course-progress { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; max-width: 440px; }
    .cp-bar { height: 8px; border-radius: 999px; background: var(--user-bg); overflow: hidden;
      border: 1px solid var(--border); }
    .cp-bar span { display: block; height: 100%; background: var(--accent); border-radius: 999px; transition: width .3s ease; }
    .cp-label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--fg-dim); }
    .course-progress.complete .cp-bar span { background: #6fae8f; }
    .course-progress.complete .cp-label { color: var(--accent); }

    /* Per-module progress badge */
    .module-eyebrow-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .module-progress { font-size: 12px; color: var(--fg-dim); padding: 2px 9px; border-radius: 999px;
      border: 1px solid var(--border); background: var(--user-bg); white-space: nowrap; }
    .module-progress.done { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
      background: color-mix(in srgb, var(--accent) 10%, transparent); }

    /* Completed-step header + review toggle */
    .done-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .link-btn { background: none; border: none; padding: 0; font: inherit; font-size: 13px; color: var(--fg-dim);
      cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
    .link-btn:hover { color: var(--accent); }

    /* Module */
    .module { display: flex; flex-direction: column; gap: 14px; padding-top: 6px; }
    .module-head { display: flex; flex-direction: column; gap: 6px; }
    .module-eyebrow { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-dim); }
    .module-head h2 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
    .objectives { margin-top: 4px; padding: 12px 14px; border-radius: 12px;
      background: color-mix(in srgb, var(--accent) 6%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border)); }
    .obj-label { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--accent); }
    .objectives ul { margin: 6px 0 0; padding-left: 18px; }
    .objectives li { font-size: 14px; line-height: 1.5; color: var(--fg); margin: 3px 0; }

    /* Stepper */
    .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .step { display: grid; grid-template-columns: 40px 1fr; gap: 14px; }
    .step-rail { display: flex; flex-direction: column; align-items: center; }
    .step-dot { width: 32px; height: 32px; flex: 0 0 auto; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 600; color: var(--fg-dim);
      background: var(--user-bg); border: 1px solid var(--border); }
    .step:not(:last-child) .step-rail::after { content: ''; flex: 1; width: 2px; min-height: 18px;
      background: var(--border); margin: 4px 0; }
    .step.done .step-dot { color: var(--accent); border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 14%, transparent); }
    .step-body { padding-bottom: 26px; min-width: 0; }
    .step-top { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
    .step-kind { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--accent); }
    .step-kind[data-kind="quiz"] { color: #e0a458; }
    .step-kind[data-kind="practice"] { color: #6fae8f; }
    .step-body h3 { margin: 0; font-size: 17px; font-weight: 600; }
    .step.locked .step-body { opacity: 0.55; }
    .step-status { margin: 0; font-size: 14px; }
    .step-status.ok { color: var(--accent); }

    /* Structured lesson content (rendered natively, no markdown) */
    .lesson { margin: 4px 0 14px; border-left: 2px solid color-mix(in srgb, var(--accent) 30%, var(--border)); padding-left: 16px; }
    .lb-h { font-size: 15px; font-weight: 600; margin: 14px 0 6px; color: var(--fg); }
    .lb-h:first-child { margin-top: 0; }
    .lb-p { font-size: 15px; line-height: 1.6; color: var(--fg); margin: 6px 0; }
    .lb-list { margin: 6px 0; padding-left: 20px; }
    .lb-list li { font-size: 15px; line-height: 1.55; color: var(--fg); margin: 4px 0; }
    .lb-list strong { color: var(--fg); }
    .lb-quote { margin: 12px 0; padding: 8px 12px; border-left: 2px solid var(--accent);
      background: color-mix(in srgb, var(--accent) 6%, transparent); color: var(--fg-dim); font-style: italic; border-radius: 0 8px 8px 0; }
    .lb-dialogue { margin: 10px 0; padding: 10px 14px; border-radius: 10px; background: var(--user-bg); }
    .lb-line { font-size: 14.5px; line-height: 1.55; color: var(--fg); margin: 4px 0; }
    .lb-line strong { color: var(--accent); }

    /* Quiz */
    .quiz { display: flex; flex-direction: column; gap: 16px; margin: 4px 0 6px; }
    .quiz-q { display: flex; flex-direction: column; gap: 8px; }
    .q-text { margin: 0; font-size: 15px; font-weight: 600; color: var(--fg); }
    .q-opts { display: flex; flex-direction: column; gap: 6px; }
    .q-opt { text-align: left; padding: 10px 14px; border-radius: 10px; font-size: 14.5px; line-height: 1.4;
      color: var(--fg); background: var(--user-bg); border: 1px solid var(--border); cursor: pointer;
      transition: border-color .12s ease, background .12s ease; }
    .q-opt:hover:not(:disabled) { border-color: var(--accent); }
    .q-opt.sel { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .q-opt.correct { border-color: #6fae8f; background: color-mix(in srgb, #6fae8f 16%, transparent); color: var(--fg); }
    .q-opt.wrong { border-color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
    .q-opt:disabled { cursor: default; }
    .q-opt.static { cursor: default; }
    .q-opt.static:not(.correct):hover { border-color: var(--border); }
    .q-explain { margin: 2px 0 0; font-size: 13.5px; line-height: 1.5; color: var(--fg-dim);
      padding-left: 10px; border-left: 2px solid color-mix(in srgb, var(--accent) 30%, var(--border)); }
    .quiz-score { margin: 0; font-size: 14px; color: var(--fg); }

    .practice-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 4px 0 6px; }
    .patient { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; color: var(--fg); }
    .patient img { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; }
    .ghost-link { color: var(--fg-dim); text-decoration: none; font-size: 13px; }
    .ghost-link:hover { color: var(--accent); }
    .hint { margin: 4px 0 0; font-size: 12.5px; color: var(--fg-dim); }

    button.primary { align-self: flex-start; }

    /* Course glossary section */
    .glossary-section { display: flex; flex-direction: column; gap: 12px; padding-top: 10px;
      border-top: 1px solid var(--border); margin-top: 6px; }
    .glossary-section h2 { margin: 0; font-size: 18px; font-weight: 600; }
    .g-terms { margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
    .g-term { padding: 12px 14px; border-radius: 12px; background: var(--user-bg); border: 1px solid var(--border); }
    .g-term dt { font-size: 15px; font-weight: 600; color: var(--fg); margin: 0 0 3px; }
    .g-term dd { margin: 0; font-size: 13.5px; line-height: 1.5; color: var(--fg-dim); }
    .g-all { align-self: flex-start; color: var(--fg-dim); text-decoration: none; font-size: 14px; }
    .g-all:hover { color: var(--accent); }

    /* Inline "terms in this lesson" expander */
    .lesson-terms { margin: 6px 0 14px; border: 1px solid var(--border); border-radius: 10px;
      background: var(--user-bg); overflow: hidden; }
    .lesson-terms > summary { cursor: pointer; padding: 10px 14px; font-size: 13.5px; color: var(--accent);
      list-style: none; user-select: none; }
    .lesson-terms > summary::-webkit-details-marker { display: none; }
    .lesson-terms > summary::before { content: '📖 '; }
    .lesson-terms[open] > summary { border-bottom: 1px solid var(--border); }
    .lesson-terms dl { margin: 0; padding: 10px 14px; display: flex; flex-direction: column; gap: 10px; }
    .lesson-terms dt { font-size: 14px; font-weight: 600; color: var(--fg); }
    .lesson-terms dd { margin: 2px 0 0; font-size: 13.5px; line-height: 1.5; color: var(--fg-dim); }
    .lt-all { display: inline-block; margin: 0 14px 12px; font-size: 13px; color: var(--fg-dim); text-decoration: none; }
    .lt-all:hover { color: var(--accent); }
  `],
})
export class CoursesComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  readonly i18n = inject(I18nService);

  loading = signal(true);
  error = signal<string | null>(null);
  list = signal<CourseListItem[]>([]);
  detail = signal<CourseDetail | null>(null);
  busy = signal<number | null>(null);

  // Quiz interaction state (client-side grading).
  private quizAnswers = signal<Record<string, number>>({});
  private checkedSteps = signal<number[]>([]);
  // Completed steps the user has re-opened to re-read.
  private reviewing = signal<number[]>([]);

  async ngOnInit(): Promise<void> {
    const key = this.route.snapshot.paramMap.get('key');
    await (key ? this.loadDetail(key) : this.loadList());
  }

  protected tr(uk: string, en: string): string {
    return this.i18n.isEn ? en : uk;
  }

  protected pct(c: CourseListItem): number {
    return c.totalSteps ? Math.round((c.doneSteps / c.totalSteps) * 100) : 0;
  }

  protected objectivesOf(m: CourseModule): string[] {
    return this.i18n.isEn ? m.objectivesEn : m.objectivesUk;
  }

  protected blocksOf(s: CourseStep): LessonBlock[] {
    return this.i18n.isEn ? s.contentEn : s.contentUk;
  }

  protected quizFor(s: CourseStep): QuizQuestion[] {
    return this.i18n.isEn ? s.quizEn : s.quizUk;
  }

  /** Glossary terms from this course whose word-stems appear in the step's
   *  text — surfaced inline so the reader needn't hunt for definitions. */
  protected lessonTerms(s: CourseStep): GlossaryTerm[] {
    const gloss = this.detail()?.glossary ?? [];
    if (!gloss.length) return [];
    const blocks = this.blocksOf(s);
    if (!blocks.length) return [];
    const en = this.i18n.isEn;
    const hay = this.blockText(blocks).toLowerCase();
    return gloss.filter((t) => this.termAppears(en ? t.termEn : t.termUk, hay)).slice(0, 10);
  }

  private blockText(blocks: LessonBlock[]): string {
    const parts: string[] = [];
    for (const b of blocks) {
      if (b.text) parts.push(b.text);
      for (const it of b.items ?? []) {
        if (it.term) parts.push(it.term);
        parts.push(it.text);
      }
      for (const ln of b.lines ?? []) parts.push(ln.text);
    }
    return parts.join(' ');
  }

  /** Word-stem match so inflected forms count (e.g. "альянс" in "альянсу").
   *  Only distinctive words trigger (≥6 chars) plus a few known acronyms, so
   *  generic words like "думки"/"план" don't pull in tangential terms. */
  private static readonly TERM_ACRONYMS = new Set(['oars', 'suds', 'ssrs']);
  private termAppears(term: string, hayLower: string): boolean {
    const words = term.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return words.some((w) => {
      if (CoursesComponent.TERM_ACRONYMS.has(w)) return hayLower.includes(w);
      if (w.length < 6) return false;
      return hayLower.includes(w.slice(0, w.length - 2));
    });
  }

  protected kindLabel(s: CourseStep): string {
    switch (s.kind) {
      case 'practice': return this.tr('Практика', 'Practice');
      case 'quiz': return this.tr('Квіз', 'Quiz');
      default: return this.tr('Урок', 'Lesson');
    }
  }

  // ── Progress ──────────────────────────────────────────────────────────────
  private modules(): CourseModule[] {
    return this.detail()?.modules ?? [];
  }
  protected courseTotal(): number {
    return this.modules().reduce((n, m) => n + m.steps.length, 0);
  }
  protected courseDone(): number {
    return this.modules().reduce((n, m) => n + m.steps.filter((s) => s.done).length, 0);
  }
  protected coursePct(): number {
    const total = this.courseTotal();
    return total ? Math.round((this.courseDone() / total) * 100) : 0;
  }
  protected moduleDone(m: CourseModule): number {
    return m.steps.filter((s) => s.done).length;
  }

  // ── Revisit completed steps ────────────────────────────────────────────────
  protected isReviewing(stepId: number): boolean {
    return this.reviewing().includes(stepId);
  }
  protected toggleReview(stepId: number): void {
    this.reviewing.update((ids) => (ids.includes(stepId) ? ids.filter((x) => x !== stepId) : [...ids, stepId]));
  }
  /** Show the step's body when it's the active step, or a completed step
   *  the user has re-opened to review. */
  protected showContent(s: CourseStep): boolean {
    return (s.available && !s.done) || (s.done && this.isReviewing(s.id));
  }

  // ── Quiz helpers ──────────────────────────────────────────────────────────
  private qaKey(stepId: number, qi: number): string {
    return `${stepId}:${qi}`;
  }
  protected selectedAnswer(stepId: number, qi: number): number | undefined {
    return this.quizAnswers()[this.qaKey(stepId, qi)];
  }
  protected isChecked(stepId: number): boolean {
    return this.checkedSteps().includes(stepId);
  }
  protected selectQuizOption(stepId: number, qi: number, oi: number): void {
    if (this.isChecked(stepId)) return;
    this.quizAnswers.update((m) => ({ ...m, [this.qaKey(stepId, qi)]: oi }));
  }
  protected quizComplete(s: CourseStep): boolean {
    return this.quizFor(s).every((_, qi) => this.selectedAnswer(s.id, qi) !== undefined);
  }
  private quizCorrectCount(s: CourseStep): number {
    return this.quizFor(s).reduce((n, q, qi) => (this.selectedAnswer(s.id, qi) === q.correct ? n + 1 : n), 0);
  }
  protected quizScoreLabel(s: CourseStep): string {
    const total = this.quizFor(s).length;
    const correct = this.quizCorrectCount(s);
    return this.tr(`Правильно ${correct} з ${total}. Спробуй ще раз, щоб пройти.`,
      `${correct} of ${total} correct. Try again to pass.`);
  }
  protected retryQuiz(s: CourseStep): void {
    this.checkedSteps.update((ids) => ids.filter((id) => id !== s.id));
    this.quizAnswers.update((m) => {
      const next = { ...m };
      this.quizFor(s).forEach((_, qi) => delete next[this.qaKey(s.id, qi)]);
      return next;
    });
  }
  protected async checkQuiz(s: CourseStep): Promise<void> {
    if (!this.quizComplete(s)) return;
    const allCorrect = this.quizCorrectCount(s) === this.quizFor(s).length;
    this.checkedSteps.update((ids) => (ids.includes(s.id) ? ids : [...ids, s.id]));
    if (allCorrect) await this.finishStep(s);
  }

  // ── Data ────────────────────────────────────────────────────────────────
  private async loadList(): Promise<void> {
    this.loading.set(true);
    this.detail.set(null);
    try {
      this.list.set(await this.api.listCourses());
    } catch {
      this.error.set(this.tr('Не вдалося завантажити курси.', 'Failed to load courses.'));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadDetail(key: string): Promise<void> {
    this.loading.set(true);
    try {
      this.detail.set(await this.api.courseDetail(key));
    } catch {
      this.error.set(this.tr('Курс не знайдено.', 'Course not found.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected async finishStep(s: CourseStep): Promise<void> {
    const d = this.detail();
    if (!d || this.busy()) return;
    this.busy.set(s.id);
    try {
      await this.api.completeCourseStep(s.id);
      await this.loadDetail(d.key);
    } catch {
      this.error.set(this.tr('Не вдалося зберегти прогрес.', 'Failed to save progress.'));
    } finally {
      this.busy.set(null);
    }
  }

  protected async startPractice(s: CourseStep): Promise<void> {
    if (this.busy()) return;
    this.busy.set(s.id);
    try {
      const { sessionId } = await this.api.startCoursePractice(s.id);
      void this.router.navigate(['/session', sessionId]);
    } catch (e: unknown) {
      const msg = (e as { error?: { message?: string } })?.error?.message;
      this.error.set(msg ?? this.tr('Не вдалося почати практику.', 'Failed to start practice.'));
      this.busy.set(null);
    }
  }
}
