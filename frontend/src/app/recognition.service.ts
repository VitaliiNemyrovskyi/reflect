import { Injectable, NgZone, inject, signal } from '@angular/core';
import { I18nService } from './i18n.service';

type SR = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

interface SpeechRecognitionResultLike {
  0: { transcript: string };
  isFinal: boolean;
}
interface SpeechRecognitionEvent {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechRecognitionResultLike };
}

/**
 * Join two spoken-text fragments with exactly one separating space.
 *
 * STT delivers final segments (and the trailing interim) as separate
 * chunks with no boundary whitespace, so naive concatenation glues
 * words at sentence boundaries (e.g. «хвилин» + «Може» → «хвилинМоже»).
 * This inserts a single space only when neither side already supplies
 * boundary whitespace, and adds no leading space when `a` is empty.
 */
export function joinSpoken(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const needsSpace = !/\s$/.test(a) && !/^\s/.test(b);
  return needsSpace ? a + ' ' + b : a + b;
}

/**
 * Web Speech API wrapper for live transcription in the chat composer.
 *
 * Two non-obvious things this service does:
 *
 * 1) **Lang follows i18n** — the browser STT engine needs a BCP-47 tag
 *    (`uk-UA`, `en-GB`, `fr-FR`). Passing the wrong lang makes Chrome
 *    fire many more low-confidence interim results trying to refit the
 *    audio, which both transcribes badly and tanks frame rate. We read
 *    `i18n.lang()` at every `start()` so toggling languages in settings
 *    actually changes the STT locale.
 *
 * 2) **Interim throttling outside the Angular zone** — `onresult` can
 *    fire 10-20×/sec during continuous speech. Each fire was previously
 *    setting `chat.draft = text` inside the zone, which scheduled a
 *    full CD cycle. The chat template binds ~50+ messages, signals for
 *    the timer/tickHandle, voice/sending flags, etc., so every CD pass
 *    cost 10-30ms. At 1200 cycles/min the UI noticeably stalls — and
 *    that's the "app freezes when therapist talks a lot" report.
 *
 *    Fix: we receive `onresult` outside the zone and emit at most one
 *    update per `interimMinIntervalMs` (200 ms → 5 Hz). Finals bypass
 *    the throttle so a hard pause shows the committed text instantly.
 *    The flush always uses the latest interim, so throttled events
 *    only delay UX — they never lose words.
 */
@Injectable({ providedIn: 'root' })
export class RecognitionService {
  readonly listening = signal<boolean>(false);
  readonly supported: boolean;

  private readonly i18n = inject(I18nService);
  private readonly zone = inject(NgZone);
  private recognition: SR | null = null;
  private finalText = '';
  private onUpdate?: (text: string, isFinal: boolean) => void;

  // Throttle state. See class docs for rationale.
  private readonly interimMinIntervalMs = 200;
  private lastInterimEmit = 0;
  private pendingInterim: string | null = null;
  private pendingFlushHandle: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const w = window as unknown as {
      SpeechRecognition?: new () => SR;
      webkitSpeechRecognition?: new () => SR;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    this.supported = !!Ctor;
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = this.bcp47ForLang(this.i18n.lang());
    r.interimResults = true;
    r.continuous = true;
    // ZoneJS patches the SpeechRecognition event target — without the
    // runOutsideAngular hop, every onresult fire would trigger CD. The
    // throttled flush below re-enters the zone exactly once per emit.
    r.onresult = (e) => this.zone.runOutsideAngular(() => this.handleResult(e));
    r.onend = () => this.zone.run(() => this.listening.set(false));
    r.onerror = () => this.zone.run(() => this.listening.set(false));
    this.recognition = r;
  }

  start(onUpdate: (text: string, isFinal: boolean) => void) {
    if (!this.supported || !this.recognition) return;
    this.finalText = '';
    this.pendingInterim = null;
    this.lastInterimEmit = 0;
    this.cancelPendingFlush();
    this.onUpdate = onUpdate;
    // Re-read i18n in case the user switched languages since the last
    // session. Setting `lang` on an idle SR instance is safe; on an
    // active one it would error, but we never start() while listening.
    this.recognition.lang = this.bcp47ForLang(this.i18n.lang());
    try {
      this.recognition.start();
      this.listening.set(true);
    } catch {
      // Already started — Chrome occasionally throws on rapid toggles.
      // Bounce and retry; the listening flag will catch up via onend.
      try {
        this.recognition.stop();
        setTimeout(() => this.recognition?.start(), 100);
      } catch {}
    }
  }

  stop() {
    if (!this.supported || !this.recognition) return;
    this.cancelPendingFlush();
    this.pendingInterim = null;
    try {
      this.recognition.stop();
    } catch {}
    this.listening.set(false);
  }

  toggle(onUpdate: (text: string, isFinal: boolean) => void) {
    if (this.listening()) this.stop();
    else this.start(onUpdate);
  }

  private handleResult(e: SpeechRecognitionEvent) {
    let interim = '';
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (final) this.finalText = joinSpoken(this.finalText, final);
    const isFinal = !interim;

    if (isFinal) {
      // Finals fire on hard pauses (~1-3 per sentence). They commit
      // text into finalText, so we flush right away — users expect to
      // see committed words within a frame of stopping.
      this.flushImmediate();
      return;
    }

    // Interim path: replace any pending value with the latest snapshot.
    // Each onresult re-derives `interim` from the current results
    // array, so the newest pendingInterim is always the right thing
    // to emit — no need to merge with prior pending values.
    this.pendingInterim = interim;

    const now = performance.now();
    const elapsed = now - this.lastInterimEmit;
    if (elapsed >= this.interimMinIntervalMs) {
      this.flushImmediate();
      return;
    }
    // Trailing-edge flush guarantees the textarea catches up even if
    // results stop arriving (e.g. user trails off mid-phrase).
    if (!this.pendingFlushHandle) {
      this.pendingFlushHandle = setTimeout(
        () => this.flushImmediate(),
        this.interimMinIntervalMs - elapsed,
      );
    }
  }

  private flushImmediate() {
    this.cancelPendingFlush();
    const interim = this.pendingInterim ?? '';
    this.pendingInterim = null;
    this.lastInterimEmit = performance.now();
    const text = joinSpoken(this.finalText, interim).trim();
    const isFinal = !interim;
    // Single zone re-entry per throttled tick → at most 5 CD cycles/sec
    // instead of one per raw onresult event.
    this.zone.run(() => this.onUpdate?.(text, isFinal));
  }

  private cancelPendingFlush() {
    if (this.pendingFlushHandle) {
      clearTimeout(this.pendingFlushHandle);
      this.pendingFlushHandle = null;
    }
  }

  /** Map an i18n lang code to the BCP-47 tag the browser STT expects. */
  private bcp47ForLang(lang: string): string {
    switch (lang) {
      case 'en': return 'en-GB';
      case 'fr': return 'fr-FR';
      case 'uk':
      default:   return 'uk-UA';
    }
  }
}
