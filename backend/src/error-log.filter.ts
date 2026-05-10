import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from './prisma/prisma.service';

/**
 * Global exception filter — catches everything, lets NestJS handle the
 * client response as usual, but ALSO snapshots 500-class errors into
 * the ErrorLog table so admins can see why things broke without SSH'ing
 * into the container for `docker logs`.
 *
 * Why ≥500 only:
 *  - 4xx errors are user mistakes (bad password, missing session, ...).
 *    Saving them adds noise without insight.
 *  - 5xx errors are us-on-fire moments — supervisor LLM crashed,
 *    Prisma can't reach DB, etc. These are worth storing.
 *
 * The filter is best-effort: if writing to ErrorLog itself throws (e.g.
 * because Prisma is the actual cause of the outage), we swallow that
 * second error and just log it locally. We never let the filter
 * obscure the original exception.
 */
@Catch()
export class ErrorLogFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorLogFilter.name);

  constructor(private readonly prisma: PrismaService) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { user?: { id?: number } }>();

    // Default behavior: replicate NestJS's default response shape so
    // existing API consumers see no difference.
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const body =
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: 500, message: (exception as Error)?.message ?? 'Internal server error' };

    if (!res.headersSent) {
      res.status(status).json(body);
    }

    // Log only 5xx to ErrorLog. Not awaiting the write — fire-and-forget
    // so the original response time isn't padded by a DB roundtrip.
    if (status >= 500) {
      const message = truncate(
        (exception as Error)?.message ??
          (typeof body === 'object' && body && 'message' in body
            ? String((body as { message: unknown }).message)
            : 'unknown error'),
        500,
      );
      const stack = truncate((exception as Error)?.stack ?? null, 3000);
      const sessionIdMatch = req.url?.match(/\/sessions\/(\d+)/);
      const sessionId = sessionIdMatch ? parseInt(sessionIdMatch[1], 10) : null;

      this.prisma.errorLog
        .create({
          data: {
            userId: req.user?.id ?? null,
            sessionId,
            endpoint: req.originalUrl ?? req.url ?? 'unknown',
            method: req.method ?? 'unknown',
            status,
            message,
            stack,
          },
        })
        .catch((e) => {
          this.logger.error('failed to persist error to ErrorLog: ' + (e as Error).message);
        });

      // Also log to console so it shows up in `docker logs`.
      this.logger.error(`${req.method} ${req.url} → ${status}: ${message}`);
    }
  }
}

function truncate(s: string, max: number): string;
function truncate(s: string | null, max: number): string | null;
function truncate(s: string | null, max: number): string | null {
  if (s == null) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
