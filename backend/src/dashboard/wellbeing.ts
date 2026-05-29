/**
 * Patient wellbeing — the gentle "care-loop" (gamification design §12).
 *
 * A started patient (≥1 scored session) carries a 0-100 wellbeing meter,
 * seeded from their last session's patient-state assessment and then drifting
 * DOWN if the trainee doesn't return. Pacing is deliberately therapy-cadence,
 * not daily-pet urgency: a 2-week grace, then a slow decline, floored well
 * above zero. The failure state is LAPSE (the patient stops coming) — never a
 * clinical crisis. Everything here is pure + time-injected so it's testable
 * and has no DB/clock coupling.
 */

export type NeglectStage = 'active' | 'slipping' | 'at_risk' | 'lapsed';

export interface Wellbeing {
  /** 0-100. Clinical baseline from the last session, minus neglect decay. */
  score: number;
  stage: NeglectStage;
  /** Whole-ish weeks since the last scored session (1 decimal). */
  weeksIdle: number;
}

/** Patient-state fields from the assessment JSON (all 1-10, may be missing). */
export interface PatientState {
  symptomSeverity?: number | null;
  insight?: number | null;
  alliance?: number | null;
  defensiveness?: number | null;
  hopefulness?: number | null;
}

// Week thresholds. Tuned so a normally-engaged trainee (weekly cadence) never
// even sees decay — it only bites on genuine abandonment.
const GRACE_WEEKS = 2; // no decay inside this window
const SLIPPING_WEEKS = 2;
const AT_RISK_WEEKS = 4;
const LAPSED_WEEKS = 6;
const DECAY_PER_WEEK = 6; // points lost per week past the grace window
const FLOOR = 18; // meter never drops below this (decay ≠ catastrophe)
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Collapse the 1-10 patient-state scores into a single 0-100 "how they're
 * doing" baseline. Higher = better: hopefulness/alliance/insight count
 * directly; symptomSeverity/defensiveness are inverted (low = good). Returns
 * null when no field is scored (can't seed a meter).
 */
export function patientStateScore(p: PatientState | null | undefined): number | null {
  if (!p) return null;
  const vals: number[] = [];
  for (const v of [p.hopefulness, p.alliance, p.insight]) {
    if (typeof v === 'number') vals.push(v);
  }
  for (const v of [p.symptomSeverity, p.defensiveness]) {
    if (typeof v === 'number') vals.push(11 - v); // invert: low severity = high wellbeing
  }
  if (vals.length === 0) return null;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length; // 1-10
  return Math.round((mean / 10) * 100); // 0-100
}

/** Neglect stage from idle weeks alone (continuity-of-care signal). */
export function neglectStage(weeksIdle: number): NeglectStage {
  if (weeksIdle >= LAPSED_WEEKS) return 'lapsed';
  if (weeksIdle >= AT_RISK_WEEKS) return 'at_risk';
  if (weeksIdle >= SLIPPING_WEEKS) return 'slipping';
  return 'active';
}

/**
 * Full wellbeing for a patient given their last-session baseline + when that
 * session ended. `now` is injected (no hidden clock). Returns null if there's
 * no baseline (patient never scored → meter inert, per §12).
 */
export function computeWellbeing(
  baseScore: number | null,
  endedAt: Date,
  now: Date,
): Wellbeing | null {
  if (baseScore == null) return null;
  const weeksIdle = Math.max(0, (now.getTime() - endedAt.getTime()) / WEEK_MS);
  const decay = Math.max(0, weeksIdle - GRACE_WEEKS) * DECAY_PER_WEEK;
  const score = Math.max(FLOOR, Math.round(baseScore - decay));
  return { score, stage: neglectStage(weeksIdle), weeksIdle: Math.round(weeksIdle * 10) / 10 };
}
