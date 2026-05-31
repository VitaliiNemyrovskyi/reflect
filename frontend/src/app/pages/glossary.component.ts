import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, GlossaryTerm } from '../api.service';
import { I18nService } from '../i18n.service';

/**
 * Global glossary of clinical terms (/glossary). Searchable, grouped by
 * category. The same terms also surface inside each course's "Словник" section.
 * Authed route — the global app-header provides the chrome.
 */
@Component({
  selector: 'app-glossary',
  standalone: true,
  imports: [RouterLink],
  template: `
    <section class="wrap">
      <a routerLink="/dashboard" class="back">← {{ tr('На головну', 'Home') }}</a>
      <header class="head">
        <h1>{{ tr('Словник термінів', 'Glossary') }}</h1>
        <p class="muted">{{ tr('Ключові поняття з курсів — коротко й своїми словами.', 'Key concepts from the courses — short, in plain words.') }}</p>
        <input class="search" type="search" [value]="query()"
          (input)="query.set($any($event.target).value)"
          [attr.aria-label]="tr('Пошук терміна', 'Search terms')"
          [placeholder]="tr('Пошук…', 'Search…')" />
      </header>

      @if (loading()) {
        <p class="muted">{{ tr('Завантаження…', 'Loading…') }}</p>
      } @else if (error()) {
        <p class="danger">{{ error() }}</p>
      } @else if (groups().length === 0) {
        <p class="muted">{{ tr('Нічого не знайдено.', 'Nothing found.') }}</p>
      } @else {
        @for (g of groups(); track g.cat) {
          <section class="cat">
            <h2>{{ catLabel(g.cat) }}</h2>
            <dl class="terms">
              @for (t of g.terms; track t.slug) {
                <div class="term">
                  <dt>{{ i18n.isEn ? t.termEn : t.termUk }}</dt>
                  <dd>{{ i18n.isEn ? t.defEn : t.defUk }}</dd>
                </div>
              }
            </dl>
          </section>
        }
      }
    </section>
  `,
  styles: [`
    .wrap { display: flex; flex-direction: column; gap: 18px; max-width: 760px; }
    .back { color: var(--fg-dim); text-decoration: none; font-size: 14px; align-self: flex-start; }
    .back:hover { color: var(--accent); }
    .muted { color: var(--fg-dim); }
    .danger { color: var(--danger); }
    .head { display: flex; flex-direction: column; gap: 10px; }
    h1 { font-size: 26px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
    .search { margin-top: 4px; padding: 11px 14px; border-radius: 12px; font-size: 15px;
      color: var(--fg); background: var(--user-bg); border: 1px solid var(--border); }
    .search:focus { outline: none; border-color: var(--accent); }

    .cat { display: flex; flex-direction: column; gap: 10px; }
    .cat h2 { margin: 6px 0 0; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--accent); }
    .terms { margin: 0; display: flex; flex-direction: column; gap: 12px; }
    .term { padding: 14px 16px; border-radius: 12px; background: var(--panel, var(--user-bg));
      border: 1px solid var(--border); }
    dt { font-size: 16px; font-weight: 600; color: var(--fg); margin: 0 0 4px; }
    dd { margin: 0; font-size: 14.5px; line-height: 1.55; color: var(--fg-dim); }
  `],
})
export class GlossaryComponent implements OnInit {
  private api = inject(ApiService);
  readonly i18n = inject(I18nService);

  loading = signal(true);
  error = signal<string | null>(null);
  query = signal('');
  private terms = signal<GlossaryTerm[]>([]);

  private static readonly CAT_ORDER = ['general', 'frame', 'alliance', 'listening', 'risk', 'anxiety'];

  groups = computed(() => {
    const q = this.query().trim().toLowerCase();
    const en = this.i18n.isEn;
    const filtered = this.terms().filter((t) => {
      if (!q) return true;
      const hay = (en ? `${t.termEn} ${t.defEn}` : `${t.termUk} ${t.defUk}`).toLowerCase();
      return hay.includes(q);
    });
    const byCat = new Map<string, GlossaryTerm[]>();
    for (const t of filtered) {
      const cat = t.category ?? 'general';
      (byCat.get(cat) ?? byCat.set(cat, []).get(cat)!).push(t);
    }
    return [...byCat.entries()]
      .map(([cat, terms]) => ({ cat, terms }))
      .sort((a, b) => GlossaryComponent.CAT_ORDER.indexOf(a.cat) - GlossaryComponent.CAT_ORDER.indexOf(b.cat));
  });

  async ngOnInit(): Promise<void> {
    try {
      this.terms.set(await this.api.listGlossary());
    } catch {
      this.error.set(this.tr('Не вдалося завантажити словник.', 'Failed to load the glossary.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected tr(uk: string, en: string): string {
    return this.i18n.isEn ? en : uk;
  }

  protected catLabel(cat: string): string {
    switch (cat) {
      case 'frame': return this.tr('Рамка та контракт', 'Frame & contract');
      case 'alliance': return this.tr('Альянс і ядрові умови', 'Alliance & core conditions');
      case 'listening': return this.tr('Активне слухання (OARS)', 'Active listening (OARS)');
      case 'risk': return this.tr('Ризик і безпека', 'Risk & safety');
      case 'anxiety': return this.tr('Тривога', 'Anxiety');
      default: return this.tr('Загальне', 'General');
    }
  }
}
