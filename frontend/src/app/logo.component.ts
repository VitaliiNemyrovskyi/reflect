import { Component, Input } from '@angular/core';

/**
 * Reflect wordmark — Synapse-inspired:
 *
 *   • Mark: a 1.4px-stroke outer ring with a smaller inner ring and a
 *     tiny solid center dot — concentric "lens" / target imagery that
 *     reads as "reflection" (looking into something) at any size.
 *     Strokes use currentColor so it inherits whatever colour the
 *     surrounding text has — accent on dark surfaces, accent-ink on
 *     filled surfaces, etc.
 *
 *   • Wordmark: REFLECT in uppercase, light weight, tracked. Matches
 *     the .section-label utility style we use elsewhere in the app but
 *     with a slightly bigger, more presentational size.
 *
 * Two sizes via the [size] input:
 *   - "md" (default): 28px mark, 18px wordmark — for app headers
 *   - "sm": 18px mark, 12px wordmark — for inline / OAuth-card uses
 *
 * Lightweight: no template logic beyond inline SVG primitives, no
 * external assets, theme-aware via CSS vars.
 */
@Component({
  selector: 'app-logo',
  standalone: true,
  template: `
    <span class="logo" [class.sm]="size === 'sm'">
      <svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true"
           fill="none" stroke="currentColor" stroke-width="1.4"
           stroke-linecap="round">
        <!-- outer ring -->
        <circle cx="16" cy="16" r="13"/>
        <!-- inner ring -->
        <circle cx="16" cy="16" r="6"/>
        <!-- subtle reflection split: a faint vertical line through the
             ring's interior, fading at the ends — "mirror axis" -->
        <line x1="16" y1="6" x2="16" y2="26" opacity="0.35"/>
        <!-- center dot -->
        <circle cx="16" cy="16" r="1.4" fill="currentColor" stroke="none"/>
      </svg>
      <span class="logo-word">REFLECT</span>
    </span>
  `,
  styles: [`
    .logo {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      color: var(--accent);
      line-height: 1;
    }
    .logo-mark {
      width: 28px;
      height: 28px;
      flex-shrink: 0;
      /* slow CCW spin to balance the body-wide CW frame-rotate so the
         logo feels "alive" but doesn't lockstep with every gradient
         border on the page */
      animation: logo-spin 22s linear infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .logo-mark { animation: none; }
    }
    @keyframes logo-spin {
      to { transform: rotate(-360deg); }
    }
    .logo-word {
      font-size: 18px;
      font-weight: 300;
      letter-spacing: 0.22em;
      /* Slight optical adjustment: tracked uppercase reads slightly
         right-leaning, so a tiny negative right-padding compensates. */
      padding-right: 0.22em;
      margin-right: -0.22em;
    }
    .logo.sm .logo-mark { width: 18px; height: 18px; }
    .logo.sm .logo-word {
      font-size: 12px;
      letter-spacing: 0.18em;
    }
  `],
})
export class LogoComponent {
  @Input() size: 'md' | 'sm' = 'md';
}
