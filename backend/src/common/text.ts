/**
 * Pure text helpers, extracted so they can be unit-tested without standing
 * up the surrounding Nest services.
 */

/**
 * Strip markdown italics (*…*), bracketed stage directions ([…]),
 * parenthetical stage directions ((…)), emoji, and collapse whitespace —
 * leaving clean prose suitable for TTS. Used by TtsService before sending
 * text to the voice engine so it doesn't read "*sighs*", "[pauses]", or
 * "(тиша, дивиться на свої руки)" aloud in the character's own voice.
 *
 * The parenthetical strip is what keeps a narrated patient (e.g. Olesya,
 * whose profile is written in 3rd-person prose) from voicing scene-setting
 * like "(довга пауза)" — the cue stays visible in the chat transcript, it
 * just isn't spoken.
 */
export function stripStageDirections(text: string): string {
  return text
    .replace(/\*[^*]+\*/g, '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
