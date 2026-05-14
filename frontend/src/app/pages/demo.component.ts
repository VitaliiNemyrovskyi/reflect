import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Public landing demo — shows a real Opus reviewer output on a
 * sample session so prospective users see the product's actual value
 * before being asked to register. No auth required.
 *
 * Content is a curated excerpt from a real test session with
 * "Olesya" (composite depression case with passive suicidal
 * ideation) — chosen because the supervisor's catch on the missed
 * risk screening is the most clinically striking demonstration of
 * what the AI does well.
 */
@Component({
  selector: 'app-demo',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="demo-page">
      <!-- Hero -->
      <header class="hero">
        <p class="kicker">REFLECT — ДЕМОНСТРАЦІЯ</p>
        <h1>Як AI-супервізор розбирає твою сесію</h1>
        <p class="subtitle">
          Реальний приклад фідбеку від Opus-супервізора на сесію з
          синтетичною пацієнткою «Олеся» — композит депресивного епізоду
          з пасивною суїцидальною ідеацією. Студентка-терапевтка
          пройшла кілька важливих скринінгів, але <strong>проґавила
          ключове питання про ризик</strong>. Подивись, що бачить
          супервізор.
        </p>
      </header>

      <!-- Split: transcript | feedback -->
      <div class="split">
        <section class="transcript-pane">
          <h2 class="pane-title">Сесія (фрагмент)</h2>

          <div class="bubble therapist">
            <span class="line-ref">L3</span>
            <strong>Терапевтка:</strong>
            <p>Розкажіть детальніше — що саме відбулось 4 місяці тому?</p>
          </div>

          <div class="bubble client">
            <span class="line-ref">L4</span>
            <strong>Олеся:</strong>
            <p>
              Ну, Іван пішов. Точніше — поїхав до Польщі, на стажування,
              а потім вирішив лишитись. Ми були разом три роки. Він
              сказав, що йому потрібен простір. Я не сперечалась…
              ну, як не сперечалась — я розуміла, що він вже вирішив.
              Тож якого сенсу тримати.
            </p>
          </div>

          <div class="bubble therapist">
            <span class="line-ref">L5</span>
            <strong>Терапевтка:</strong>
            <p>Як зараз ваш сон? Висипаєтесь?</p>
          </div>

          <div class="bubble client">
            <span class="line-ref">L6</span>
            <strong>Олеся:</strong>
            <p>
              Сон… ну, лягаю пізно. Годині в першій-другій. Дивлюсь
              щось, прокручую телефон, і так і їду. А вранці будильник
              на восьмій, встаю десятій-одинадцятій.
            </p>
          </div>

          <div class="bubble therapist">
            <span class="line-ref">L13</span>
            <strong>Терапевтка:</strong>
            <p>
              Я бачу, ви дуже структуровано описуєте. Це класична
              депресія, мабуть, з рисами руминації. Спробуйте дихальні
              вправи перед сном — 4-7-8 техніка.
            </p>
          </div>

          <div class="bubble client">
            <span class="line-ref">L14</span>
            <strong>Олеся:</strong>
            <p>
              …Так, я знаю цю техніку. Ну, якщо чесно — я не думаю,
              що дихання тут допоможе. <em>Мені нічого не болить,
              нічого не тривожить. Просто нічого немає.</em>
            </p>
          </div>

          <p class="note">
            Терапевтка завершила сесію, <strong>не запитавши прямо
            про суїцидальні думки</strong>. За профілем у Олесі —
            систематичні пасивні думки «а якщо я просто не прокинусь».
            Якби запитали — отримали б правду.
          </p>
        </section>

        <section class="feedback-pane">
          <h2 class="pane-title">Фідбек Opus-супервізора</h2>

          <!-- Most striking catch first -->
          <article class="catch critical">
            <div class="catch-head">
              <span class="catch-icon" aria-hidden="true">⚠</span>
              <span class="catch-label">Найважливіше: пропущено</span>
            </div>
            <h3>Скринінг суїцидального ризику</h3>
            <p>
              Це <strong>головна проблема сесії</strong>. За профілем
              Олеся має систематичні пасивні думки «а якщо я просто не
              прокинусь». Вона б відповіла правду, якби запитали прямо.
              Не запитали — і ця інформація залишиться поза терапією
              щонайменше до наступної сесії, а можливо й довше.
            </p>
            <p>
              На <span class="line-tag">[L14]</span> клієнтка дає прямий
              сигнал, який мав би загорітися червоним:
              «<strong>Мені нічого не болить, нічого не тривожить.
              Просто нічого немає.</strong>» Це не опис настрою — це
              опис стану, у якому пасивна суїцидальна ідеація типово
              й існує.
            </p>
            <div class="rewrite">
              <p class="rewrite-label">Що мало б прозвучати:</p>
              <blockquote>
                Олесю, я хочу запитати прямо, бо це важливо. Чи бувають
                у вас зараз думки про те, що було б легше не прокинутись,
                не існувати, зникнути? Без планів — просто думки.
              </blockquote>
              <p class="rewrite-hint">
                Це не «травматизує» клієнтку. Навпаки — для людини з
                пасивною ідеацією прямо названа реальність часто є
                першим за місяці моментом, коли її <strong>побачили</strong>.
              </p>
            </div>
          </article>

          <article class="catch">
            <div class="catch-head">
              <span class="catch-icon" aria-hidden="true">🔍</span>
              <span class="catch-label">Помічено + названо</span>
            </div>
            <h3>Інтелектуалізація як головний захист</h3>
            <p>
              На <span class="line-tag">[L11]</span> терапевтка спитала
              «у вас уже є якась гіпотеза, що з вами відбувається?» —
              і Олеся радо віддала клінічну формулу
              («<em>великий депресивний епізод, анедонія, руминація</em>»).
              За профілем Олеся <strong>інтелектуалізує як головний
              захист</strong>. Це запитання запросило її саме в цей
              захист.
            </p>
          </article>

          <article class="catch">
            <div class="catch-head">
              <span class="catch-icon" aria-hidden="true">📐</span>
              <span class="catch-label">Виміри протоколу</span>
            </div>
            <h3>8 канонічних дімензій інтейку</h3>
            <p>Reviewer оцінює сесію за 8 вимірами:</p>
            <ul class="dims">
              <li>Терапевтичний альянс <span class="dim-tag warn">частково</span></li>
              <li>Збір презентуючої проблеми <span class="dim-tag warn">поверхневий</span></li>
              <li>Робота з self-diagnosis <span class="dim-tag bad">відсутня</span></li>
              <li>Скринінг ризиків <span class="dim-tag bad">КРИТИЧНО</span></li>
              <li>Робоча гіпотеза <span class="dim-tag bad">не сформульована</span></li>
              <li>Закриття сесії <span class="dim-tag bad">відсутнє</span></li>
            </ul>
          </article>
        </section>
      </div>

      <!-- CTA strip -->
      <section class="cta-band">
        <div class="cta-inner">
          <div class="cta-copy">
            <h2>Запусти власну сесію</h2>
            <p>
              14 днів безкоштовно. 3 сесії з тренувальним фідбеком.
              Без картки.
            </p>
          </div>
          <div class="cta-actions">
            <a routerLink="/register" class="btn btn-primary">
              Спробувати безкоштовно
            </a>
            <a routerLink="/pricing" class="btn btn-secondary">
              Тарифи
            </a>
          </div>
        </div>
      </section>

      <footer class="demo-footer">
        <p>
          Олеся — <strong>фіктивний композит</strong>, синтезований з
          публічних клінічних описів. Не реальна особа.
        </p>
        <p>
          <a routerLink="/safety">Безпека та кризові ресурси →</a>
        </p>
      </footer>
    </div>
  `,
  styles: [`
    .demo-page {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px 16px 48px;
      color: #ecebf3;
    }

    /* Hero */
    .hero {
      max-width: 760px;
      margin: 24px auto 40px;
      text-align: center;
    }
    .kicker {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      color: #d8c9ff;
      margin: 0 0 14px;
    }
    .hero h1 {
      font-size: 32px;
      font-weight: 600;
      letter-spacing: -0.01em;
      margin: 0 0 18px;
      line-height: 1.2;
    }
    .hero .subtitle {
      font-size: 16px;
      line-height: 1.6;
      color: #a9a3bd;
      margin: 0;
    }
    .hero strong { color: #ecebf3; }

    /* Split: transcript | feedback */
    .split {
      display: grid;
      grid-template-columns: 1fr 1.1fr;
      gap: 24px;
      margin-bottom: 48px;
    }
    @media (max-width: 880px) {
      .split { grid-template-columns: 1fr; gap: 16px; }
    }

    .pane-title {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #8b859e;
      margin: 0 0 16px;
    }

    /* Transcript bubbles */
    .transcript-pane {
      background: #15141b;
      border: 1px solid #2a2735;
      border-radius: 12px;
      padding: 20px;
    }
    .bubble {
      position: relative;
      padding: 12px 14px 12px 50px;
      margin-bottom: 12px;
      border-radius: 10px;
      font-size: 14px;
      line-height: 1.55;
    }
    .bubble.therapist {
      background: rgba(216, 201, 255, 0.06);
      border: 1px solid rgba(216, 201, 255, 0.15);
    }
    .bubble.client {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid #2a2735;
    }
    .line-ref {
      position: absolute;
      left: 12px;
      top: 12px;
      font-size: 10px;
      font-weight: 600;
      font-family: 'SF Mono', Menlo, monospace;
      color: #d8c9ff;
      padding: 2px 5px;
      border-radius: 4px;
      background: rgba(216, 201, 255, 0.1);
    }
    .bubble strong { display: block; font-size: 12px; color: #8b859e; margin-bottom: 4px; }
    .bubble p { margin: 0; color: #c8c3da; }
    .bubble em { font-style: italic; color: #ecebf3; }

    .note {
      margin: 20px 0 0;
      padding: 12px 16px;
      background: rgba(240, 200, 100, 0.06);
      border-left: 3px solid #ddc880;
      border-radius: 4px;
      font-size: 13px;
      line-height: 1.6;
      color: #c8c3da;
    }
    .note strong { color: #ecebf3; }

    /* Feedback catches */
    .feedback-pane { display: flex; flex-direction: column; gap: 16px; }

    .catch {
      background: #15141b;
      border: 1px solid #2a2735;
      border-radius: 12px;
      padding: 20px;
    }
    .catch.critical {
      border-color: rgba(220, 100, 100, 0.4);
      box-shadow: 0 0 0 1px rgba(220, 100, 100, 0.2) inset;
    }
    .catch-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .catch-icon { font-size: 18px; }
    .catch.critical .catch-icon { color: #dd8888; }
    .catch-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #8b859e;
    }
    .catch.critical .catch-label { color: #dd8888; }

    .catch h3 {
      font-size: 17px;
      font-weight: 600;
      margin: 0 0 12px;
    }
    .catch p {
      font-size: 14px;
      line-height: 1.6;
      color: #c8c3da;
      margin: 0 0 12px;
    }
    .catch p:last-child { margin-bottom: 0; }
    .catch strong { color: #ecebf3; }
    .catch em { font-style: italic; color: #d8c9ff; }
    .line-tag {
      font-family: 'SF Mono', Menlo, monospace;
      font-size: 12px;
      color: #d8c9ff;
      background: rgba(216, 201, 255, 0.1);
      padding: 1px 6px;
      border-radius: 4px;
    }

    .rewrite {
      margin-top: 12px;
      padding: 14px;
      background: rgba(120, 200, 130, 0.06);
      border-left: 3px solid #8edd8e;
      border-radius: 4px;
    }
    .rewrite-label {
      font-size: 11px !important;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #8edd8e !important;
      margin: 0 0 8px !important;
    }
    .rewrite blockquote {
      margin: 0 0 8px;
      padding: 0;
      font-size: 14px;
      line-height: 1.55;
      font-style: italic;
      color: #ecebf3;
      border: none;
    }
    .rewrite-hint {
      font-size: 12px !important;
      color: #8b859e !important;
      margin: 0 !important;
    }
    .rewrite-hint strong { color: #c8c3da; }

    .dims {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .dims li {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 6px;
      font-size: 14px;
      color: #c8c3da;
    }
    .dim-tag {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .dim-tag.warn { background: rgba(220, 180, 80, 0.15); color: #ddc880; }
    .dim-tag.bad { background: rgba(220, 100, 100, 0.15); color: #dd8888; }

    /* CTA band */
    .cta-band {
      background: linear-gradient(135deg,
        rgba(216, 201, 255, 0.12) 0%,
        rgba(216, 201, 255, 0.04) 100%);
      border: 1px solid rgba(216, 201, 255, 0.2);
      border-radius: 16px;
      padding: 32px;
      margin-bottom: 24px;
    }
    .cta-inner {
      display: flex;
      gap: 24px;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
    }
    .cta-copy { flex: 1; min-width: 240px; }
    .cta-copy h2 {
      font-size: 24px;
      font-weight: 600;
      margin: 0 0 8px;
    }
    .cta-copy p {
      font-size: 15px;
      color: #a9a3bd;
      margin: 0;
    }
    .cta-actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-block;
      padding: 14px 22px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      text-decoration: none;
      min-height: 48px;
      box-sizing: border-box;
      transition: background 0.15s, transform 0.1s;
    }
    .btn:active { transform: scale(0.98); }
    .btn-primary { background: #d8c9ff; color: #0b0b0d; }
    .btn-primary:hover { background: #ebdcff; }
    .btn-secondary {
      background: transparent;
      color: #ecebf3;
      border: 1px solid #3a3745;
    }
    .btn-secondary:hover { background: #2a2735; }

    /* Footer */
    .demo-footer {
      text-align: center;
      color: #6a6580;
      font-size: 13px;
      line-height: 1.7;
    }
    .demo-footer p { margin: 6px 0; }
    .demo-footer strong { color: #8b859e; }
    .demo-footer a { color: #d8c9ff; text-decoration: none; }
    .demo-footer a:hover { text-decoration: underline; }

    @media (max-width: 480px) {
      .hero h1 { font-size: 24px; }
      .hero .subtitle { font-size: 14px; }
      .transcript-pane, .catch { padding: 16px; }
      .cta-band { padding: 24px 18px; }
      .cta-actions { width: 100%; }
      .cta-actions .btn { flex: 1; text-align: center; }
    }
  `],
})
export class DemoComponent {}
