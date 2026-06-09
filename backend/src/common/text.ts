/**
 * Pure text helpers, extracted so they can be unit-tested without standing
 * up the surrounding Nest services.
 */

/**
 * OmniVoice's supported inline non-verbal cues. The patient model may emit
 * these sparingly (a sigh, a nervous laugh) and OmniVoice renders them as
 * real sounds. Matches a token that is EXACTLY one supported tag. Every other
 * bracketed token is a stage direction and gets stripped.
 */
export const OMNI_NONVERBAL =
  /^\[(?:laughter|sigh|confirmation-en|question-(?:en|ah|oh|ei|yi)|surprise-(?:ah|oh|wa|yo)|dissatisfaction-hnn)\]$/i;

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
 *
 * With `{ keepOmniTags: true }` the supported OmniVoice non-verbal cues
 * (OMNI_NONVERBAL — [sigh], [laughter], …) survive so the engine can voice
 * them; every other bracketed token is still removed. Use that ONLY for the
 * OmniVoice path — the Gemini/edge sidecar would read "[sigh]" out loud as a
 * word, so it gets the default (all brackets stripped).
 */
export function stripStageDirections(
  text: string,
  opts: { keepOmniTags?: boolean } = {},
): string {
  return text
    .replace(/\*[^*]+\*/g, '')
    .replace(/\[[^\]]+\]/g, (m) => (opts.keepOmniTags && OMNI_NONVERBAL.test(m) ? m : ''))
    .replace(/\([^)]*\)/g, '')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
