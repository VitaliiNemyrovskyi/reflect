import { Controller, Get, Headers, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { NetworkService } from './network.service';
import { coerceLang } from '../common/lang';

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
    @Headers('accept-language') langHeader?: string,
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
      // Locale isolation: the graph only ever shows ONE city + its
      // residents (the one matching the current UI locale). Cross-locale
      // browsing belongs in a dedicated admin panel; for the regular
      // /network page admins see their selected lang's graph just like
      // any other user.
      lang: coerceLang(langHeader),
    });
  }
}
