import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AdminService } from './admin.service';

/**
 * All admin endpoints live under /api/admin/* and require both:
 *   - JWT auth (global guard, populates req.user)
 *   - AdminGuard (this controller — checks isAdmin in DB)
 *
 * 403 Forbidden if non-admin tries to hit any of these.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  users() {
    return this.admin.listUsers();
  }

  @Get('sessions')
  sessions(
    @Query('userId') userId?: string,
    @Query('characterId') characterId?: string,
    @Query('ended') ended?: string,
  ) {
    return this.admin.listSessions({
      userId: userId ? parseInt(userId, 10) : undefined,
      characterId: characterId ? parseInt(characterId, 10) : undefined,
      ended: ended === 'true' ? true : ended === 'false' ? false : undefined,
    });
  }

  @Get('sessions/:id')
  session(@Param('id', ParseIntPipe) id: number) {
    return this.admin.getSession(id);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSession(@Param('id', ParseIntPipe) id: number) {
    await this.admin.deleteSession(id);
  }

  @Get('errors')
  errors(
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('userId') userId?: string,
  ) {
    return this.admin.listErrors({
      limit: limit ? parseInt(limit, 10) : undefined,
      before: before ? parseInt(before, 10) : undefined,
      userId: userId ? parseInt(userId, 10) : undefined,
    });
  }
}
