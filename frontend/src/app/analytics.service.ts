import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

/**
 * Fire-and-forget telemetry pipe. Every call to track() schedules a
 * POST /api/events. Errors are swallowed silently — analytics must
 * NEVER break the user experience, only feed the funnel dashboard.
 *
 * The 200ms debounce/batch isn't strictly necessary at our traffic
 * but it amortizes overhead if a component fires several events in
 * one frame (e.g. routing transitions). Calls in the same tick send
 * separately for now — we'll batch when needed.
 *
 * Auth: the global HttpInterceptor attaches the Bearer token if the
 * user is logged in. Anonymous requests work too — backend hashes
 * IP+UA into anonHash for them.
 */
@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  private http = inject(HttpClient);

  /**
   * @param type   one of the known event types (server validates)
   * @param props  optional small payload (<500 chars after JSON)
   * @param sessionId  optional session id for chat-flow events
   */
  track(
    type: string,
    props?: Record<string, unknown>,
    sessionId?: number,
  ): void {
    // Fire-and-forget. Don't await. Swallow errors.
    try {
      this.http
        .post('/api/events', { type, props, sessionId })
        .subscribe({
          next: () => undefined,
          error: () => undefined,
        });
    } catch {
      // even synchronous setup errors are silenced
    }
  }
}
