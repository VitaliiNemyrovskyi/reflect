/**
 * Approximate USD price per 1M tokens, matched by SUBSTRING against the model
 * id (ids vary by provider/version, so we match loosely and fall back to
 * zero-cost — tokens are still recorded, so cost can be backfilled if a price
 * is missing). Drift vs the provider's live price is fine; this is for cost
 * VISIBILITY, not invoicing.
 *
 * ORDER MATTERS: the first matching substring wins, so more-specific ids must
 * come before their prefixes — `gemini-2.5-flash-lite` before `gemini`,
 * `deepseek-v4-flash` before `deepseek`. Reordering can silently mis-price.
 * (pricing.spec.ts pins this.)
 */
export const MODEL_PRICES: Array<{ match: string; in: number; out: number }> = [
  { match: 'claude-opus', in: 15, out: 75 },
  { match: 'claude-sonnet', in: 3, out: 15 },
  { match: 'claude-haiku', in: 1, out: 5 },
  { match: 'gemini-2.5-flash-lite', in: 0.1, out: 0.4 },
  { match: 'gemini-2.5-flash', in: 0.3, out: 2.5 },
  { match: 'gemini', in: 0.3, out: 2.5 },
  { match: 'deepseek-v4-flash', in: 0.1, out: 0.2 },
  { match: 'deepseek', in: 0.27, out: 1.1 },
  { match: 'qwen3.7-max', in: 1.2, out: 6 },
  { match: 'qwen', in: 0.4, out: 1.2 },
  // owl-alpha and other free stealth models → no entry → cost 0.
];

/** Estimate USD cost for a completion. Unknown model → 0 (tokens still
 *  recorded elsewhere). Case-insensitive substring match against MODEL_PRICES. */
export function estimateCostUsd(model: string, inTok: number, outTok: number): number {
  const m = model.toLowerCase();
  const price = MODEL_PRICES.find((p) => m.includes(p.match));
  if (!price) return 0;
  return (inTok * price.in + outTok * price.out) / 1_000_000;
}
