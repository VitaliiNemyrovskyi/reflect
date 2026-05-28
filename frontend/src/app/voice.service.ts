import { Injectable, inject, signal } from '@angular/core';
import { I18nService } from './i18n.service';
import { AuthService } from './auth.service';

const STORAGE_KEY = 'reflect.muted';

@Injectable({ providedIn: 'root' })
export class VoiceService {
  private readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthService);
  readonly muted = signal<boolean>(this.readStored());
  readonly speaking = signal<boolean>(false);
  readonly engine = signal<'elevenlabs' | 'browser' | 'unknown'>('unknown');

  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private currentAudio: HTMLAudioElement | null = null;
  private currentObjectUrl: string | null = null;
  private supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  private elevenlabsAvailable: boolean | null = null;
  private speakSeq = 0;

  constructor() {
    if (this.supported) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }
    void this.probeElevenlabs();
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
      // Send current locale so the backend picks the right neural voice
      // (uk → Polina, en → Sonia, fr → Denise). We don't have character
      // gender/age plumbed yet — default voice per lang for now.
      body: JSON.stringify({ text, voice: this.i18n.lang() }),
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
    };
    audio.onended = () => {
      this.speaking.set(false);
      this.currentAudio = null;
      if (this.currentObjectUrl === url) {
        URL.revokeObjectURL(url);
        this.currentObjectUrl = null;
      }
    };
    audio.onerror = () => {
      this.speaking.set(false);
      this.currentAudio = null;
    };
    void audio.play().catch(() => {
      this.speaking.set(false);
    });
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
