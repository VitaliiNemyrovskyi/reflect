import { Injectable, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { Meta, Title } from '@angular/platform-browser';

const BASE_URL = 'https://reflect.swift-mail.app';
const DEFAULT_TITLE = 'Reflect — AI-тренажер психотерапії';
const DEFAULT_DESC =
  'AI-тренажер для майбутніх психотерапевтів — практика сесій з реалістичними AI-клієнтами та структурованим фідбеком рівня супервізора.';
const DEFAULT_OG_IMAGE = BASE_URL + '/cities/kyiv.webp';

export interface SeoData {
  /** Page title (without the " · Reflect" suffix). Empty → default home title. */
  title?: string;
  description?: string;
  /** Absolute or root-relative og/canonical image. */
  ogImage?: string;
  /** Path for canonical + og:url (e.g. "/pricing"). */
  path?: string;
}

/**
 * Centralised per-page SEO: title, description, canonical, Open Graph and
 * Twitter cards. Uses Angular's DI-based Title/Meta + DOCUMENT, so it runs
 * during prerender (platform-server) too — the static HTML for /, /pricing,
 * /demo, /safety gets the correct tags baked in (the actual SEO win). Driven
 * by the SeoTitleStrategy from route `data` on every navigation.
 */
@Injectable({ providedIn: 'root' })
export class SeoService {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly doc = inject<Document>(DOCUMENT);

  update(data: SeoData = {}): void {
    const fullTitle = data.title ? `${data.title} · Reflect` : DEFAULT_TITLE;
    const desc = data.description ?? DEFAULT_DESC;
    const url = BASE_URL + (data.path ?? '/');
    const img = this.abs(data.ogImage ?? DEFAULT_OG_IMAGE);

    this.title.setTitle(fullTitle);
    this.meta.updateTag({ name: 'description', content: desc });
    this.setCanonical(url);

    this.meta.updateTag({ property: 'og:title', content: fullTitle });
    this.meta.updateTag({ property: 'og:description', content: desc });
    this.meta.updateTag({ property: 'og:url', content: url });
    this.meta.updateTag({ property: 'og:image', content: img });
    this.meta.updateTag({ property: 'og:type', content: 'website' });
    this.meta.updateTag({ property: 'og:site_name', content: 'Reflect' });

    this.meta.updateTag({ name: 'twitter:card', content: 'summary_large_image' });
    this.meta.updateTag({ name: 'twitter:title', content: fullTitle });
    this.meta.updateTag({ name: 'twitter:description', content: desc });
    this.meta.updateTag({ name: 'twitter:image', content: img });
  }

  private abs(src: string): string {
    return src.startsWith('http') ? src : BASE_URL + (src.startsWith('/') ? src : '/' + src);
  }

  private setCanonical(url: string): void {
    let link = this.doc.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = this.doc.createElement('link');
      link.setAttribute('rel', 'canonical');
      this.doc.head.appendChild(link);
    }
    link.setAttribute('href', url);
  }
}
