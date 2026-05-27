import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  ApiService,
  NetworkEdge,
  NetworkGraph,
  NetworkNode,
  NetworkNodeType,
} from '../api.service';
import { AuthService } from '../auth.service';
import { I18nService } from '../i18n.service';

// 3d-force-graph is a vanilla JS library — we instantiate it
// imperatively in ngAfterViewInit. No Angular wrapper available so
// this is the standard pattern.
import ForceGraph3D from '3d-force-graph';
import type { ForceGraph3DInstance } from '3d-force-graph';
import * as THREE from 'three';

/** Visual tuning per node type — colours match the rest of the dark
 *  Synapse theme, with cities glowing in the accent purple and
 *  characters in a softer secondary. Kept here so the component file
 *  is self-contained; revisit when we add NPC / news nodes. */
const NODE_COLOR: Record<NetworkNodeType, string> = {
  city: '#d8c9ff',      // accent purple — gravitational anchors
  character: '#a7f3d0', // soft mint — patients
  user: '#fbbf6e',      // warm amber — therapists (you stand out)
  npc: '#94a3b8',       // slate — peripheral NPCs (Phase 3)
};

/** Edge tints — keep low-alpha so the canvas doesn't get visually
 *  noisy when there are lots of co-resident lines. */
const EDGE_COLOR: Record<string, string> = {
  lives_in: 'rgba(216, 201, 255, 0.5)',
  treats: 'rgba(251, 191, 110, 0.55)',
  shared_with: 'rgba(167, 243, 208, 0.45)',
  co_resident: 'rgba(255, 255, 255, 0.08)',
  knows: 'rgba(148, 163, 184, 0.5)',
};

@Component({
  selector: 'app-network',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <header class="net-header">
      <a routerLink="/" class="back">← {{ i18n.t('general.back') }}</a>
      <h1>{{ i18n.t('network.title') }}</h1>
      <p class="subtitle dim">{{ i18n.t('network.subtitle') }}</p>

      <div class="controls">
        <button
          [class.active]="scope() === 'mine'"
          (click)="changeScope('mine')">
          {{ i18n.t('network.scope_mine') }}
        </button>
        @if (isAdmin()) {
          <button
            [class.active]="scope() === 'admin'"
            (click)="changeScope('admin')">
            {{ i18n.t('network.scope_admin') }}
          </button>
        }
        <button class="ghost" (click)="resetView()" [title]="i18n.t('network.recenter')">
          ⟲
        </button>
      </div>
    </header>

    @if (loading()) {
      <p class="hint">{{ i18n.t('general.loading') }}</p>
    } @else if (graph()?.nodes?.length === 0) {
      <p class="hint">{{ i18n.t('network.empty') }}</p>
    }

    <!-- 3D canvas container — the force graph attaches its WebGL
         renderer here. Size is driven by CSS; the ResizeObserver
         keeps it in sync with the viewport. -->
    <div #graphContainer class="graph-container" [class.hidden]="loading()"></div>

    <!-- Side panel for the selected node. Slides in from the right
         on click, dismisses with the × button or by clicking the
         empty canvas behind it. -->
    @if (selected(); as n) {
      <aside class="node-panel">
        <header class="panel-head">
          <span class="type-chip" [style.--chip]="colorFor(n.type)">
            {{ chipLabel(n.type) }}
          </span>
          <button class="close" (click)="selected.set(null)" aria-label="Close">×</button>
        </header>
        <h2>{{ n.label }}</h2>
        @if (n.meta) {
          <dl class="meta-grid">
            @for (kv of metaEntries(n.meta); track kv.key) {
              <dt>{{ kv.key }}</dt>
              <dd>{{ kv.value }}</dd>
            }
          </dl>
        }
        @if (n.href) {
          <a [routerLink]="n.href" class="primary open-btn">
            {{ i18n.t('network.open') }} →
          </a>
        }
      </aside>
    }

    <!-- Legend — fixed bottom-left so the user can decode colors
         without leaving the canvas. Compact so it doesn't fight
         the visualization for attention. -->
    <div class="legend">
      <div class="legend-item"><span class="dot" style="--c:#d8c9ff"></span>{{ i18n.t('network.legend.city') }}</div>
      <div class="legend-item"><span class="dot" style="--c:#a7f3d0"></span>{{ i18n.t('network.legend.character') }}</div>
      <div class="legend-item"><span class="dot" style="--c:#fbbf6e"></span>{{ i18n.t('network.legend.user') }}</div>
      <div class="legend-item"><span class="dot" style="--c:#94a3b8"></span>{{ i18n.t('network.legend.npc') }}</div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      position: relative;
      min-height: calc(100vh - 80px);
    }
    .net-header {
      position: absolute;
      top: 16px;
      left: 16px;
      z-index: 5;
      max-width: 340px;
      pointer-events: none;
    }
    .net-header > * { pointer-events: auto; }
    .back {
      color: var(--fg-dim);
      text-decoration: none;
      font-size: 12px;
      display: inline-block;
      margin-bottom: 6px;
    }
    .back:hover { color: var(--accent); }
    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 500;
      text-shadow: 0 2px 12px rgba(0,0,0,0.7);
    }
    .subtitle {
      font-size: 12px;
      margin: 4px 0 12px;
      text-shadow: 0 1px 4px rgba(0,0,0,0.6);
    }
    .dim { color: var(--fg-dim); }
    .controls {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .controls button {
      background: color-mix(in srgb, var(--bg) 70%, transparent);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      color: var(--fg-dim);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      min-height: auto;
    }
    .controls button:hover { color: var(--fg); }
    .controls button.active {
      color: var(--accent);
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 8%, var(--bg));
    }
    .controls button.ghost { padding: 6px 10px; font-size: 14px; }

    /* The 3D canvas spans the full viewport area. Hidden during the
       initial load so the user doesn't see an empty black box flash. */
    .graph-container {
      position: absolute;
      inset: 0;
      background:
        radial-gradient(ellipse at center,
          color-mix(in srgb, var(--accent) 4%, var(--bg)) 0%,
          var(--bg) 70%);
      transition: opacity 0.3s ease;
    }
    .graph-container.hidden { opacity: 0; pointer-events: none; }

    .hint {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: var(--fg-dim);
      font-size: 14px;
      z-index: 4;
    }

    /* Node detail panel — slides from the right when a node is clicked.
       Frosted glass over the canvas so the user keeps spatial context. */
    .node-panel {
      position: absolute;
      top: 16px;
      right: 16px;
      width: 320px;
      max-height: calc(100vh - 120px);
      overflow-y: auto;
      z-index: 10;
      background: color-mix(in srgb, var(--bg) 78%, transparent);
      backdrop-filter: blur(20px) saturate(140%);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 18px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.5);
      animation: panelIn .18s ease-out;
    }
    @keyframes panelIn {
      from { transform: translateX(20px); opacity: 0; }
      to   { transform: translateX(0); opacity: 1; }
    }
    .panel-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .type-chip {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 3px 8px;
      border-radius: 999px;
      color: var(--chip);
      background: color-mix(in srgb, var(--chip) 15%, transparent);
      border: 1px solid color-mix(in srgb, var(--chip) 40%, transparent);
    }
    .close {
      background: transparent;
      border: none;
      color: var(--fg-dim);
      font-size: 22px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
      min-height: auto;
    }
    .close:hover { color: var(--fg); }
    .node-panel h2 {
      margin: 0 0 12px;
      font-size: 18px;
      font-weight: 500;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 4px 12px;
      font-size: 12px;
      margin: 0 0 14px;
    }
    .meta-grid dt {
      color: var(--fg-dim);
      text-transform: capitalize;
    }
    .meta-grid dd {
      margin: 0;
      color: var(--fg);
      word-break: break-word;
    }
    .open-btn {
      display: inline-block;
      text-decoration: none;
      text-align: center;
      width: 100%;
      padding: 9px 16px;
      font-size: 13px;
    }

    /* Legend pinned to the bottom-left corner, compact. */
    .legend {
      position: absolute;
      bottom: 16px;
      left: 16px;
      z-index: 5;
      display: flex;
      gap: 14px;
      font-size: 11px;
      color: var(--fg-dim);
      background: color-mix(in srgb, var(--bg) 70%, transparent);
      backdrop-filter: blur(10px);
      padding: 6px 12px;
      border-radius: 999px;
      border: 1px solid var(--border);
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .legend-item .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--c);
      box-shadow: 0 0 6px var(--c);
    }

    @media (max-width: 720px) {
      .net-header { max-width: calc(100vw - 32px); }
      h1 { font-size: 18px; }
      .node-panel {
        top: auto;
        right: 8px;
        left: 8px;
        bottom: 8px;
        width: auto;
        max-height: 50vh;
      }
      .legend { display: none; }
    }
  `],
})
export class NetworkComponent implements AfterViewInit, OnDestroy {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private router = inject(Router);
  readonly i18n = inject(I18nService);

  @ViewChild('graphContainer', { static: true })
  private container!: ElementRef<HTMLDivElement>;

  private graphInstance: ForceGraph3DInstance | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Loaded avatar textures keyed by URL. Each URL is fetched once;
   *  the rendered Sprite reads through this map. Survives re-renders
   *  inside this component instance (cleared on destroy). */
  private avatarTextureCache = new Map<string, THREE.Texture>();

  graph = signal<NetworkGraph | null>(null);
  loading = signal(true);
  selected = signal<NetworkNode | null>(null);
  scope = signal<'mine' | 'admin'>('mine');

  isAdmin = computed(() => this.auth.user()?.isAdmin === true);

  ngAfterViewInit(): void {
    this.initGraph();
    void this.load();

    // Keep the WebGL viewport sized to its container — Angular
    // route enters/exits and CSS height changes both trigger this.
    this.resizeObserver = new ResizeObserver(() => {
      const el = this.container.nativeElement;
      this.graphInstance?.width(el.clientWidth).height(el.clientHeight);
    });
    this.resizeObserver.observe(this.container.nativeElement);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    // 3d-force-graph holds a Three.js scene + animation loop; explicit
    // teardown prevents a leak when the user navigates away.
    this.graphInstance?._destructor?.();
    this.graphInstance = null;
    // Dispose textures we own — three.js doesn't GC GPU memory.
    for (const tex of this.avatarTextureCache.values()) tex.dispose();
    this.avatarTextureCache.clear();
  }

  /** Reset camera back to the auto-fit position the engine picked on
   *  first render. Used by the ⟲ button. */
  resetView(): void {
    this.graphInstance?.zoomToFit(800, 80);
  }

  changeScope(s: 'mine' | 'admin'): void {
    if (s === this.scope()) return;
    this.scope.set(s);
    void this.load();
  }

  // Re-apply graph data without re-creating the engine when scope flips.
  private async load(): Promise<void> {
    this.loading.set(true);
    this.selected.set(null);
    try {
      const g = await this.api.networkGraph(this.scope());
      this.graph.set(g);
      this.applyGraphData(g);
    } catch {
      // Empty state handled by template
      this.graph.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  /** Initialise the 3D engine once on view init. Subsequent loads
   *  just call .graphData() to swap nodes/edges in place. */
  private initGraph(): void {
    const el = this.container.nativeElement;
    const fg = new ForceGraph3D(el)
      .backgroundColor('rgba(0,0,0,0)')
      .nodeRelSize(4)
      .nodeVal((n: any) => (n.size as number) * 1.2)
      .nodeColor((n: any) => NODE_COLOR[(n.type ?? 'character') as NetworkNodeType])
      .nodeLabel((n: any) => this.tooltipHtml(n))
      .nodeOpacity(0.95)
      // Custom 3D object per node. Returns a circular avatar sprite for
      // characters that have an avatarUrl; null falls back to the
      // default colored sphere for cities, therapists, NPCs without
      // photos, and characters whose avatar URL didn't load. The
      // .nodeThreeObjectExtend(true) below keeps the default sphere
      // BEHIND the custom sprite as a fallback halo — so if the texture
      // is still loading you see a faint glow in the type-color rather
      // than empty space.
      .nodeThreeObjectExtend(true)
      // Type signature claims we must return Object3D, but the runtime
      // happily accepts null / undefined to fall back to the default
      // sphere. Cast the callback to keep TS happy without lying about
      // our return value.
      .nodeThreeObject(((n: any) => {
        // Characters: explicit avatarUrl required (set in DB).
        if (n.type === 'character') {
          const url = n.meta?.avatarUrl as string | undefined;
          return url ? this.makeAvatarSprite(url, n.size as number) : null;
        }
        // NPCs: use their avatarUrl if set, else auto-derive a
        // DiceBear `personas` avatar from the NPC's name. Visual style
        // differs from characters' `lorelei` so the two layers are
        // distinguishable at a glance.
        if (n.type === 'npc') {
          const url = (n.meta?.avatarUrl as string | undefined)
            || this.fallbackNpcAvatar(n.label as string);
          return this.makeAvatarSprite(url, n.size as number);
        }
        return null;
      }) as any)
      .linkColor((l: any) => EDGE_COLOR[l.type as string] ?? 'rgba(255,255,255,0.12)')
      .linkOpacity(0.7)
      .linkWidth((l: any) => Math.min(3, (l.weight ?? 1)))
      .linkDirectionalParticles((l: any) => (l.type === 'treats' ? 2 : 0))
      .linkDirectionalParticleWidth(2)
      .linkDirectionalParticleColor(() => '#fbbf6e')
      .width(el.clientWidth)
      .height(el.clientHeight)
      .onNodeClick((n: any) => this.onNodeClick(n))
      .onBackgroundClick(() => this.selected.set(null));

    // Tighten link distance so smaller groups don't fly apart on a
    // wide viewport. d3-force-3d defaults are tuned for very big
    // graphs; ours is intimate. Bracket access because the d3 force
    // typings expose these via index signature.
    (fg.d3Force('link') as any)?.distance?.(70);
    (fg.d3Force('charge') as any)?.strength?.(-110);

    this.graphInstance = fg;
  }

  private applyGraphData(g: NetworkGraph): void {
    if (!this.graphInstance) return;
    this.graphInstance.graphData({
      nodes: g.nodes.map((n) => ({ ...n })),
      links: g.edges.map((e) => ({ ...e })),
    });
    // Re-fit camera after the layout settles a beat.
    setTimeout(() => this.graphInstance?.zoomToFit(600, 80), 600);
  }

  private onNodeClick(n: NetworkNode & { x?: number; y?: number; z?: number }): void {
    this.selected.set(n);
    // Gently fly the camera to the node so the user gets focus +
    // context. The orbit-around-target distance is set per nodeRelSize.
    if (this.graphInstance && n.x !== undefined && n.y !== undefined && n.z !== undefined) {
      const dist = 120;
      const ratio = 1 + dist / Math.hypot(n.x, n.y, n.z);
      this.graphInstance.cameraPosition(
        { x: n.x * ratio, y: n.y * ratio, z: n.z * ratio },
        { x: n.x, y: n.y, z: n.z } as any,
        1000,
      );
    }
  }

  // ─── Avatar sprites ─────────────────────────────────────────────────

  /**
   * Build a billboard sprite for a character node. The sprite starts
   * invisible (transparent material) so until the texture loads we
   * just see the fallback sphere underneath via nodeThreeObjectExtend.
   * Once the texture lands we swap in a circular masked CanvasTexture
   * and the avatar visually "fades in" on the next render frame.
   *
   * Size matches the node's `size` so big patients (lots of sessions)
   * get bigger faces — same visual ranking as before.
   */
  private makeAvatarSprite(url: string, nodeSize: number): THREE.Sprite {
    const material = new THREE.SpriteMaterial({
      transparent: true,
      depthWrite: false,
      opacity: 0,
    });
    const sprite = new THREE.Sprite(material);
    const scale = nodeSize * 4;
    sprite.scale.set(scale, scale, 1);

    void this.loadCircularTexture(url).then((tex) => {
      if (!tex) return; // load failed → sphere stays visible underneath
      material.map = tex;
      material.opacity = 1;
      material.needsUpdate = true;
    });

    return sprite;
  }

  /**
   * Load an avatar URL and mask it to a circle via offscreen canvas.
   * Result is cached per-URL so re-renders (scope switch, re-fit) don't
   * trigger duplicate downloads. CORS-enabled — required for both
   * DiceBear's anonymized SVG endpoint and any other CDN we might use
   * later, otherwise the canvas becomes tainted and texture upload
   * throws.
   *
   * Returns null on any failure — the caller's fallback (default
   * sphere from the engine) handles missing textures gracefully.
   */
  private async loadCircularTexture(url: string): Promise<THREE.Texture | null> {
    const cached = this.avatarTextureCache.get(url);
    if (cached) return cached;

    try {
      const img = await this.loadImage(url);
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      // Circular mask. The 1px outset on the radius and clearRect at the
      // edge avoid a hard aliased ring; SVG sources tend to bleed.
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.fillStyle = '#1a1a22'; // dim bg so a transparent PNG isn't see-through
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      this.avatarTextureCache.set(url, texture);
      return texture;
    } catch {
      return null;
    }
  }

  /**
   * Synthesize a stable DiceBear avatar URL from the NPC's name when
   * no explicit avatarUrl is on file. Uses `personas` style (cartoonish,
   * diverse) so NPCs visually contrast with character nodes which use
   * `lorelei`. Same seed → same face across reloads.
   */
  private fallbackNpcAvatar(name: string): string {
    const seed = encodeURIComponent((name || 'npc').trim().slice(0, 64));
    return `https://api.dicebear.com/9.x/personas/svg?seed=${seed}`;
  }

  /**
   * Promise-wrapped <img> load. anonymous crossorigin so the canvas
   * doesn't become tainted when we draw the result for the texture.
   * DiceBear's API responds with the right CORS headers; failing that,
   * the catch in loadCircularTexture surfaces the issue as "no avatar".
   */
  private loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`avatar load failed: ${url}`));
      img.src = url;
    });
  }

  // ─── Template helpers ───────────────────────────────────────────────

  /** HTML the library shows on hover. Quick way to surface label +
   *  type without opening the panel. */
  private tooltipHtml(n: NetworkNode): string {
    const escape = (s: string) =>
      s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c] || c);
    const type = this.chipLabel(n.type);
    return `<div style="font-size:11px;color:#999">${escape(type)}</div><div style="font-weight:500">${escape(n.label)}</div>`;
  }

  chipLabel(type: NetworkNodeType): string {
    switch (type) {
      case 'city': return this.i18n.t('network.legend.city');
      case 'character': return this.i18n.t('network.legend.character');
      case 'user': return this.i18n.t('network.legend.user');
      case 'npc': return this.i18n.t('network.legend.npc');
    }
  }

  colorFor(type: NetworkNodeType): string {
    return NODE_COLOR[type];
  }

  /** Pretty-print the node.meta dictionary into a small key/value list
   *  for the panel. We skip falsy values to keep it tight. */
  metaEntries(meta: Record<string, unknown>): Array<{ key: string; value: string }> {
    return Object.entries(meta)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([key, value]) => ({ key, value: String(value) }));
  }

  @HostListener('window:keydown.escape')
  closePanelOnEscape(): void {
    if (this.selected()) this.selected.set(null);
  }
}
