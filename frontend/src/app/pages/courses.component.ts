import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import { ApiService, CourseDetail, CourseListItem, CourseStep } from '../api.service';
import { I18nService } from '../i18n.service';
import { IconComponent } from '../icon.component';

/**
 * Skill-path courses. Two views in one component (like /cohorts):
 *  - `/courses`        → catalog of published tracks with progress
 *  - `/courses/:key`   → the track stepper (lessons render markdown; practice
 *                        steps launch a real session; checkpoints flip to ✓
 *                        once the session's feedback meets the criterion)
 * Authed route, so the global app-header provides the chrome.
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
        <!-- ── Track stepper ── -->
        <a routerLink="/courses" class="back">← {{ tr('Усі курси', 'All courses') }}</a>
        <header class="track-head">
          <h1>{{ i18n.isEn ? d.titleEn : d.titleUk }}</h1>
          <p class="muted">{{ i18n.isEn ? d.descEn : d.descUk }}</p>
          @if (d.completed) {
            <span class="done-pill"><app-icon name="shield-check" /> {{ tr('Трек пройдено', 'Track complete') }}</span>
          }
        </header>

        <ol class="steps">
          @for (s of d.steps; track s.id) {
            <li class="step" [class.done]="s.done" [class.locked]="!s.available && !s.done">
              <div class="step-rail">
                <span class="step-dot">
                  @if (s.done) { <app-icon name="shield-check" /> }
                  @else { {{ s.order + 1 }} }
                </span>
              </div>
              <div class="step-body">
                <div class="step-top">
                  <span class="step-kind">{{ s.kind === 'practice' ? tr('Практика', 'Practice') : tr('Урок', 'Lesson') }}</span>
                  <h3>{{ i18n.isEn ? s.titleEn : s.titleUk }}</h3>
                </div>

                @if (s.done) {
                  <p class="step-status ok">✓ {{ tr('Зараховано', 'Completed') }}</p>
                } @else if (!s.available) {
                  <p class="step-status muted">{{ tr('Відкриється після попереднього кроку', 'Unlocks after the previous step') }}</p>
                } @else {
                  <!-- Active step content -->
                  @if (bodyOf(s)) {
                    <div class="md" [innerHTML]="renderBody(s)"></div>
                  }
                  @if (s.kind === 'lesson') {
                    <button class="primary" [disabled]="busy() === s.id" (click)="finishLesson(s)">
                      {{ busy() === s.id ? '…' : tr('Зрозуміло, далі', 'Got it, next') }}
                    </button>
                  } @else {
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
              </div>
            </li>
          }
        </ol>
      } @else {
        <!-- ── Catalog ── -->
        <a routerLink="/dashboard" class="back">← {{ tr('На головну', 'Home') }}</a>
        <header class="cat-head">
          <h1>{{ tr('Курси', 'Courses') }}</h1>
          <p class="muted">{{ tr('Скіл-паси: коротка теорія → практика з AI-пацієнтом → фідбек.', 'Skill paths: short theory → practice with an AI patient → feedback.') }}</p>
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
                <span class="bar-label">{{ c.doneSteps }} / {{ c.totalSteps }} {{ tr('кроків', 'steps') }}</span>
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

    /* Stepper */
    .steps { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; }
    .step { display: grid; grid-template-columns: 40px 1fr; gap: 14px; }
    .step-rail { display: flex; flex-direction: column; align-items: center; }
    .step-dot { width: 32px; height: 32px; flex: 0 0 auto; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 600; color: var(--fg-dim);
      background: var(--user-bg); border: 1px solid var(--border); }
    /* vertical connector */
    .step:not(:last-child) .step-rail::after { content: ''; flex: 1; width: 2px; min-height: 18px;
      background: var(--border); margin: 4px 0; }
    .step.done .step-dot { color: var(--accent); border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 14%, transparent); }
    .step-body { padding-bottom: 26px; min-width: 0; }
    .step-top { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
    .step-kind { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--accent); }
    .step-body h3 { margin: 0; font-size: 17px; font-weight: 600; }
    .step.locked .step-body { opacity: 0.55; }
    .step-status { margin: 0; font-size: 14px; }
    .step-status.ok { color: var(--accent); }

    /* Rendered markdown lesson */
    .md { font-size: 15px; line-height: 1.6; color: var(--fg); margin: 4px 0 14px;
      border-left: 2px solid color-mix(in srgb, var(--accent) 30%, var(--border)); padding-left: 16px; }
    .md h2 { font-size: 16px; font-weight: 600; margin: 14px 0 6px; }
    .md ul { margin: 6px 0; padding-left: 20px; }
    .md li { margin: 3px 0; }
    .md blockquote { margin: 10px 0; padding: 8px 12px; border-left: 2px solid var(--accent);
      background: color-mix(in srgb, var(--accent) 6%, transparent); color: var(--fg-dim); font-style: italic; border-radius: 0 8px 8px 0; }
    .md strong { color: var(--fg); }

    .practice-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 4px 0 6px; }
    .patient { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; color: var(--fg); }
    .patient img { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; }
    .ghost-link { color: var(--fg-dim); text-decoration: none; font-size: 13px; }
    .ghost-link:hover { color: var(--accent); }
    .hint { margin: 4px 0 0; font-size: 12.5px; color: var(--fg-dim); }

    button.primary { align-self: flex-start; }
  `],
})
export class CoursesComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private sanitizer = inject(DomSanitizer);
  readonly i18n = inject(I18nService);

  loading = signal(true);
  error = signal<string | null>(null);
  list = signal<CourseListItem[]>([]);
  detail = signal<CourseDetail | null>(null);
  busy = signal<number | null>(null);

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

  protected bodyOf(s: CourseStep): string | null {
    return (this.i18n.isEn ? s.bodyEn : s.bodyUk) ?? s.bodyUk ?? null;
  }

  protected renderBody(s: CourseStep): SafeHtml {
    const md = this.bodyOf(s) ?? '';
    const html = marked.parse(md, { async: false }) as string;
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

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

  protected async finishLesson(s: CourseStep): Promise<void> {
    const d = this.detail();
    if (!d || this.busy()) return;
    this.busy.set(s.id);
    try {
      await this.api.completeCourseLesson(s.id);
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
