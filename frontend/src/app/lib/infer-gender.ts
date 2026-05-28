/**
 * Heuristic: guess a patient's gender from their display name. Used by
 * `VoiceService` to pick a male or female TTS voice without needing the
 * Character schema to carry an explicit gender column (which it doesn't,
 * pre-MVP).
 *
 * Strategy:
 *   1. Strip titles/honorifics ("Dr", "Mrs", …) and take the first word —
 *      surnames don't usually carry gender info reliably.
 *   2. Consult an override list for known edge cases:
 *      - Slavic biblical/old male names that LOOK female (Ілля, Лука,
 *        Микита, Кузьма, Микола, Сава)
 *      - Romance male names ending in -e/-i that the vowel rule would
 *        mis-classify (Antoine, Pierre, Henri, Théo, Reza)
 *      - Names ending in consonants that are actually female (Eleanor,
 *        Carmen, Inès, Zineb)
 *   3. Fall back to "last char is a female-leaning vowel" heuristic:
 *      ends in а/я/e/é/è/i/ї/ю/y → female. Otherwise → male.
 *
 * Returns null only when the input is empty/null. Otherwise always picks
 * a side — sidecar's voice lookup degrades gracefully to female-default
 * if the wrong side gets passed, so a guess is better than nothing.
 *
 * Couples ("Adam & Holly Thompson", "Олег і Юля") yield the gender of
 * the first name listed — that voice will play during the session.
 *
 * NOT comprehensive across all world cultures. Tune the override sets
 * as new cohorts are added.
 */

const KNOWN_MALE: ReadonlySet<string> = new Set([
  // Slavic biblical / Old-Church-Slavonic males with female-looking endings
  'ілля', 'лука', 'микита', 'кузьма', 'микола', 'сава', 'хома', 'іов',
  // French / Romance male names ending in -e or -i
  'antoine', 'pierre', 'philippe', 'henri', 'théo', 'theo', 'noé', 'noe',
  'tobie', 'rémi', 'remi', 'gabriele',
  // Persian / Arabic / Indian male names that don't fit the vowel rule
  'reza', 'mehdi', 'mamadou',
  // English male names ending in -e
  'luke',
]);

const KNOWN_FEMALE: ReadonlySet<string> = new Set([
  // English female names ending in consonants
  'eleanor', 'gwen', 'iris', 'pearl', 'faith', 'joy', 'hope',
  // French / Arabic female names ending in consonants
  'carmen', 'inès', 'ines', 'agnès', 'agnes', 'zineb', 'doris',
]);

// Letter sets are duplicated between Latin and Cyrillic visually-identical
// characters (U+0061 'a' vs U+0430 'а'), so we list both for each side.
const FEMALE_VOWELS = new Set<string>([
  // Cyrillic
  'а', 'я', 'е', 'ё', 'и', 'ї', 'і', 'ю',
  // Latin a-family
  'a', 'á', 'à', 'â', 'ä', 'ã', 'å',
  // Latin e-family
  'e', 'é', 'è', 'ê', 'ë',
  // Latin i-family
  'i', 'í', 'î', 'ï',
  // English y-ending (Holly, Mary, Emily, …)
  'y',
]);

const TITLES = new Set([
  'dr', 'dr.', 'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.',
  'pan', 'pani', 'pere', 'père', 'sir', 'lord', 'lady',
]);

export type Gender = 'male' | 'female';

export function inferGender(displayName: string | null | undefined): Gender | null {
  if (!displayName) return null;
  // Split on whitespace, hyphens, en/em dashes, and "&" / "і" (UA) couple separators.
  const words = displayName
    .trim()
    .split(/[\s—–\-&]+|\bі\b|\band\b|\bet\b/u)
    .map((w) => w.toLowerCase().replace(/[^\p{L}]+/gu, ''))
    .filter((w) => w.length > 0);
  if (words.length === 0) return null;

  // Skip leading titles.
  let first = words[0];
  if (TITLES.has(first) && words.length > 1) first = words[1];

  if (KNOWN_MALE.has(first)) return 'male';
  if (KNOWN_FEMALE.has(first)) return 'female';

  // Vowel-ending heuristic — covers UA -а/-я, EN -y/-ie, FR -e/-i, etc.
  const lastChar = first.slice(-1);
  if (FEMALE_VOWELS.has(lastChar)) return 'female';

  return 'male';
}
