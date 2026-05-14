import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Output, signal } from '@angular/core';

/**
 * First-time onboarding modal — shown on the very first visit to the
 * characters list page, persisted via localStorage so it doesn't
 * nag returning users.
 *
 * Three slides:
 *   1. "Це не справжня терапія" — sets expectation that patients are
 *      synthetic, mistakes are safe to make
 *   2. "Як працює" — session flow + Opus supervisor at the end
 *   3. "Безпека" — privacy + crisis-resources link
 *
 * Implementation is intentionally minimal: no router, no animations
 * heavier than a fade. Mobile-first layout (cards stack, full-width
 * CTAs, large tap targets). Dismiss closes the modal AND emits
 * `dismissed` so the host can fade the backdrop.
 */
@Component({
  selector: 'app-welcome-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="welcome-backdrop" (click)="dismiss()"></div>
    <div class="welcome-card" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <!-- Slide progress dots -->
      <div class="dots">
        @for (i of slides; track $index) {
          <span class="dot" [class.active]="$index === step()" [class.past]="$index < step()"></span>
        }
      </div>

      @switch (step()) {
        @case (0) {
          <div class="slide">
            <div class="badge">Reflect</div>
            <h2 id="welcome-title">Це <em>не</em> справжня терапія</h2>
            <p>
              Reflect — AI-симулятор для тренування навичок інтейку.
              Усі пацієнти — синтетичні композити з клінічної літератури.
              Тут можна помилятись без шкоди для будь-кого реального.
            </p>
            <p class="hint">
              Тренувальний майданчик, не клінічна практика. Не використовуй
              для роботи з реальними клієнтами.
            </p>
          </div>
        }
        @case (1) {
          <div class="slide">
            <div class="badge">Як це працює</div>
            <h2>Сесія — фідбек — повтор</h2>
            <ol class="flow">
              <li><strong>Обери пацієнта</strong> з картотеки нижче</li>
              <li><strong>Проведи сесію</strong> 20-30 хвилин — пиши як терапевт, у ролі</li>
              <li><strong>Натисни «Отримати фідбек»</strong> — Opus-супервізор розбере твою сесію за 8 канонічними вимірами</li>
              <li><strong>Поверни через тиждень</strong> — пацієнт памʼятає попередні сесії</li>
            </ol>
          </div>
        }
        @case (2) {
          <div class="slide">
            <div class="badge">Безпека</div>
            <h2>Твоя практика — твої дані</h2>
            <ul class="safety-list">
              <li>Сесії <strong>не передаються</strong> третім особам</li>
              <li>Транскрипти доступні <strong>лише тобі</strong></li>
              <li>В кризі — кнопка «Безпека та кризові ресурси» внизу будь-якої сторінки</li>
            </ul>
            <p class="hint">
              Якщо ти сам зараз у важкому стані — Reflect <em>не</em> заміна
              справжньому терапевту. Розглянь розділ кризових ресурсів першим.
            </p>
          </div>
        }
      }

      <div class="actions">
        @if (step() > 0) {
          <button class="ghost" (click)="prev()">Назад</button>
        }
        @if (step() < slides.length - 1) {
          <button class="primary" (click)="next()">Далі</button>
        } @else {
          <button class="primary" (click)="dismiss()">Зрозуміло</button>
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: block;
      animation: fade-in 0.25s ease;
    }
    @keyframes fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .welcome-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(11, 11, 13, 0.75);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    }

    .welcome-card {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(520px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      overflow-y: auto;
      background: #15141b;
      border: 1px solid #2a2735;
      border-radius: 16px;
      padding: 28px 24px 20px;
      color: #ecebf3;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.4),
                  0 0 0 1px color-mix(in srgb, #d8c9ff 12%, transparent);
    }

    .dots {
      display: flex;
      gap: 6px;
      justify-content: center;
      margin-bottom: 20px;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #2a2735;
      transition: background 0.2s, transform 0.2s;
    }
    .dot.active {
      background: #d8c9ff;
      transform: scale(1.4);
    }
    .dot.past {
      background: #6a6580;
    }

    .slide {
      min-height: 220px;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #d8c9ff;
      background: rgba(216, 201, 255, 0.12);
      border-radius: 12px;
      margin-bottom: 12px;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 22px;
      font-weight: 600;
      line-height: 1.3;
    }
    h2 em {
      color: #d8c9ff;
      font-style: normal;
    }
    p {
      margin: 0 0 12px;
      font-size: 15px;
      line-height: 1.6;
      color: #c8c3da;
    }
    .hint {
      font-size: 13px;
      color: #8b859e;
      padding: 10px 14px;
      background: rgba(216, 201, 255, 0.06);
      border-left: 2px solid #d8c9ff;
      border-radius: 4px;
    }
    .hint em {
      font-style: italic;
      color: #d8c9ff;
    }

    ol.flow, ul.safety-list {
      margin: 0 0 16px;
      padding-left: 20px;
      font-size: 15px;
      line-height: 1.7;
      color: #c8c3da;
    }
    ol.flow li, ul.safety-list li {
      padding-left: 4px;
      margin-bottom: 6px;
    }
    ol.flow strong, ul.safety-list strong {
      color: #ecebf3;
      font-weight: 600;
    }

    .actions {
      display: flex;
      gap: 8px;
      margin-top: 20px;
    }
    .actions button {
      flex: 1;
      min-height: 48px;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      border: none;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
    }
    .actions button:active { transform: scale(0.98); }
    .primary {
      background: #d8c9ff;
      color: #0b0b0d;
    }
    .primary:hover { background: #ebdcff; }
    .ghost {
      background: transparent;
      color: #a9a3bd;
      border: 1px solid #3a3745 !important;
    }
    .ghost:hover {
      background: #2a2735;
      color: #ecebf3;
    }

    /* iPhone SE (320px) — tighten paddings */
    @media (max-width: 380px) {
      .welcome-card {
        padding: 22px 18px 16px;
        border-radius: 12px;
      }
      h2 { font-size: 19px; }
      p, ol.flow, ul.safety-list { font-size: 14px; }
    }
  `],
})
export class WelcomeModalComponent {
  @Output() dismissed = new EventEmitter<void>();

  /** Slide index (0-based). Three slides total. */
  step = signal(0);
  /** Used only for the dots indicator template loop. */
  slides = [0, 1, 2];

  next() {
    this.step.update((s) => Math.min(s + 1, this.slides.length - 1));
  }

  prev() {
    this.step.update((s) => Math.max(0, s - 1));
  }

  dismiss() {
    localStorage.setItem('reflect.onboarded', new Date().toISOString());
    this.dismissed.emit();
  }
}
