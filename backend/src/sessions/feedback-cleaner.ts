/**
 * Post-process supervisor feedback to repair or remove citation
 * inaccuracies BEFORE the student sees them.
 *
 * Background. The LLM (even after critic-reviewer pass-2) regularly
 * produces paraphrased quotes wrapped in « ». The audit-block
 * solution flagged these, which (a) overwhelmed the UI when many
 * failures occurred and (b) left a false "exact words" impression
 * standing in the narrative. This module repairs in place.
 *
 * Pipeline. Two passes over the feedback string, then a residual
 * audit list for anything we couldn't auto-fix:
 *
 *   PASS 1 — anchored quotes: every «...» [L<n>] pair.
 *     - If quote ⊂ line N verbatim → keep as is.
 *     - Else if fuzzy-derivable from line N (≥50% contiguous token
 *       overlap) → REPLACE the quoted text with the verbatim slice
 *       that produced the overlap.
 *     - Else if the quote matches a DIFFERENT line at high overlap
 *       → fix the [L<n>] ref AND replace quote with verbatim slice.
 *     - Else → STRIP the « », keep the [L<n>] (paraphrase + ref).
 *
 *   PASS 2 — orphan quotes: every «...» without an adjacent [L<n>].
 *     - If a "suggestion-verb" precedes within 50 chars ("спробуй",
 *       "можна було", "пропоную", "альтернатив", "переформулюй",
 *       "запитати", "запропонуй", "варіант", "формулюв", "я б") →
 *       leave alone — it's a proposed alternative, not a citation.
 *     - Else if quote IS verbatim somewhere in the transcript →
 *       ADD [L<n>] automatically.
 *     - Else if fuzzy-derivable from any line at ≥60% overlap →
 *       REPLACE quote text + ADD [L<n>].
 *     - Else → STRIP the « ».
 *
 *   RESIDUAL — any [L<n>] reference where N > lineMap.size becomes
 *   an issue we can't auto-fix (the model invented a line number).
 *
 * Returns:
 *   cleaned     — rewritten feedback text
 *   repairs     — count of successful repairs (telemetry)
 *   issues      — residual problems for the audit-block (rare now)
 */

export interface CleanResult {
  cleaned: string;
  repairs: number;
  issues: string[];
}

/**
 * Lemma-prefix list of verbs/phrases that indicate the upcoming
 * « » is a PROPOSED therapist wording, not a transcript citation.
 * Lowercase, partial match. Tuned on observed Reflect feedback.
 *
 * IMMEDIATE_SUGGESTION fires when the marker appears in the ~60
 * chars right before the quote (e.g., "можна було спитати: «…»").
 *
 * SECTION_SUGGESTION fires when the quote sits inside a markdown
 * bullet list AND the marker appears in the ~400 chars upward
 * (typically the colon-headed section intro 2-3 lines above the
 * bullets, e.g., "**Що треба було запитати:**\n\n- «...»").
 */
const IMMEDIATE_SUGGESTION_PREFIXES = [
  'спробу',
  'можна',
  'пропону',
  'альтернатив',
  'переформул',
  'я б ',
  'запитайт',
  'запропонуй',
  'варіант',
  'формулюв',
  'наприклад',
  'сказати:',
  'сформулюв',
  // Negative-frame markers — the supervisor pointing out what the
  // therapist SHOULD have asked but didn't. Almost always followed
  // by a proposed question in quotes.
  'треба було',
  'немає питання',
  'не задала питання',
  'не запитала',
  'не повернулась',
  'забракло',
];

const SECTION_SUGGESTION_MARKERS = [
  'запитати:',
  'питання:',
  'розпитати:',
  'не запитала',
  'не розпитала',
  'не повернулась',
  'можна було',
  'треба було',
  'які питання',
  'що сказати',
  'альтернатив',
  'запропонувати',
  'переформулюва',
];

/**
 * Normalize for substring comparison: drop quote chars, dashes,
 * collapse whitespace, lowercase. Symmetric — apply to both sides.
 */
function normalize(s: string): string {
  return s
    .replace(/[«»"„“”'`]/g, '')
    .replace(/[—–]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/** Unicode-aware word extraction with offsets in the ORIGINAL string. */
function tokensWithOffsets(s: string): { lower: string; start: number; end: number }[] {
  const out: { lower: string; start: number; end: number }[] = [];
  const re = /[\p{L}\p{N}']+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push({ lower: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Find the longest contiguous run of QUOTE tokens that appears (in
 * order, lowercase-matched) in LINE tokens. Returns the original
 * line-text slice covering that run, or null if overlap is too low.
 *
 * @param minRatio overlap threshold: bestLen / quoteTokens.length must
 *                 be ≥ this AND bestLen must be ≥ 2.
 */
function findFuzzyVerbatim(
  quote: string,
  line: string,
  minRatio: number,
): string | null {
  const qTokens = tokensWithOffsets(quote).map((t) => t.lower);
  if (qTokens.length < 2) return null;

  const lineTokens = tokensWithOffsets(line);
  if (lineTokens.length < 2) return null;

  let bestStart = -1;
  let bestLen = 0;

  // O(N*M*K) brute force. Inputs are small (quotes ≤30 tokens,
  // lines ≤200 tokens). No need for suffix arrays / DP.
  for (let i = 0; i < lineTokens.length; i++) {
    for (let j = 0; j < qTokens.length; j++) {
      let k = 0;
      while (
        i + k < lineTokens.length &&
        j + k < qTokens.length &&
        lineTokens[i + k].lower === qTokens[j + k]
      ) {
        k++;
      }
      if (k > bestLen) {
        bestLen = k;
        bestStart = i;
      }
    }
  }

  const required = Math.max(2, Math.ceil(qTokens.length * minRatio));
  if (bestLen < required) return null;

  const startChar = lineTokens[bestStart].start;
  let endChar = lineTokens[bestStart + bestLen - 1].end;
  // If the original line has a sentence-terminating char or closing
  // INNER quote immediately after our last token, include it.
  // Otherwise the slice "О, а звідки ви знаєте про маму" loses its
  // "?" and 'я загуглила: "панічні атаки"' loses its closing inner `"`.
  //
  // CRITICAL: do NOT include `»` or `«` — those are the OUTER curly
  // quotes that wrap the original quote in the line, and including
  // them would produce double `»»` in our reconstructed `«slice»`.
  while (endChar < line.length && /["'”’?!….]/.test(line.charAt(endChar))) {
    endChar++;
  }
  return line.substring(startChar, endChar);
}

/**
 * Search ALL lines for the quote; pick the highest-overlap match.
 * Returns the line number and verbatim slice. Null if no line clears
 * the 60% threshold.
 */
function findBestLineForQuote(
  quote: string,
  lineMap: Map<number, string>,
): { lineNum: number; verbatim: string; ratio: number } | null {
  const qTokens = tokensWithOffsets(quote);
  if (qTokens.length < 2) return null;

  // Pass A: exact-substring match (cheap, no fuzzy).
  const qNorm = normalize(quote);
  if (qNorm.length >= 10) {
    for (const [n, line] of lineMap) {
      if (normalize(line).includes(qNorm)) {
        // Pull verbatim slice with original casing/punct.
        const slice = findFuzzyVerbatim(quote, line, 0.9);
        if (slice) return { lineNum: n, verbatim: slice, ratio: 1.0 };
      }
    }
  }

  // Pass B: fuzzy across all lines.
  let best: { lineNum: number; verbatim: string; ratio: number } | null = null;
  for (const [n, line] of lineMap) {
    const slice = findFuzzyVerbatim(quote, line, 0.6);
    if (slice) {
      const matchedTokens = tokensWithOffsets(slice).length;
      const ratio = matchedTokens / qTokens.length;
      if (!best || ratio > best.ratio) {
        best = { lineNum: n, verbatim: slice, ratio };
      }
    }
  }
  return best;
}

/**
 * Decide if a quote at position `quoteIdx` in `feedback` is a
 * PROPOSED therapist wording (and therefore must keep its quotes).
 *
 * Two-tier heuristic:
 *
 *   Tier 1 — immediate: scan the 60 chars right before the quote
 *   for prefixes like "спробу", "можна", "пропону" etc. Catches
 *   inline patterns "можна було спитати: «...»".
 *
 *   Tier 2 — section: only fires when the quote is at the start of
 *   a markdown bullet (preceded by "\n- " or "\n* " within a few
 *   chars). Scans the 400 chars before THAT bullet for list-intro
 *   markers like "Що треба було запитати:", "Можна було сказати:",
 *   "Альтернативні питання:". Catches the pattern:
 *
 *     **Що треба було запитати:**
 *
 *     - «Перед атаками ви весь день тривожилися…?»
 *     - «Через що вас турбує весь день…?»
 */
function looksLikeSuggestion(feedback: string, quoteIdx: number): boolean {
  // Tier 1 — immediate context (preceding 100 chars). Widened from
  // 60 to cover "Чи це її тригер, чи просто контекст? Немає питання:
  // «...»" where the marker sits before a clause boundary.
  const immediateCtx = feedback.slice(Math.max(0, quoteIdx - 100), quoteIdx).toLowerCase();
  if (IMMEDIATE_SUGGESTION_PREFIXES.some((v) => immediateCtx.includes(v))) {
    return true;
  }

  // Tier 2 — markdown bullet at column zero of a line.
  // Match "\n- " or "\n* " or "\n• " possibly with leading whitespace,
  // anywhere in the last 8 chars before the quote.
  const tail = feedback.slice(Math.max(0, quoteIdx - 8), quoteIdx);
  if (!/\n\s{0,4}[-*•]\s+$/.test(tail)) {
    return false;
  }
  // It's a bullet → scan up to 400 chars back for a list-intro marker.
  const sectionCtx = feedback.slice(Math.max(0, quoteIdx - 400), quoteIdx).toLowerCase();
  return SECTION_SUGGESTION_MARKERS.some((m) => sectionCtx.includes(m));
}

/** Build a single transcript blob for "is this quote anywhere?" check. */
function buildTranscriptText(lineMap: Map<number, string>): string {
  return Array.from(lineMap.values()).join('\n');
}

export function cleanFeedback(
  feedback: string,
  lineMap: Map<number, string>,
): CleanResult {
  const issues: string[] = [];
  let repairs = 0;

  // -----------------------------------------------------------------
  // PASS 0: residual invalid [L<n>] refs (line numbers that don't
  // exist). These can't be auto-repaired — the model invented them.
  // -----------------------------------------------------------------
  const refRe = /\[L(\d+)\]/g;
  const seenInvalidRefs = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(feedback)) !== null) {
    const n = parseInt(m[1], 10);
    if (!lineMap.has(n) && !seenInvalidRefs.has(n)) {
      seenInvalidRefs.add(n);
      issues.push(
        `🔢 **Неіснуюче посилання \`[L${n}]\`** — у транскрипті лише L1-L${lineMap.size}.`,
      );
    }
  }

  // -----------------------------------------------------------------
  // PASS 1: anchored quotes — «...» [L<n>] pairs.
  // We collect replacements first, then apply in reverse-position
  // order so earlier replacements don't shift later offsets.
  // -----------------------------------------------------------------
  type Repl = { start: number; end: number; text: string };
  const repls: Repl[] = [];

  // Curly-quote outers only — inner straight quotes (e.g. when Anna
  // quotes Google's "панічні атаки" inside Anna's own remembered
  // line) are allowed in inner text. The original audit regex
  // excluded inner " which broke on "...«я загуглила: "паніка"»...".
  //
  // Trailing `\)?` (no trailing `\s*`) — so we DON'T consume the
  // whitespace between `]` and the next word; otherwise the
  // replacement glues "[L11]" to the following text ("[L11]назван").
  const anchoredRe = /«([^«»]{4,500})»\s*\(?\s*\[L(\d+)\]\)?/g;
  while ((m = anchoredRe.exec(feedback)) !== null) {
    const innerText = m[1].trim();
    const lineNum = parseInt(m[2], 10);
    const line = lineMap.get(lineNum);
    const matchEnd = m.index + m[0].length;
    const refSuffix = ` [L${lineNum}]`;

    if (!line) continue; // residual already collected in Pass 0.

    if (normalize(line).includes(normalize(innerText))) {
      continue; // already verbatim; leave as is.
    }

    // Try fuzzy fix on the CITED line first.
    const slice = findFuzzyVerbatim(innerText, line, 0.5);
    if (slice && tokensWithOffsets(slice).length >= 2) {
      repls.push({
        start: m.index,
        end: matchEnd,
        text: `«${slice}»${refSuffix}`,
      });
      repairs++;
      continue;
    }

    // Cross-line: maybe the model attached the right quote to wrong N.
    const elsewhere = findBestLineForQuote(innerText, lineMap);
    if (elsewhere && elsewhere.lineNum !== lineNum && elsewhere.ratio >= 0.75) {
      repls.push({
        start: m.index,
        end: matchEnd,
        text: `«${elsewhere.verbatim}» [L${elsewhere.lineNum}]`,
      });
      repairs++;
      continue;
    }

    // Can't be repaired: strip the « » wrapping so the text reads as
    // paraphrase. Keep the [L<n>] pointer — it still localizes the
    // claim for the reader, just without the false "exact words"
    // implication.
    repls.push({
      start: m.index,
      end: matchEnd,
      text: `${innerText}${refSuffix}`,
    });
    repairs++;
  }

  let cleaned = feedback;
  repls.sort((a, b) => b.start - a.start);
  for (const r of repls) cleaned = cleaned.slice(0, r.start) + r.text + cleaned.slice(r.end);

  // -----------------------------------------------------------------
  // PASS 2: orphan quotes — «...» WITHOUT an adjacent [L<n>].
  // Three outcomes per quote: (a) it's a suggestion → skip,
  // (b) it's findable in transcript → repair + add ref,
  // (c) hallucination → strip quotes.
  // -----------------------------------------------------------------
  const transcriptText = buildTranscriptText(lineMap);
  const tNorm = normalize(transcriptText);
  // Curly outer, inner straight allowed (same fix as anchored pass).
  // The negative lookahead skips quotes that already have an adjacent
  // [L<n>] — Pass 1 handled those.
  const orphanRe = /«([^«»]{20,500})»(?!\s*\(?\s*\[L\d+\])/g;
  const orphanRepls: Repl[] = [];

  while ((m = orphanRe.exec(cleaned)) !== null) {
    const innerText = m[1].trim();
    const matchEnd = m.index + m[0].length;

    // Heuristic: does the preceding context hint this is a suggestion?
    if (looksLikeSuggestion(cleaned, m.index)) {
      continue;
    }

    // Exact verbatim hit anywhere?
    if (tNorm.includes(normalize(innerText))) {
      const found = findBestLineForQuote(innerText, lineMap);
      if (found) {
        orphanRepls.push({
          start: m.index,
          end: matchEnd,
          text: `«${found.verbatim}» [L${found.lineNum}]`,
        });
        repairs++;
        continue;
      }
    }

    // Fuzzy match across transcript
    const found = findBestLineForQuote(innerText, lineMap);
    if (found && found.ratio >= 0.6) {
      orphanRepls.push({
        start: m.index,
        end: matchEnd,
        text: `«${found.verbatim}» [L${found.lineNum}]`,
      });
      repairs++;
      continue;
    }

    // Strip quotes — leave bare text as a paraphrase.
    orphanRepls.push({
      start: m.index,
      end: matchEnd,
      text: innerText,
    });
    repairs++;
  }

  orphanRepls.sort((a, b) => b.start - a.start);
  for (const r of orphanRepls) cleaned = cleaned.slice(0, r.start) + r.text + cleaned.slice(r.end);

  return { cleaned, repairs, issues };
}
