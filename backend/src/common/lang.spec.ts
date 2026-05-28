import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceLang } from './lang';

// coerceLang is the backbone of language isolation — a bug here leaks
// patients across locales (a UK trainee seeing FR patients). These cases
// pin the contract.

test('coerceLang: bare supported codes pass through', () => {
  assert.equal(coerceLang('uk'), 'uk');
  assert.equal(coerceLang('en'), 'en');
  assert.equal(coerceLang('fr'), 'fr');
});

test('coerceLang: strips region tags (en-US -> en)', () => {
  assert.equal(coerceLang('en-US'), 'en');
  assert.equal(coerceLang('fr-FR'), 'fr');
  assert.equal(coerceLang('uk-UA'), 'uk');
});

test('coerceLang: takes the first of an Accept-Language quality list', () => {
  assert.equal(coerceLang('uk,en;q=0.9,fr;q=0.8'), 'uk');
  assert.equal(coerceLang('en;q=0.8'), 'en');
  assert.equal(coerceLang('fr,en;q=0.5'), 'fr');
});

test('coerceLang: case-insensitive', () => {
  assert.equal(coerceLang('EN'), 'en');
  assert.equal(coerceLang('Fr-FR'), 'fr');
});

test('coerceLang: trims whitespace', () => {
  assert.equal(coerceLang('  fr  '), 'fr');
});

test('coerceLang: unsupported / missing falls back to uk', () => {
  assert.equal(coerceLang('de'), 'uk');
  assert.equal(coerceLang('ru'), 'uk'); // explicitly not supported
  assert.equal(coerceLang('zh-CN'), 'uk');
  assert.equal(coerceLang(''), 'uk');
  assert.equal(coerceLang(null), 'uk');
  assert.equal(coerceLang(undefined), 'uk');
});
