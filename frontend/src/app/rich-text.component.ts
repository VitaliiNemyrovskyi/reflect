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
    .term-link { font: inherit; color: var(--accent); background: none; border: none; padding: 0; margin: 0;
      cursor: pointer; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 2px; }
    .term-link:hover { text-decoration-style: solid; }
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
  @Output() term = new EventEmitter<{ slug: string; x: number; y: number }>();

  segments = computed<TextSegment[]>(() => linkify(this.textSig(), this.linkerSig()));

  pick(slug: string, ev: MouseEvent): void {
    ev.stopPropagation();
    this.term.emit({ slug, x: ev.clientX, y: ev.clientY });
  }
}
