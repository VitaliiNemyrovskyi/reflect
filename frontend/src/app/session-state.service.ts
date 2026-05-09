import { Injectable, signal } from '@angular/core';

export interface ChatBubble {
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
}

@Injectable({ providedIn: 'root' })
export class SessionStateService {
  readonly characterDisplayName = signal<string | null>(null);
  readonly bubbles = signal<ChatBubble[]>([]);

  reset(displayName: string | null = null) {
    this.characterDisplayName.set(displayName);
    this.bubbles.set([]);
  }

  push(bubble: ChatBubble) {
    this.bubbles.update((arr) => [...arr, bubble]);
  }

  replaceLast(bubble: ChatBubble) {
    this.bubbles.update((arr) => {
      const next = arr.slice(0, -1);
      next.push(bubble);
      return next;
    });
  }
}
