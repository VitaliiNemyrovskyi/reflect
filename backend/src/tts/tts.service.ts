import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * Backend TTS gateway. Forwards to the local `reflect_tts` sidecar,
 * which (as of v2) calls Google Gemini TTS primary + Microsoft
 * edge-tts fallback. Gemini's `Aoede`/`Kore`/`Leda` voices sound
 * markedly better on Ukrainian than edge's `PolinaNeural`.
 *
 * Architecture:
 *   browser → POST /api/tts { text, voice, gender, age }
 *           → this service forwards to sidecar (no pre-mapping)
 *           → POST http://reflect_tts:5050/tts { text, voice, gender }
 *           → audio bytes streamed back with sidecar's Content-Type
 *             (audio/wav for Gemini, audio/mpeg for edge fallback)
 *
 * The voice param can be:
 *   - bare lang 'uk'|'en'|'fr'           → sidecar picks per provider
 *   - edge-tts id 'uk-UA-PolinaNeural'   → forced edge path
 *   - Gemini voice name 'Aoede','Kore'…  → forced Gemini path
 *
 * Frontend `voice.service.ts` uses `new Audio()` which auto-detects
 * the format from Content-Type, so WAV/MP3 are both fine.
 *
 * The sidecar is internal-only on the reflect_net docker network. If
 * TTS_BASE_URL is unset (dev) the service reports disabled and the
 * frontend falls back to browser SpeechSynthesis.
 */
@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);
  readonly enabled: boolean;
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = (process.env.TTS_BASE_URL ?? '').trim();
    this.enabled = !!this.baseUrl;
    if (this.enabled) {
      this.logger.log(`TTS sidecar active at ${this.baseUrl}`);
    } else {
      this.logger.log('TTS sidecar disabled (TTS_BASE_URL unset) — frontend falls back to browser');
    }
  }

  async synthesize(
    text: string,
    voiceOrLang: string,
    opts: { gender?: string | null; age?: number | null } = {},
  ): Promise<{ audio: Buffer; contentType: string }> {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        'TTS-сервіс не налаштовано (TTS_BASE_URL пустий). Frontend має fallback на browser SpeechSynthesis.',
      );
    }
    const cleaned = this.stripStageDirections(text);
    if (!cleaned) {
      throw new BadGatewayException('Після очищення тексту нічого не залишилось озвучувати.');
    }

    // Pass voice straight through — the sidecar resolves bare lang
    // codes, edge IDs, and Gemini voice names. Gender hint lets the
    // sidecar pick a male/female default when only bare lang arrives.
    // Age is currently ignored upstream (Gemini voices aren't tagged
    // by age); kept here in the request signature for forward-compat.
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: cleaned,
          voice: voiceOrLang,
          gender: opts.gender ?? null,
        }),
        // Gemini is HTTP + decode; edge opens a WS to Microsoft. 30s
        // covers either path even on slow networks.
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      this.logger.error(`TTS sidecar unreachable: ${(e as Error).message}`);
      throw new ServiceUnavailableException('TTS-сервіс недоступний.');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error(`TTS sidecar ${res.status}: ${body.slice(0, 300)}`);
      throw new BadGatewayException(`TTS ${res.status}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'audio/mpeg';
    return { audio, contentType };
  }

  /**
   * Видаляє маркдаун-курсив (*…*), квадратні дужки [-режисура], emoji,
   * multiple-newlines. Залишає природний текст для озвучки.
   */
  private stripStageDirections(text: string): string {
    return text
      .replace(/\*[^*]+\*/g, '')
      .replace(/\[[^\]]+\]/g, '')
      .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
