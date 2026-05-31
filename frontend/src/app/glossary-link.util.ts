import { GlossaryTerm } from './api.service';

/** A run of text, optionally linked to a glossary term (by slug). */
export interface TextSegment {
  text: string;
  slug?: string;
}

export interface Linker {
  re: RegExp | null;
  bySlug: Map<string, GlossaryTerm>;
  stemToSlug: Map<string, string>;
}

const ESC = /[.*+?^${}()|[\]\\]/g;
const escapeRegex = (s: string): string => s.replace(ESC, '\\$&');

/** Best-effort English stem (mild inflection): longest word minus 2 chars. */
function enStem(term: string): string {
  const w = term
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] ?? '';
  return w.length > 5 ? w.slice(0, w.length - 2) : w;
}

/**
 * Build a linkifier from glossary terms. Ukrainian uses the authored `match`
 * stem; English falls back to a derived stem. Matches the stem + up to ~3
 * trailing letters at Unicode word boundaries, so inflected forms link too.
 */
export function buildLinker(terms: GlossaryTerm[], isEn: boolean): Linker {
  const bySlug = new Map<string, GlossaryTerm>();
  const stems: Array<{ stem: string; slug: string }> = [];
  for (const t of terms) {
    bySlug.set(t.slug, t);
    const raw = isEn ? enStem(t.termEn) : (t.match ?? '');
    const stem = raw.toLowerCase();
    if (stem.length >= 3) stems.push({ stem, slug: t.slug });
  }
  // Longer stems first so the alternation prefers the most specific match.
  stems.sort((a, b) => b.stem.length - a.stem.length);
  const stemToSlug = new Map<string, string>();
  for (const s of stems) if (!stemToSlug.has(s.stem)) stemToSlug.set(s.stem, s.slug);

  const alt = [...stemToSlug.keys()].map(escapeRegex).join('|');
  let re: RegExp | null = null;
  if (alt) {
    try {
      re = new RegExp(`(?<![\\p{L}\\p{N}])(${alt})(\\p{L}{0,3})(?![\\p{L}\\p{N}])`, 'giu');
    } catch {
      re = null; // lookbehind unsupported on an old engine → no inline links
    }
  }
  return { re, bySlug, stemToSlug };
}

/** Split text into plain runs + term-linked runs. */
export function linkify(text: string, linker: Linker | null): TextSegment[] {
  if (!linker?.re || !text) return [{ text: text ?? '' }];
  const re = linker.re;
  re.lastIndex = 0;
  const segs: TextSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index) });
    segs.push({ text: m[0], slug: linker.stemToSlug.get(m[1].toLowerCase()) });
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs;
}
