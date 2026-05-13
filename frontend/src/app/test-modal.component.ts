import { CommonModule } from '@angular/common';
import { Component, EventEmitter, OnInit, Output, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, PsychTestSummary } from './api.service';

/**
 * Modal for picking a psychological test to administer during a chat
 * session. Loads the catalog once on open, supports text search +
 * domain filter chips. On pick, emits `picked` with the test key and
 * the parent component handles the actual administer call (so loading
 * state lives in the chat component, not here).
 *
 * Standalone — rendered conditionally from chat.component when the
 * therapist clicks the test button in the composer.
 */
@Component({
  selector: 'app-test-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="modal-backdrop" (click)="onBackdropClick($event)">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="test-modal-title">
        <header class="modal-head">
          <h2 id="test-modal-title">📋 Запропонувати тест</h2>
          <button class="ghost icon" type="button" (click)="close.emit()" aria-label="Закрити">×</button>
        </header>

        <div class="modal-controls">
          <input
            type="search"
            class="search-input"
            placeholder="Пошук: депресія, тривога, PHQ, GAD…"
            [(ngModel)]="searchQ"
            (ngModelChange)="onSearchChange()"
            autofocus />
          @if (domains().length > 1) {
            <div class="domain-chips">
              <button
                type="button"
                class="domain-chip"
                [class.active]="activeDomain() === null"
                (click)="setDomain(null)">Усі</button>
              @for (d of domains(); track d) {
                <button
                  type="button"
                  class="domain-chip"
                  [class.active]="activeDomain() === d"
                  (click)="setDomain(d)">{{ domainLabel(d) }}</button>
              }
            </div>
          }
        </div>

        <div class="modal-body">
          @if (loading()) {
            <p class="hint">Завантаження каталогу…</p>
          } @else if (filtered().length === 0) {
            <p class="hint">Нічого не знайдено за запитом «{{ searchQ }}».</p>
          } @else {
            <ul class="test-list">
              @for (t of filtered(); track t.key) {
                <li class="test-card" (click)="pick(t.key)">
                  <div class="test-name-row">
                    <span class="test-name">{{ t.name }}</span>
                    <span class="test-time">{{ t.timeMinutes }} хв · {{ t.itemCount }} п.</span>
                  </div>
                  <div class="test-full">{{ t.fullNameUa }}</div>
                  <div class="test-desc">{{ t.descriptionUa }}</div>
                  <div class="test-tags">
                    <span class="tag tag-domain">{{ domainLabel(t.domain) }}</span>
                    @for (tag of t.tags.slice(0, 3); track tag) {
                      <span class="tag">{{ tag }}</span>
                    }
                  </div>
                </li>
              }
            </ul>
          }
        </div>

        <footer class="modal-foot">
          <p class="footnote">
            Тести призначені для тренування адміністрування і інтерпретації.
            Українські формулювання — авторські, не для клінічної діагностики.
          </p>
        </footer>
      </div>
    </div>
  `,
  styles: [`
    .modal-backdrop {
      position: fixed; inset: 0; z-index: 100;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center;
      padding: 16px;
      animation: fade-in .2s ease-out;
    }
    @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

    .modal-card {
      width: 100%;
      max-width: 720px;
      max-height: 92vh;
      display: flex;
      flex-direction: column;
      background: var(--assistant-bg);
      border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 24px 60px -12px rgba(0,0,0,0.6);
    }
    .modal-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 18px 22px 14px;
      border-bottom: 1px solid color-mix(in srgb, var(--accent) 12%, var(--border));
    }
    .modal-head h2 { margin: 0; font-size: 18px; font-weight: 500; }
    .modal-head .icon {
      width: 32px; height: 32px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 22px; line-height: 1;
      background: transparent; border: 1px solid var(--border);
      border-radius: 50%; color: var(--fg-dim); cursor: pointer;
    }
    .modal-head .icon:hover { color: var(--fg); }

    .modal-controls {
      padding: 14px 22px 12px;
      display: flex; flex-direction: column; gap: 10px;
      border-bottom: 1px solid color-mix(in srgb, var(--accent) 8%, var(--border));
    }
    .search-input {
      width: 100%;
      padding: 10px 14px;
      background: color-mix(in srgb, var(--accent) 4%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border));
      border-radius: 8px;
      color: var(--fg);
      font-size: 14px;
    }
    .search-input:focus { outline: none; border-color: var(--accent); }

    .domain-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .domain-chip {
      padding: 4px 10px;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--fg-dim);
      font-size: 11px;
      letter-spacing: 0.02em;
      cursor: pointer;
      transition: border-color .15s, color .15s, background .15s;
    }
    .domain-chip:hover { color: var(--fg); border-color: var(--fg-dim); }
    .domain-chip.active {
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      color: var(--accent);
      border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    }

    .modal-body { flex: 1; overflow-y: auto; padding: 8px 14px 16px; }
    .hint { padding: 24px 8px; color: var(--fg-dim); text-align: center; font-size: 14px; }

    .test-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .test-card {
      padding: 14px 16px;
      background: color-mix(in srgb, var(--accent) 3%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 12%, var(--border));
      border-radius: 10px;
      cursor: pointer;
      transition: border-color .15s, background .15s, transform .1s;
    }
    .test-card:hover {
      border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
      background: color-mix(in srgb, var(--accent) 7%, transparent);
    }
    .test-card:active { transform: scale(0.99); }

    .test-name-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
    .test-name { font-size: 16px; font-weight: 500; color: var(--accent); letter-spacing: -0.01em; }
    .test-time { font-size: 11px; color: var(--fg-dim); white-space: nowrap; }
    .test-full { font-size: 13px; color: var(--fg); margin: 2px 0 6px; }
    .test-desc { font-size: 12px; color: var(--fg-dim); line-height: 1.4; }
    .test-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .tag {
      padding: 1px 7px;
      background: color-mix(in srgb, var(--accent) 6%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border));
      border-radius: 999px;
      color: var(--fg-dim);
      font-size: 10px;
      letter-spacing: 0.02em;
    }
    .tag.tag-domain {
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      color: var(--accent);
      border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
    }

    .modal-foot {
      padding: 10px 22px 14px;
      border-top: 1px solid color-mix(in srgb, var(--accent) 8%, var(--border));
      background: color-mix(in srgb, var(--accent) 2%, transparent);
    }
    .footnote {
      margin: 0;
      font-size: 11px;
      color: var(--fg-dim);
      line-height: 1.4;
    }

    @media (max-width: 600px) {
      .modal-backdrop { padding: 8px; align-items: flex-end; }
      .modal-card { max-height: 95dvh; border-radius: 16px 16px 0 0; }
      .modal-head { padding: 14px 16px 10px; }
      .modal-controls { padding: 10px 16px; }
      .modal-body { padding: 6px 10px 12px; }
    }
  `],
})
export class TestModalComponent implements OnInit {
  private api = inject(ApiService);

  @Output() picked = new EventEmitter<string>();
  @Output() close = new EventEmitter<void>();

  private allTests = signal<PsychTestSummary[]>([]);
  domains = signal<string[]>([]);
  loading = signal(true);

  /** Search input model. ngModelChange triggers onSearchChange which
   *  debounces the actual filter recompute. */
  searchQ = '';
  private searchTrigger = signal(0);
  activeDomain = signal<string | null>(null);

  /** Visible list — re-filtered on each search/domain change. */
  filtered = computed(() => {
    // Touch searchTrigger so the computation re-runs when search changes.
    this.searchTrigger();
    const q = this.searchQ.toLowerCase().trim();
    const d = this.activeDomain();
    return this.allTests().filter((t) => {
      if (d && t.domain !== d) return false;
      if (!q) return true;
      const hay = [t.name, t.fullName, t.fullNameUa, t.descriptionUa, t.domain, ...t.tags]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  });

  /** Maps domain key → Ukrainian display label. */
  private static readonly DOMAIN_LABELS: Record<string, string> = {
    depression: 'Депресія',
    anxiety: 'Тривога',
    stress: 'Стрес',
    wellbeing: 'Благополуччя',
    substance: 'Залежність',
    trauma: 'Травма',
    suicide: 'Ризик суїциду',
    adhd: 'СДУГ',
    eating: 'Харч. поведінка',
  };
  domainLabel(d: string): string {
    return TestModalComponent.DOMAIN_LABELS[d] ?? d;
  }

  async ngOnInit() {
    try {
      const [tests, domains] = await Promise.all([
        this.api.listPsychTests(),
        this.api.listTestDomains(),
      ]);
      this.allTests.set(tests);
      this.domains.set(domains);
    } catch {
      this.allTests.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  onSearchChange() {
    this.searchTrigger.update((v) => v + 1);
  }

  setDomain(d: string | null) {
    this.activeDomain.set(d);
  }

  pick(key: string) {
    this.picked.emit(key);
  }

  onBackdropClick(e: MouseEvent) {
    // Only close if the click is on the backdrop itself, not on the card.
    if ((e.target as HTMLElement).classList.contains('modal-backdrop')) {
      this.close.emit();
    }
  }
}
