import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { SessionsService } from './sessions.service';
import { CreateSessionDto, SendMessageDto } from './dto';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { HealthService } from '../health/health.service';

@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly health: HealthService,
  ) {}

  @Post()
  create(@Body() dto: CreateSessionDto, @CurrentUser() user: AuthUser) {
    return this.sessions.create(user.id, dto.characterId);
  }

  /**
   * Read-only fetch of a session — owner or admin. Used by /session/:id/view
   * for past-session review (transcript + feedback + notes).
   */
  @Get(':id')
  view(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.sessions.getForView(user.id, id);
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
   * Administer a psychological test mid-session. Body: { testKey }.
   * AI patient "fills in" the test staying in character (profile +
   * transcript context + difficulty + defenses all shape the
   * answers). Returns the populated SessionTest row with score +
   * severity + parsed answers for the result card to render inline.
   */
  @Post(':id/tests')
  administerTest(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { testKey: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.sessions.administerTest(user.id, id, body.testKey);
  }

  /**
   * List every test administered during this session. Used by
   * session-view to re-render past test results inline with the
   * transcript.
   */
  @Get(':id/tests')
  listTests(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sessions.listSessionTests(user.id, id);
  }

  /**
   * Hard-delete a session ("як така що не розпочиналась") — therapist
   * decides this practice run shouldn't count. Removes session + cascades
   * to all messages and notes. Returns 204 No Content.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async discard(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    await this.sessions.discard(user.id, id);
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
    /** Accept-Language: en | uk — drives which locale the feedback is
     *  generated in. Sent by the frontend based on I18nService.lang. */
    @Headers('accept-language') langHeader?: string,
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

    // Tell HealthService this replica has a long-running stream open so
    // graceful-shutdown waits for the feedback to finish before letting
    // the process exit. The token is freed in the finally block whether
    // we ended cleanly, threw, or the client disconnected.
    const streamToken = this.health.registerStream(`endStream session=${id}`);

    try {
      // Normalise: 'en-GB', 'en-US' → 'en'; anything else → 'uk'.
      const lang = langHeader?.split(/[-,;]/)[0].trim().toLowerCase() === 'en' ? 'en' : 'uk';
      for await (const event of this.sessions.endStream(user.id, id, lang)) {
        send(event.type, event.data);
      }
    } catch (e: unknown) {
      const message =
        (e as { message?: string })?.message ?? 'Не вдалося згенерувати фідбек.';
      send('error', { message });
    } finally {
      clearInterval(heartbeat);
      this.health.unregisterStream(streamToken);
      res.end();
    }
  }
}
