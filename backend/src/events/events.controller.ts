import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { EventsService } from './events.service';

/**
 * Public ingestion endpoint. Accepts both authenticated requests
 * (uses req.user.id) and anonymous (uses anonHash). Body shape:
 *
 *   { type: 'page.demo', props?: { ... }, sessionId?: 42 }
 *
 * Frontend AnalyticsService bundles 1-5 events into one call when
 * the user navigates rapidly, but for now we accept single events
 * only (simpler validation, same throughput on our traffic).
 */
@Controller('events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly jwt: JwtService,
  ) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async track(
    @Req() req: Request,
    @Body() body: { type: string; props?: Record<string, unknown>; sessionId?: number },
  ) {
    // Auth-optional. We marked this @Public() so the global JwtAuthGuard
    // doesn't reject anonymous /demo + /pricing visitors. As a side
    // effect req.user is also NOT populated for logged-in clients —
    // so we manually decode the Authorization header here to get the
    // userId when present. Invalid/missing token → treat as anon.
    let userId: number | null = null;
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      const token = auth.slice(7).trim();
      try {
        const payload = await this.jwt.verifyAsync<{ sub: number; type?: string }>(
          token,
          { secret: process.env.JWT_ACCESS_SECRET },
        );
        if (payload?.type === 'access' && typeof payload.sub === 'number') {
          userId = payload.sub;
        }
      } catch {
        // invalid / expired — treat as anon
      }
    }
    // Trust X-Forwarded-For (Caddy reverse-proxy sets it). Fall back
    // to req.ip. Privacy: we don't store the IP itself, only the hash.
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() ||
      req.ip ||
      'unknown';
    const ua = (req.headers['user-agent'] as string | undefined) ?? 'unknown';
    const anonHash = userId ? null : this.events.anonHash(ip, ua);

    await this.events.record({
      userId,
      anonHash,
      eventType: body.type,
      props: body.props,
      sessionId: body.sessionId ?? null,
      userAgent: ua,
    });
    return; // 204 No Content
  }
}
