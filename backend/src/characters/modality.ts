/**
 * Therapy modality — drives what skill the trainee is practicing.
 *
 * SQLite (Prisma) has no native enum, so Character.modality is stored
 * as a plain string. This module is the single source of truth for the
 * allowed values + their UI labels + their long-form descriptions used
 * in the supervisor prompt (Phase 2).
 *
 * Adding a new modality:
 *   1. Append to MODALITIES below.
 *   2. The Character schema string accepts it automatically once it's
 *      validated in isModality().
 *   3. Frontend filter chips + form selector pick it up from the API
 *      since we expose this list verbatim via /modalities.
 */

export const MODALITIES = [
  {
    key: 'individual',
    label: 'Індивідуальна',
    short: 'individual',
    icon: 'user',
    description:
      "Класична робота 1-на-1. Клієнт у кабінеті, терапевт допомагає опрацювати запит. Базова модальність — більшість профілів сюди.",
  },
  {
    key: 'couples',
    label: 'Парна',
    short: 'couples',
    icon: 'users',
    description:
      "Двоє партнерів у кабінеті. Терапевт працює з парою як з системою: не бере чий-небудь бік, керує emotional flooding, тримає alliance з обома.",
  },
  {
    key: 'family',
    label: 'Сімейна',
    short: 'family',
    icon: 'users-group',
    description:
      "Кілька членів родини (батьки-діти, сиблінги, multi-generation). Системна перспектива: тригуляція, патерни взаємодії, role enactment.",
  },
  {
    key: 'adolescent',
    label: 'Підліткова',
    short: 'adolescent',
    icon: 'school',
    description:
      "Робота з підлітком 12-18 років. Інша мова, питання конфіденційності, інтегрування шкільного контексту та батьків.",
  },
  {
    key: 'crisis',
    label: 'Кризова',
    short: 'crisis',
    icon: 'alert-triangle',
    description:
      "Гостра кризова інтервенція: суїцидальні наміри, флешбек, ПА, дисоціація. Темп інший — мета стабілізувати, не «копати».",
  },
] as const;

export type ModalityKey = (typeof MODALITIES)[number]['key'];

/**
 * Default modality applied to legacy characters during migration AND
 * to new submissions that leave the field blank. Keeps the system
 * backwards-compatible: anything that already exists continues to
 * behave as before.
 */
export const DEFAULT_MODALITY: ModalityKey = 'individual';

const MODALITY_KEYS = new Set<string>(MODALITIES.map((m) => m.key));

export function isModality(value: unknown): value is ModalityKey {
  return typeof value === 'string' && MODALITY_KEYS.has(value);
}

/**
 * Coerce arbitrary input from a form / draft brief into a valid
 * ModalityKey, falling back to DEFAULT_MODALITY rather than throwing.
 * Used at the entry points (POST /characters, draftCharacter) where
 * we'd rather save with a sane default than reject the whole payload.
 */
export function coerceModality(value: unknown): ModalityKey {
  return isModality(value) ? value : DEFAULT_MODALITY;
}
