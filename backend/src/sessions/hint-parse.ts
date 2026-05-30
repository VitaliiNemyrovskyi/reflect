/**
 * Parser for the coach/"what should I say?" hint feature.
 *
 * The hint LLM is asked for JSON ({ suggestions: [{ text, rationale, kind }] }).
 * Real-world output is messy: it may be wrapped in a ```json fence, surrounded
 * by prose, or — crucially — TRUNCATED by the token cap mid-array. The parser
 * must be tolerant AND safe: a suggestion's `text` is shown as a clickable card
 * that the trainee can drop straight into the composer and SEND, so it must
 * NEVER contain raw JSON / a half-baked blob. (Session #74 L27 was exactly
 * that: a truncated `suggestions` JSON got surfaced as a hint, clicked, and
 * sent into the transcript.)
 *
 * Strategy:
 *   1. Clean path — fenced or first balanced {…} that parses as a wrapper.
 *   2. Salvage path — when the whole thing isn't valid JSON (e.g. truncated),
 *      extract every individually-parseable {…} object (any depth) and keep
 *      the ones shaped like a suggestion. This recovers the complete leading
 *      suggestions from a truncated array and discards the broken tail.
 *   3. If nothing usable survives, return an EMPTY list — the UI then shows a
 *      "couldn't prepare options, try again" state rather than raw JSON.
 */

export type HintKind =
  | 'open-question'
  | 'reflection'
  | 'summary'
  | 'screening'
  | 'here-and-now'
  | 'psychoeducation'
  | 'closing'
  | 'other';

export interface HintSuggestion {
  text: string;
  rationale: string;
  kind: HintKind;
}

export interface HintResult {
  suggestions: HintSuggestion[];
}

/** Coerce an unknown object into a HintSuggestion, or null if it isn't one. */
function toSuggestion(value: unknown): HintSuggestion | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as { text?: unknown; rationale?: unknown; kind?: unknown };
  const text = typeof o.text === 'string' ? o.text.trim() : '';
  if (!text) return null;
  const rationale = typeof o.rationale === 'string' ? o.rationale.trim() : '';
  const kind = (typeof o.kind === 'string' ? o.kind : 'other') as HintKind;
  return { text, rationale, kind };
}

/**
 * Extract every balanced {…} substring (at any nesting depth), string-aware so
 * braces inside string literals don't break the balance. Unterminated objects
 * (the truncated tail) are simply never emitted.
 */
function extractBalancedObjects(s: string): string[] {
  const objs: string[] = [];
  const stack: number[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push(i);
    else if (ch === '}') {
      const start = stack.pop();
      if (start !== undefined) objs.push(s.slice(start, i + 1));
    }
  }
  return objs;
}

export function parseHintResult(raw: string): HintResult {
  // 1) Clean path — fenced block, else the outermost {…} span.
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  const candidate = fence ? fence[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
        suggestions?: unknown;
      };
      const out: HintSuggestion[] = [];
      if (Array.isArray(parsed.suggestions)) {
        for (const s of parsed.suggestions) {
          const sug = toSuggestion(s);
          if (sug) out.push(sug);
        }
      }
      if (out.length > 0) return { suggestions: out.slice(0, 3) };
    } catch {
      // fall through to salvage
    }
  }

  // 2) Salvage path — output wasn't valid JSON as a whole (commonly truncated
  // by the token cap). Recover complete suggestion objects, skip the wrapper
  // and the broken tail. NEVER surface raw text as a suggestion.
  const salvaged: HintSuggestion[] = [];
  const seen = new Set<string>();
  for (const block of extractBalancedObjects(raw)) {
    let obj: unknown;
    try {
      obj = JSON.parse(block);
    } catch {
      continue;
    }
    // Skip a wrapper object — its inner items are extracted on their own.
    if (obj && typeof obj === 'object' && 'suggestions' in obj) continue;
    const sug = toSuggestion(obj);
    if (sug && !seen.has(sug.text)) {
      seen.add(sug.text);
      salvaged.push(sug);
    }
  }
  // 3) Empty when nothing survives — caller/UI handles the retry state.
  return { suggestions: salvaged.slice(0, 3) };
}
