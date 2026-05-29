import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patientStateScore, neglectStage, computeWellbeing } from './wellbeing';

// Wellbeing drives the home-grid care-loop indicator (design §12). The decay
// pacing + stage thresholds are the product-sensitive part — pin them.

const D = (isoDaysAgo: number, now: Date) =>
  new Date(now.getTime() - isoDaysAgo * 24 * 3600 * 1000);

test('patientStateScore inverts severity/defensiveness, averages to 0-100', () => {
  // all "perfect": hope/alliance/insight=10, severity/defensiveness=1 → (10+10+10+10+10)/5=10 → 100
  assert.equal(patientStateScore({ hopefulness: 10, alliance: 10, insight: 10, symptomSeverity: 1, defensiveness: 1 }), 100);
  // all "worst": hope/alliance/insight=1, severity/defensiveness=10 → all map to 1 → 10/10 → 10
  assert.equal(patientStateScore({ hopefulness: 1, alliance: 1, insight: 1, symptomSeverity: 10, defensiveness: 10 }), 10);
  // partial fields still average
  assert.equal(patientStateScore({ hopefulness: 8, symptomSeverity: 2 }), Math.round(((8 + 9) / 2 / 10) * 100));
  // nothing scored → null (inert meter)
  assert.equal(patientStateScore({}), null);
  assert.equal(patientStateScore(null), null);
});

test('neglectStage uses week thresholds (2 / 4 / 6)', () => {
  assert.equal(neglectStage(0), 'active');
  assert.equal(neglectStage(1.9), 'active');
  assert.equal(neglectStage(2), 'slipping');
  assert.equal(neglectStage(3.9), 'slipping');
  assert.equal(neglectStage(4), 'at_risk');
  assert.equal(neglectStage(5.9), 'at_risk');
  assert.equal(neglectStage(6), 'lapsed');
  assert.equal(neglectStage(20), 'lapsed');
});

test('computeWellbeing: no decay inside the 2-week grace', () => {
  const now = new Date('2026-05-29T12:00:00Z');
  const w = computeWellbeing(80, D(10, now), now); // 10 days ≈ 1.43 wks < grace
  assert.equal(w?.score, 80);
  assert.equal(w?.stage, 'active');
});

test('computeWellbeing: slow decay past grace, floored at 18', () => {
  const now = new Date('2026-05-29T12:00:00Z');
  // 4 weeks idle → decay = (4-2)*6 = 12 → 80-12 = 68, stage at_risk
  const w = computeWellbeing(80, D(28, now), now);
  assert.equal(w?.score, 68);
  assert.equal(w?.stage, 'at_risk');
  // huge gap floors the meter, never below 18
  const lapsed = computeWellbeing(80, D(365, now), now);
  assert.equal(lapsed?.score, 18);
  assert.equal(lapsed?.stage, 'lapsed');
});

test('computeWellbeing: null baseline → null (no meter)', () => {
  const now = new Date('2026-05-29T12:00:00Z');
  assert.equal(computeWellbeing(null, D(1, now), now), null);
});
