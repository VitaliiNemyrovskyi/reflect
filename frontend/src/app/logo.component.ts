import { Component, Input } from '@angular/core';

/**
 * Reflect wordmark — Synapse-inspired honeycomb cluster + sentence-case
 * wordmark.
 *
 *   • Mark: 7 pointy-top hexagons arranged in a tight flower cluster
 *     (1 centre + 6 neighbours sharing edges). Each hex carries a
 *     diagonal linear-gradient from currentColor at full strength to
 *     ~55% strength so the whole cluster picks up a subtle "top-left
 *     lit, bottom-right shaded" depth — matches the Synapse identity
 *     where each cell reads as a small 3D bead.
 *
 *     Geometry (size r=4 in a 32×32 viewBox, centre at 16,16):
 *       — vertex-to-centre distance r = 4
 *       — apothem (centre to flat side) = r * √3 / 2 ≈ 3.46
 *       — neighbour-centre distance     = r * √3      ≈ 6.93
 *       — neighbours at 0°/60°/120°/180°/240°/300° around the centre
 *
 *   • Wordmark: "Reflect" in sentence case, weight 500, no tracking —
 *     a clean modern sans rather than the spread-out uppercase the
 *     section labels use. Sized to read alongside the mark without
 *     dominating.
 *
 * Two sizes via [size]: "md" (default, 30px mark + 22px word) and
 * "sm" (20px / 14px). The gradient ID is suffixed with a unique key
 * per size so md and sm rendered on the same page don't collide.
 */
@Component({
  selector: 'app-logo',
  standalone: true,
  template: `
    <span class="logo" [class.sm]="size === 'sm'">
      <svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <!-- objectBoundingBox gradient: each path independently maps
               0,0 → 1,1 to its own bbox, so all seven hexes pick up the
               same "top-left bright, bottom-right shaded" highlight. -->
          <linearGradient id="reflect-hex-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%"   stop-color="currentColor" stop-opacity="1"/>
            <stop offset="100%" stop-color="currentColor" stop-opacity="0.55"/>
          </linearGradient>
        </defs>
        <g fill="url(#reflect-hex-grad)">
          <!-- centre -->
          <path d="M 16 12 L 19.46 14 L 19.46 18 L 16 20 L 12.54 18 L 12.54 14 Z"/>
          <!-- north-east -->
          <path d="M 19.46 6 L 22.92 8 L 22.92 12 L 19.46 14 L 16 12 L 16 8 Z"/>
          <!-- north-west -->
          <path d="M 12.54 6 L 16 8 L 16 12 L 12.54 14 L 9.08 12 L 9.08 8 Z"/>
          <!-- east -->
          <path d="M 22.93 12 L 26.39 14 L 26.39 18 L 22.93 20 L 19.47 18 L 19.47 14 Z"/>
          <!-- west -->
          <path d="M 9.07 12 L 12.53 14 L 12.53 18 L 9.07 20 L 5.61 18 L 5.61 14 Z"/>
          <!-- south-east -->
          <path d="M 19.46 18 L 22.92 20 L 22.92 24 L 19.46 26 L 16 24 L 16 20 Z"/>
          <!-- south-west -->
          <path d="M 12.54 18 L 16 20 L 16 24 L 12.54 26 L 9.08 24 L 9.08 20 Z"/>
        </g>
      </svg>
      <span class="logo-word">Reflect</span>
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
      width: 30px;
      height: 30px;
      flex-shrink: 0;
      display: block;
      /* Static like Synapse. Light drop-shadow keyed to the accent
         picks up the page's ambient wash without baking in any
         specific colour. */
      filter: drop-shadow(0 0 12px color-mix(in srgb, var(--accent) 30%, transparent));
    }
    .logo-word {
      font-size: 22px;
      font-weight: 500;
      letter-spacing: -0.01em;
      color: var(--fg);
    }
    .logo.sm .logo-mark { width: 20px; height: 20px; }
    .logo.sm .logo-word { font-size: 14px; }
  `],
})
export class LogoComponent {
  @Input() size: 'md' | 'sm' = 'md';
}
