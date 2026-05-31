import { Component, computed, input } from '@angular/core';

/**
 * Single icon component for the whole app — renders a glyph from the
 * self-hosted **Tabler Icons** webfont (loaded globally in angular.json). Tabler
 * is the Lucide twin (24px grid, 2px stroke, round joins), so it matches the
 * app's look while being a true font: glyphs inherit `color` and size to the
 * surrounding `font-size`, exactly like text.
 *
 * Usage: `<app-icon name="chart-up" />`. Size via `font-size` on the host or an
 * ancestor; colour via `color`. `name` is our stable semantic key — mapped to a
 * Tabler glyph here, so call sites never reference Tabler class names directly
 * and we can re-map a glyph in one place. Unknown names fall back to `diamond`.
 */

/** Stable semantic name → Tabler glyph (without the `ti-` prefix). */
const NAME_MAP: Record<string, string> = {
  // ── App chrome / nav ──
  'chart-up': 'trending-up',
  network: 'affiliate',
  'shield-check': 'shield-check',
  settings: 'adjustments-horizontal',
  lightbulb: 'bulb',
  users: 'users',
  user: 'user',
  'log-out': 'logout',
  menu: 'menu-2',
  bell: 'bell',
  clipboard: 'clipboard',
  link: 'link',
  search: 'search',
  // ── Badges ──
  sprout: 'seeding',
  heart: 'heart',
  'heart-handshake': 'heart-handshake',
  anchor: 'anchor',
  'map-pin': 'map-pin',
  palette: 'palette',
  globe: 'world',
  'life-buoy': 'lifebuoy',
  'shield-heart': 'shield-heart',
  mountain: 'mountain',
  lock: 'lock',
  flag: 'flag',
  medal: 'medal',
  trophy: 'trophy',
  waveform: 'wave-sine',
  union: 'circles-relation',
  target: 'target',
  sparkles: 'sparkles',
  hexagon: 'hexagon',
  sun: 'sun',
  calendar: 'calendar',
  'rotate-ccw': 'rotate-2',
  // ── Session / video-call controls ──
  clock: 'clock',
  message: 'message',
  video: 'video',
  pencil: 'pencil',
  mic: 'microphone',
  square: 'square',
  volume: 'volume',
  'volume-off': 'volume-off',
  captions: 'badge-cc',
  keyboard: 'keyboard',
  phone: 'phone',
  // ── Content / patient-card glyphs ──
  book: 'book-2',
  brain: 'brain',
  bookmark: 'bookmark',
  news: 'news',
  'file-text': 'file-text',
  scroll: 'script',
  movie: 'movie',
  stopwatch: 'stopwatch',
  ban: 'ban',
  point: 'point',
  school: 'school',
  'users-group': 'users-group',
  'alert-triangle': 'alert-triangle',
  // fallback
  diamond: 'diamond',
};

@Component({
  selector: 'app-icon',
  standalone: true,
  template: `<i class="ti ti-{{ glyph() }}" aria-hidden="true"></i>`,
  styles: [`
    :host { display: inline-flex; align-items: center; justify-content: center; line-height: 0; }
    .ti { font-size: 1em; line-height: 1; }
  `],
})
export class IconComponent {
  /** Semantic icon name — see NAME_MAP. Unknown names fall back to `diamond`. */
  readonly name = input.required<string>();
  protected glyph = computed(() => NAME_MAP[this.name()] ?? 'diamond');
}
