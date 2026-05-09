import { Injectable, signal } from '@angular/core';

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

@Injectable({ providedIn: 'root' })
export class RecognitionService {
  readonly listening = signal<boolean>(false);
  readonly supported: boolean;
  private recognition: SR | null = null;
  private finalText = '';
  private onUpdate?: (text: string, isFinal: boolean) => void;

  constructor() {
    const w = window as unknown as {
      SpeechRecognition?: new () => SR;
      webkitSpeechRecognition?: new () => SR;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    this.supported = !!Ctor;
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = 'uk-UA';
    r.interimResults = true;
    r.continuous = true;
    r.onresult = (e) => this.handleResult(e);
    r.onend = () => this.listening.set(false);
    r.onerror = () => this.listening.set(false);
    this.recognition = r;
  }

  start(onUpdate: (text: string, isFinal: boolean) => void) {
    if (!this.supported || !this.recognition) return;
    this.finalText = '';
    this.onUpdate = onUpdate;
    try {
      this.recognition.start();
      this.listening.set(true);
    } catch {
      // already started — restart cycle
      try {
        this.recognition.stop();
        setTimeout(() => this.recognition?.start(), 100);
      } catch {}
    }
  }

  stop() {
    if (!this.supported || !this.recognition) return;
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
    if (final) this.finalText += final;
    const text = (this.finalText + interim).trim();
    this.onUpdate?.(text, !interim);
  }
}
