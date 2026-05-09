import {
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
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
}
