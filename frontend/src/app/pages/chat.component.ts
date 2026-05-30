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
import { ApiService, HintSuggestion, Note, PsychTestSummary, SessionTest } from '../api.service';
import { I18nService } from '../i18n.service';
import { SessionStateService } from '../session-state.service';
import { VoiceService } from '../voice.service';
import { RecognitionService } from '../recognition.service';
import { PreferencesService } from '../preferences.service';
import { TestModalComponent } from '../test-modal.component';
import { TestResultCardComponent } from '../test-result-card.component';
import { IconComponent } from '../icon.component';

interface SelectionAnchor {
  text: string;
  rectTop: number;
  rectLeft: number;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [FormsModule, TestModalComponent, TestResultCardComponent, IconComponent],
  template: `
    <header class="chat-header" [class.video]="mode() === 'video'">
      <div class="left">
        <!-- Video mode labels the patient on the call tile (Zoom-style), so a
             header name would be a third duplicate (tile + caption). Show it
             only in chat mode; video header = timer + mode toggle. -->
        @if (mode() !== 'video') {
          <h2>{{ state.characterDisplayName() ?? 'Клієнт' }}</h2>
        }
        <span class="timer"
              [class.warn]="elapsedMin() >= 35"
              [title]="elapsedMin() >= 35 ? 'Орієнтовний час закриття інтейк-сесії' : 'Час сесії'">
          <app-icon name="clock" /> {{ elapsedDisplay() }}
        </span>
      </div>
      <div class="actions">
        <div class="mode-toggle" role="group" aria-label="Режим сесії">
          <button class="mode-btn" [class.active]="mode() === 'chat'"
                  (click)="setMode('chat')" title="Чат" aria-label="Чат"><app-icon name="message" /></button>
          <button class="mode-btn" [class.active]="mode() === 'video'"
                  (click)="setMode('video')" title="Відеодзвінок" aria-label="Відеодзвінок"><app-icon name="video" /></button>
        </div>
        <!-- In video mode the bottom controls bar owns mute / notes / end,
             so the header stays minimal (name · timer · mode toggle). -->
        @if (mode() === 'chat') {
        <button
          class="ghost icon mobile-only"
          [class.has-notes]="notes().length > 0"
          [attr.aria-label]="i18n.t('chat.notes') + ' (' + notes().length + ')'"
          [title]="i18n.t('chat.notes')"
          (click)="toggleNotes()">
          <app-icon name="pencil" />{{ notes().length > 0 ? ' ' + notes().length : '' }}
        </button>
        <button
          class="ghost icon"
          [class.active]="!voice.muted()"
          [attr.aria-label]="voice.muted() ? 'Увімкнути голос' : 'Вимкнути голос'"
          [title]="voice.muted() ? 'Увімкнути голос' : 'Вимкнути голос'"
          (click)="voice.toggleMute()">
          <app-icon [name]="voice.muted() ? 'volume-off' : 'volume'" />
        </button>
        <button class="ghost end-btn" (click)="openEndDialog()" [title]="i18n.t('chat.end_session')">
          {{ i18n.t('chat.end_session') }}
        </button>
        <button class="primary feedback-btn" (click)="getFeedback()" [title]="i18n.t('chat.get_feedback')">
          {{ i18n.t('chat.get_feedback') }}
        </button>
        }
      </div>
    </header>

    @if (mode() === 'chat') {
    <div class="chat-layout">
      <section class="chat-main">
        <div #scroll class="messages" aria-live="polite">
          @for (b of state.bubbles(); track $index) {
            <div class="bubble fx-fade-up"
                 [class.user]="b.role === 'user'"
                 [class.assistant]="b.role === 'assistant'"
                 [class.typing]="b.pending"
                 [class.failed]="b.failed">
              {{ b.content }}
              @if (b.role === 'assistant' && !b.pending) {
                <button class="replay"
                        title="Озвучити"
                        aria-label="Озвучити репліку"
                        (click)="voice.speak(b.content)"><app-icon name="volume" /></button>
              }
              @if (b.failed && b.clientId !== undefined) {
                <!-- Telegram/WhatsApp pattern: keep the user's text
                     visible, show a red marker + actions row to retry
                     or delete. Tapping Retry re-sends through the
                     normal pipeline; if it fails again, the bubble
                     simply gets re-marked as failed at the new spot. -->
                <div class="bubble-failed-row">
                  <span class="failed-icon"
                        [attr.aria-label]="i18n.t('chat.failed_label')"
                        [title]="i18n.t('chat.failed_label')">⚠</span>
                  <button type="button"
                          class="failed-action retry"
                          [disabled]="sending()"
                          (click)="retryFailed(b.clientId)">
                    ↻ {{ i18n.t('chat.failed_retry') }}
                  </button>
                  <button type="button"
                          class="failed-action delete"
                          [disabled]="sending()"
                          (click)="deleteFailed(b.clientId)">
                    × {{ i18n.t('chat.failed_delete') }}
                  </button>
                </div>
              }
            </div>
          }

          <!-- Test result cards appear inline at the bottom of the
               message stream so they scroll with the chat. Order is
               administration time (sessionTests is pushed-to, not
               re-sorted). Pending cards show a loading state until
               the LLM resolves. -->
          @for (t of sessionTests(); track t.id) {
            <app-test-result-card
              [test]="t"
              [summary]="summaryFor(t.testKey)" />
          }
        </div>

        @if (testModalOpen()) {
          <app-test-modal
            (picked)="onTestPicked($event)"
            (close)="testModalOpen.set(false)" />
        }

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
            } @else if (hints().length) {
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
            } @else {
              <p class="hints-status">Не вдалось підготувати варіанти. Спробуй ще раз.</p>
            }
          </div>
        }

        <form class="composer" (ngSubmit)="send()">
          <textarea
            rows="2"
            [(ngModel)]="draft"
            name="draft"
            [placeholder]="i18n.t('chat.placeholder')"
            [disabled]="sending()"
            (ngModelChange)="saveDraft()"
            (keydown.meta.enter)="send()"
            (keydown.control.enter)="send()"></textarea>
          <!-- Action icons grouped so they can flow into a sub-row on
               mobile (display: contents on desktop keeps them as direct
               flex children of .composer; on mobile this becomes a real
               flex container in the grid's "tools" area). -->
          <div class="composer-tools">
            @if (prefs.hintsEnabled()) {
              <button type="button"
                      class="ghost icon hint-trigger"
                      [class.active]="hintsOpen()"
                      [class.loading]="hintsLoading()"
                      [disabled]="sending()"
                      [attr.aria-label]="i18n.t('chat.hint_label')"
                      [title]="i18n.t('chat.hint_label')"
                      (click)="toggleHints()">
                <app-icon name="lightbulb" />
              </button>
            }
            <!-- Psychological test trigger — opens the catalog modal so
                 the therapist can pick a test for the AI patient to take
                 (PHQ-9, GAD-7, WHO-5, PSS-10). Disabled while a test is
                 already being administered. -->
            <button type="button"
                    class="ghost icon test-trigger"
                    [class.loading]="loadingTestKey() !== null"
                    [disabled]="sending() || loadingTestKey() !== null"
                    aria-label="Запропонувати тест"
                    title="Запропонувати психологічний тест"
                    (click)="testModalOpen.set(true)">
              <app-icon name="clipboard" />
            </button>
            @if (recognition.supported) {
              <button type="button"
                      class="ghost icon mic"
                      [class.listening]="recognition.listening()"
                      [attr.aria-label]="recognition.listening() ? 'Зупинити запис' : 'Говорити'"
                      [title]="recognition.listening() ? 'Зупинити запис' : 'Говорити'"
                      [disabled]="sending()"
                      (click)="toggleMic()">
                <app-icon [name]="recognition.listening() ? 'square' : 'mic'" />
              </button>
            }
          </div>
          <button class="primary send-btn" type="submit" [disabled]="sending() || !draft.trim()">
            {{ i18n.t('chat.send') }}
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
          <h3>{{ i18n.t('chat.notes') }} {{ notes().length ? '(' + notes().length + ')' : '' }}</h3>
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
            [placeholder]="i18n.t('chat.note_placeholder')"
            (keydown.meta.enter)="saveNote()"
            (keydown.control.enter)="saveNote()"></textarea>
          <button type="submit" class="primary"
                  [disabled]="!noteDraft.trim() || savingNote()">
            {{ savingNote() ? '…' : i18n.t('chat.notes') }}
          </button>
        </form>
      </aside>
    </div>
    }

    @if (mode() === 'video') {
      <div class="video-stage">
        <div class="vtile patient"
             [class.speaking]="voice.speaking()"
             [class.dragging]="dragArmed"
             [style.--lvl]="voice.level()"
             (pointerdown)="onTilePointerDown($event)"
             (pointermove)="onTilePointerMove($event)"
             (pointerup)="onTilePointerUp()"
             (pointercancel)="onTilePointerUp()"
             (pointerleave)="onTilePointerUp()">
          @if (state.characterAvatar(); as a) {
            <img class="vtile-img" [src]="a" [alt]="state.characterDisplayName() ?? ''" />
          } @else {
            <div class="vtile-initials">{{ patientInitials() }}</div>
          }
          <div class="vtile-glow"></div>
          <div class="vtile-name">
            <span>{{ state.characterDisplayName() ?? 'Клієнт' }}</span>
            @if (voice.speaking()) {
              <span class="speaking-eq" aria-hidden="true"><i></i><i></i><i></i></span>
            }
          </div>
          @if (sending()) {
            <div class="vtile-typing">{{ (state.characterDisplayName() ?? 'Клієнт') }} відповідає…</div>
          }
        </div>

        @if (captionsOn() && lastLine(); as line) {
          <div class="captions" [class.mine]="line.role === 'user'">
            <span class="cap-who">{{ line.role === 'user' ? 'Ти' : (state.characterDisplayName() ?? 'Клієнт') }}</span>
            <p>{{ line.content }}</p>
          </div>
        }

        @if (videoComposerOpen()) {
          <form class="vcomposer" (ngSubmit)="send(); videoComposerOpen.set(false)">
            <input type="text" [(ngModel)]="draft" name="vdraft" autocomplete="off"
                   placeholder="Напишіть повідомлення…" />
            <button type="submit" class="vsend" [disabled]="sending() || !draft.trim()">→</button>
          </form>
        }

        <div class="vbar" role="toolbar" aria-label="Керування дзвінком">
          @if (recognition.supported) {
            <button class="vbtn" [class.live]="recognition.listening()" (click)="videoMic()"
                    [title]="recognition.listening() ? 'Стоп і надіслати' : 'Говорити'"
                    [attr.aria-label]="recognition.listening() ? 'Стоп і надіслати' : 'Говорити'">
              <app-icon [name]="recognition.listening() ? 'square' : 'mic'" />
            </button>
          }
          <button class="vbtn" [class.off]="voice.muted()" (click)="voice.toggleMute()"
                  [title]="voice.muted() ? 'Увімкнути звук' : 'Вимкнути звук'"
                  aria-label="Звук пацієнта"><app-icon [name]="voice.muted() ? 'volume-off' : 'volume'" /></button>
          <button class="vbtn" [class.off]="!captionsOn()" (click)="toggleCaptions()"
                  title="Субтитри" aria-label="Субтитри"><app-icon name="captions" /></button>
          <button class="vbtn" [class.live]="transcriptOpen()" (click)="toggleTranscript()"
                  title="Транскрипт і нотатки" aria-label="Транскрипт і нотатки"><app-icon name="pencil" /></button>
          <button class="vbtn" [class.live]="videoComposerOpen()"
                  (click)="videoComposerOpen.set(!videoComposerOpen())"
                  title="Написати текстом" aria-label="Написати текстом"><app-icon name="keyboard" /></button>
          <button class="vbtn end" (click)="openEndDialog()" title="Завершити"
                  aria-label="Завершити сесію"><app-icon name="phone" /></button>
        </div>

        <!-- Right-side transcript + notes drawer. Opened by the 📝 .vbar
             button or by dragging the patient tile right. Backdrop closes
             it on tap; the panel slides in via translateX. Reuses the exact
             notes mechanism from the chat notes panel (notes()/noteDraft/
             saveNote()) so there's a single notes path. -->
        @if (transcriptOpen()) {
          <div class="vdrawer-backdrop" (click)="closeTranscript()" aria-hidden="true"></div>
        }
        <aside class="vdrawer" [class.open]="transcriptOpen()"
               role="dialog" aria-label="Транскрипт розмови і нотатки">
          <header class="vdrawer-head">
            <h3>Транскрипт</h3>
            <button class="vdrawer-close" type="button"
                    (click)="closeTranscript()" aria-label="Закрити">×</button>
          </header>

          <div class="vdrawer-body">
            <section class="vdrawer-transcript">
              <div #transcriptScroll class="vtranscript-scroll" aria-live="polite">
                @for (b of state.bubbles(); track $index) {
                  @if (!b.pending) {
                    <div class="vline" [class.mine]="b.role === 'user'">
                      <span class="vline-who">
                        {{ b.role === 'user' ? 'Ти' : (state.characterDisplayName() ?? 'Клієнт') }}
                      </span>
                      <p class="vline-text">{{ b.content }}</p>
                    </div>
                  }
                }
                @if (lastLine() === null) {
                  <p class="vdrawer-empty">Розмова ще не почалась.</p>
                }
              </div>
            </section>

            <section class="vdrawer-notes">
              <header class="vdrawer-notes-head">
                <h4>{{ i18n.t('chat.notes') }} {{ notes().length ? '(' + notes().length + ')' : '' }}</h4>
              </header>
              <ul class="vnotes-list">
                @for (n of notes(); track n.id) {
                  <li class="vnote">
                    @if (n.anchorText) {
                      <blockquote class="vnote-anchor">«{{ n.anchorText }}»</blockquote>
                    }
                    <p class="vnote-body">{{ n.noteText }}</p>
                    <button class="vnote-delete" type="button" title="Видалити нотатку"
                            (click)="deleteNote(n.id)" aria-label="Видалити нотатку">✕</button>
                  </li>
                }
                @if (notes().length === 0) {
                  <li class="vnote-empty">Поки порожньо.</li>
                }
              </ul>
              <form class="vnote-form" (ngSubmit)="saveNote()">
                <textarea
                  rows="2"
                  [(ngModel)]="noteDraft"
                  name="vNoteDraft"
                  [placeholder]="i18n.t('chat.note_placeholder')"
                  (keydown.meta.enter)="saveNote()"
                  (keydown.control.enter)="saveNote()"></textarea>
                <button type="submit" class="primary"
                        [disabled]="!noteDraft.trim() || savingNote()">
                  {{ savingNote() ? '…' : i18n.t('chat.notes') }}
                </button>
              </form>
            </section>
          </div>
        </aside>
      </div>
    }

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
        <h3 id="end-dialog-title">{{ i18n.t('chat.end_dialog_title') }}</h3>
        <p>{{ i18n.t('chat.end_dialog_subtitle') }}</p>

        <!-- Primary path: complete the session normally. Big and at the
             top so a stressed user (LLM timeout, etc.) can't miss it. -->
        <div class="modal-primary-actions">
          <button class="primary big" (click)="getFeedback()" [disabled]="discarding()">
            ✓ {{ i18n.t('chat.get_feedback') }}
          </button>
          <button class="ghost" (click)="closeEndDialog()" [disabled]="discarding()">
            {{ i18n.t('chat.confirm_no') }}
          </button>
        </div>

        <!-- Destructive path: separated visually + behind a two-step
             confirmation. Pre-Phase-1 there was a single "Так, завершити"
             button right next to "Отримати фідбек" that looked benign
             and read as "yes, complete" — a stressed therapist clicked
             it and lost 40 messages. Now: collapsed by default, the
             "discard" verb is explicit, and clicking opens a confirm-
             phase that surfaces the patient's name and a final red
             confirm button. Friction lives only on the destructive
             path; the normal completion flow stays one click. -->
        <details class="modal-danger-section" [open]="discardConfirmOpen()">
          <summary (click)="discardConfirmOpen.set(!discardConfirmOpen())">
            ⚠ {{ i18n.t('chat.discard_toggle') }}
          </summary>
          @if (discardConfirmOpen()) {
            <p class="modal-warning-strong">
              {{ i18n.t('chat.discard_warning_prefix') }}
              <strong>{{ state.characterDisplayName() ?? '' }}</strong>
              {{ i18n.t('chat.discard_warning_suffix') }}
            </p>
            <button class="danger small" (click)="discardSession()" [disabled]="discarding()">
              {{ discarding() ? '…' : i18n.t('chat.discard_confirm') }}
            </button>
          }
        </details>
      </div>
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; flex: 1; }
    /* Sticky chat header — pins at the top of the viewport when the
       message stream scrolls past. The translucent backdrop + blur
       keeps it legible while the bubbles slide underneath.
       Horizontal margin/padding tradeoff bleeds the bg across the
       shell's 20px side padding so messages don't peek through at
       the edges of a sticky header. top respects the iOS safe area. */
    .chat-header {
      position: sticky;
      top: var(--safe-top, 0px);
      z-index: 10;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin: 0 -20px;
      padding: 12px 20px 14px;
      background: color-mix(in srgb, var(--bg) 78%, transparent);
      backdrop-filter: blur(20px) saturate(140%);
      -webkit-backdrop-filter: blur(20px) saturate(140%);
      border-bottom: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border));
    }
    /* Video mode: minimal, immersive — the header floats borderless over the
       dark call stage (name · timer · mode toggle only; everything else lives
       in the bottom controls bar). */
    .chat-header.video {
      background: transparent;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      border-bottom: none;
      padding-bottom: 6px;
    }
    h2 { font-size: 22px; margin: 0; font-weight: 500; }
    @media (max-width: 720px) {
      h2 { font-size: 18px; }
      /* Let the bar wrap instead of overflowing the viewport: the action
         buttons flow onto a second line (right-aligned) when they don't fit. */
      .chat-header { flex-wrap: wrap; row-gap: 8px; }
      .chat-header .danger,
      .chat-header .end-btn,
      .chat-header .feedback-btn { padding: 8px 12px; font-size: 13px; }
      .chat-header .icon { padding: 8px 10px; font-size: 16px; min-width: 44px; min-height: 44px; }
      .left { gap: 8px; flex-shrink: 1; min-width: 0; }
      .left h2 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .actions { flex: 1 1 100%; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
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
      /* minmax(0, 1fr) — without the explicit 0 minimum, the grid
         column auto-expands to fit min-content of children (long
         composer rows, wide bubbles), forcing horizontal scroll on
         mobile. The 0 minimum lets the column shrink to viewport. */
      .chat-layout { grid-template-columns: minmax(0, 1fr); }
    }

    .chat-main {
      display: flex;
      flex-direction: column;
      min-width: 0;
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
    /* Chat bubbles get the Synapse accent-tint treatment — soft
       inner radial wash from the corner anchor (right for user,
       left for assistant) plus an accent-toned border so messages
       feel like distinct surfaces against the ambient body wash. */
    .bubble {
      position: relative;
      max-width: 85%;
      padding: 12px 16px;
      border-radius: 14px;
      white-space: pre-wrap;
      word-wrap: break-word;
      border: 1px solid color-mix(in srgb, var(--accent) 12%, var(--border));
      user-select: text;
    }
    .bubble.user {
      background:
        radial-gradient(ellipse 80% 80% at 100% 100%,
          color-mix(in srgb, var(--accent) 14%, transparent) 0%,
          transparent 65%),
        color-mix(in srgb, var(--accent) 5%, var(--user-bg));
      align-self: flex-end;
      border-bottom-right-radius: 4px;
      border-color: color-mix(in srgb, var(--accent) 22%, var(--border));
    }
    .bubble.assistant {
      background:
        radial-gradient(ellipse 80% 80% at 0% 100%,
          color-mix(in srgb, var(--accent) 8%, transparent) 0%,
          transparent 70%),
        color-mix(in srgb, var(--accent) 3%, var(--assistant-bg));
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    .bubble.typing { color: var(--fg-dim); font-style: italic; }
    /* Failed-send state, Telegram-style: keep the message visible (so
       the user sees what didn't go through) with a red border + tint,
       and surface Retry / Delete inline so they don't have to retype.
       The override beats the .user gradient by being later in cascade. */
    .bubble.failed {
      border-color: var(--danger) !important;
      background:
        radial-gradient(ellipse 60% 60% at 100% 100%,
          color-mix(in srgb, var(--danger) 14%, transparent) 0%,
          transparent 70%),
        color-mix(in srgb, var(--danger) 4%, var(--user-bg));
    }
    .bubble-failed-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed color-mix(in srgb, var(--danger) 35%, transparent);
      font-size: 12px;
    }
    .failed-icon {
      color: var(--danger);
      font-size: 14px;
      line-height: 1;
    }
    .failed-action {
      background: transparent;
      border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
      color: var(--danger);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      min-height: auto;
      line-height: 1.2;
    }
    .failed-action:hover:not(:disabled) {
      background: color-mix(in srgb, var(--danger) 10%, transparent);
    }
    .failed-action:disabled { opacity: 0.5; cursor: not-allowed; }
    .failed-action.retry { font-weight: 500; }
    .failed-action.delete { color: var(--fg-dim); border-color: var(--border); }
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
      min-width: 0;  /* without this, textarea natural min-content keeps composer wider than viewport on mobile */
      resize: vertical;
      min-height: 44px;
      max-height: 200px;
    }
    /* On desktop, the wrapper is laid out as-if-absent — its three
       icon-buttons participate directly in the .composer flex row so
       the desktop layout stays identical to before (textarea, 💡, 📋,
       🎙, Send all on one line). On mobile, a media query below
       upgrades this to a real flex container in the grid's tools row. */
    .composer-tools { display: contents; }
    .mic {
      padding: 10px 14px;
      font-size: 18px;
      line-height: 1;
      align-self: stretch;
    }
    @media (max-width: 720px) {
      /* Mobile composer: textarea gets the full row width (no more
         60-70px crammed cell), and the secondary controls split into
         a second row — tool icons on the left, Send on the right. This
         is the WhatsApp/iMessage layout pattern: big primary input,
         compact action group below. */
      .composer {
        display: grid;
        grid-template-columns: 1fr auto;
        grid-template-areas:
          "input input"
          "tools send";
        gap: 8px;
        padding-top: 10px;
      }
      .composer textarea {
        grid-area: input;
        min-height: 80px;        /* taller default — comfortable to type */
        font-size: 16px;         /* prevents iOS zoom-on-focus */
      }
      .composer-tools {
        grid-area: tools;
        display: flex;
        gap: 8px;
        align-self: center;
      }
      .composer .send-btn {
        grid-area: send;
        min-height: 48px;
        min-width: 100px;
        padding: 12px 18px;
        font-size: 15px;
        font-weight: 500;
      }
      .composer .mic,
      .composer .hint-trigger,
      .composer .test-trigger {
        min-height: 48px;
        min-width: 48px;
        padding: 10px 12px;
        font-size: 20px;
        align-self: auto;        /* stretch was relevant only on flex row */
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
    /* Test trigger — mirror the hint button styling so they form a
       coherent action group in the composer. Loading state pulses
       while the AI patient is "filling in" the test. */
    .test-trigger {
      padding: 10px 14px;
      font-size: 18px;
      line-height: 1;
      align-self: stretch;
    }
    .test-trigger.loading {
      animation: pulse 1.2s ease-in-out infinite;
      color: var(--accent);
      border-color: var(--accent);
    }
    /* Mobile sizing for tool icons lives in the .composer media query
       above — keeping all composer-related responsive rules in one block
       so the grid layout + icon dimensions stay coupled. */

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

    /* Notes side-panel: accent-toned vertical divider as a left border
       (matches Synapse hairlines across the rest of the app). */
    .notes-panel {
      display: flex;
      flex-direction: column;
      border-left: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border));
      padding-left: 22px;
      min-height: 0;
    }
    .mobile-only { display: none; }
    @media (max-width: 880px) {
      .mobile-only { display: inline-flex; }
      /* Mobile: notes panel becomes a bottom-sheet */
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
      /* Backdrop only relevant on mobile */
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

    /* End-session dialog: primary path is big and obvious, destructive
       path is collapsed and visually distinct. The whole point is the
       therapist who's just stressed by an LLM timeout can't fat-finger
       the wrong button and lose 40 messages. */
    .modal-primary-actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 18px;
    }
    .modal-primary-actions .primary.big {
      padding: 14px 22px;
      font-size: 16px;
      font-weight: 500;
      min-height: 52px;
    }
    .modal-primary-actions .ghost {
      padding: 10px 18px;
    }
    .modal-danger-section {
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px dashed var(--border);
    }
    .modal-danger-section summary {
      cursor: pointer;
      font-size: 12px;
      color: var(--fg-dim);
      list-style: none;
      user-select: none;
    }
    .modal-danger-section summary::-webkit-details-marker { display: none; }
    .modal-danger-section summary:hover { color: var(--danger); }
    .modal-danger-section[open] summary { color: var(--danger); margin-bottom: 10px; }
    .modal-warning-strong {
      font-size: 13px;
      padding: 10px 12px;
      background: rgba(208, 116, 116, 0.1);
      border: 1px solid var(--danger);
      border-radius: 6px;
      margin: 0 0 12px;
      color: var(--fg);
    }
    .modal-warning-strong strong { color: var(--danger); }
    .modal-danger-section .danger.small {
      width: 100%;
      padding: 10px 16px;
      font-size: 13px;
      min-height: 40px;
    }

    /* ── Mode toggle (chat | video) in the header ── */
    .mode-toggle {
      display: inline-flex;
      gap: 2px;
      padding: 2px;
      border: 1px solid var(--border);
      border-radius: 9px;
      background: color-mix(in srgb, var(--accent) 4%, transparent);
    }
    .mode-btn {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 16px;
      line-height: 0;
      padding: 6px 9px;
      border-radius: 7px;
      color: var(--fg-dim);
      transition: background .15s ease, color .15s ease;
    }
    .mode-btn:hover { color: var(--fg); }
    .mode-btn.active {
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      color: var(--accent);
    }

    /* ── Video-call stage (Meet/Zoom-style) ── */
    .video-stage {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 18px;
      min-height: calc(100dvh - 150px);
      padding: 16px 12px 28px;
    }
    .vtile {
      position: relative;
      width: min(520px, 88vw);
      aspect-ratio: 4 / 3;
      border-radius: 18px;
      overflow: hidden;
      background:
        radial-gradient(120% 120% at 50% 30%, color-mix(in srgb, var(--accent) 14%, #14141c), #0c0c12);
      border: 1px solid var(--border);
      box-shadow: 0 18px 50px -20px rgba(0,0,0,0.7);
      /* idle "breathing" so the tile never feels frozen */
      animation: vtile-breathe 6s ease-in-out infinite;
      transition: box-shadow .12s linear, transform .12s linear;
      will-change: transform;
    }
    @keyframes vtile-breathe {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.012); }
    }
    .vtile-img {
      width: 100%; height: 100%;
      object-fit: cover;
      display: block;
    }
    .vtile-initials {
      width: 100%; height: 100%;
      display: flex; align-items: center; justify-content: center;
      font-size: 84px; font-weight: 600;
      color: color-mix(in srgb, var(--accent) 70%, #fff);
    }
    /* speaking: amplitude (--lvl 0..1) drives micro-zoom + accent glow.
       A base glow + the breathing keep it alive even on the SpeechSynthesis
       fallback where --lvl stays 0. */
    .vtile.speaking {
      transform: scale(calc(1 + var(--lvl, 0) * 0.05));
      box-shadow:
        0 18px 50px -20px rgba(0,0,0,0.7),
        0 0 calc(18px + var(--lvl, 0) * 46px) color-mix(in srgb, var(--accent) 55%, transparent);
      animation: none;
    }
    .vtile-glow {
      position: absolute; inset: 0;
      border-radius: inherit;
      pointer-events: none;
      box-shadow: inset 0 0 0 2px transparent;
    }
    .vtile.speaking .vtile-glow {
      box-shadow: inset 0 0 0 calc(2px + var(--lvl, 0) * 4px)
        color-mix(in srgb, var(--accent) 70%, transparent);
      animation: vtile-ring 1.3s ease-in-out infinite;
    }
    @keyframes vtile-ring {
      0%, 100% { opacity: 0.55; }
      50% { opacity: 1; }
    }
    .vtile-name {
      position: absolute; left: 12px; bottom: 12px;
      display: inline-flex; align-items: center; gap: 8px;
      padding: 5px 12px;
      border-radius: 999px;
      background: rgba(0,0,0,0.5);
      backdrop-filter: blur(6px);
      color: #fff; font-size: 13px; font-weight: 500;
    }
    .speaking-eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; }
    .speaking-eq i {
      width: 3px; height: 100%;
      background: var(--accent);
      border-radius: 2px;
      animation: eq 0.9s ease-in-out infinite;
    }
    .speaking-eq i:nth-child(2) { animation-delay: 0.15s; }
    .speaking-eq i:nth-child(3) { animation-delay: 0.3s; }
    @keyframes eq {
      0%, 100% { transform: scaleY(0.35); }
      50% { transform: scaleY(1); }
    }
    .vtile-typing {
      position: absolute; right: 12px; bottom: 12px;
      padding: 4px 10px; border-radius: 999px;
      background: rgba(0,0,0,0.5); backdrop-filter: blur(6px);
      color: var(--fg-dim); font-size: 12px;
    }

    .captions {
      max-width: min(560px, 90vw);
      text-align: center;
      color: #fff;
      background: rgba(0,0,0,0.5);
      backdrop-filter: blur(6px);
      border-radius: 12px;
      padding: 10px 16px;
    }
    .captions .cap-who {
      display: block;
      font-size: 11px; letter-spacing: .05em; text-transform: uppercase;
      color: var(--accent); margin-bottom: 3px;
    }
    .captions.mine .cap-who { color: var(--fg-dim); }
    .captions p { margin: 0; font-size: 15px; line-height: 1.45; }

    .vcomposer {
      display: flex; gap: 8px;
      width: min(560px, 92vw);
    }
    .vcomposer input {
      flex: 1; min-width: 0;
      padding: 11px 14px; font-size: 14px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--user-bg); color: var(--fg);
    }
    .vcomposer input:focus { outline: none; border-color: var(--accent); }
    .vsend {
      flex: 0 0 auto; width: 44px;
      border-radius: 50%; border: none; cursor: pointer;
      background: var(--accent); color: #1a1430; font-size: 18px;
    }
    .vsend:disabled { opacity: .5; cursor: default; }

    .vbar {
      display: inline-flex; gap: 12px;
      padding: 10px 14px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent) 5%, rgba(0,0,0,0.35));
      border: 1px solid var(--border);
      backdrop-filter: blur(8px);
    }
    .vbtn {
      width: 48px; height: 48px;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: var(--user-bg);
      color: var(--fg);
      font-size: 19px; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: background .15s ease, border-color .15s ease, color .15s ease;
    }
    .vbtn:hover { border-color: var(--accent); }
    .vbtn.live {
      background: var(--accent);
      border-color: var(--accent);
      color: #1a1430;
      animation: vbtn-pulse 1.4s ease-in-out infinite;
    }
    @keyframes vbtn-pulse {
      0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); }
      50% { box-shadow: 0 0 0 7px transparent; }
    }
    .vbtn.off { color: var(--fg-dim); opacity: 0.7; }
    .vbtn.end {
      background: var(--danger);
      border-color: var(--danger);
      color: #fff;
      font-size: 17px;
    }

    @media (max-width: 560px) {
      .video-stage { min-height: calc(100dvh - 130px); gap: 14px; padding-top: 8px; }
      /* Phone: a bigger, portrait tile — fills the width and shows the
         face larger, like a real video call on a phone. */
      .vtile { width: 94vw; aspect-ratio: 4 / 5; }
      .vbtn { width: 44px; height: 44px; font-size: 17px; }
    }

    /* While the user is dragging the tile, suppress the breathing/zoom
       animations and show the grab cursor so the gesture reads as draggable.
       touch-action lets the browser keep vertical panning while we own the
       horizontal drag, so the gesture never fights page scroll. */
    .vtile { touch-action: pan-y; cursor: grab; }
    .vtile.dragging { cursor: grabbing; animation: none; }

    /* Right-side transcript + notes drawer in video mode. Anchored to the
       video-stage (position: relative). Slides in from the right via
       translateX. Mobile width ~88vw, desktop ~380px. Own scroll. */
    /* Fixed (viewport-anchored), not absolute: the .video-stage's right
       edge is inset by the shell padding, so an absolutely-positioned
       drawer translated 100% still left a sliver peeking on the right.
       z-index above the global app header so it reads as a full overlay. */
    .vdrawer-backdrop {
      position: fixed;
      inset: 0;
      z-index: 108;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
      animation: fadeIn 0.16s ease-out;
    }
    .vdrawer {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 109;
      width: 88vw;
      max-width: 380px;
      display: flex;
      flex-direction: column;
      background: color-mix(in srgb, var(--accent) 4%, var(--bg));
      border-left: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border));
      box-shadow: -18px 0 50px -20px rgba(0, 0, 0, 0.75);
      transform: translateX(100%);
      transition: transform 0.26s cubic-bezier(0.4, 0, 0.2, 1);
      will-change: transform;
    }
    .vdrawer.open { transform: translateX(0); }
    .vdrawer-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 14px 16px;
      border-bottom: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border));
    }
    .vdrawer-head h3 {
      margin: 0;
      font-size: 16px;
      font-weight: 500;
      color: var(--fg);
    }
    .vdrawer-close {
      background: transparent;
      border: none;
      color: var(--fg-dim);
      font-size: 26px;
      line-height: 1;
      cursor: pointer;
      padding: 0 6px;
      min-height: auto;
    }
    .vdrawer-close:hover { color: var(--fg); }

    /* Body splits into a flexible transcript region (scrolls) and a
       notes region pinned below it. Both live inside the drawer's column. */
    .vdrawer-body {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .vdrawer-transcript {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .vtranscript-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .vdrawer-empty,
    .vnote-empty {
      color: var(--fg-dim);
      font-size: 13px;
      font-style: italic;
    }
    /* One transcript line: speaker label + text. Therapist (Ти) lines tint
       with the user-bg, the patient with assistant-bg, mirroring the chat
       bubbles so the two views feel like the same conversation. */
    .vline {
      border-radius: 10px;
      padding: 8px 11px;
      background: var(--assistant-bg);
      border: 1px solid color-mix(in srgb, var(--accent) 8%, var(--border));
    }
    .vline.mine {
      background: color-mix(in srgb, var(--accent) 6%, var(--user-bg));
      border-color: color-mix(in srgb, var(--accent) 16%, var(--border));
    }
    .vline-who {
      display: block;
      font-size: 10px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--fg-dim);
      margin-bottom: 3px;
    }
    .vline.mine .vline-who { color: var(--accent); }
    .vline-text {
      margin: 0;
      font-size: 14px;
      line-height: 1.45;
      color: var(--fg);
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    /* Notes region — same composer + list as the chat notes panel, just
       compact. Bounded height with its own scroll so a long note list
       never pushes the composer off-screen. */
    .vdrawer-notes {
      flex: 0 0 auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      border-top: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border));
      padding: 12px 16px calc(12px + var(--safe-bottom));
      background: color-mix(in srgb, var(--accent) 6%, var(--bg));
    }
    .vdrawer-notes-head h4 {
      margin: 0;
      font-size: 13px;
      font-weight: 500;
      color: var(--fg-dim);
      letter-spacing: 0.02em;
    }
    .vnotes-list {
      list-style: none;
      padding: 0;
      margin: 0;
      max-height: 28vh;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .vnote {
      position: relative;
      background: var(--assistant-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 28px 8px 10px;
      font-size: 13px;
    }
    .vnote-anchor {
      margin: 0 0 5px;
      padding: 0 0 0 8px;
      border-left: 2px solid var(--accent);
      color: var(--fg-dim);
      font-size: 12px;
      font-style: italic;
    }
    .vnote-body { margin: 0; white-space: pre-wrap; color: var(--fg); }
    .vnote-delete {
      position: absolute;
      top: 4px;
      right: 4px;
      padding: 2px 7px;
      font-size: 12px;
      background: transparent;
      border: none;
      color: var(--fg-dim);
      opacity: 0.55;
      cursor: pointer;
      min-height: auto;
    }
    .vnote:hover .vnote-delete { opacity: 1; }
    .vnote-form {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .vnote-form textarea {
      resize: vertical;
      min-height: 44px;
      max-height: 160px;
      font-size: 14px;
    }
    .vnote-form .primary { align-self: stretch; }
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
  readonly i18n = inject(I18nService);

  @ViewChild('scroll', { static: false })
  private scrollEl?: ElementRef<HTMLElement>;

  /** Scroll container of the video-mode transcript drawer — used to
   *  auto-scroll to the newest line when the drawer opens. */
  @ViewChild('transcriptScroll', { static: false })
  private transcriptScrollEl?: ElementRef<HTMLElement>;

  draft = '';
  sending = signal(false);

  // End-of-session UX:
  // - "Отримати фідбек" button = direct path → /feedback page (streams)
  // - "Завершити" button = open dialog → choice between feedback or discard
  endDialogOpen = signal(false);
  /** Two-step confirmation for the destructive "discard session" path
   *  in the end-session dialog. Defaults closed; users have to open
   *  the <details> AND click the explicit red button to actually
   *  delete. Past one-click trap caused a therapist to lose 40
   *  messages they thought they were saving. */
  discardConfirmOpen = signal(false);
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

  // ─── Video-call mode ───────────────────────────────────────────────────
  // Toggle between the classic chat and a Meet/Zoom-style call. The patient
  // tile animates with the TTS voice (voice.level()/voice.speaking()). Mode
  // is persisted globally so the trainee's preference sticks across sessions.
  mode = signal<'chat' | 'video'>(this.readMode());
  captionsOn = signal<boolean>(true);
  videoComposerOpen = signal<boolean>(false);

  // ─── Video-mode transcript + notes drawer ──────────────────────────────
  // A right-anchored drawer (mobile-first) that shows the running transcript
  // and reuses the SAME notes mechanism the chat notes panel uses
  // (notes() + noteDraft + saveNote()). It opens two ways: the 📝 button in
  // the .vbar, or by dragging the patient tile to the right past a threshold.
  transcriptOpen = signal<boolean>(false);
  /** Pointer-drag bookkeeping for the drag-the-tile-right open gesture.
   *  We keep it dead simple so pointermove does almost no work: just record
   *  where the press started, then on each move check if we've crossed the
   *  open threshold. `armed` guards against starting a drag from a 2nd finger
   *  or a press that began outside the tile. */
  private dragStartX = 0;
  private dragStartY = 0;
  /** protected (not private): the template reads it for the .dragging class. */
  protected dragArmed = false;
  /** Drag distance (px) to the right that opens the drawer. */
  private readonly DRAG_OPEN_THRESHOLD = 60;

  /** Last non-pending line — the live caption in video mode. */
  lastLine = computed(() => {
    const bubbles = this.state.bubbles();
    for (let i = bubbles.length - 1; i >= 0; i--) {
      if (!bubbles[i].pending) return bubbles[i];
    }
    return null;
  });
  /** Initials shown on the tile when the patient has no avatar. */
  patientInitials = computed(() => {
    const name = this.state.characterDisplayName() ?? '';
    return (
      name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() ?? '')
        .join('') || '🙂'
    );
  });

  // Psychological tests admin'd during this session. Cards render
  // below the message stream and above the composer.
  testModalOpen = signal(false);
  /** Tests that have been administered this session (any status). */
  sessionTests = signal<SessionTest[]>([]);
  /** Catalog summaries cached so the result card can show
   *  fullNameUa + scoreRange without an extra fetch. Loaded once. */
  private testCatalog = signal<Map<string, PsychTestSummary>>(new Map());
  /** Which test key is currently mid-administration (for the
   *  spinner on the composer button). null when idle. */
  loadingTestKey = signal<string | null>(null);

  /** Helper for the template — looks up the catalog summary for a
   *  given test row so the result card can render its full title +
   *  scoreRange even though SessionTest itself doesn't carry them. */
  summaryFor(testKey: string): PsychTestSummary | null {
    return this.testCatalog().get(testKey) ?? null;
  }

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
    let bubbles = this.state.bubbles();
    // Empty bubbles = direct URL hit / refresh / new tab. In that case
    // we hydrate state from the API instead of redirecting home —
    // critical for mobile UX, where pull-to-refresh is one swipe away.
    // If session ended, we send the user to the read-only view; if the
    // session doesn't exist or belongs to someone else, we bounce home.
    if (bubbles.length === 0) {
      try {
        const sv = await this.api.viewSession(this.sessionId);
        if (sv.endedAt) {
          // Session already finished — route to /view, not /chat.
          void this.router.navigate(['/session', this.sessionId, 'view']);
          return;
        }
        this.state.reset(sv.character.displayName, sv.character.gender, sv.character.avatarUrl);
        // Pin the patient's gender on voice.service so /api/tts gets it
        // and the sidecar picks the right voice (male → Ostap/Ryan/Henri,
        // female → Polina/Sonia/Denise). Source of truth = Character.gender
        // column. Null is acceptable — sidecar defaults to female.
        this.voice.setGender(sv.character.gender);
        for (const m of sv.messages) {
          this.state.push({ role: m.role as 'user' | 'assistant', content: m.content });
        }
        bubbles = this.state.bubbles();
        if (bubbles.length === 0) {
          // Empty session (no messages persisted) — treat as broken, go home.
          void this.router.navigate(['/']);
          return;
        }
      } catch {
        void this.router.navigate(['/']);
        return;
      }
    } else {
      // Bubbles were already in state (in-app navigation). Re-pin the
      // voice service with the cached gender so the new patient's voice
      // takes over instead of carrying over from the previous session.
      this.voice.setGender(this.state.characterGender());
    }
    this.startedAt = Date.now();
    this.tickHandle = window.setInterval(() => this.nowMs.set(Date.now()), 1000);

    // Restore any draft the user had typed before they navigated away
    // (browser crash, accidental back nav, refresh). Per-session key so
    // drafts don't bleed between unrelated chats.
    const restored = this.readDraft();
    if (restored) this.draft = restored;

    // Load the test catalog summaries + any session tests already
    // administered (in case the page was refreshed mid-session).
    // Both run in the background — chat is functional even without.
    void this.api.listPsychTests()
      .then((tests) => {
        const map = new Map(tests.map((t) => [t.key, t]));
        this.testCatalog.set(map);
      })
      .catch(() => { /* no-op: modal still works, just won't preload */ });
    void this.api.listSessionTests(this.sessionId)
      .then((tests) => this.sessionTests.set(tests))
      .catch(() => { /* no-op: session has no tests yet */ });

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

  /** localStorage key — namespaced per-session so a draft in session A
   *  doesn't pop up in session B. */
  private draftKey(): string {
    return `reflect:chat-draft:${this.sessionId}`;
  }
  private readDraft(): string {
    try { return localStorage.getItem(this.draftKey()) ?? ''; } catch { return ''; }
  }
  /** Called on every keystroke from the textarea's (ngModelChange).
   *  Writes synchronously — localStorage at <1KB is fast and the user
   *  never has to wait. Empty drafts are removed to keep storage tidy. */
  saveDraft() {
    try {
      const v = this.draft;
      if (v && v.trim()) localStorage.setItem(this.draftKey(), v);
      else localStorage.removeItem(this.draftKey());
    } catch {
      // Storage quota or private mode — silently degrade, user can still
      // type normally; they just lose autosave for this session.
    }
  }
  private clearDraft() {
    try { localStorage.removeItem(this.draftKey()); } catch { /* noop */ }
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

  // ─── Video-call mode ───────────────────────────────────────────────────

  private readMode(): 'chat' | 'video' {
    try {
      return localStorage.getItem('reflect.sessionMode') === 'video' ? 'video' : 'chat';
    } catch {
      return 'chat';
    }
  }

  setMode(m: 'chat' | 'video') {
    this.mode.set(m);
    try {
      localStorage.setItem('reflect.sessionMode', m);
    } catch {}
    // Leaving video: stop listening so the mic doesn't linger in chat mode.
    if (m === 'chat') this.recognition.stop();
  }

  toggleCaptions() {
    this.captionsOn.update((v) => !v);
  }

  /**
   * Video-mode mic: tap to talk, tap again to stop — and on stop, auto-send
   * whatever was dictated (a call feels like "speak, then it's sent"). Falls
   * back to the composer (⌨) for typing when STT isn't available.
   */
  videoMic() {
    if (this.recognition.listening()) {
      this.recognition.stop();
      if (this.draft.trim()) void this.send();
    } else {
      this.voice.cancel();
      this.recognition.toggle((text) => {
        this.draft = text;
      });
    }
  }

  // ─── Video-mode transcript + notes drawer ──────────────────────────────

  toggleTranscript() {
    if (this.transcriptOpen()) this.closeTranscript();
    else this.openTranscript();
  }

  openTranscript() {
    this.transcriptOpen.set(true);
    // Jump to the newest line once the drawer's content has rendered.
    // queueMicrotask is too early (the @if block hasn't been laid out yet),
    // so a 0ms timeout lets Angular paint the list first.
    setTimeout(() => this.scrollTranscriptToBottom(), 60);
  }

  closeTranscript() {
    this.transcriptOpen.set(false);
  }

  private scrollTranscriptToBottom() {
    const el = this.transcriptScrollEl?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  /**
   * Drag-the-tile-right to open the drawer. We use pointer events so one
   * code path covers mouse + touch + pen. The handlers are intentionally
   * thin: pointerdown just records the origin, pointermove only measures
   * and (once) trips the open, pointerup resets. We do NOT preventDefault
   * or call setPointerCapture, so a plain tap on the tile is untouched —
   * the gesture only fires after a real horizontal drag past the threshold.
   */
  onTilePointerDown(e: PointerEvent) {
    // Only track the primary button / first touch; ignore if the drawer
    // is already open (nothing to open) — a drag-to-close lives on the
    // backdrop/panel instead.
    if (this.transcriptOpen()) return;
    this.dragArmed = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
  }

  onTilePointerMove(e: PointerEvent) {
    if (!this.dragArmed) return;
    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;
    // Open only on a clearly-horizontal rightward drag past the threshold.
    // Requiring |dx| > |dy| keeps a vertical scroll/scrub from tripping it.
    if (dx > this.DRAG_OPEN_THRESHOLD && dx > Math.abs(dy)) {
      this.dragArmed = false;
      this.openTranscript();
    }
  }

  onTilePointerUp() {
    this.dragArmed = false;
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
    const text = (s.text ?? '').trim();
    // Defensive: a suggestion must be a sendable therapist line, never raw
    // model output. Refuse a code-fence / JSON blob so it can't be dropped
    // into the composer and sent (the session #74 L27 failure mode).
    if (!text || text.startsWith('```') || /^\{\s*"/.test(text)) {
      this.hintsOpen.set(false);
      return;
    }
    this.draft = text;
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

  /**
   * Therapist picked a test from the modal — administer it to the AI
   * patient. We close the modal immediately so the UI doesn't feel
   * frozen, push a 'pending' placeholder into sessionTests for the
   * loading card, then let the backend's LLM call resolve. On
   * success / failure we replace the placeholder with the real row.
   */
  async onTestPicked(testKey: string) {
    this.testModalOpen.set(false);
    if (this.loadingTestKey()) return; // already administering one
    this.loadingTestKey.set(testKey);

    // Optimistic placeholder so the loading card appears right away.
    const placeholder: SessionTest = {
      id: -Date.now(),
      sessionId: this.sessionId,
      testKey,
      status: 'pending',
      answers: null,
      rawScore: null,
      scaledScore: null,
      severity: null,
      severityLabel: null,
      aiAnalysis: null,
      requestedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.sessionTests.update((arr) => [...arr, placeholder]);
    this.shouldScroll = true;

    try {
      const result = await this.api.administerTest(this.sessionId, testKey);
      // Backend returns answersJson; we keep both for ease — the
      // result card uses .answers when present.
      const enriched: SessionTest = {
        ...result,
        answers: result.answersJson ? JSON.parse(result.answersJson) : null,
      };
      // Swap the placeholder for the real row.
      this.sessionTests.update((arr) =>
        arr.map((t) => (t.id === placeholder.id ? enriched : t)),
      );
    } catch (e: unknown) {
      // Mark placeholder failed so the user sees something went wrong.
      this.sessionTests.update((arr) =>
        arr.map((t) =>
          t.id === placeholder.id ? { ...t, status: 'failed' as const } : t,
        ),
      );
    } finally {
      this.loadingTestKey.set(null);
      this.shouldScroll = true;
    }
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    // Escape closes the topmost transient overlay: hints popover first
    // (always above), then the mobile notes sheet. Two presses to clear
    // both. Matches OS conventions — hit Esc, lose the most-recent thing.
    if (this.hintsOpen()) {
      this.hintsOpen.set(false);
      return;
    }
    if (this.transcriptOpen()) {
      this.closeTranscript();
      return;
    }
    if (this.notesOpen()) this.closeNotes();
  }

  /**
   * Cmd+K (Mac) / Ctrl+K (Windows/Linux) — open the hint coach.
   * Bound to the document so it works regardless of focus (inside the
   * composer or anywhere else on the page).
   */
  @HostListener('document:keydown', ['$event'])
  onGlobalKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      // toggleHints is async — we don't await; the user gets immediate
      // open feedback and the request resolves in the background.
      void this.toggleHints();
    }
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
    this.draft = '';
    this.clearDraft();
    const clientId = this.nextClientId();
    this.state.push({ role: 'user', content: text, clientId });
    await this.dispatchSend(text, clientId);
  }

  /**
   * Re-send a previously-failed user message. Lifts it from its old
   * spot in the transcript and re-pushes it at the bottom — server
   * appends in send-order, so this keeps UI and DB consistent. If the
   * retry also fails, the bubble gets re-marked as failed in the new
   * position.
   */
  async retryFailed(clientId: number) {
    if (this.sending()) return;
    const removed = this.state.removeByClientId(clientId);
    if (!removed || removed.role !== 'user') return;
    const fresh = this.nextClientId();
    this.state.push({ role: 'user', content: removed.content, clientId: fresh });
    await this.dispatchSend(removed.content, fresh);
  }

  /** Drop a failed message entirely — therapist decided to ditch it. */
  deleteFailed(clientId: number) {
    this.state.removeByClientId(clientId);
  }

  /**
   * Shared send pipeline used by both fresh sends and retries. Pushes
   * the pending assistant bubble, hits the API, then either replaces
   * the pending bubble with the reply OR — on error — removes the
   * pending bubble and marks the user bubble as failed so the UI shows
   * Retry / Delete actions on it.
   */
  private async dispatchSend(text: string, userClientId: number) {
    this.sending.set(true);
    this.state.push({ role: 'assistant', content: '…', pending: true });
    this.shouldScroll = true;

    try {
      const { reply } = await this.api.sendMessage(this.sessionId, text);
      this.state.replaceLast({ role: 'assistant', content: reply });
      this.voice.speak(reply);
    } catch {
      // Pull the pending typing bubble; the user bubble keeps its
      // original text but gets the `failed` flag, which the template
      // styles in red and offers Retry / Delete buttons on.
      this.state.removeLast();
      this.state.updateByClientId(userClientId, { failed: true });
    } finally {
      this.sending.set(false);
      this.shouldScroll = true;
    }
  }

  /** Monotonic per-component clientId source for bubble identity. Doesn't
   *  need to be globally unique — only used to address bubbles within
   *  this in-memory transcript. */
  private clientIdCounter = 0;
  private nextClientId(): number {
    return ++this.clientIdCounter;
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
    // Always reset the destructive section to collapsed on open — even
    // if someone closed the modal mid-flow, next open starts safe.
    this.discardConfirmOpen.set(false);
    this.endDialogOpen.set(true);
  }

  closeEndDialog() {
    if (this.discarding()) return; // protect against close-during-delete
    this.endDialogOpen.set(false);
    this.discardConfirmOpen.set(false);
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
