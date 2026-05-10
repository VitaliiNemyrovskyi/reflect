import {
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { SessionsService } from './sessions.service';
import { CreateSessionDto, SendMessageDto } from './dto';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post()
  create(@Body() dto: CreateSessionDto, @CurrentUser() user: AuthUser) {
    return this.sessions.create(user.id, dto.characterId);
  }

  @Post(':id/messages')
  sendMessage(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sessions.sendMessage(user.id, id, dto.content);
  }

  @Post(':id/end')
  end(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.sessions.end(user.id, id);
  }

  /**
   * Coach-mode hint — student stuck mid-session, asks "what to say next".
   * Returns 3 strategic suggestions per hint_system.md. Frontend respects
   * `User.preferences.hintsEnabled` and hides the entry button when off.
   */
  @Post(':id/hint')
  hint(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.sessions.generateHints(user.id, id);
  }

  /**
   * Streaming variant of /end. Writes raw SSE frames so we can carry typed
   * events (chunk / cached / done / error) instead of plain text. Auth comes
   * from the global JWT guard; the frontend cannot use EventSource (no custom
   * headers), so it must call this with fetch + ReadableStream.
   */
  @Post(':id/end-stream')
  async endStream(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disable nginx/proxy buffering so chunks reach the client immediately.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const heartbeat = setInterval(() => {
      // Comment lines keep the connection alive through proxies.
      res.write(': keep-alive\n\n');
    }, 15000);

    const send = (type: string, data: unknown) => {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const event of this.sessions.endStream(user.id, id)) {
        send(event.type, event.data);
      }
    } catch (e: unknown) {
      const message =
        (e as { message?: string })?.message ?? 'Не вдалося згенерувати фідбек.';
      send('error', { message });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }
}
