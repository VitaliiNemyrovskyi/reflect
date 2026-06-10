/**
 * Defensive bounds for LLM-authored assessment scores.
 *
 * The supervisor-synthesis prompt asks for therapist competency axes on a 0–6
 * scale and patient-state axes on 1–10, but a model can still return garbage —
 * most dangerously a differently-scaled value like `empathy: 60` (a 0–100
 * habit). Left unchecked that:
 *   - inflates the competency radar past 100%, and
 *   - permanently mints flagship badges the trainee never earned, because
 *     UserMilestone rows are awarded once and never revoked.
 *
 * So we sanitise every score where the assessment is read. The rule per value:
 *   - not a finite number            → null  (excluded from means; awards nothing)
 *   - more than 1 past either bound  → null  (clearly the wrong scale — distrust
 *                                             it rather than clamp 60→6, which
 *                                             would still read as a perfect score
 *                                             and mis-award a badge)
 *   - within a rounding margin       → clamp to the bound (6.2 → 6; patient 0.5 → 1)
 */
export function clampScore(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < min - 1 || v > max + 1) return null;
  return Math.min(max, Math.max(min, v));
}

type ScoreMap = Record<string, number | null | undefined> | undefined;

/**
 * Return a copy of an assessment with its therapist axes clamped to 0–6 and
 * patient axes to 1–10 (see {@link clampScore}). Any other fields (e.g.
 * `signals`, `patientMemory`) pass through untouched. Generic so it works on
 * the full `Assessment` type without importing it.
 */
export function clampAssessment<T extends { therapist?: ScoreMap; patient?: ScoreMap }>(
  a: T,
): T {
  const clampMap = (m: ScoreMap, min: number, max: number): ScoreMap =>
    m
      ? Object.fromEntries(
          Object.entries(m).map(([k, v]) => [k, clampScore(v, min, max)]),
        )
      : m;
  return {
    ...a,
    therapist: clampMap(a.therapist, 0, 6),
    patient: clampMap(a.patient, 1, 10),
  };
}
