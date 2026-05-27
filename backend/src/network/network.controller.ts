import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { NetworkService } from './network.service';

/**
 * GET /api/network/graph?scope=mine|admin
 *
 * Returns the 3D-graph payload (nodes + edges) used by the
 * /network frontend page. 'admin' scope is silently downgraded
 * to 'mine' for non-admin users — no separate 403 so the request
 * always returns something renderable.
 */
@Controller('network')
export class NetworkController {
  constructor(
    private readonly network: NetworkService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('graph')
  async graph(
    @CurrentUser() user: AuthUser,
    @Query('scope') scope?: string,
  ) {
    const me = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { isAdmin: true },
    });
    const requested: 'mine' | 'admin' = scope === 'admin' ? 'admin' : 'mine';
    return this.network.buildGraph({
      userId: user.id,
      isAdmin: !!me?.isAdmin,
      scope: requested,
    });
  }
}
