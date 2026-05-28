import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { HealthService } from './health.service';

/**
 * GET /api/health — load balancer probe.
 *
 * Returns:
 *  - 200 { status: "ok" }              when ready to serve traffic
 *  - 503 { status: "shutting_down" }   once SIGTERM landed; tells Caddy
 *                                       to stop sending new requests
 *                                       here while in-flight ones drain
 *
 * Caddy's health-check polls every 5s. The handful of seconds between
 * SIGTERM landing and Caddy noticing is bounded by `lb_try_duration`:
 * if a request lands here in that window, Caddy retries on the sibling
 * replica.
 */
// Exempt from the global rate limiter — Caddy's LB probe hits this every
// few seconds on every replica; throttling it could falsely mark the API
// unhealthy and break the load balancer.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get()
  @HttpCode(HttpStatus.OK)
  check(@Res() res: Response): void {
    if (this.health.shuttingDown) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: 'shutting_down',
        activeStreams: this.health.activeStreamCount,
      });
      return;
    }
    res.json({ status: 'ok' });
  }
}
