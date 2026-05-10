import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './current-user.decorator';

/**
 * Allows the request only if the authenticated user has `isAdmin = true`
 * in the DB. Pairs with the global JwtAuthGuard — that one populates
 * req.user, this one checks the role.
 *
 * Re-reads from DB on every request rather than trusting the JWT — so
 * revoking admin (toggling `isAdmin` off) takes effect immediately,
 * not after token refresh. Cost: one extra `findUnique` per admin
 * request, negligible.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = req.user;
    if (!user?.id) throw new ForbiddenException('not authenticated');
    const fresh = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { isAdmin: true },
    });
    if (!fresh?.isAdmin) {
      throw new ForbiddenException('admin only');
    }
    return true;
  }
}
