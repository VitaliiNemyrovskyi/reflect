import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampScore, clampAssessment } from './assessment-clamp';

// These scores feed the competency radar AND the badge gates, and badges are
// awarded once and never revoked — so a single out-of-scale value from the LLM
// must NEVER survive into a 7/6 radar or a wrongly-minted milestone.

test('clampScore: in-range values pass through unchanged', () => {
  assert.equal(clampScore(0, 0, 6), 0);
  assert.equal(clampScore(4, 0, 6), 4);
  assert.equal(clampScore(6, 0, 6), 6);
  assert.equal(clampScore(4.5, 0, 6), 4.5);
});

test('clampScore: within a rounding margin clamps to the bound', () => {
  assert.equal(clampScore(6.2, 0, 6), 6); // model overshoot → max
  assert.equal(clampScore(-0.4, 0, 6), 0); // slight negative → min
  assert.equal(clampScore(0.5, 1, 10), 1); // patient scale lower edge
  assert.equal(clampScore(10.4, 1, 10), 10);
});

test('clampScore: wildly out of scale → null (distrust, do not clamp to a perfect score)', () => {
  assert.equal(clampScore(60, 0, 6), null); // the canonical 0–100 mistake
  assert.equal(clampScore(8, 0, 6), null);
  assert.equal(clampScore(-5, 0, 6), null);
  assert.equal(clampScore(100, 1, 10), null);
});

test('clampScore: non-numbers → null', () => {
  assert.equal(clampScore(undefined, 0, 6), null);
  assert.equal(clampScore(null, 0, 6), null);
  assert.equal(clampScore('5', 0, 6), null);
  assert.equal(clampScore(NaN, 0, 6), null);
  assert.equal(clampScore(Infinity, 0, 6), null);
});

test('clampAssessment: clamps therapist (0–6) and patient (1–10), preserves other fields', () => {
  const out = clampAssessment({
    therapist: { empathy: 60, collaboration: 5, structure: 6.1 } as Record<string, number | null>,
    patient: { insight: 12, alliance: 7, symptomSeverity: 0 } as Record<string, number | null>,
    signals: { riskScreened: true },
    patientMemory: 'kept',
  });

  assert.equal(out.therapist.empathy, null); // 60 → null, NOT 6 (no false badge)
  assert.equal(out.therapist.collaboration, 5);
  assert.equal(out.therapist.structure, 6); // 6.1 → 6
  assert.equal(out.patient.insight, null); // 12 → null
  assert.equal(out.patient.alliance, 7);
  assert.equal(out.patient.symptomSeverity, 1); // 0 → 1 (patient floor)
  assert.deepEqual(out.signals, { riskScreened: true });
  assert.equal(out.patientMemory, 'kept');
});

test('clampAssessment: missing therapist/patient maps stay absent', () => {
  // Annotate the input with the optional score maps so it shares properties
  // with the generic constraint (avoids TS's weak-type rejection) — the values
  // are still absent, which is what we're asserting survives.
  const input: {
    therapist?: Record<string, number | null>;
    patient?: Record<string, number | null>;
    signals: { ruptureRepaired: boolean };
  } = { signals: { ruptureRepaired: true } };
  const out = clampAssessment(input);
  assert.equal(out.therapist, undefined);
  assert.equal(out.patient, undefined);
});
