import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * SSG / render policy for the build.
 *
 * Only the public, content-rich marketing pages are PRERENDERED to static
 * HTML (great for SEO + social cards). Everything else — the authenticated
 * app, dynamic `:id` routes, and guest auth forms — is CLIENT-rendered and
 * served via the SPA `index.html` fallback by nginx. No Node SSR server is
 * deployed; the prerendered pages are plain static files under dist/browser.
 *
 * (The landing at `''` joins the Prerender list in a later PR, once the
 *  public landing component replaces the auth'd dashboard at the root.)
 */
export const serverRoutes: ServerRoute[] = [
  { path: 'pricing', renderMode: RenderMode.Prerender },
  { path: 'demo', renderMode: RenderMode.Prerender },
  { path: 'safety', renderMode: RenderMode.Prerender },
  { path: '**', renderMode: RenderMode.Client },
];
