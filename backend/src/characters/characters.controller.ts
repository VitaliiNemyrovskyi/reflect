import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('characters')
export class CharactersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.character.findMany({
      select: { id: true, slug: true, displayName: true },
      orderBy: { id: 'asc' },
    });
  }
}
