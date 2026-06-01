import { Component, Input, inject } from '@angular/core';
import { I18nService } from './i18n.service';

/**
 * Library of small, code-drawn SVG infographics for course lessons. Themed via
 * CSS vars (accent/fg/border), crisp at any size, and bilingual (labels resolve
 * through I18nService). Referenced from lesson content by a `figure` key.
 */
@Component({
  selector: 'app-course-figure',
  standalone: true,
  template: `
    <figure class="fig-wrap">
      @switch (name) {
        @case ('alliance-triangle') {
          <svg viewBox="0 0 320 210" class="fig" role="img" [attr.aria-label]="tr('Робочий альянс: звʼязок, цілі, завдання', 'Working alliance: bond, goals, tasks')">
            <polygon points="160,28 38,184 282,184" class="stroke-accent" fill="none" stroke-width="2" />
            <text x="160" y="120" text-anchor="middle" class="t-mut" font-size="12">{{ tr('Робочий', 'Working') }}</text>
            <text x="160" y="136" text-anchor="middle" class="t-mut" font-size="12">{{ tr('альянс', 'alliance') }}</text>
            <circle cx="160" cy="28" r="6" class="fill-accent" />
            <circle cx="38" cy="184" r="6" class="fill-accent" />
            <circle cx="282" cy="184" r="6" class="fill-accent" />
            <text x="160" y="16" text-anchor="middle" class="t-fg" font-size="13" font-weight="600">{{ tr('Звʼязок', 'Bond') }}</text>
            <text x="38" y="202" text-anchor="middle" class="t-fg" font-size="13" font-weight="600">{{ tr('Цілі', 'Goals') }}</text>
            <text x="282" y="202" text-anchor="middle" class="t-fg" font-size="13" font-weight="600">{{ tr('Завдання', 'Tasks') }}</text>
          </svg>
        }
        @case ('oars') {
          <svg viewBox="0 0 520 110" class="fig" role="img" [attr.aria-label]="'OARS'">
            @for (c of oars; track c.k; let i = $index) {
              <g [attr.transform]="'translate(' + (i * 130 + 6) + ',0)'">
                <rect x="0" y="6" width="118" height="98" rx="12" class="stroke-border fill-soft" stroke-width="1" />
                <text x="59" y="46" text-anchor="middle" class="t-accent" font-size="30" font-weight="700">{{ c.k }}</text>
                <text x="59" y="76" text-anchor="middle" class="t-fg" font-size="11.5">{{ tr(c.uk, c.en) }}</text>
              </g>
            }
          </svg>
        }
        @case ('biopsychosocial') {
          <svg viewBox="0 0 340 240" class="fig" role="img" [attr.aria-label]="tr('Біопсихосоціальна модель', 'Biopsychosocial model')">
            <circle cx="130" cy="100" r="78" class="stroke-accent" fill="none" stroke-width="2" opacity="0.85" />
            <circle cx="210" cy="100" r="78" class="stroke-accent" fill="none" stroke-width="2" opacity="0.85" />
            <circle cx="170" cy="160" r="78" class="stroke-accent" fill="none" stroke-width="2" opacity="0.85" />
            <text x="96" y="86" text-anchor="middle" class="t-fg" font-size="12.5" font-weight="600">{{ tr('Біо', 'Bio') }}</text>
            <text x="244" y="86" text-anchor="middle" class="t-fg" font-size="12.5" font-weight="600">{{ tr('Психо', 'Psycho') }}</text>
            <text x="170" y="200" text-anchor="middle" class="t-fg" font-size="12.5" font-weight="600">{{ tr('Соціо', 'Social') }}</text>
          </svg>
        }
        @case ('risk-ladder') {
          <svg viewBox="0 0 360 190" class="fig" role="img" [attr.aria-label]="tr('Уточнення ризику: думки, план, засоби, намір', 'Risk clarifying: thoughts, plan, means, intent')">
            @for (s of riskSteps; track s.uk; let i = $index) {
              <g [attr.transform]="'translate(' + (i * 84 + 6) + ',' + (140 - i * 34) + ')'">
                <rect x="0" y="0" width="78" height="44" rx="8" class="stroke-border fill-soft" stroke-width="1" />
                <text x="39" y="27" text-anchor="middle" class="t-fg" font-size="12" font-weight="600">{{ tr(s.uk, s.en) }}</text>
              </g>
            }
            <text x="350" y="178" text-anchor="end" class="t-mut" font-size="11">{{ tr('гострота зростає →', 'acuity rises →') }}</text>
          </svg>
        }
        @case ('anxiety-loop') {
          <svg viewBox="0 0 320 230" class="fig" role="img" [attr.aria-label]="tr('Цикл тривоги й уникання', 'The anxiety–avoidance loop')">
            <defs>
              <marker id="fig-arrow" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" class="fill-accent" />
              </marker>
            </defs>
            <circle cx="160" cy="115" r="78" fill="none" class="stroke-accent" stroke-width="1.6"
              stroke-dasharray="44 24" marker-end="url(#fig-arrow)" opacity="0.7" />
            <text x="160" y="30" text-anchor="middle" class="t-fg" font-size="12" font-weight="600">{{ tr('Тригер', 'Trigger') }}</text>
            <text x="250" y="119" text-anchor="middle" class="t-fg" font-size="12" font-weight="600">{{ tr('Тривога ↑', 'Anxiety ↑') }}</text>
            <text x="160" y="208" text-anchor="middle" class="t-fg" font-size="12" font-weight="600">{{ tr('Уникання', 'Avoidance') }}</text>
            <text x="70" y="119" text-anchor="middle" class="t-mut" font-size="12">{{ tr('Полегшення', 'Relief') }}</text>
          </svg>
        }
        @case ('grounding') {
          <svg viewBox="0 0 340 200" class="fig" role="img" [attr.aria-label]="tr('Заземлення 5-4-3-2-1', 'Grounding 5-4-3-2-1')">
            @for (g of grounding; track g.uk; let i = $index) {
              <g [attr.transform]="'translate(0,' + (i * 38 + 4) + ')'">
                <circle cx="20" cy="16" r="15" class="fill-accent-soft stroke-accent" stroke-width="1.5" />
                <text x="20" y="21" text-anchor="middle" class="t-accent" font-size="15" font-weight="700">{{ g.n }}</text>
                <text x="48" y="21" class="t-fg" font-size="13">{{ tr(g.uk, g.en) }}</text>
              </g>
            }
          </svg>
        }
        @case ('suds') {
          <svg viewBox="0 0 420 96" class="fig" role="img" [attr.aria-label]="tr('Шкала дискомфорту SUDS 0–100', 'SUDS distress scale 0–100')">
            <defs>
              <linearGradient id="fig-suds" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stop-color="#6fae8f" />
                <stop offset="0.55" stop-color="#e0a458" />
                <stop offset="1" stop-color="#d06b6b" />
              </linearGradient>
            </defs>
            <rect x="20" y="34" width="380" height="16" rx="8" fill="url(#fig-suds)" />
            @for (t of [0,30,60,100]; track t) {
              <g [attr.transform]="'translate(' + (20 + t / 100 * 380) + ',0)'">
                <line x1="0" y1="30" x2="0" y2="54" class="stroke-fg" stroke-width="1.5" />
                <text x="0" y="24" text-anchor="middle" class="t-mut" font-size="11">{{ t }}</text>
              </g>
            }
            <text x="20" y="76" class="t-mut" font-size="11">{{ tr('спокій', 'calm') }}</text>
            <text x="400" y="76" text-anchor="end" class="t-mut" font-size="11">{{ tr('паніка', 'panic') }}</text>
          </svg>
        }
        @case ('rupture-repair') {
          <svg viewBox="0 0 440 96" class="fig" role="img" [attr.aria-label]="tr('Розрив альянсу та відновлення', 'Alliance rupture and repair')">
            <defs>
              <marker id="fig-arrow-rr" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" class="fill-accent" />
              </marker>
            </defs>
            <rect x="6" y="30" width="120" height="40" rx="10" class="stroke-border fill-soft" stroke-width="1.5" />
            <text x="66" y="55" text-anchor="middle" class="t-mut" font-size="13" font-weight="600">{{ tr('Розрив', 'Rupture') }}</text>
            <line x1="130" y1="50" x2="154" y2="50" class="stroke-accent" stroke-width="1.6" marker-end="url(#fig-arrow-rr)" />
            <rect x="160" y="30" width="120" height="40" rx="10" class="stroke-accent fill-soft" stroke-width="2" />
            <text x="220" y="55" text-anchor="middle" class="t-accent" font-size="13" font-weight="600">{{ tr('Відновлення', 'Repair') }}</text>
            <line x1="284" y1="50" x2="308" y2="50" class="stroke-accent" stroke-width="1.6" marker-end="url(#fig-arrow-rr)" />
            <rect x="314" y="30" width="120" height="40" rx="10" fill="none" stroke="#6fae8f" stroke-width="2" />
            <text x="374" y="49" text-anchor="middle" class="t-fg" font-size="12" font-weight="600">{{ tr('Міцніший', 'Stronger') }}</text>
            <text x="374" y="63" text-anchor="middle" class="t-fg" font-size="12" font-weight="600">{{ tr('альянс', 'alliance') }}</text>
          </svg>
        }
        @case ('session-arc') {
          <svg viewBox="0 0 440 92" class="fig" role="img" [attr.aria-label]="tr('Каркас першої сесії в часі', 'Time arc of a first session')">
            <text x="20" y="18" class="t-mut" font-size="11">0</text>
            <text x="420" y="18" text-anchor="end" class="t-mut" font-size="11">{{ tr('~50 хв', '~50 min') }}</text>
            <rect x="20" y="26" width="44" height="22" rx="5" class="stroke-border fill-soft" stroke-width="1.5" />
            <rect x="64" y="26" width="232" height="22" rx="5" class="stroke-accent fill-accent-soft" stroke-width="1.5" />
            <rect x="296" y="26" width="44" height="22" rx="5" fill="color-mix(in srgb, #e0a458 22%, transparent)" stroke="#e0a458" stroke-width="1.5" />
            <rect x="340" y="26" width="80" height="22" rx="5" class="stroke-border fill-soft" stroke-width="1.5" />
            <text x="42" y="64" text-anchor="middle" class="t-fg" font-size="10.5">{{ tr('Контакт', 'Contact') }}</text>
            <text x="180" y="64" text-anchor="middle" class="t-accent" font-size="10.5" font-weight="600">{{ tr('Дослідження — слухаєш', 'Exploration — listen') }}</text>
            <text x="318" y="64" text-anchor="middle" class="t-fg" font-size="10.5">{{ tr('Ризик', 'Risk') }}</text>
            <text x="380" y="64" text-anchor="middle" class="t-fg" font-size="10.5">{{ tr('Рамка / кінець', 'Frame / close') }}</text>
          </svg>
        }
        @case ('safety-plan') {
          <svg viewBox="0 0 380 250" class="fig" role="img" [attr.aria-label]="tr('План безпеки: 6 кроків', 'Safety plan: 6 steps')">
            @for (s of safetyPlan; track s.uk; let i = $index) {
              <g [attr.transform]="'translate(' + (i * 10 + 4) + ',' + (i * 38 + 6) + ')'">
                <circle cx="20" cy="16" r="15" class="fill-accent-soft stroke-accent" stroke-width="1.5" />
                <text x="20" y="21" text-anchor="middle" class="t-accent" font-size="14" font-weight="700">{{ i + 1 }}</text>
                <text x="46" y="21" class="t-fg" font-size="13">{{ tr(s.uk, s.en) }}</text>
              </g>
            }
            <text x="374" y="14" text-anchor="end" class="t-mut" font-size="11">{{ tr('сам → інші', 'self → others') }}</text>
          </svg>
        }
        @case ('depression-cycle') {
          <svg viewBox="0 0 320 230" class="fig" role="img" [attr.aria-label]="tr('Низхідна спіраль депресії', 'The downward spiral of depression')">
            <defs>
              <marker id="fig-arrow-dep" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" class="fill-accent" />
              </marker>
            </defs>
            <circle cx="160" cy="115" r="78" fill="none" class="stroke-accent" stroke-width="1.6"
              stroke-dasharray="44 24" marker-end="url(#fig-arrow-dep)" opacity="0.7" />
            <text x="160" y="30" text-anchor="middle" class="t-fg" font-size="12" font-weight="600">{{ tr('Низький настрій', 'Low mood') }}</text>
            <text x="250" y="119" text-anchor="middle" class="t-fg" font-size="12" font-weight="600">{{ tr('Менше дій', 'Less activity') }}</text>
            <text x="160" y="208" text-anchor="middle" class="t-fg" font-size="12" font-weight="600">{{ tr('Менше радості', 'Fewer rewards') }}</text>
            <text x="70" y="119" text-anchor="middle" class="t-mut" font-size="12">{{ tr('Самокритика', 'Self-criticism') }}</text>
          </svg>
        }
        @case ('cognitive-triad') {
          <svg viewBox="0 0 320 210" class="fig" role="img" [attr.aria-label]="tr('Когнітивна тріада: себе, світ, майбутнє', 'Cognitive triad: self, world, future')">
            <polygon points="160,28 38,184 282,184" class="stroke-accent" fill="none" stroke-width="2" />
            <text x="160" y="120" text-anchor="middle" class="t-mut" font-size="12">{{ tr('Когнітивна', 'Cognitive') }}</text>
            <text x="160" y="136" text-anchor="middle" class="t-mut" font-size="12">{{ tr('тріада', 'triad') }}</text>
            <circle cx="160" cy="28" r="6" class="fill-accent" />
            <circle cx="38" cy="184" r="6" class="fill-accent" />
            <circle cx="282" cy="184" r="6" class="fill-accent" />
            <text x="160" y="16" text-anchor="middle" class="t-fg" font-size="13" font-weight="600">{{ tr('Себе', 'Self') }}</text>
            <text x="38" y="202" text-anchor="middle" class="t-fg" font-size="13" font-weight="600">{{ tr('Світ', 'World') }}</text>
            <text x="282" y="202" text-anchor="middle" class="t-fg" font-size="13" font-weight="600">{{ tr('Майбутнє', 'Future') }}</text>
          </svg>
        }
        @case ('belief-levels') {
          <svg viewBox="0 0 340 200" class="fig" role="img" [attr.aria-label]="tr('Рівні думок: від автоматичних до глибинних переконань', 'Levels of cognition: from automatic thoughts to core beliefs')">
            <defs>
              <marker id="fig-arrow-bl" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" class="fill-accent" />
              </marker>
            </defs>
            <rect x="74" y="12" width="252" height="44" rx="8" class="stroke-border fill-soft" stroke-width="1.5" />
            <text x="200" y="31" text-anchor="middle" class="t-fg" font-size="12.5" font-weight="600">{{ tr('Автоматичні думки', 'Automatic thoughts') }}</text>
            <text x="200" y="47" text-anchor="middle" class="t-mut" font-size="11">{{ tr('«я провалюся»', '"I\\'ll fail"') }}</text>
            <rect x="74" y="72" width="252" height="44" rx="8" class="stroke-border fill-soft" stroke-width="1.5" />
            <text x="200" y="91" text-anchor="middle" class="t-fg" font-size="12.5" font-weight="600">{{ tr('Правила й припущення', 'Rules & assumptions') }}</text>
            <text x="200" y="107" text-anchor="middle" class="t-mut" font-size="11">{{ tr('«не ідеально — отже ніяк»', '"not perfect = nothing"') }}</text>
            <rect x="74" y="132" width="252" height="50" rx="8" class="stroke-accent fill-accent-soft" stroke-width="2" />
            <text x="200" y="153" text-anchor="middle" class="t-fg" font-size="12.5" font-weight="700">{{ tr('Глибинне переконання', 'Core belief') }}</text>
            <text x="200" y="170" text-anchor="middle" class="t-mut" font-size="11">{{ tr('«я нікчемний»', '"I\\'m worthless"') }}</text>
            <line x1="34" y1="20" x2="34" y2="176" class="stroke-accent" stroke-width="1.8" marker-end="url(#fig-arrow-bl)" opacity="0.8" />
          </svg>
        }
        @case ('three-circles') {
          <svg viewBox="0 0 320 210" class="fig" role="img" [attr.aria-label]="tr('Три системи регуляції емоцій', 'Three emotion-regulation systems')">
            <circle cx="95" cy="72" r="52" fill="none" stroke="#d06b6b" stroke-width="2" opacity="0.85" />
            <text x="95" y="68" text-anchor="middle" class="t-fg" font-size="12" font-weight="600">{{ tr('Загроза', 'Threat') }}</text>
            <text x="95" y="84" text-anchor="middle" class="t-mut" font-size="10.5">{{ tr('тривога, сором', 'fear, shame') }}</text>
            <circle cx="225" cy="72" r="52" fill="none" class="stroke-accent" stroke-width="2" opacity="0.85" />
            <text x="225" y="68" text-anchor="middle" class="t-fg" font-size="12" font-weight="600">{{ tr('Драйв', 'Drive') }}</text>
            <text x="225" y="84" text-anchor="middle" class="t-mut" font-size="10.5">{{ tr('гонитва', 'striving') }}</text>
            <circle cx="160" cy="150" r="54" fill="none" stroke="#6fae8f" stroke-width="2.4" />
            <text x="160" y="146" text-anchor="middle" class="t-fg" font-size="12.5" font-weight="700">{{ tr('Заспокоєння', 'Soothing') }}</text>
            <text x="160" y="163" text-anchor="middle" class="t-mut" font-size="10.5">{{ tr('безпека, тепло', 'safety, warmth') }}</text>
          </svg>
        }
      }
      @if (caption) { <figcaption>{{ caption }}</figcaption> }
    </figure>
  `,
  styles: [`
    .fig-wrap { margin: 14px 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .fig { width: 100%; max-width: 520px; height: auto; }
    figcaption { font-size: 12.5px; color: var(--fg-dim); text-align: center; }
    .t-fg { fill: var(--fg); }
    .t-mut { fill: var(--fg-dim); }
    .t-accent { fill: var(--accent); }
    .stroke-accent { stroke: var(--accent); }
    .stroke-border { stroke: var(--border); }
    .stroke-fg { stroke: var(--fg-dim); }
    .fill-accent { fill: var(--accent); }
    .fill-soft { fill: var(--user-bg); }
    .fill-accent-soft { fill: color-mix(in srgb, var(--accent) 16%, transparent); }
    text { font-family: inherit; }
  `],
})
export class CourseFigureComponent {
  private i18n = inject(I18nService);
  @Input({ required: true }) name = '';
  @Input() caption?: string;

  protected oars = [
    { k: 'O', uk: 'Відкриті питання', en: 'Open questions' },
    { k: 'A', uk: 'Підтримки', en: 'Affirmations' },
    { k: 'R', uk: 'Рефлексії', en: 'Reflections' },
    { k: 'S', uk: 'Резюме', en: 'Summaries' },
  ];
  protected riskSteps = [
    { uk: 'Думки', en: 'Thoughts' },
    { uk: 'План', en: 'Plan' },
    { uk: 'Засоби', en: 'Means' },
    { uk: 'Намір', en: 'Intent' },
  ];
  protected grounding = [
    { n: 5, uk: 'речей, які бачиш', en: 'things you see' },
    { n: 4, uk: 'звуки, які чуєш', en: 'things you hear' },
    { n: 3, uk: 'дотики', en: 'things you touch' },
    { n: 2, uk: 'запахи', en: 'things you smell' },
    { n: 1, uk: 'смак', en: 'thing you taste' },
  ];
  protected safetyPlan = [
    { uk: 'Сигнали тривоги', en: 'Warning signs' },
    { uk: 'Самодопомога', en: 'Self-coping' },
    { uk: 'Люди для відволікання', en: 'People — distraction' },
    { uk: 'Близькі для допомоги', en: 'People to ask for help' },
    { uk: 'Фахівці, кризові лінії', en: 'Professionals, crisis lines' },
    { uk: 'Безпека засобів', en: 'Means safety' },
  ];

  protected tr(uk: string, en: string): string {
    return this.i18n.isEn ? en : uk;
  }
}
