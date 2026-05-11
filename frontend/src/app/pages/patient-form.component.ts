import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  ApiService,
  CharacterDraftBrief,
  CreateCharacterDto,
  DraftFieldName,
} from '../api.service';

type Mode = 'create' | 'edit';

const PASTEL_BACKGROUNDS = [
  'fde7c2', 'c0aede', 'd1d4f9', 'ffd5dc', 'b6e3f4',
  'ffe5b4', 'd8f0c2', 'f4d1d1', 'ffd6a5', 'caffbf',
];

const THEME_OPTIONS = [
  'тривога', 'депресія', 'травма', 'горе', 'харчування',
  'стосунки', 'сімейна динаміка', 'війна', 'самооцінка',
  'ідентичність', 'кар\'єра', 'батьківство', 'фобії',
  'обсесивні думки', 'зловживання речовинами',
];

@Component({
  selector: 'app-patient-form',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <header class="page-header">
      <a routerLink="/" class="back">← На головну</a>
      <h1>
        @if (mode() === 'create') {
          Створити пацієнтку
        } @else {
          Редагувати: {{ form.displayName }}
        }
      </h1>
      <p class="hint">
        Опиши клінічний випадок коротко, потім модель розгорне у повний
        8-секційний профіль. Можеш відредагувати markdown вручну перед
        збереженням. <strong>Біля кожного поля є <code>✨</code></strong>
        — тицни, і ШІ запропонує значення, узгоджене з тим, що ти вже
        заповнила. Тисни ще раз — отримаєш іншу варіацію.
      </p>
    </header>

    @if (loadError()) {
      <p class="hint danger">{{ loadError() }}</p>
    }

    <section class="form-section">
      <h2>1. Хто це</h2>

      <div class="row">
        <div class="field">
          <div class="label-row">
            <label for="displayName">Ім'я *</label>
            <button type="button" class="ai-mini"
                    [disabled]="aiBlocked()"
                    (click)="fillField('displayName')"
                    title="Згенерувати ім'я через ШІ">
              @if (aiBusy('displayName')) { ⏳ } @else { ✨ }
            </button>
          </div>
          <input id="displayName" type="text" required maxlength="80"
                 [(ngModel)]="form.displayName" name="displayName" />
        </div>
        <div class="field narrow">
          <div class="label-row">
            <label for="age">Вік</label>
            <button type="button" class="ai-mini"
                    [disabled]="aiBlocked()"
                    (click)="fillField('age')"
                    title="Згенерувати вік через ШІ">
              @if (aiBusy('age')) { ⏳ } @else { ✨ }
            </button>
          </div>
          <input id="age" type="number" min="14" max="90"
                 [(ngModel)]="form.age" name="age" />
        </div>
        <div class="field narrow">
          <label>Стать *</label>
          <div class="radio-group">
            <label class="radio">
              <input type="radio" name="gender" value="female"
                     [(ngModel)]="form.gender" /> Жіноча
            </label>
            <label class="radio">
              <input type="radio" name="gender" value="male"
                     [(ngModel)]="form.gender" /> Чоловіча
            </label>
          </div>
        </div>
      </div>

      <div class="row">
        <div class="field">
          <div class="label-row">
            <label for="city">Місто/район</label>
            <button type="button" class="ai-mini"
                    [disabled]="aiBlocked()"
                    (click)="fillField('city')"
                    title="Згенерувати місто через ШІ">
              @if (aiBusy('city')) { ⏳ } @else { ✨ }
            </button>
          </div>
          <input id="city" type="text" maxlength="120"
                 [(ngModel)]="form.city" name="city"
                 placeholder="Київ, Поділ" />
        </div>
        <div class="field">
          <div class="label-row">
            <label for="profession">Професія/контекст</label>
            <button type="button" class="ai-mini"
                    [disabled]="aiBlocked()"
                    (click)="fillField('profession')"
                    title="Згенерувати професію через ШІ">
              @if (aiBusy('profession')) { ⏳ } @else { ✨ }
            </button>
          </div>
          <input id="profession" type="text" maxlength="120"
                 [(ngModel)]="form.profession" name="profession"
                 placeholder="вчителька, IT-аналітик, студентка..." />
        </div>
      </div>
    </section>

    <section class="form-section">
      <h2>2. Клінічна рамка</h2>

      <div class="row">
        <div class="field">
          <div class="label-row">
            <label for="diagnosis">Діагноз українською</label>
            <button type="button" class="ai-mini"
                    [disabled]="aiBlocked()"
                    (click)="fillField('diagnosis')"
                    title="Згенерувати діагноз через ШІ">
              @if (aiBusy('diagnosis')) { ⏳ } @else { ✨ }
            </button>
          </div>
          <input id="diagnosis" type="text" maxlength="200"
                 [(ngModel)]="form.diagnosis" name="diagnosis"
                 placeholder="Соціальна тривога з уникненням" />
        </div>
        <div class="field">
          <div class="label-row">
            <label for="diagnosisCode">Шифр (МКХ-10 / DSM-5)</label>
            <button type="button" class="ai-mini"
                    [disabled]="aiBlocked()"
                    (click)="fillField('diagnosisCode')"
                    title="Згенерувати шифр через ШІ">
              @if (aiBusy('diagnosisCode')) { ⏳ } @else { ✨ }
            </button>
          </div>
          <input id="diagnosisCode" type="text" maxlength="200"
                 [(ngModel)]="form.diagnosisCode" name="diagnosisCode"
                 placeholder="F40.1 (МКХ-10) / 300.23 (DSM-5)" />
        </div>
      </div>

      <div class="row">
        <div class="field narrow">
          <div class="label-row">
            <label>Поведінкова складність: {{ form.difficulty }}</label>
            <button type="button" class="ai-mini"
                    [disabled]="aiBlocked()"
                    (click)="fillField('difficulty')"
                    title="Підібрати складність через ШІ">
              @if (aiBusy('difficulty')) { ⏳ } @else { ✨ }
            </button>
          </div>
          <input type="range" min="1" max="5" step="1"
                 [(ngModel)]="form.difficulty" name="difficulty" />
          <span class="hint">1 = відкрита, 5 = глухий опір</span>
        </div>
        <div class="field narrow">
          <div class="label-row">
            <label>Клінічна тяжкість: {{ form.complexity }}</label>
            <button type="button" class="ai-mini"
                    [disabled]="aiBlocked()"
                    (click)="fillField('complexity')"
                    title="Підібрати тяжкість через ШІ">
              @if (aiBusy('complexity')) { ⏳ } @else { ✨ }
            </button>
          </div>
          <input type="range" min="1" max="5" step="1"
                 [(ngModel)]="form.complexity" name="complexity" />
          <span class="hint">1 = легка, 5 = гостра небезпека</span>
        </div>
      </div>
    </section>

    <section class="form-section">
      <h2>3. Випадок</h2>

      <div class="field">
        <div class="label-row">
          <label for="brief">Що з нею відбувається (2-3 речення)</label>
          <button type="button" class="ai-mini"
                  [disabled]="aiBlocked()"
                  (click)="fillField('brief')"
                  title="Згенерувати опис випадку через ШІ">
            @if (aiBusy('brief')) { ⏳ } @else { ✨ }
          </button>
        </div>
        <textarea id="brief" rows="3" maxlength="600"
                  [(ngModel)]="form.brief" name="brief"
                  placeholder="Останні 4 місяці — панічні атаки уночі. Працює, але виснажена. Партнер не знає масштабу."></textarea>
      </div>

      <div class="field">
        <div class="label-row">
          <label for="hiddenLayerHint">Прихований шар (1-2 речення, що насправді відбувається)</label>
          <button type="button" class="ai-mini"
                  [disabled]="aiBlocked()"
                  (click)="fillField('hiddenLayerHint')"
                  title="Згенерувати прихований шар через ШІ">
            @if (aiBusy('hiddenLayerHint')) { ⏳ } @else { ✨ }
          </button>
        </div>
        <textarea id="hiddenLayerHint" rows="2" maxlength="500"
                  [(ngModel)]="form.hiddenLayerHint" name="hiddenLayerHint"
                  placeholder="Контракт умовної любові з мамою + криза кар'єрного стелі = панічна атака як легітимний спосіб зупинитись."></textarea>
      </div>

      <div class="field">
        <div class="label-row">
          <label for="voiceNotes">Особливості мовлення</label>
          <button type="button" class="ai-mini"
                  [disabled]="aiBlocked()"
                  (click)="fillField('voiceNotes')"
                  title="Згенерувати опис мовлення через ШІ">
            @if (aiBusy('voiceNotes')) { ⏳ } @else { ✨ }
          </button>
        </div>
        <textarea id="voiceNotes" rows="2" maxlength="400"
                  [(ngModel)]="form.voiceNotes" name="voiceNotes"
                  placeholder="Артикульована, перфекціоністка, іронія як захист. Російську не вживає крім цитування мами."></textarea>
      </div>

      <div class="field">
        <div class="label-row">
          <label>Спеціальні теми (необов'язково)</label>
          <button type="button" class="ai-mini"
                  [disabled]="aiBlocked()"
                  (click)="fillField('themes')"
                  title="Підібрати теми через ШІ">
            @if (aiBusy('themes')) { ⏳ } @else { ✨ }
          </button>
        </div>
        <div class="theme-chips">
          @for (t of themeOptions; track t) {
            <label class="chip" [class.active]="hasTheme(t)">
              <input type="checkbox" [checked]="hasTheme(t)" (change)="toggleTheme(t)" />
              {{ t }}
            </label>
          }
        </div>
      </div>
    </section>

    <section class="form-section">
      <h2>4. Згенерувати профіль</h2>

      <div class="actions">
        <button type="button" class="primary" (click)="generateProfile()"
                [disabled]="aiBlocked() || !canGenerate()">
          @if (generating()) {
            🪄 Генерую…
          } @else if (aiBlocked()) {
            ⏳ Чекаю поки інша AI-операція завершиться…
          } @else if (form.profileText) {
            🔄 Перегенерувати
          } @else {
            ✨ Згенерувати профіль
          }
        </button>
        @if (generateError()) {
          <span class="danger">{{ generateError() }}</span>
        }
      </div>

      @if (!canGenerate() && !form.profileText) {
        <p class="hint">
          Заповни принаймні Ім'я і Стать (плюс хоч короткий опис випадку),
          щоб модель мала контекст.
        </p>
      }

      @if (form.profileText) {
        <div class="field">
          <label for="profileText">
            Markdown профілю (можна редагувати вручну)
          </label>
          <textarea id="profileText" rows="20"
                    [(ngModel)]="form.profileText" name="profileText"></textarea>
          <span class="hint char-count">{{ form.profileText.length }} символів</span>
        </div>
      }
    </section>

    <section class="form-section sticky-actions">
      @if (form.profileText) {
        <button type="button" class="primary big" (click)="save()"
                [disabled]="saving() || !form.displayName.trim()">
          @if (saving()) {
            Зберігаю…
          } @else if (mode() === 'create') {
            Зберегти нову пацієнтку
          } @else {
            Зберегти зміни
          }
        </button>
      }
      @if (saveError()) {
        <span class="danger">{{ saveError() }}</span>
      }
      <a routerLink="/" class="ghost-link">Скасувати</a>
    </section>
  `,
  styles: [`
    :host { display: block; max-width: 760px; }

    .page-header { margin-bottom: 28px; }
    .back { color: var(--fg-dim); text-decoration: none; font-size: 13px; }
    .back:hover { color: var(--accent); }
    h1 { margin: 12px 0 8px; font-size: 26px; letter-spacing: -0.02em; }
    .page-header .hint { font-size: 14px; line-height: 1.55; }

    .form-section {
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 22px;
      margin-bottom: 16px;
    }
    .form-section h2 {
      margin: 0 0 16px;
      font-size: 14px;
      font-weight: 500;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: .04em;
    }

    .row {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 14px;
      margin-bottom: 14px;
    }
    .row:last-child { margin-bottom: 0; }
    .row .field.narrow { grid-column: span 1; }
    .row .field:not(.narrow) { grid-column: span 1; }
    @media (max-width: 640px) {
      .row { grid-template-columns: 1fr; }
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 14px;
    }
    .field:last-child { margin-bottom: 0; }
    .field label {
      font-size: 12px;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: .04em;
      font-weight: 500;
    }
    .label-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      min-height: 22px;
    }
    .label-row label {
      flex: 1;
      min-width: 0;
    }
    .ai-mini {
      flex-shrink: 0;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg-dim);
      padding: 2px 8px;
      font-size: 11px;
      line-height: 1.4;
      border-radius: 4px;
      cursor: pointer;
      min-height: auto;
      transition: all .15s ease;
      text-transform: none;
      letter-spacing: 0;
      font-weight: 400;
    }
    .ai-mini:hover:not(:disabled) {
      background: rgba(216, 201, 255, 0.1);
      border-color: var(--accent);
      color: var(--accent);
    }
    .ai-mini:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .field input[type="text"],
    .field input[type="number"],
    .field textarea {
      padding: 10px 12px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--fg);
      font-size: 14px;
      font-family: inherit;
      line-height: 1.5;
      width: 100%;
      box-sizing: border-box;
    }
    .field textarea { resize: vertical; min-height: 70px; }
    .field input:focus, .field textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    .field input[type="range"] {
      width: 100%;
      accent-color: var(--accent);
    }
    .hint {
      font-size: 12px;
      color: var(--fg-dim);
      line-height: 1.4;
      margin: 0;
    }
    .hint.danger, .danger { color: var(--danger); font-size: 13px; }
    .char-count { align-self: flex-end; }

    .radio-group {
      display: flex;
      gap: 14px;
    }
    .radio {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 14px;
      text-transform: none;
      letter-spacing: 0;
      color: var(--fg);
      cursor: pointer;
    }
    .radio input { accent-color: var(--accent); }

    .theme-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .theme-chips .chip {
      display: inline-flex;
      align-items: center;
      padding: 5px 12px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 12px;
      cursor: pointer;
      text-transform: none;
      letter-spacing: 0;
      color: var(--fg-dim);
    }
    .theme-chips .chip:hover { color: var(--fg); }
    .theme-chips .chip.active {
      background: rgba(216, 201, 255, 0.1);
      border-color: var(--accent);
      color: var(--accent);
    }
    .theme-chips .chip input { display: none; }

    .actions {
      display: flex;
      gap: 14px;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .actions:last-child { margin-bottom: 0; }

    .sticky-actions {
      position: sticky;
      bottom: 0;
      background: var(--assistant-bg);
      display: flex;
      gap: 14px;
      align-items: center;
      flex-wrap: wrap;
    }
    .big { padding: 12px 24px; font-size: 14px; }

    .ghost-link {
      color: var(--fg-dim);
      text-decoration: none;
      font-size: 13px;
    }
    .ghost-link:hover { color: var(--fg); }
  `],
})
export class PatientFormComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  mode = signal<Mode>('create');
  private editingId = signal<number | null>(null);

  themeOptions = THEME_OPTIONS;

  form: CharacterDraftBrief & { profileText: string } = {
    displayName: '',
    gender: 'female',
    age: undefined,
    city: '',
    profession: '',
    diagnosis: '',
    diagnosisCode: '',
    difficulty: 3,
    complexity: 3,
    brief: '',
    hiddenLayerHint: '',
    voiceNotes: '',
    themes: [],
    profileText: '',
  };

  loadError = signal<string | null>(null);
  generating = signal(false);
  generateError = signal<string | null>(null);
  saving = signal(false);
  saveError = signal<string | null>(null);

  /**
   * Tracks per-field "fetching from AI" state. Only the field currently
   * generating shows ⏳; all others stay ✨. But `aiBlocked()` returns
   * true while ANY AI call is in flight, which we wire into every
   * ✨ + the big "Згенерувати профіль" button as the disabled binding.
   *
   * Rationale: free OpenRouter tier hits rate-limits hard on parallel
   * calls — serializing AI requests gives much more reliable behavior.
   */
  private aiBusyMap = signal<Record<string, boolean>>({});

  aiBusy(field: DraftFieldName): boolean {
    return !!this.aiBusyMap()[field];
  }

  /** True if ANY AI call (per-field ✨ or full-profile generate) is in flight. */
  aiBlocked(): boolean {
    if (this.generating()) return true;
    const map = this.aiBusyMap();
    for (const k in map) if (map[k]) return true;
    return false;
  }

  /**
   * Whether the "Згенерувати профіль" button should be active. Plain
   * method (not computed signal) — `this.form` is a plain object and a
   * computed wouldn't see updates to its properties; a method re-runs
   * on every change-detection cycle which is what we want here.
   */
  canGenerate(): boolean {
    return (
      this.form.displayName.trim().length > 0 &&
      (this.form.brief?.trim() ?? '').length > 0
    );
  }

  hasTheme(t: string): boolean {
    return (this.form.themes ?? []).includes(t);
  }
  toggleTheme(t: string) {
    const list = this.form.themes ?? [];
    this.form.themes = list.includes(t)
      ? list.filter((x) => x !== t)
      : [...list, t];
  }

  async ngOnInit() {
    const idParam = this.route.snapshot.paramMap.get('id');
    if (!idParam) {
      this.mode.set('create');
      return;
    }
    const id = Number(idParam);
    this.mode.set('edit');
    this.editingId.set(id);
    try {
      const card = await this.api.patientCard(id);
      // Prefill from the existing character. Brief fields aren't stored
      // separately on the backend (only profileText is), so for edit we
      // only prefill identity + clinical metadata + the markdown body.
      // The brief stays empty — if user wants to regenerate, they'd need
      // to provide a new brief.
      this.form.displayName = card.displayName;
      this.form.diagnosis = card.diagnosis ?? '';
      this.form.diagnosisCode = card.diagnosisCode ?? '';
      this.form.difficulty = card.difficulty ?? 3;
      this.form.complexity = card.complexity ?? 3;
      this.form.profileText = card.profileText;
      // gender best-guess from avatar URL style
      this.form.gender = card.avatarUrl?.includes('/lorelei/') ? 'female' : 'male';
    } catch (e: unknown) {
      this.loadError.set(
        (e as { error?: { message?: string } })?.error?.message ??
          'Не вдалось завантажити характер для редагування.',
      );
    }
  }

  async generateProfile() {
    if (!this.canGenerate() || this.generating()) return;
    this.generating.set(true);
    this.generateError.set(null);
    try {
      const res = await this.api.draftCharacter(this.briefPayload());
      this.form.profileText = res.markdown;
    } catch (e: unknown) {
      const httpErr = e as { error?: { message?: string }; status?: number };
      this.generateError.set(
        httpErr.error?.message ||
          (httpErr.status === 503
            ? 'Модель тимчасово недоступна (rate-limit). Спробуй за хвилину.'
            : 'Не вдалось згенерувати профіль.'),
      );
    } finally {
      this.generating.set(false);
    }
  }

  /**
   * Single-field AI assist. Captures the current form state as context,
   * asks the backend for a value, then applies it to the form. Always
   * overwrites — re-clicking ✨ gives a fresh variation.
   */
  async fillField(field: DraftFieldName) {
    if (this.aiBusy(field)) return;
    this.aiBusyMap.update((curr) => ({ ...curr, [field]: true }));
    try {
      const res = await this.api.draftField(field, this.briefPayload());
      this.applyAiValue(field, res.value);
    } catch (e: unknown) {
      const httpErr = e as { error?: { message?: string }; status?: number };
      // Reuse the global generateError surface — per-field error UI would
      // bloat the template. User sees the message under section 4.
      this.generateError.set(
        httpErr.error?.message ||
          (httpErr.status === 503
            ? 'Модель тимчасово недоступна (rate-limit). Спробуй за хвилину.'
            : `Не вдалось згенерувати поле «${field}».`),
      );
    } finally {
      this.aiBusyMap.update((curr) => ({ ...curr, [field]: false }));
    }
  }

  /**
   * Apply a value returned by the backend's draft-field endpoint into
   * the form, with field-specific coercion. The backend already coerces
   * server-side (number for age/difficulty/complexity, string[] for
   * themes), but we belt-and-suspenders here so a weird response can't
   * break the form.
   */
  private applyAiValue(field: DraftFieldName, raw: unknown): void {
    switch (field) {
      case 'age': {
        const n = Number(raw);
        this.form.age = Number.isFinite(n) ? Math.max(14, Math.min(90, Math.round(n))) : undefined;
        return;
      }
      case 'difficulty': {
        const n = Number(raw);
        this.form.difficulty = Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : 3;
        return;
      }
      case 'complexity': {
        const n = Number(raw);
        this.form.complexity = Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : 3;
        return;
      }
      case 'themes': {
        const list = Array.isArray(raw)
          ? raw
          : typeof raw === 'string'
            ? raw.split(',').map((t) => t.trim())
            : [];
        // Filter to known options + de-dupe
        const valid = Array.from(
          new Set(list.map((t) => t.toLowerCase()).filter((t) => THEME_OPTIONS.includes(t))),
        );
        this.form.themes = valid;
        return;
      }
      case 'displayName': {
        this.form.displayName = String(raw ?? '').trim();
        return;
      }
      case 'city':
        this.form.city = String(raw ?? '');
        return;
      case 'profession':
        this.form.profession = String(raw ?? '');
        return;
      case 'diagnosis':
        this.form.diagnosis = String(raw ?? '');
        return;
      case 'diagnosisCode':
        this.form.diagnosisCode = String(raw ?? '');
        return;
      case 'brief':
        this.form.brief = String(raw ?? '');
        return;
      case 'hiddenLayerHint':
        this.form.hiddenLayerHint = String(raw ?? '');
        return;
      case 'voiceNotes':
        this.form.voiceNotes = String(raw ?? '');
        return;
    }
  }

  async save() {
    if (this.saving() || !this.form.displayName.trim() || !this.form.profileText.trim()) return;
    this.saving.set(true);
    this.saveError.set(null);
    try {
      const dto: CreateCharacterDto = {
        displayName: this.form.displayName.trim(),
        profileText: this.form.profileText,
        diagnosis: this.form.diagnosis || undefined,
        diagnosisCode: this.form.diagnosisCode || undefined,
        difficulty: this.form.difficulty,
        complexity: this.form.complexity,
        avatarUrl: this.buildAvatarUrl(),
      };
      const character =
        this.mode() === 'create'
          ? await this.api.createCharacter(dto)
          : await this.api.updateCharacter(this.editingId()!, dto);
      void this.router.navigate(['/patient', character.id]);
    } catch (e: unknown) {
      this.saveError.set(
        (e as { error?: { message?: string } })?.error?.message ??
          'Не вдалось зберегти.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  private briefPayload(): CharacterDraftBrief {
    return {
      displayName: this.form.displayName.trim(),
      gender: this.form.gender,
      age: this.form.age,
      city: this.form.city?.trim() || undefined,
      profession: this.form.profession?.trim() || undefined,
      diagnosis: this.form.diagnosis?.trim() || undefined,
      diagnosisCode: this.form.diagnosisCode?.trim() || undefined,
      difficulty: this.form.difficulty,
      complexity: this.form.complexity,
      brief: this.form.brief?.trim() || undefined,
      hiddenLayerHint: this.form.hiddenLayerHint?.trim() || undefined,
      voiceNotes: this.form.voiceNotes?.trim() || undefined,
      themes: this.form.themes?.length ? this.form.themes : undefined,
    };
  }

  /**
   * Build a deterministic DiceBear avatar URL from the patient name and
   * gender. lorelei = consistently feminine, notionists = chosen for
   * masculine (works fine for Maxim et al). seed uses transliterated
   * name so the same name always gives the same picture.
   */
  private buildAvatarUrl(): string {
    const seed = transliterate(this.form.displayName).replace(/[^A-Za-z0-9]/g, '') || 'patient';
    const style = this.form.gender === 'female' ? 'lorelei' : 'notionists';
    // Pick a background from the pastel palette, deterministic on name hash
    const hash = [...seed].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 7);
    const color = PASTEL_BACKGROUNDS[Math.abs(hash) % PASTEL_BACKGROUNDS.length];
    return `https://api.dicebear.com/9.x/${style}/svg?seed=${seed}&backgroundColor=${color}`;
  }
}

const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ye', ж: 'zh',
  з: 'z', и: 'y', і: 'i', ї: 'yi', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'yu', я: 'ya',
};
function transliterate(s: string): string {
  return s
    .toLowerCase()
    .split('')
    .map((c) => CYR_TO_LAT[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]/g, '');
}
