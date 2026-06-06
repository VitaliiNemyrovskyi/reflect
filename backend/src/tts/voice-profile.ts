/**
 * Per-character voice design for the OmniVoice engine.
 *
 * A patient's speaking voice should match their temperament, and temperament
 * is largely driven by the presenting condition: a depressed, exhausted
 * patient speaks slowly, low and flat; an anxious one is tenser and a touch
 * faster; a trauma patient is guarded and subdued. So we key the voice off
 * the ICD-10 F-code (`diagnosisCode`), with a fallback to keyword-matching
 * the Ukrainian `diagnosis` label, then a sensible default.
 *
 * Output maps onto OmniVoice's real controls:
 *   - `instruct` — structured tags the engine validates (gender [+ pitch]).
 *   - `speed`    — 0.25–4.0; <1 reads calmer/slower (raw 1.0 reads too fast).
 *   - `tone`     — free-text `description` colouring (best-effort on this
 *                  engine; speed+pitch carry most of the affect).
 *
 * Deterministic and cheap (no LLM) — same character always sounds the same.
 */
export interface VoiceProfile {
  instruct: string;
  speed: number;
  tone: string | null;
}

export function voiceForCharacter(c: {
  gender?: string | null;
  diagnosisCode?: string | null;
  diagnosis?: string | null;
}): VoiceProfile {
  const g = c.gender === 'male' ? 'male' : 'female'; // default female (legacy null rows)
  const code = (c.diagnosisCode ?? '').toUpperCase();
  const dx = (c.diagnosis ?? '').toLowerCase();
  const match = (re: RegExp, ...kw: string[]) =>
    re.test(code) || kw.some((k) => dx.includes(k));

  // Depression / recurrent depression / dysthymia → slow, low, flat affect.
  if (match(/\bF3[234]/, 'депрес', 'дистим', 'пригнічен')) {
    return { instruct: `${g}, low pitch`, speed: 0.8, tone: 'tired, flat, low energy, quiet' };
  }
  // Trauma / PTSD / acute stress reaction → slow, guarded, careful.
  if (match(/\bF43/, 'птср', 'травм', 'стрес', 'горе')) {
    return { instruct: `${g}, low pitch`, speed: 0.85, tone: 'subdued, guarded, careful' };
  }
  // OCD → controlled, precise (checked before anxiety so F42 doesn't fall
  // into the F4x bucket).
  if (match(/\bF42/, "нав'язлив", 'окр')) {
    return { instruct: g, speed: 0.95, tone: 'controlled, precise' };
  }
  // Anxiety / panic / phobia → a touch faster, tense, on edge.
  if (match(/\bF4[01]/, 'тривож', 'паніч', 'фобі')) {
    return { instruct: g, speed: 0.92, tone: 'tense, restless' };
  }
  // Eating disorders → reserved, controlled.
  if (match(/\bF50/, 'харчов', 'анорекс', 'булім')) {
    return { instruct: g, speed: 0.88, tone: 'reserved' };
  }
  // Default — natural, just under 1.0 (raw 1.0 read too fast for everyone).
  return { instruct: g, speed: 0.85, tone: null };
}
