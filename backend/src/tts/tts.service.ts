import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);
  readonly enabled: boolean;
  private readonly apiKey?: string;
  private readonly voiceId: string;
  private readonly model: string;

  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY?.trim();
    // Charlotte — young female, multilingual-friendly default. Override via env.
    this.voiceId =
      process.env.ELEVENLABS_VOICE_ID?.trim() || 'XB0fDUnXU5powFXDhCwa';
    this.model =
      process.env.ELEVENLABS_MODEL?.trim() || 'eleven_multilingual_v2';
    this.enabled = !!this.apiKey && this.apiKey !== 'sk_…' && !this.apiKey.includes('…');
    if (this.enabled) {
      this.logger.log(`ElevenLabs TTS active (voice=${this.voiceId}, model=${this.model})`);
    } else {
      this.logger.log('ElevenLabs TTS disabled — frontend fallbacks to browser SpeechSynthesis');
    }
  }

  async synthesize(text: string): Promise<Buffer> {
    if (!this.enabled || !this.apiKey) {
      throw new ServiceUnavailableException(
        'ElevenLabs TTS не налаштовано. Додай ELEVENLABS_API_KEY у .env або користуйся browser fallback.',
      );
    }
    const cleaned = this.stripStageDirections(text);
    if (!cleaned) {
      throw new BadGatewayException('Після очищення тексту нічого не залишилось озвучувати.');
    }
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}?output_format=mp3_44100_128`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: cleaned,
        model_id: this.model,
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.75,
          style: 0.3,
          use_speaker_boost: true,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error(`ElevenLabs ${res.status}: ${body.slice(0, 300)}`);
      if (res.status === 401) {
        throw new ServiceUnavailableException(
          'ElevenLabs відхилив ключ (401). Перевір ELEVENLABS_API_KEY у .env.',
        );
      }
      if (res.status === 429) {
        throw new ServiceUnavailableException(
          'ElevenLabs rate limit (429). Free-tier: 10K символів/місяць — або вичерпано, або занадто часті виклики.',
        );
      }
      throw new BadGatewayException(`ElevenLabs ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Видаляє маркдаун-курсив (*…*), квадратні дужки [-режисура], emoji, multiple-newlines.
   * Залишає природний український текст для озвучки.
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
