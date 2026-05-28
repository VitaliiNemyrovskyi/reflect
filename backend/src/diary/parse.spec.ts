import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent, parseDiaryArray } from './parse';

// These parsers turn raw LLM output into the World-Tick event / diary
// entries. They must fail SAFE (null / []) on malformed input so a flaky
// model response degrades to "no entry" rather than throwing inside the
// diary cron.

const validEvent = JSON.stringify({
  npcInvolved: 'Ірина',
  summary: 'Дружина отримала пропозицію роботи у Львові.',
  spoken: 'Іра сказала, що їй пропонують роботу у Львові.',
  hidden: 'Він відчуває це як початок кінця, але мовчить.',
  stateBias: 'Я не знаю, що їй відповісти.',
  tensionDelta: 2,
});

test('parseEvent: valid object returns all fields', () => {
  const e = parseEvent(validEvent);
  assert.ok(e);
  assert.equal(e?.npcInvolved, 'Ірина');
  assert.equal(e?.tensionDelta, 2);
  assert.ok((e?.hidden.length ?? 0) > 5);
});

test('parseEvent: tolerates prose/markdown around the JSON', () => {
  const e = parseEvent('Ось подія:\n```json\n' + validEvent + '\n```\nГотово.');
  assert.ok(e);
  assert.equal(e?.npcInvolved, 'Ірина');
});

test('parseEvent: missing load-bearing field -> null', () => {
  const noHidden = JSON.stringify({ spoken: 'aaaaa', stateBias: 'bbbbb' });
  assert.equal(parseEvent(noHidden), null);
});

test('parseEvent: too-short field -> null', () => {
  const short = JSON.stringify({ spoken: 'ok', hidden: 'hidden text', stateBias: 'bias text' });
  assert.equal(parseEvent(short), null);
});

test('parseEvent: tensionDelta coercion', () => {
  const base = { spoken: 'spoken text', hidden: 'hidden text', stateBias: 'bias text' };
  assert.equal(parseEvent(JSON.stringify({ ...base, tensionDelta: 2.7 }))?.tensionDelta, 2);
  assert.equal(parseEvent(JSON.stringify({ ...base, tensionDelta: 'abc' }))?.tensionDelta, 0);
  assert.equal(parseEvent(JSON.stringify(base))?.tensionDelta, 0); // absent
});

test('parseEvent: malformed / no JSON -> null', () => {
  assert.equal(parseEvent('not json at all'), null);
  assert.equal(parseEvent('{ broken'), null);
  assert.equal(parseEvent(''), null);
});

test('parseDiaryArray: valid array of entries', () => {
  const raw = JSON.stringify([
    { tag: 'mood', content: 'Сьогодні було важко встати.' },
    { content: 'Випила каву на балконі.' },
  ]);
  const out = parseDiaryArray(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].tag, 'mood');
  assert.equal(out[1].tag, undefined);
});

test('parseDiaryArray: skips short / non-object entries', () => {
  const raw = JSON.stringify([
    { content: 'ok' },          // too short (<5)
    'just a string',            // not an object
    null,                       // null
    { content: 'Достатньо довгий запис.' },
  ]);
  const out = parseDiaryArray(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'Достатньо довгий запис.');
});

test('parseDiaryArray: trims content', () => {
  const out = parseDiaryArray(JSON.stringify([{ content: '   запис із пробілами   ' }]));
  assert.equal(out[0].content, 'запис із пробілами');
});

test('parseDiaryArray: non-array / no brackets -> []', () => {
  assert.deepEqual(parseDiaryArray('{"content":"obj not array"}'), []);
  assert.deepEqual(parseDiaryArray('no brackets here'), []);
  assert.deepEqual(parseDiaryArray('[ broken'), []);
});
