import { Injectable, Logger } from '@nestjs/common';

/**
 * Tracks the API's lifecycle state for both the HTTP health endpoint
 * (Caddy load-balancer probes here) and the graceful-shutdown flow in
 * main.ts (waits for active long-running requests to drain before exit).
 *
 * The two signals it exposes:
 *   - `shuttingDown` — set by the SIGTERM handler. Health endpoint
 *     starts returning 503 the moment this flips so Caddy marks this
 *     replica as unhealthy and routes new traffic to the sibling.
 *   - `activeStreamCount` — incremented when an SSE handler starts a
 *     stream, decremented when it ends. Used as the "drain" gate:
 *     shutdown waits for this to reach zero before letting the process
 *     exit, so a 60-second feedback stream in flight isn't killed
 *     mid-token by a deploy.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private _shuttingDown = false;
  private readonly activeStreams = new Set<symbol>();

  get shuttingDown(): boolean {
    return this._shuttingDown;
  }

  get activeStreamCount(): number {
    return this.activeStreams.size;
  }

  /** Flip the shutdown flag. Idempotent. */
  beginShutdown(): void {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    this.logger.log(
      `Shutdown initiated — health endpoint now returns 503 (${this.activeStreams.size} active streams)`,
    );
  }

  /**
   * Register a long-running stream (SSE) so the drain logic can wait
   * for it. Returns an opaque token the caller MUST pass to
   * unregisterStream(), typically in a `finally` block.
   */
  registerStream(label?: string): symbol {
    const token = Symbol(label ?? 'stream');
    this.activeStreams.add(token);
    return token;
  }

  unregisterStream(token: symbol): void {
    this.activeStreams.delete(token);
  }
}
