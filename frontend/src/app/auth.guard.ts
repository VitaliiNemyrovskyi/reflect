import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = (): boolean | UrlTree => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isAuthenticated()) return true;
  return router.parseUrl('/login');
};

export const guestOnlyGuard: CanActivateFn = (): boolean | UrlTree => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.isAuthenticated()) return true;
  return router.parseUrl('/dashboard');
};

/**
 * Gate for the public landing at `''`. Guests see the (prerendered, SEO)
 * marketing page; authenticated users are bounced to their dashboard. This
 * centralises the redirect so every existing `routerLink="/"` / navigate(['/'])
 * keeps working: authed → /dashboard, guest → landing. SSR-safe (reads a
 * signal only; on the server auth is always false, so the landing prerenders).
 */
export const landingGuard: CanActivateFn = (): boolean | UrlTree => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isAuthenticated() ? router.parseUrl('/dashboard') : true;
};
