import {
  AfterViewChecked,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService, HintSuggestion, Note } from '../api.service';
import { SessionStateService } from '../session-state.service';
import { VoiceService } from '../voice.service';
import { RecognitionService } from '../recognition.service';
import { PreferencesService } from '../preferences.service';

interface SelectionAnchor {
  text: string;
  rectTop: number;
  rectLeft: number;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [FormsModule],
  template: `
    <header class="chat-header">
      <div class="left">
        <h2>{{ state.characterDisplayName() ?? 'Клієнт' }}</h2>
        <span class="timer"
              [class.warn]="elapsedMin() >= 35"
              [title]="elapsedMin() >= 35 ? 'Орієнтовний час закриття інтейк-сесії' : 'Час сесії'">
          🕐 {{ elapsedDisplay() }}
        </span>
      </div>
      <div class="actions">
        <button
          class="ghost icon mobile-only"
          [class.has-notes]="notes().length > 0"
          [attr.aria-label]="'Нотатки (' + notes().length + ')'"
          title="Нотатки"
          (click)="toggleNotes()">
          📝{{ notes().length > 0 ? ' ' + notes().length : '' }}
        </button>
        <button
          class="ghost icon"
          [class.active]="!voice.muted()"
          [attr.aria-label]="voice.muted() ? 'Увімкнути голос' : 'Вимкнути голос'"
          [title]="voice.muted() ? 'Увімкнути голос' : 'Вимкнути голос'"
          (click)="voice.toggleMute()">
          {{ voice.muted() ? '🔇' : voice.speaking() ? '🔊' : '🔈' }}
        </button>
        <button class="ghost end-btn" (click)="openEndDialog()" title="Завершити сесію (з опцією видалити)">
          Завершити
        </button>
        <button class="primary feedback-btn" (click)="getFeedback()" title="Зберегти сесію і отримати фідбек супервізора">
          Отримати фідбек
        </button>
      </div>
    </header>

    <div class="chat-layout">
      <section class="chat-main">
        <div #scroll class="messages" aria-live="polite">
          @for (b of state.bubbles(); track $index) {
            <div class="bubble fx-fade-up"
                 [class.user]="b.role === 'user'"
                 [class.assistant]="b.role === 'assistant'"
                 [class.typing]="b.pending">
              {{ b.content }}
              @if (b.role === 'assistant' && !b.pending) {
                <button class="replay"
                        title="Озвучити"
                        aria-label="Озвучити репліку"
                        (click)="voice.speak(b.content)">🔁</button>
              }
            </div>
          }
        </div>

        @if (hintsOpen()) {
          <div class="hints-popover" (click)="$event.stopPropagation()">
            <header class="hints-head">
              <span class="hints-title">💡 Що спитати?</span>
              <button class="hints-close" type="button" (click)="hintsOpen.set(false)" aria-label="Закрити">×</button>
            </header>
            @if (hintsLoading()) {
              <p class="hints-status">Готую варіанти…</p>
            } @else if (hintsError()) {
              <p class="hints-status danger">{{ hintsError() }}</p>
            } @else {
              <ul class="hints-list">
                @for (s of hints(); track $index) {
                  <li class="hint-card" (click)="applyHint(s)" tabindex="0"
                      (keydown.enter)="applyHint(s)">
                    <span class="hint-kind">{{ hintKindLabel(s.kind) }}</span>
                    <p class="hint-text">{{ s.text }}</p>
                    @if (s.rationale) {
                      <p class="hint-rationale">{{ s.rationale }}</p>
                    }
                  </li>
                }
              </ul>
              <p class="hints-foot">
                Натисни варіант — він підставиться у поле, ти зможеш відредагувати перед надсиланням.
              </p>
            }
          </div>
        }

        <form class="composer" (ngSubmit)="send()">
          <textarea
            rows="2"
            [(ngModel)]="draft"
            name="draft"
            [placeholder]="recognition.listening() ? 'Слухаю…' : 'Напишіть або натисніть мікрофон…'"
            [disabled]="sending()"
            (keydown.meta.enter)="send()"
            (keydown.control.enter)="send()"></textarea>
          @if (prefs.hintsEnabled()) {
            <button type="button"
                    class="ghost icon hint-trigger"
                    [class.active]="hintsOpen()"
                    [class.loading]="hintsLoading()"
                    [disabled]="sending()"
                    [attr.aria-label]="hintsOpen() ? 'Закрити підказки' : 'Що спитати?'"
                    title="Що спитати? (підказка від наставника)"
                    (click)="toggleHints()">
              💡
            </button>
          }
          @if (recognition.supported) {
            <button type="button"
                    class="ghost icon mic"
                    [class.listening]="recognition.listening()"
                    [attr.aria-label]="recognition.listening() ? 'Зупинити запис' : 'Говорити'"
                    [title]="recognition.listening() ? 'Зупинити запис' : 'Говорити'"
                    [disabled]="sending()"
                    (click)="toggleMic()">
              {{ recognition.listening() ? '⏹' : '🎙' }}
            </button>
          }
          <button class="primary" type="submit" [disabled]="sending() || !draft.trim()">
            Надіслати
          </button>
        </form>
      </section>

      @if (notesOpen()) {
        <div class="sheet-backdrop visible" (click)="closeNotes()"></div>
      }

      <aside class="notes-panel" [class.open]="notesOpen()">
        <button class="sheet-handle mobile-only" (click)="closeNotes()" aria-label="Закрити нотатки">
        </button>
        <header class="notes-header">
          <h3>Нотатки {{ notes().length ? '(' + notes().length + ')' : '' }}</h3>
          <span class="hint">Виділи текст у репліці, щоб приколоти нотатку</span>
        </header>

        <ul class="notes-list">
          @for (n of notes(); track n.id) {
            <li class="note">
              @if (n.anchorText) {
                <blockquote class="anchor">«{{ n.anchorText }}»</blockquote>
              }
              <p class="note-body">{{ n.noteText }}</p>
              <button class="note-delete" title="Видалити нотатку"
                      (click)="deleteNote(n.id)">✕</button>
            </li>
          }
          @if (notes().length === 0) {
            <li class="empty">Поки порожньо.</li>
          }
        </ul>

        <form class="note-form" (ngSubmit)="saveNote()">
          @if (anchorPreview()) {
            <blockquote class="anchor preview">
              «{{ anchorPreview() }}»
              <button type="button" class="anchor-clear" (click)="clearAnchor()" title="Прибрати прив'язку">×</button>
            </blockquote>
          }
          <textarea
            rows="3"
            [(ngModel)]="noteDraft"
            name="noteDraft"
            placeholder="Робоча гіпотеза, що помітила, на що повернутись…"
            (keydown.meta.enter)="saveNote()"
            (keydown.control.enter)="saveNote()"></textarea>
          <button type="submit" class="primary"
                  [disabled]="!noteDraft.trim() || savingNote()">
            {{ savingNote() ? 'Зберігаю…' : 'Додати нотатку' }}
          </button>
        </form>
      </aside>
    </div>

    @if (selectionAnchor()) {
      <button #selBtn class="floating-add-note"
              [style.top.px]="selectionAnchor()!.rectTop"
              [style.left.px]="selectionAnchor()!.rectLeft"
              (mousedown)="$event.preventDefault()"
              (click)="addAnchorFromSelection()">
        + Нотатка
      </button>
    }

    @if (endDialogOpen()) {
      <div class="modal-backdrop" (click)="closeEndDialog()"></div>
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="end-dialog-title">
        <h3 id="end-dialog-title">Завершити сесію</h3>
        <p>Зберегти цю сесію разом із фідбеком супервізора?</p>
        <p class="modal-warning">
          Якщо ні — сесію буде <strong>видалено повністю</strong>:
          транскрипт, нотатки, та пам'ять клієнтки про неї. Так, ніби сесії не було.
        </p>
        <div class="modal-actions">
          <button class="ghost" (click)="closeEndDialog()" [disabled]="discarding()">
            Скасувати
          </button>
          <button class="danger" (click)="discardSession()" [disabled]="discarding()">
            {{ discarding() ? 'Видаляю…' : 'Видалити сесію' }}
          </button>
          <button class="primary" (click)="getFeedback()" [disabled]="discarding()">
            Зберегти і отримати фідбек
          </button>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; flex: 1; }
    .chat-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 14px;
      margin-bottom: 0;
      gap: 8px;
    }
    h2 { font-size: 22px; margin: 0; font-weight: 500; }
    @media (max-width: 720px) {
      h2 { font-size: 18px; }
      .chat-header .danger,
      .chat-header .end-btn,
      .chat-header .feedback-btn { padding: 8px 12px; font-size: 13px; }
      .chat-header .icon { padding: 8px 10px; font-size: 16px; min-width: 44px; min-height: 44px; }
      .left { gap: 8px; flex-shrink: 1; min-width: 0; }
      .left h2 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .actions { flex-shrink: 0; gap: 6px; }
    }
    /* The "Завершити" button is the *destructive-with-question* path —
       muted ghost styling so the primary "Отримати фідбек" pulls the
       eye. Native confirm dialog lives in the modal-* block below. */
    .end-btn {
      color: var(--fg-dim);
      border: 1px solid var(--border);
    }
    .end-btn:hover {
      color: var(--fg);
      border-color: var(--fg-dim);
    }
    .feedback-btn { white-space: nowrap; }
    .left {
      display: flex;
      align-items: baseline;
      gap: 14px;
    }
    .timer {
      font-size: 13px;
      font-variant-numeric: tabular-nums;
      color: var(--fg-dim);
      letter-spacing: 0.02em;
    }
    .timer.warn {
      color: var(--accent);
    }
    .actions { display: flex; gap: 8px; }
    .icon {
      padding: 6px 10px;
      font-size: 18px;
      line-height: 1;
    }
    .icon.active { color: var(--accent); }

    .chat-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: 24px;
      flex: 1;
      min-height: 0;
    }
    @media (max-width: 880px) {
      .chat-layout { grid-template-columns: 1fr; }
    }

    .chat-main {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px 0;
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: 200px;
    }
    .bubble {
      position: relative;
      max-width: 85%;
      padding: 12px 16px;
      border-radius: 14px;
      white-space: pre-wrap;
      word-wrap: break-word;
      border: 1px solid var(--border);
      user-select: text;
    }
    .bubble.user {
      background: var(--user-bg);
      align-self: flex-end;
      border-bottom-right-radius: 4px;
    }
    .bubble.assistant {
      background: var(--assistant-bg);
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    .bubble.typing { color: var(--fg-dim); font-style: italic; }
    .bubble .replay {
      position: absolute;
      top: 6px;
      right: 6px;
      opacity: 0;
      transition: opacity .15s ease;
      padding: 2px 6px;
      font-size: 13px;
      background: var(--user-bg);
      border: 1px solid var(--border);
    }
    .bubble:hover .replay { opacity: 0.85; }
    .bubble .replay:hover { opacity: 1; }

    .composer {
      display: flex;
      gap: 8px;
      align-items: flex-end;
      border-top: 1px solid var(--border);
      padding-top: 14px;
      padding-bottom: var(--safe-bottom);
    }
    .composer textarea {
      flex: 1;
      resize: vertical;
      min-height: 44px;
      max-height: 200px;
    }
    .mic {
      padding: 10px 14px;
      font-size: 18px;
      line-height: 1;
      align-self: stretch;
    }
    @media (max-width: 720px) {
      .composer {
        gap: 6px;
        padding-top: 10px;
      }
      .composer textarea {
        min-height: 48px;
        font-size: 16px; // prevents iOS zoom-on-focus
      }
      .composer .primary,
      .composer .mic {
        min-height: 48px;
        min-width: 48px;
        padding: 10px 12px;
        font-size: 14px;
      }
      .composer .mic {
        font-size: 20px;
      }
    }
    .mic.listening {
      background: var(--danger);
      color: #15151b;
      border-color: var(--danger);
      animation: pulse 1.2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.65; }
    }

    /* Hint coach — trigger button + dropdown popover above the composer. */
    .hint-trigger {
      padding: 10px 14px;
      font-size: 18px;
      line-height: 1;
      align-self: stretch;
    }
    .hint-trigger.active {
      background: rgba(216, 201, 255, 0.15);
      border-color: var(--accent);
      color: var(--accent);
    }
    .hint-trigger.loading {
      animation: pulse 1.2s ease-in-out infinite;
    }
    @media (max-width: 720px) {
      .composer .hint-trigger {
        min-height: 48px;
        min-width: 48px;
        font-size: 20px;
      }
    }

    .hints-popover {
      background: var(--assistant-bg);
      border: 1px solid var(--accent);
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      max-height: 50vh;
      overflow-y: auto;
    }
    .hints-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .hints-title {
      font-size: 13px;
      color: var(--accent);
      font-weight: 500;
      letter-spacing: .02em;
    }
    .hints-close {
      background: transparent;
      border: none;
      color: var(--fg-dim);
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      padding: 0 4px;
      min-height: auto;
    }
    .hints-close:hover { color: var(--fg); }
    .hints-status {
      margin: 4px 0;
      font-size: 13px;
      color: var(--fg-dim);
    }
    .hints-status.danger { color: var(--danger); }

    .hints-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .hint-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      cursor: pointer;
      transition: border-color .12s ease, transform .12s ease;
    }
    .hint-card:hover {
      border-color: var(--accent);
      transform: translateY(-1px);
    }
    .hint-card:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(216, 201, 255, 0.25);
    }
    .hint-kind {
      display: inline-block;
      font-size: 10px;
      letter-spacing: .04em;
      text-transform: uppercase;
      color: var(--accent);
      padding: 2px 8px;
      background: rgba(216, 201, 255, 0.08);
      border: 1px solid rgba(216, 201, 255, 0.25);
      border-radius: 999px;
      margin-bottom: 6px;
    }
    .hint-text {
      margin: 4px 0 6px;
      font-size: 14px;
      line-height: 1.5;
      color: var(--fg);
    }
    .hint-rationale {
      margin: 0;
      font-size: 12px;
      line-height: 1.4;
      color: var(--fg-dim);
      font-style: italic;
    }
    .hints-foot {
      margin: 10px 0 0;
      font-size: 11px;
      color: var(--fg-dim);
      line-height: 1.4;
    }

    .notes-panel {
      display: flex;
      flex-direction: column;
      border-left: 1px solid var(--border);
      padding-left: 22px;
      min-height: 0;
    }
    .mobile-only { display: none; }
    @media (max-width: 880px) {
      .mobile-only { display: inline-flex; }
      // Mobile: notes panel becomes a bottom-sheet
      .notes-panel {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 100;
        background: var(--sheet-bg);
        border-radius: var(--sheet-radius);
        border-left: none;
        padding: 0 18px var(--safe-bottom);
        max-height: 85vh;
        transform: translateY(100%);
        transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: var(--sheet-shadow);
      }
      .notes-panel.open {
        transform: translateY(0);
      }
      .notes-panel .sheet-handle {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 32px;
        margin: 0 -18px 6px;
        background: transparent;
        border: none;
        cursor: grab;
        min-height: auto;
        &::before {
          content: '';
          width: var(--sheet-handle-w);
          height: var(--sheet-handle-h);
          background: var(--fg-dim);
          border-radius: 4px;
          opacity: 0.6;
        }
      }
    }
    @media (min-width: 881px) {
      .notes-panel .sheet-handle { display: none; }
      // Backdrop only relevant on mobile
      .sheet-backdrop { display: none !important; }
    }

    .icon.has-notes {
      color: var(--accent);
      border-color: var(--accent);
    }
    .notes-header h3 {
      margin: 0;
      font-size: 16px;
      font-weight: 500;
    }
    .notes-header .hint {
      display: block;
      font-size: 12px;
      color: var(--fg-dim);
      margin-top: 4px;
    }

    .notes-list {
      list-style: none;
      padding: 0;
      margin: 16px 0;
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .notes-list .empty {
      color: var(--fg-dim);
      font-size: 13px;
      font-style: italic;
    }
    .note {
      position: relative;
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 14px;
    }
    .anchor {
      margin: 0 0 6px;
      padding: 0 0 0 8px;
      border-left: 2px solid var(--accent);
      color: var(--fg-dim);
      font-size: 12px;
      font-style: italic;
    }
    .note-body { margin: 0; white-space: pre-wrap; }
    .note-delete {
      position: absolute;
      top: 4px;
      right: 4px;
      padding: 2px 7px;
      font-size: 12px;
      color: var(--fg-dim);
      opacity: 0.5;
    }
    .note:hover .note-delete { opacity: 1; }

    .note-form {
      display: flex;
      flex-direction: column;
      gap: 8px;
      border-top: 1px solid var(--border);
      padding-top: 14px;
    }
    .note-form textarea {
      resize: vertical;
      min-height: 60px;
      max-height: 200px;
    }
    .note-form .anchor.preview {
      position: relative;
      padding-right: 24px;
      font-style: normal;
    }
    .anchor-clear {
      position: absolute;
      top: 0;
      right: 0;
      padding: 0 6px;
      font-size: 14px;
      color: var(--fg-dim);
    }

    .floating-add-note {
      position: fixed;
      z-index: 50;
      background: var(--accent);
      color: #15151b;
      border: 1px solid var(--accent);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      animation: fadeIn 0.12s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* End-session confirmation modal — 3-button choice (cancel / discard /
       save+feedback) so the user can't accidentally lose their practice
       run by hitting the wrong key. */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      z-index: 100;
      animation: fadeIn 0.15s ease-out;
    }
    .modal-card {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 101;
      width: min(480px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      overflow-y: auto;
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px 24px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
      animation: modalIn 0.18s ease-out;
    }
    @keyframes modalIn {
      from { opacity: 0; transform: translate(-50%, -48%); }
      to   { opacity: 1; transform: translate(-50%, -50%); }
    }
    .modal-card h3 {
      margin: 0 0 14px;
      font-size: 18px;
      font-weight: 500;
      color: var(--fg);
    }
    .modal-card p {
      margin: 0 0 10px;
      font-size: 14px;
      line-height: 1.55;
      color: var(--fg);
    }
    .modal-warning {
      color: var(--fg-dim);
      font-size: 13px;
      padding: 10px 12px;
      background: rgba(208, 116, 116, 0.06);
      border-left: 2px solid var(--danger);
      border-radius: 4px;
    }
    .modal-warning strong { color: var(--danger); font-weight: 500; }
    .modal-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 18px;
    }
    .modal-actions button {
      flex-shrink: 0;
    }
    @media (max-width: 480px) {
      .modal-actions {
        flex-direction: column-reverse;
        align-items: stretch;
      }
      .modal-actions button {
        width: 100%;
        min-height: 44px;
      }
    }
  `],
})
export class ChatComponent implements OnInit, AfterViewChecked, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);
  protected state = inject(SessionStateService);
  protected voice = inject(VoiceService);
  protected recognition = inject(RecognitionService);
  protected prefs = inject(PreferencesService);

  @ViewChild('scroll', { static: false })
  private scrollEl?: ElementRef<HTMLElement>;

  draft = '';
  sending = signal(false);

  // End-of-session UX:
  // - "Отримати фідбек" button = direct path → /feedback page (streams)
  // - "Завершити" button = open dialog → choice between feedback or discard
  endDialogOpen = signal(false);
  discarding = signal(false);

  notes = signal<Note[]>([]);
  noteDraft = '';
  savingNote = signal(false);
  anchorPreview = signal<string | null>(null);
  selectionAnchor = signal<SelectionAnchor | null>(null);
  notesOpen = signal<boolean>(false);

  // Hint coach: opens a popover with 3 strategic next-reply suggestions.
  // Visibility of the trigger button is gated by `prefs.hintsEnabled()`.
  hintsLoading = signal(false);
  hintsOpen = signal(false);
  hintsError = signal<string | null>(null);
  hints = signal<HintSuggestion[]>([]);

  private startedAt = Date.now();
  private nowMs = signal(Date.now());
  elapsedMin = computed(() => (this.nowMs() - this.startedAt) / 60000);
  elapsedDisplay = computed(() => {
    const total = Math.max(0, Math.floor((this.nowMs() - this.startedAt) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  });
  private tickHandle?: number;

  private sessionId = 0;
  private shouldScroll = false;

  async ngOnInit() {
    this.sessionId = Number(this.route.snapshot.paramMap.get('sessionId'));
    const bubbles = this.state.bubbles();
    if (bubbles.length === 0) {
      void this.router.navigate(['/']);
      return;
    }
    this.startedAt = Date.now();
    this.tickHandle = window.setInterval(() => this.nowMs.set(Date.now()), 1000);

    const last = bubbles[bubbles.length - 1];
    if (last?.role === 'assistant' && !last.pending) {
      this.voice.speak(last.content);
    }
    try {
      this.notes.set(await this.api.listNotes(this.sessionId));
    } catch {
      // noop on first session
    }
  }

  ngAfterViewChecked() {
    if (this.shouldScroll && this.scrollEl) {
      this.scrollEl.nativeElement.scrollTop = this.scrollEl.nativeElement.scrollHeight;
      this.shouldScroll = false;
    }
  }

  ngOnDestroy() {
    this.voice.cancel();
    this.recognition.stop();
    if (this.tickHandle) clearInterval(this.tickHandle);
  }

  toggleMic() {
    this.voice.cancel();
    this.recognition.toggle((text) => {
      this.draft = text;
    });
  }

  // ─── Hint coach ────────────────────────────────────────────────────────

  /**
   * Open the hint popover and request 3 next-reply suggestions. If the
   * popover was already open, just close it (toggle behavior).
   */
  async toggleHints() {
    if (this.hintsOpen()) {
      this.hintsOpen.set(false);
      return;
    }
    if (this.hintsLoading()) return;
    this.hintsOpen.set(true);
    this.hintsError.set(null);
    this.hints.set([]);
    this.hintsLoading.set(true);
    try {
      const res = await this.api.requestHint(this.sessionId);
      this.hints.set(res.suggestions ?? []);
      if ((res.suggestions ?? []).length === 0) {
        this.hintsError.set('Модель не повернула жодного варіанту.');
      }
    } catch (e: unknown) {
      // HttpClient errors come back as HttpErrorResponse — Angular's default
      // .message is "Http failure response for ...: 503", useless to user.
      // The actual server-side message lives at e.error.message (NestJS
      // exception filter shape: { statusCode, message, error }).
      const httpErr = e as { status?: number; error?: { message?: string }; message?: string };
      const msg =
        httpErr.error?.message ||
        (httpErr.status === 503
          ? 'Модель тимчасово недоступна (rate-limit OpenRouter). Зачекай 30s і спробуй ще.'
          : null) ||
        httpErr.message ||
        'Не вдалось отримати підказку.';
      this.hintsError.set(msg);
    } finally {
      this.hintsLoading.set(false);
    }
  }

  /**
   * Click on a suggestion → fill the composer textarea. Don't auto-send;
   * student should be able to tweak the wording before committing.
   */
  applyHint(s: HintSuggestion) {
    this.draft = s.text;
    this.hintsOpen.set(false);
    // Move focus + caret to the end so the student can edit immediately.
    queueMicrotask(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.composer textarea');
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    });
  }

  hintKindLabel(k: HintSuggestion['kind']): string {
    return {
      'open-question': 'Open question',
      'reflection': 'Reflection',
      'summary': 'Summary',
      'screening': 'Скринінг',
      'here-and-now': 'Here-and-now',
      'psychoeducation': 'Психоосвіта',
      'closing': 'Закриття',
      'other': '·',
    }[k] ?? '·';
  }

  toggleNotes() {
    this.notesOpen.update((v) => !v);
  }

  closeNotes() {
    this.notesOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.notesOpen()) this.closeNotes();
  }

  @HostListener('document:selectionchange')
  onSelectionChange() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.selectionAnchor.set(null);
      return;
    }
    const text = sel.toString().trim();
    if (text.length < 3) {
      this.selectionAnchor.set(null);
      return;
    }
    const anchor = sel.anchorNode?.parentElement;
    if (!anchor || !anchor.closest('.bubble')) {
      this.selectionAnchor.set(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    this.selectionAnchor.set({
      text,
      rectTop: Math.max(8, rect.top - 36),
      rectLeft: rect.left + rect.width / 2 - 50,
    });
  }

  addAnchorFromSelection() {
    const a = this.selectionAnchor();
    if (!a) return;
    this.anchorPreview.set(a.text);
    this.selectionAnchor.set(null);
    document.getSelection()?.removeAllRanges();
    // On mobile, open the notes bottom-sheet so user can type immediately
    this.notesOpen.set(true);
    // Focus note textarea after sheet opens (transition ~280ms)
    setTimeout(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.note-form textarea');
      ta?.focus();
    }, 320);
  }

  clearAnchor() {
    this.anchorPreview.set(null);
  }

  async saveNote() {
    const text = this.noteDraft.trim();
    if (!text || this.savingNote()) return;
    this.savingNote.set(true);
    try {
      const note = await this.api.createNote(this.sessionId, {
        noteText: text,
        anchorText: this.anchorPreview() ?? undefined,
      });
      this.notes.update((arr) => [...arr, note]);
      this.noteDraft = '';
      this.anchorPreview.set(null);
      // On mobile auto-close sheet so user sees chat. On desktop no-op.
      if (window.innerWidth <= 880) {
        this.closeNotes();
      }
    } catch {
      alert('Не вдалося зберегти нотатку.');
    } finally {
      this.savingNote.set(false);
    }
  }

  async deleteNote(id: number) {
    try {
      await this.api.deleteNote(this.sessionId, id);
      this.notes.update((arr) => arr.filter((n) => n.id !== id));
    } catch {
      // noop
    }
  }

  async send() {
    const text = this.draft.trim();
    if (!text || this.sending()) return;
    this.recognition.stop();
    this.sending.set(true);
    this.draft = '';
    this.state.push({ role: 'user', content: text });
    this.state.push({ role: 'assistant', content: '…', pending: true });
    this.shouldScroll = true;

    try {
      const { reply } = await this.api.sendMessage(this.sessionId, text);
      this.state.replaceLast({ role: 'assistant', content: reply });
      this.voice.speak(reply);
    } catch (e: unknown) {
      this.state.replaceLast({
        role: 'assistant',
        content: '[помилка надсилання, спробуй ще раз]',
      });
    } finally {
      this.sending.set(false);
      this.shouldScroll = true;
    }
  }

  // ─── End / discard session ──────────────────────────────────────────────

  /**
   * "Отримати фідбек" button — direct save-and-feedback path. No prompt —
   * the button label tells the user exactly what happens. Stops voice +
   * mic, navigates to /feedback which then calls /end-stream and streams
   * supervisor tokens live (single round-trip ends + streams).
   */
  getFeedback() {
    this.voice.cancel();
    this.recognition.stop();
    this.endDialogOpen.set(false);
    void this.router.navigate(['/session', this.sessionId, 'feedback']);
  }

  /** "Завершити" button — opens confirmation modal, doesn't navigate yet. */
  openEndDialog() {
    this.endDialogOpen.set(true);
  }

  closeEndDialog() {
    if (this.discarding()) return; // protect against close-during-delete
    this.endDialogOpen.set(false);
  }

  /**
   * Hard-delete this session (modal "Видалити сесію" button). Removes
   * session + all its messages + notes via cascade — "як така що не
   * розпочиналась". After success, navigate back to patient list; the
   * sessions tab won't show this run, sessionCount won't include it,
   * patientMemory tied to this session is gone.
   */
  async discardSession() {
    if (this.discarding()) return;
    this.discarding.set(true);
    try {
      await this.api.discardSession(this.sessionId);
      this.voice.cancel();
      this.recognition.stop();
      this.endDialogOpen.set(false);
      void this.router.navigate(['/']);
    } catch {
      this.discarding.set(false);
      alert('Не вдалось видалити сесію. Спробуй ще раз або вийди вручну.');
    }
  }
}
