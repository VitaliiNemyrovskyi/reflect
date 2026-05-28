/**
 * Supported UI/profile languages. Each character row has a `lang`
 * column that gets matched against the user's current locale so the
 * patient roster stays language-consistent (a UK trainee sees only
 * uk characters, an EN trainee only en, an FR trainee only fr).
 *
 * The model is intentionally narrow: adding a new lang requires
 * (1) registering the City row, (2) translating the i18n.service.ts
 * dictionary, (3) adding it here. Doing all three in one PR keeps
 * "half-supported" locales from leaking into the UI.
 */
export type Lang = 'uk' | 'en' | 'fr';

const SUPPORTED: ReadonlySet<Lang> = new Set(['uk', 'en', 'fr']);

/**
 * Narrow an arbitrary Accept-Language header (or any raw lang string)
 * to one of the supported locales. Defaults to 'uk' — the original
 * primary locale — so a missing/unknown header doesn't blank the
 * patient roster for a Ukrainian-only user.
 *
 * Accepts the full Accept-Language quality list (`uk,en;q=0.9`) and
 * also bare codes ('en', 'fr'). Case-insensitive.
 */
export function coerceLang(raw: string | undefined | null): Lang {
  if (!raw) return 'uk';
  const first = raw.split(/[-,;]/)[0].trim().toLowerCase();
  return SUPPORTED.has(first as Lang) ? (first as Lang) : 'uk';
}
