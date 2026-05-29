import { Component, computed, inject, input } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';

/**
 * Single inline-SVG icon set for the whole app — replaces the emoji we
 * used as UI glyphs (📈 🕸 🛡 ⚙ + the badge glyphs). Hand-authored on the
 * Lucide grid convention (24×24, 2px stroke, round caps/joins, `fill:none`,
 * `stroke:currentColor`) so every icon inherits the surrounding text colour
 * and sizes to `1em` — i.e. it behaves exactly like a font glyph. That keeps
 * the eventual consolidation into one self-hosted `.woff2` icon font seamless:
 * the same `<app-icon name="…">` call sites stay, only the rendering swaps.
 *
 * Usage: `<app-icon name="chart-up" />`. Size via `font-size` on the host (or
 * an ancestor); colour via `color`. Unknown names fall back to `diamond`.
 *
 * The markup is 100% static and authored here (no user input ever flows in),
 * so bypassing the sanitizer for the inner SVG is safe — it's the only way to
 * keep Angular's HTML sanitizer from stripping the <svg> children.
 */

const WRAP =
  'width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/** name → inner SVG markup (paths/lines/circles). */
const ICONS: Record<string, string> = {
  // ── App chrome / nav ──────────────────────────────────────────────
  'chart-up': '<polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/>',
  network:
    '<circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="19" r="2.4"/><circle cx="19" cy="19" r="2.4"/>' +
    '<line x1="10.6" y1="6.9" x2="6.4" y2="16.8"/><line x1="13.4" y1="6.9" x2="17.6" y2="16.8"/>' +
    '<line x1="7.4" y1="19" x2="16.6" y2="19"/>',
  'shield-check':
    '<path d="M12 3 L19 6 V11.5 C19 16 15.6 19.4 12 20.5 C8.4 19.4 5 16 5 11.5 V6 Z"/>' +
    '<path d="M9 11.5 l2 2 l4 -4"/>',
  settings:
    '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/>' +
    '<line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2.2"/>' +
    '<circle cx="15" cy="12" r="2.2"/><circle cx="8" cy="17" r="2.2"/>',
  lightbulb:
    '<path d="M9 18 H15"/><path d="M10 21 H14"/>' +
    '<path d="M12 3 C8.7 3 6 5.7 6 9 C6 11.4 7.3 13 8.5 14.2 C9.2 14.9 9.5 15.5 9.5 16.5 ' +
    'H14.5 C14.5 15.5 14.8 14.9 15.5 14.2 C16.7 13 18 11.4 18 9 C18 5.7 15.3 3 12 3 Z"/>',
  users:
    '<circle cx="9" cy="8" r="3.2"/>' +
    '<path d="M3.5 20 C3.5 16.4 6 14 9 14 C12 14 14.5 16.4 14.5 20"/>' +
    '<path d="M16 5.2 C17.6 5.6 18.8 7.1 18.8 8.8 C18.8 10.5 17.6 12 16 12.4"/>' +
    '<path d="M17 14.2 C19.4 14.9 21 17 21 20"/>',

  // ── Badge glyphs ──────────────────────────────────────────────────
  sprout:
    '<path d="M12 20 V10"/>' +
    '<path d="M12 14 C12 11 9.6 8.6 6.6 8.6 C6.6 11.6 9 14 12 14 Z"/>' +
    '<path d="M12 10.5 C12 7.5 14.4 5.1 17.4 5.1 C17.4 8.1 15 10.5 12 10.5 Z"/>',
  heart:
    '<path d="M12 20 C12 20 4 14.6 4 9 C4 6.5 6 4.6 8.4 4.6 C10 4.6 11.3 5.4 12 6.6 ' +
    'C12.7 5.4 14 4.6 15.6 4.6 C18 4.6 20 6.5 20 9 C20 14.6 12 20 12 20 Z"/>',
  anchor:
    '<circle cx="12" cy="5" r="2.5"/><line x1="12" y1="7.5" x2="12" y2="21"/>' +
    '<line x1="8.5" y1="11" x2="15.5" y2="11"/>' +
    '<path d="M5 13 C5 17.5 8.5 21 12 21 C15.5 21 19 17.5 19 13"/>',
  'map-pin':
    '<path d="M12 21 C12 21 19 14.5 19 9 C19 5.1 15.9 2 12 2 C8.1 2 5 5.1 5 9 C5 14.5 12 21 12 21 Z"/>' +
    '<circle cx="12" cy="9" r="2.5"/>',
  palette:
    '<circle cx="8" cy="8.5" r="3.4"/><circle cx="16" cy="9.5" r="3.4"/><circle cx="12" cy="15.5" r="3.4"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/>' +
    '<path d="M3.6 8.5 H20.4"/><path d="M3.6 15.5 H20.4"/><ellipse cx="12" cy="12" rx="4" ry="9"/>',
  'life-buoy':
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/>' +
    '<line x1="14.5" y1="9.5" x2="18.4" y2="5.6"/><line x1="9.5" y1="9.5" x2="5.6" y2="5.6"/>' +
    '<line x1="14.5" y1="14.5" x2="18.4" y2="18.4"/><line x1="9.5" y1="14.5" x2="5.6" y2="18.4"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="16" y1="16" x2="21" y2="21"/>',
  link:
    '<path d="M9.5 12 H14.5"/>' +
    '<path d="M8.5 8 H6.5 C4.3 8 2.5 9.8 2.5 12 C2.5 14.2 4.3 16 6.5 16 H8.5"/>' +
    '<path d="M15.5 8 H17.5 C19.7 8 21.5 9.8 21.5 12 C21.5 14.2 19.7 16 17.5 16 H15.5"/>',
  'shield-heart':
    '<path d="M12 3 L19 6 V11.5 C19 16 15.6 19.4 12 20.5 C8.4 19.4 5 16 5 11.5 V6 Z"/>' +
    '<path d="M12 16 C12 16 8.8 14 8.8 11.6 C8.8 10.4 9.7 9.7 10.6 9.7 C11.2 9.7 11.7 10 12 10.5 ' +
    'C12.3 10 12.8 9.7 13.4 9.7 C14.3 9.7 15.2 10.4 15.2 11.6 C15.2 14 12 16 12 16 Z"/>',
  mountain: '<path d="M3 20 L10 6 L14 14 L16.3 9.5 L21 20 Z"/>',
  lock:
    '<rect x="5" y="11" width="14" height="9" rx="2"/>' +
    '<path d="M8 11 V8 C8 5.8 9.8 4 12 4 C14.2 4 16 5.8 16 8 V11"/>',

  // ── Badge glyphs (extended set — Phase 1a+) ───────────────────────
  flag: '<path d="M6 21 V4"/><path d="M6 5 H17.5 L14.5 8.5 L17.5 12 H6"/>',
  medal:
    '<path d="M8.5 3 L11.5 9.5"/><path d="M15.5 3 L12.5 9.5"/>' +
    '<circle cx="12" cy="15" r="5.5"/><circle cx="12" cy="15" r="2"/>',
  trophy:
    '<path d="M8 4 H16 V8.5 C16 11 14.2 13 12 13 C9.8 13 8 11 8 8.5 Z"/>' +
    '<path d="M8 5.5 H5 V7 C5 9 6.5 10.3 8.3 10.3"/>' +
    '<path d="M16 5.5 H19 V7 C19 9 17.5 10.3 15.7 10.3"/>' +
    '<path d="M12 13 V17"/><path d="M9 20.5 C9 18.5 10.2 17 12 17 C13.8 17 15 18.5 15 20.5 Z"/>',
  waveform:
    '<line x1="5" y1="10" x2="5" y2="14"/><line x1="9" y1="7" x2="9" y2="17"/>' +
    '<line x1="12" y1="4" x2="12" y2="20"/><line x1="15" y1="7" x2="15" y2="17"/>' +
    '<line x1="19" y1="10" x2="19" y2="14"/>',
  union: '<circle cx="9.3" cy="12" r="6"/><circle cx="14.7" cy="12" r="6"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  sparkles:
    '<path d="M12 4 C12 8 12.4 8.4 16 9 C12.4 9.6 12 10 12 14 C12 10 11.6 9.6 8 9 C11.6 8.4 12 8 12 4 Z"/>' +
    '<path d="M18 13 C18 14.6 18.2 14.8 19.6 15 C18.2 15.2 18 15.4 18 17 C18 15.4 17.8 15.2 16.4 15 C17.8 14.8 18 14.6 18 13 Z"/>',
  hexagon: '<path d="M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 Z"/>',
  sun:
    '<circle cx="12" cy="12" r="4.2"/><line x1="12" y1="2" x2="12" y2="4.5"/>' +
    '<line x1="12" y1="19.5" x2="12" y2="22"/><line x1="2" y1="12" x2="4.5" y2="12"/>' +
    '<line x1="19.5" y1="12" x2="22" y2="12"/><line x1="5" y1="5" x2="6.7" y2="6.7"/>' +
    '<line x1="17.3" y1="17.3" x2="19" y2="19"/><line x1="5" y1="19" x2="6.7" y2="17.3"/>' +
    '<line x1="17.3" y1="6.7" x2="19" y2="5"/>',
  calendar:
    '<rect x="4" y="5" width="16" height="16" rx="2"/><line x1="4" y1="9.5" x2="20" y2="9.5"/>' +
    '<line x1="8" y1="3" x2="8" y2="6.5"/><line x1="16" y1="3" x2="16" y2="6.5"/>',
  'rotate-ccw':
    '<path d="M3 12 a9 9 0 1 0 9 -9 9.75 9.75 0 0 0 -6.74 2.74 L3 8"/><path d="M3 3 v5 h5"/>',
  bell:
    '<path d="M10.27 21 a2 2 0 0 0 3.46 0"/>' +
    '<path d="M3.26 15.33 A1 1 0 0 0 4 17 h16 a1 1 0 0 0 .74 -1.67 C19.41 13.96 18 12.5 18 8 a6 6 0 0 0 -12 0 c0 4.5 -1.41 5.96 -2.74 7.33"/>',

  diamond: '<path d="M12 3 L21 12 L12 21 L3 12 Z"/>',
};

@Component({
  selector: 'app-icon',
  standalone: true,
  template: `<span class="i" [innerHTML]="svg()"></span>`,
  styles: [`
    :host { display: inline-flex; align-items: center; justify-content: center; line-height: 0; }
    .i { display: inline-flex; }
    .i ::ng-deep svg { display: block; }
  `],
})
export class IconComponent {
  /** Icon name — see the ICONS map. Unknown names fall back to `diamond`. */
  readonly name = input.required<string>();
  private san = inject(DomSanitizer);

  protected svg = computed<SafeHtml>(() => {
    const inner = ICONS[this.name()] ?? ICONS['diamond'];
    return this.san.bypassSecurityTrustHtml(`<svg ${WRAP}>${inner}</svg>`);
  });
}
