import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCostUsd } from './pricing';

// estimateCostUsd feeds the admin cost dashboard. The substring price map is
// order-sensitive; a regression silently mis-prices spend. These pin it.

test('prices a known model by its per-1M rates', () => {
  // 1M in + 1M out of claude-opus = 15 + 75 = 90
  assert.equal(estimateCostUsd('claude-opus-4-7', 1_000_000, 1_000_000), 90);
  // deepseek-v4-flash: 2392 in @ .10 + 600 out @ .20 per 1M
  const c = estimateCostUsd('deepseek/deepseek-v4-flash', 2392, 600);
  assert.ok(Math.abs(c - (2392 * 0.1 + 600 * 0.2) / 1e6) < 1e-12);
});

test('ORDER: specific ids win over their prefixes', () => {
  // lite must match before bare "gemini" (0.1/0.4, not 0.3/2.5)
  assert.equal(estimateCostUsd('google/gemini-2.5-flash-lite', 1_000_000, 0), 0.1);
  // non-lite flash → 0.3
  assert.equal(estimateCostUsd('google/gemini-2.5-flash', 1_000_000, 0), 0.3);
  // v4-flash must match before bare "deepseek" (0.1, not 0.27)
  assert.equal(estimateCostUsd('deepseek/deepseek-v4-flash', 1_000_000, 0), 0.1);
  assert.equal(estimateCostUsd('deepseek/deepseek-chat', 1_000_000, 0), 0.27);
});

test('case-insensitive', () => {
  assert.equal(estimateCostUsd('Claude-Haiku-4-5', 1_000_000, 0), 1);
});

test('unknown / free model → 0 (tokens recorded elsewhere)', () => {
  assert.equal(estimateCostUsd('openrouter/owl-alpha', 1_000_000, 1_000_000), 0);
  assert.equal(estimateCostUsd('some-unlisted-model', 5000, 5000), 0);
});

test('zero tokens → 0', () => {
  assert.equal(estimateCostUsd('claude-opus', 0, 0), 0);
});
