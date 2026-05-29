import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';
import { I18nService } from './i18n.service';

/** Outcome of an opt-in attempt — drives the settings UI feedback. */
export type PushEnableResult = 'ok' | 'denied' | 'unsupported' | 'no-keys' | 'error';

/**
 * Client side of Web Push. Registers the root-scope service worker (/sw.js),
 * requests Notification permission, subscribes via PushManager with the
 * server's VAPID public key, and registers the subscription with the backend.
 *
 * Everything is opt-in and defensive: unsupported browsers, denied permission,
 * and a push-disabled backend all resolve to a clear status rather than throw.
 */
@Injectable({ providedIn: 'root' })
export class PushClientService {
  private api = inject(ApiService);
  private i18n = inject(I18nService);

  /** True only where the full Web Push stack exists. iOS Safari < 16.4 = false. */
  get supported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      typeof window !== 'undefined' &&
      'PushManager' in window &&
      'Notification' in window
    );
  }

  get permission(): NotificationPermission | 'unsupported' {
    return this.supported ? Notification.permission : 'unsupported';
  }

  /** Whether a live push subscription already exists on this device. */
  async isSubscribed(): Promise<boolean> {
    if (!this.supported) return false;
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = await reg?.pushManager.getSubscription();
    return !!sub;
  }

  async enable(): Promise<PushEnableResult> {
    if (!this.supported) return 'unsupported';
    try {
      const { publicKey } = await this.api.getVapidPublicKey();
      if (!publicKey) return 'no-keys';

      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return 'denied';

      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));

      await this.api.pushSubscribe(sub.toJSON(), navigator.userAgent, this.i18n.lang());
      return 'ok';
    } catch {
      return 'error';
    }
  }

  async disable(): Promise<void> {
    if (!this.supported) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await this.api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
        await sub.unsubscribe().catch(() => undefined);
      }
    } catch {
      /* best-effort */
    }
  }
}

/** VAPID public key (base64url) → Uint8Array, as PushManager requires. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
