import { Injectable, signal } from '@angular/core';

export interface ChatBubble {
  role: 'user' | 'assistant';
  content: string;
  /** True while the assistant reply is being generated — UI shows it
   *  as a typing bubble. Cleared once the reply lands. */
  pending?: boolean;
  /** True when the user's message failed to send (network error, 5xx,
   *  LLM timeout). The bubble stays visible — same content the user
   *  typed — with a red ring and Retry / Delete actions, à la Telegram /
   *  WhatsApp. Cleared on successful retry. */
  failed?: boolean;
  /** Client-side id used to address a specific bubble for retry or
   *  delete. Generated when the user sends; assistant bubbles also
   *  get one but it's rarely needed there. */
  clientId?: number;
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

  /** Drop the last bubble. Used to clear the pending assistant typing
   *  indicator when the user message it was waiting on errored out. */
  removeLast() {
    this.bubbles.update((arr) => arr.slice(0, -1));
  }

  /** Patch a bubble in place — used to flip `failed: true` on a user
   *  bubble after sendMessage threw, or `failed: false` on retry. */
  updateByClientId(clientId: number, patch: Partial<ChatBubble>) {
    this.bubbles.update((arr) =>
      arr.map((b) => (b.clientId === clientId ? { ...b, ...patch } : b)),
    );
  }

  /** Remove a specific bubble — used by the "Delete" action on a failed
   *  message. Also used by retry() to lift the failed bubble out of its
   *  old position so we can re-push it at the bottom in send order. */
  removeByClientId(clientId: number): ChatBubble | undefined {
    let removed: ChatBubble | undefined;
    this.bubbles.update((arr) => {
      const next = arr.filter((b) => {
        if (b.clientId === clientId) {
          removed = b;
          return false;
        }
        return true;
      });
      return next;
    });
    return removed;
  }
}
