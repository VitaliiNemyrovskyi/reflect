/**
 * Pure parsers for the DiaryService LLM outputs, extracted so they can be
 * unit-tested without the Nest service. Both tolerate the model wrapping its
 * JSON in prose/markdown fences (they slice between the first/last bracket)
 * and fail SAFE — a malformed payload returns null/[] so the caller falls
 * back rather than throwing.
 */

export interface ParsedEvent {
  npcInvolved: string;
  summary: string;
  spoken: string;
  hidden: string;
  stateBias: string;
  tensionDelta: number;
}

/**
 * Parse the single-object World-Tick event JSON. Returns null if any of the
 * three load-bearing fields (spoken / hidden / stateBias) is missing or too
 * short, so the caller falls back to a mundane diary entry. `npcInvolved` is
 * optional (only used for the tension nudge); `tensionDelta` coerces to an
 * integer, defaulting to 0 when absent/non-numeric.
 */
export function parseEvent(raw: string): ParsedEvent | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
    const npcInvolved = str('npcInvolved');
    const spoken = str('spoken');
    const hidden = str('hidden');
    const stateBias = str('stateBias');
    if (spoken.length < 5 || hidden.length < 5 || stateBias.length < 5) return null;
    const td = Number(o['tensionDelta']);
    return {
      npcInvolved,
      summary: str('summary'),
      spoken,
      hidden,
      stateBias,
      tensionDelta: Number.isFinite(td) ? Math.trunc(td) : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Parse the mundane-diary JSON array. Skips non-objects and entries whose
 * `content` is missing or under 5 chars. Returns [] on any structural
 * failure (not an array, bad JSON, no brackets).
 */
export function parseDiaryArray(raw: string): Array<{ tag?: string; content: string }> {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  try {
    const arr = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    const out: Array<{ tag?: string; content: string }> = [];
    for (const x of arr) {
      if (!x || typeof x !== 'object') continue;
      const content = typeof (x as { content?: unknown }).content === 'string'
        ? ((x as { content: string }).content).trim()
        : '';
      if (!content || content.length < 5) continue;
      const tag = typeof (x as { tag?: unknown }).tag === 'string'
        ? ((x as { tag: string }).tag).trim()
        : undefined;
      out.push(tag ? { tag, content } : { content });
    }
    return out;
  } catch {
    return [];
  }
}
