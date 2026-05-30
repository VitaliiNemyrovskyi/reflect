import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHintResult } from './hint-parse';

// The hint parser turns raw coach-LLM output into clickable suggestions. A
// suggestion's `text` can be dropped straight into the composer and SENT, so
// the parser must NEVER surface raw JSON / a truncated blob as a suggestion
// (that's exactly how session #74 L27 ended up with a ```json dump in the
// transcript). It must also salvage the good leading suggestions when the
// model output is truncated by the token cap.

const clean = JSON.stringify({
  suggestions: [
    { text: 'Що ти відчуваєш зараз?', rationale: 'open question', kind: 'open-question' },
    { text: 'Схоже, тобі важко.', rationale: 'reflection', kind: 'reflection' },
    { text: 'Підсумуймо.', rationale: 'summary', kind: 'summary' },
  ],
});

test('clean unfenced JSON → all three suggestions', () => {
  const r = parseHintResult(clean);
  assert.equal(r.suggestions.length, 3);
  assert.equal(r.suggestions[0].text, 'Що ти відчуваєш зараз?');
  assert.equal(r.suggestions[0].kind, 'open-question');
});

test('fenced JSON with surrounding prose → parsed', () => {
  const raw = 'Ось варіанти:\n```json\n' + clean + '\n```\nсподіваюсь допоможе';
  const r = parseHintResult(raw);
  assert.equal(r.suggestions.length, 3);
});

test('caps at 3 suggestions', () => {
  const many = JSON.stringify({
    suggestions: Array.from({ length: 6 }, (_, i) => ({
      text: `s${i}`,
      rationale: 'r',
      kind: 'other',
    })),
  });
  assert.equal(parseHintResult(many).suggestions.length, 3);
});

test('drops items with empty/missing text', () => {
  const raw = JSON.stringify({
    suggestions: [
      { text: '', rationale: 'r', kind: 'other' },
      { rationale: 'r', kind: 'other' },
      { text: 'справжня підказка', rationale: 'r', kind: 'reflection' },
    ],
  });
  const r = parseHintResult(raw);
  assert.equal(r.suggestions.length, 1);
  assert.equal(r.suggestions[0].text, 'справжня підказка');
});

// The regression that caused session #74 L27: fenced JSON truncated mid-array
// (no closing fence, broken second object).
const truncated =
  '```json\n{\n  "suggestions": [\n    {\n      "text": "Схоже, ти дуже дбаєш про маму і боїшся її засмутити.",\n      "rationale": "Reflection турботи про маму (OARS).",\n      "kind": "reflection"\n    },\n    {\n      "text": "Ти кажеш';

test('truncated output → salvages the complete leading suggestion', () => {
  const r = parseHintResult(truncated);
  assert.equal(r.suggestions.length, 1);
  assert.equal(r.suggestions[0].text, 'Схоже, ти дуже дбаєш про маму і боїшся її засмутити.');
  assert.equal(r.suggestions[0].kind, 'reflection');
});

test('truncated output → never surfaces raw JSON as a suggestion', () => {
  const r = parseHintResult(truncated);
  for (const s of r.suggestions) {
    assert.ok(!s.text.includes('```'), 'no code fence in suggestion text');
    assert.ok(!s.text.includes('"suggestions"'), 'no raw JSON key in suggestion text');
    assert.ok(!s.text.trimStart().startsWith('{'), 'suggestion text is not a JSON object');
  }
});

test('total garbage → empty (no raw-text fallback)', () => {
  assert.deepEqual(parseHintResult('the model said something weird').suggestions, []);
  assert.deepEqual(parseHintResult('').suggestions, []);
  assert.deepEqual(parseHintResult('```json\n{ broken').suggestions, []);
});

test('bare suggestion objects without a wrapper are still salvaged', () => {
  // Some truncations lose the wrapper entirely but keep complete objects.
  const raw =
    '{ "text": "перша", "rationale": "r", "kind": "reflection" }\n' +
    '{ "text": "друга", "rationale": "r", "kind": "open-question" }';
  const r = parseHintResult(raw);
  assert.equal(r.suggestions.length, 2);
  assert.deepEqual(r.suggestions.map((s) => s.text), ['перша', 'друга']);
});
