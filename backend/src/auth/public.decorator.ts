import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks an endpoint as accessible without auth. Use sparingly — only for
 * /api/auth/*, health checks, and other intentionally unauthenticated routes.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
