/**
 * Pure text helpers, extracted so they can be unit-tested without standing
 * up the surrounding Nest services.
 */

/**
 * Strip markdown italics (*…*), bracketed stage directions ([…]), emoji,
 * and collapse whitespace/newlines — leaving clean prose suitable for TTS.
 * Used by TtsService before sending text to the voice sidecar so the model
 * doesn't read "*sighs*" or "[pauses]" aloud.
 */
export function stripStageDirections(text: string): string {
  return text
    .replace(/\*[^*]+\*/g, '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
