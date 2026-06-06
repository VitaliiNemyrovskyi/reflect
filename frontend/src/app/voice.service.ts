import { Injectable, inject, signal } from '@angular/core';
import { I18nService } from './i18n.service';
import { AuthService } from './auth.service';

const STORAGE_KEY = 'reflect.muted';

type Gender = 'female' | 'male';

@Injectable({ providedIn: 'root' })
export class VoiceService {
  private readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthService);
  readonly muted = signal<boolean>(this.readStored());
  readonly speaking = signal<boolean>(false);
  readonly engine = signal<'elevenlabs' | 'browser' | 'unknown'>('unknown');
  /**
   * Live speech amplitude (0..1) while a TTS clip plays — drives the
   * audio-reactive patient tile in video-call mode. Real RMS for the blob
   * (neural-TTS) path via a Web Audio AnalyserNode tap; stays 0 on the
   * SpeechSynthesis fallback (no media element to analyse), where the UI
   * falls back to a synthetic pulse keyed off `speaking()`.
   */
  readonly level = signal<number>(0);

  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelRaf: number | null = null;
  /** Elements already routed via createMediaElementSource — it may be
   *  called at most once per element, so we never re-tap one. */
  private readonly tapped = new WeakSet<HTMLAudioElement>();

  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private currentAudio: HTMLAudioElement | null = null;
  private currentObjectUrl: string | null = null;
  private supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  private elevenlabsAvailable: boolean | null = null;
  private speakSeq = 0;
  /** Gender of the currently active patient — set explicitly by
   *  chat.component on session load from `sv.character.gender` (the
   *  Character.gender DB column). Sent to /api/tts so the sidecar
   *  picks the male voice (Ostap/Ryan/Henri) for male patients
   *  instead of always defaulting to female. Null = unknown → sidecar
   *  falls back to the female default. No name-based guessing happens
   *  on this side any more — single source of truth lives on the
   *  Character schema. */
  private currentGender: Gender | null = null;
  /** Patient id pinned alongside gender; sent to /api/tts so the backend
   *  resolves a per-character voice (temperament: speed/pitch/tone). */
  private currentCharacterId: number | null = null;

  constructor() {
    if (this.supported) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }
    void this.probeElevenlabs();
  }

  /**
   * Pin a character's gender to subsequent speak() calls. Called by
   * chat.component once per session load with `sv.character.gender`
   * (the persisted DB column). Pass null to clear the pin — speak()
   * will then fall back to the sidecar's female default.
   *
   * Explicit gender only; we removed the name-based guesser. Source of
   * truth is Character.gender on the backend.
   */
  setGender(gender: Gender | null) {
    this.currentGender = gender;
  }

  /** Pin the speaking patient's id (set with gender by chat.component on
   *  session load). Drives the backend's per-character voice mapping. */
  setCharacterId(id: number | null) {
    this.currentCharacterId = id;
  }

  speak(text: string) {
    if (this.muted() || !text.trim()) return;
    this.cancel();
    const seq = ++this.speakSeq;
    void this.speakAsync(text, seq);
  }

  cancel() {
    this.speakSeq++;
    if (this.supported) window.speechSynthesis.cancel();
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = '';
      this.currentAudio = null;
    }
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
    this.speaking.set(false);
    this.stopLevel();
    this.currentUtterance = null;
  }

  toggleMute() {
    const next = !this.muted();
    this.muted.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {}
    if (next) this.cancel();
  }

  private async speakAsync(text: string, seq: number) {
    // Try ElevenLabs first if known available; if unknown, attempt and degrade
    const tryEleven = this.elevenlabsAvailable !== false;
    if (tryEleven) {
      try {
        const blob = await this.fetchElevenlabs(text);
        if (seq !== this.speakSeq) return; // cancelled
        this.elevenlabsAvailable = true;
        this.engine.set('elevenlabs');
        this.playBlob(blob, seq);
        return;
      } catch (e) {
        // Likely 503 (no key) or 401/429 — fall back
        this.elevenlabsAvailable = false;
      }
    }
    if (seq !== this.speakSeq) return;
    this.speakBrowser(text);
  }

  private async fetchElevenlabs(text: string): Promise<Blob> {
    // We use raw fetch (not Angular HttpClient) so the audio response
    // can stream as a Blob. That means the global auth interceptor —
    // which attaches the Bearer token to HttpClient requests — does
    // NOT run here. We MUST attach it manually or every TTS call comes
    // back 401. The auth service exposes the current access token as
    // a signal; we read it synchronously per request so token refreshes
    // are picked up automatically.
    const token = this.auth.accessToken();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'accept-language': this.i18n.lang(),
    };
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers,
      // - voice  : bare lang ('uk'|'en'|'fr'); backend forwards to the
      //            sidecar which picks the actual neural voice id.
      // - gender : 'male' | 'female' from Character.gender, pinned by
      //            chat.component on session load via setGender(). Sidecar
      //            routes male → Ostap/Ryan/Henri, female → Polina/
      //            Sonia/Denise. Null gracefully falls back to female on
      //            the sidecar side.
      body: JSON.stringify({
        text,
        voice: this.i18n.lang(),
        gender: this.currentGender,
        // Omitted when null (JSON.stringify drops undefined) → backend
        // falls back to a gender-only voice.
        characterId: this.currentCharacterId ?? undefined,
      }),
    });
    if (!res.ok) {
      throw new Error(`tts ${res.status}`);
    }
    return await res.blob();
  }

  private playBlob(blob: Blob, seq: number) {
    if (this.currentObjectUrl) URL.revokeObjectURL(this.currentObjectUrl);
    const url = URL.createObjectURL(blob);
    this.currentObjectUrl = url;
    const audio = new Audio(url);
    this.currentAudio = audio;
    audio.onplay = () => {
      if (seq !== this.speakSeq) {
        audio.pause();
        return;
      }
      this.speaking.set(true);
      this.startLevel(audio);
    };
    audio.onended = () => {
      this.speaking.set(false);
      this.stopLevel();
      this.currentAudio = null;
      if (this.currentObjectUrl === url) {
        URL.revokeObjectURL(url);
        this.currentObjectUrl = null;
      }
    };
    audio.onerror = () => {
      this.speaking.set(false);
      this.stopLevel();
      this.currentAudio = null;
    };
    void audio.play().catch(() => {
      this.speaking.set(false);
    });
  }

  /**
   * Tap the playing audio element through a Web Audio analyser so the
   * video-call tile can pulse with the patient's voice. Safety: we connect
   * the source straight to the destination FIRST — if any later step throws
   * (or the browser lacks AudioContext), audio still plays; we just lose the
   * reactive animation. createMediaElementSource may run once per element,
   * so each TTS clip (a fresh Audio) is tapped at most once.
   */
  private startLevel(audio: HTMLAudioElement) {
    try {
      if (!this.audioCtx) {
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        this.audioCtx = new Ctx();
      }
      const ctx = this.audioCtx;
      void ctx.resume();
      if (!this.tapped.has(audio)) {
        const source = ctx.createMediaElementSource(audio);
        source.connect(ctx.destination); // keep audio audible no matter what
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser); // side tap — needs no onward connection
        this.analyser = analyser;
        this.tapped.add(audio);
      }
    } catch {
      this.analyser = null; // animation falls back to the speaking() pulse
    }
    this.runLevelLoop();
  }

  private runLevelLoop() {
    const analyser = this.analyser;
    if (!analyser) {
      this.level.set(0);
      return;
    }
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (!this.analyser) {
        this.level.set(0);
        return;
      }
      this.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      // Scale + round to ~0.02 steps so the signal only notifies on real
      // change (Angular dedups equal values) — keeps change-detection light.
      this.level.set(Math.round(Math.min(1, rms * 2.4) * 50) / 50);
      this.levelRaf = requestAnimationFrame(tick);
    };
    this.levelRaf = requestAnimationFrame(tick);
  }

  private stopLevel() {
    if (this.levelRaf !== null) {
      cancelAnimationFrame(this.levelRaf);
      this.levelRaf = null;
    }
    this.level.set(0);
  }

  private speakBrowser(text: string) {
    if (!this.supported) return;
    this.engine.set('browser');
    const lang = this.i18n.lang();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = { uk: 'uk-UA', en: 'en-GB', fr: 'fr-FR' }[lang] ?? 'uk-UA';
    u.rate = 0.95;
    u.pitch = 1.0;
    const voice = this.pickVoice(lang);
    if (voice) u.voice = voice;
    u.onstart = () => this.speaking.set(true);
    u.onend = () => {
      this.speaking.set(false);
      this.currentUtterance = null;
    };
    u.onerror = () => {
      this.speaking.set(false);
      this.currentUtterance = null;
    };
    this.currentUtterance = u;
    window.speechSynthesis.speak(u);
  }

  private async probeElevenlabs() {
    try {
      const res = await fetch('/api/tts/status');
      if (!res.ok) {
        this.elevenlabsAvailable = false;
        return;
      }
      const json = (await res.json()) as { enabled: boolean };
      this.elevenlabsAvailable = json.enabled;
      if (json.enabled) this.engine.set('elevenlabs');
      else this.engine.set(this.supported ? 'browser' : 'unknown');
    } catch {
      this.elevenlabsAvailable = false;
    }
  }

  private pickVoice(lang: string = 'uk'): SpeechSynthesisVoice | null {
    if (!this.supported) return null;
    const voices = window.speechSynthesis.getVoices();
    // Voice priority by current locale: native OS voices first, with a
    // soft preference for female (matches our patient gender mix), then
    // any voice in that lang, finally any close relative.
    if (lang === 'en') {
      const en = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
      if (en.length > 0) {
        const enFemale = en.find((v) => /samantha|jenny|amy|kate|allison|female/i.test(v.name));
        return enFemale ?? en[0];
      }
    }
    if (lang === 'fr') {
      const fr = voices.filter((v) => v.lang.toLowerCase().startsWith('fr'));
      if (fr.length > 0) {
        const frFemale = fr.find((v) => /amelie|amélie|audrey|julie|virginie|female/i.test(v.name));
        return frFemale ?? fr[0];
      }
    }
    const ukraine = voices.filter((v) => v.lang.toLowerCase().startsWith('uk'));
    if (ukraine.length > 0) {
      const female = ukraine.find((v) =>
        /lesya|олена|olena|tetyana|анна|anna|ukrainian/i.test(v.name),
      );
      return female ?? ukraine[0];
    }
    const russian = voices.filter((v) => v.lang.toLowerCase().startsWith('ru'));
    if (russian.length > 0) {
      return russian.find((v) => /milena|katya|female|жен/i.test(v.name)) ?? russian[0];
    }
    return null;
  }

  private readStored(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  }
}
