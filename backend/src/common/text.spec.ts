import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripStageDirections } from './text';

// stripStageDirections cleans patient replies before TTS. A regression
// here means the voice reads "*sighs*" or "[pauses]" aloud, or emoji
// names — jarring in a therapy sim.

test('removes markdown italics / stage directions', () => {
  assert.equal(stripStageDirections('*sighs* hello'), 'hello');
  assert.equal(stripStageDirections('hello *quietly*'), 'hello');
});

test('removes bracketed directions', () => {
  assert.equal(stripStageDirections('[pauses] ok'), 'ok');
  assert.equal(stripStageDirections('ok [тихо]'), 'ok');
});

test('strips emoji', () => {
  assert.equal(stripStageDirections('hello 😊 world'), 'hello world');
  assert.equal(stripStageDirections('сум 😢'), 'сум');
});

test('double newline becomes sentence break, single becomes space', () => {
  assert.equal(stripStageDirections('line1\n\nline2'), 'line1. line2');
  assert.equal(stripStageDirections('line1\nline2'), 'line1 line2');
});

test('collapses repeated whitespace and trims', () => {
  assert.equal(stripStageDirections('  multiple   spaces  '), 'multiple spaces');
});

test('combined: directions + emoji + quotes left clean', () => {
  const out = stripStageDirections('*Вона зупиняється.* «Я не знаю», [тихо] 😢');
  assert.ok(!out.includes('*'), 'no asterisks');
  assert.ok(!/\[|\]/.test(out), 'no brackets');
  assert.ok(out.includes('«Я не знаю»'), 'keeps real speech');
  assert.equal(out, out.trim(), 'trimmed');
});

test('empty / whitespace-only yields empty string', () => {
  assert.equal(stripStageDirections('   '), '');
  assert.equal(stripStageDirections(''), '');
});
