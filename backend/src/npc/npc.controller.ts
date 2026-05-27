import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { CharactersService } from '../characters/characters.service';
import { NpcService, type CreateNpcDto, type UpdateNpcDto } from './npc.service';

/**
 * NPC management endpoints. NPCs belong to a character so the routes
 * are nested:
 *
 *   GET    /api/characters/:id/npcs           — list
 *   POST   /api/characters/:id/npcs           — create
 *   POST   /api/characters/:id/npcs/generate  — LLM-generate cast (3-5)
 *   PATCH  /api/npcs/:npcId                   — edit
 *   DELETE /api/npcs/:npcId                   — delete
 *
 * Listing is open to anyone who can see the character (visibility
 * filter). Mutations require edit rights — same gate as
 * CharactersService.update/delete.
 */
@Controller()
export class NpcController {
  constructor(
    private readonly npcs: NpcService,
    private readonly characters: CharactersService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('characters/:id/npcs')
  async list(
    @Param('id', ParseIntPipe) characterId: number,
    @CurrentUser() user: AuthUser,
  ) {
    await this.assertCanRead(user.id, characterId);
    return this.npcs.listForCharacter(characterId);
  }

  @Post('characters/:id/npcs')
  async create(
    @Param('id', ParseIntPipe) characterId: number,
    @Body() dto: CreateNpcDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.assertCanEdit(user.id, characterId);
    return this.npcs.create(characterId, dto);
  }

  @Post('characters/:id/npcs/generate')
  async generate(
    @Param('id', ParseIntPipe) characterId: number,
    @Body() body: { count?: number },
    @CurrentUser() user: AuthUser,
  ) {
    await this.assertCanEdit(user.id, characterId);
    return this.npcs.generateForCharacter(characterId, { count: body?.count });
  }

  @Patch('npcs/:npcId')
  async update(
    @Param('npcId', ParseIntPipe) npcId: number,
    @Body() dto: UpdateNpcDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.assertCanEditViaNpc(user.id, npcId);
    return this.npcs.update(npcId, dto);
  }

  @Delete('npcs/:npcId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('npcId', ParseIntPipe) npcId: number,
    @CurrentUser() user: AuthUser,
  ) {
    await this.assertCanEditViaNpc(user.id, npcId);
    await this.npcs.delete(npcId);
  }

  // ─── Authorization helpers ─────────────────────────────────────────────

  /** Read access: anyone who can see the character via the standard
   *  visibility filter. */
  private async assertCanRead(userId: number, characterId: number): Promise<void> {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true },
    });
    const visibility = this.characters.visibilityFilter(userId, !!me?.isAdmin);
    const character = await this.prisma.character.findFirst({
      where: { id: characterId, AND: [visibility] },
      select: { id: true },
    });
    if (!character) throw new NotFoundException('character not found');
  }

  /** Edit access: owner of the character OR admin. Same rule as
   *  CharactersService.assertCanEdit (which is private), so we
   *  inline-replicate here. */
  private async assertCanEdit(userId: number, characterId: number): Promise<void> {
    const character = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: { createdById: true },
    });
    if (!character) throw new NotFoundException('character not found');
    if (character.createdById === userId) return;
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true },
    });
    if (!me?.isAdmin) {
      throw new NotFoundException('character not found');
    }
  }

  private async assertCanEditViaNpc(userId: number, npcId: number): Promise<void> {
    const npc = await this.prisma.nPC.findUnique({
      where: { id: npcId },
      select: { characterId: true },
    });
    if (!npc) throw new NotFoundException('npc not found');
    await this.assertCanEdit(userId, npc.characterId);
  }
}
