import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'reflect.muted';

@Injectable({ providedIn: 'root' })
export class VoiceService {
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
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
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
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'uk-UA';
    u.rate = 0.95;
    u.pitch = 1.0;
    const voice = this.pickVoice();
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

  private pickVoice(): SpeechSynthesisVoice | null {
    if (!this.supported) return null;
    const voices = window.speechSynthesis.getVoices();
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
