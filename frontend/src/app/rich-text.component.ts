import { Component, EventEmitter, Input, Output, computed, signal } from '@angular/core';
import { Linker, TextSegment, linkify } from './glossary-link.util';

/**
 * Renders text with glossary terms turned into inline links. Emits `term` with
 * the term slug + click coordinates so the host can show a definition popover
 * (in lessons) or scroll to the entry (in the glossary, wiki-style).
 */
@Component({
  selector: 'app-rich-text',
  standalone: true,
  template: `@for (seg of segments(); track $index) {@if (seg.slug) {<button type="button" class="term-link" (click)="pick(seg.slug!, $event)">{{ seg.text }}</button>} @else {{{ seg.text }}}}`,
  styles: [`
    :host { display: inline; }
    /* "Term with a definition" affordance: inherits text colour (readable),
       a subtle dotted underline + help cursor signal there's more info. */
    .term-link { font: inherit; color: inherit; background: none; border: none; padding: 0; margin: 0;
      cursor: help; text-decoration: underline dotted;
      text-decoration-color: color-mix(in srgb, var(--accent) 50%, var(--border));
      text-underline-offset: 3px; }
    .term-link:hover { text-decoration-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  `],
})
export class RichTextComponent {
  private textSig = signal('');
  private linkerSig = signal<Linker | null>(null);

  @Input({ required: true }) set text(v: string | null | undefined) {
    this.textSig.set(v ?? '');
  }
  @Input() set linker(v: Linker | null) {
    this.linkerSig.set(v);
  }
  @Output() term = new EventEmitter<{ slug: string; el: HTMLElement }>();

  segments = computed<TextSegment[]>(() => linkify(this.textSig(), this.linkerSig()));

  pick(slug: string, ev: MouseEvent): void {
    ev.stopPropagation();
    this.term.emit({ slug, el: ev.currentTarget as HTMLElement });
  }
}
