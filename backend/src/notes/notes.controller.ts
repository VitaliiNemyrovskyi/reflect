import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';

class CreateNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  noteText!: string;

  @IsOptional()
  @IsInt()
  anchorMessageId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  anchorText?: string;
}

@Controller('sessions/:id/notes')
export class NotesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Param('id', ParseIntPipe) sessionId: number,
    @CurrentUser() user: AuthUser,
  ) {
    await this.assertOwn(sessionId, user.id);
    return this.prisma.note.findMany({
      where: { sessionId },
      orderBy: { id: 'asc' },
    });
  }

  @Post()
  async create(
    @Param('id', ParseIntPipe) sessionId: number,
    @Body() dto: CreateNoteDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.assertOwn(sessionId, user.id);
    return this.prisma.note.create({
      data: {
        sessionId,
        noteText: dto.noteText.trim(),
        anchorMessageId: dto.anchorMessageId ?? null,
        anchorText: dto.anchorText?.trim() || null,
      },
    });
  }

  @Delete(':noteId')
  async remove(
    @Param('id', ParseIntPipe) sessionId: number,
    @Param('noteId', ParseIntPipe) noteId: number,
    @CurrentUser() user: AuthUser,
  ) {
    await this.assertOwn(sessionId, user.id);
    await this.prisma.note.deleteMany({ where: { id: noteId, sessionId } });
    return { ok: true };
  }

  private async assertOwn(sessionId: number, userId: number) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) throw new NotFoundException('session not found');
  }
}
