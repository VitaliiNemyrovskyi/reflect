import { Injectable, inject } from '@angular/core';
import { ActivatedRouteSnapshot, RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { SeoService } from './seo.service';

/**
 * Drives SeoService from the activated route's `data` on every navigation
 * (and during prerender). Reads `title` / `description` / `ogImage` from the
 * deepest matched route and sets the full SEO tag set + canonical/og:url from
 * the resolved path. Registered as the app's TitleStrategy in app.config.ts.
 */
@Injectable({ providedIn: 'root' })
export class SeoTitleStrategy extends TitleStrategy {
  private readonly seo = inject(SeoService);

  override updateTitle(state: RouterStateSnapshot): void {
    let route: ActivatedRouteSnapshot = state.root;
    while (route.firstChild) route = route.firstChild;
    const data = route.data ?? {};
    this.seo.update({
      title: data['title'],
      description: data['description'],
      ogImage: data['ogImage'],
      path: state.url.split('?')[0].split('#')[0] || '/',
    });
  }
}
