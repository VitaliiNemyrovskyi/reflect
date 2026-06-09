import {
  BadGatewayException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { stripStageDirections } from '../common/text';
import type { VoiceProfile } from './voice-profile';

/**
 * Backend TTS gateway with two engines:
 *
 *   1. OmniVoice (self-hosted, optional PRIMARY) — a GPU box runs the
 *      OmniVoice Studio backend in server mode (OMNIVOICE_SERVER_MODE=1, no
 *      rotating share PIN); we reach it over a named Cloudflare tunnel
 *      (OMNIVOICE_URL) fronted by Cloudflare Access — a STABLE service-token
 *      pair (OMNIVOICE_CF_ACCESS_CLIENT_ID / _SECRET) checked at Cloudflare's
 *      edge before the request reaches the box. Apache-2.0 model, ~5s/line,
 *      natural Ukrainian + voice-design by description. Enabled only when the
 *      URL + both token halves are set.
 *
 *   2. reflect_tts sidecar (FALLBACK / default) — Google Gemini TTS primary
 *      + Microsoft edge-tts fallback, on the internal docker network.
 *
 * Flow:
 *   browser → POST /api/tts { text, voice, gender, age }
 *           → OmniVoice (if configured + breaker closed + bare-lang voice)
 *           → on any failure/timeout → reflect_tts sidecar
 *           → audio bytes streamed back with the engine's Content-Type
 *
 * OmniVoice is a home/GPU box behind a tunnel, so it's treated as strictly
 * best-effort. Three guards keep a down/slow tunnel from ever degrading the
 * user-facing path:
 *   - a per-call timeout;
 *   - a HEALTH GATE — a 5-min probe cron (which doubles as a keepalive, since
 *     the model unloads after ~15 min idle) flips `omniHealthy`; live requests
 *     only attempt OmniVoice when it's true, so we never pay the timeout on a
 *     dead tunnel. A probe that succeeds clears the breaker, so a tunnel that
 *     comes back online re-enables itself within one cron cycle — no redeploy;
 *   - a circuit breaker — a few consecutive LIVE failures skip it for a short
 *     cooldown (covers a tunnel that dies between probes).
 *
 * If neither engine is configured the service reports disabled and the
 * frontend falls back to browser SpeechSynthesis.
 */
@Injectable()
export class TtsService implements OnModuleInit {
  private readonly logger = new Logger(TtsService.name);

  /** reflect_tts sidecar (Gemini/edge). */
  readonly enabled: boolean;
  private readonly baseUrl: string;

  /** OmniVoice self-hosted primary (named Cloudflare tunnel, fronted by
   *  Cloudflare Access — a stable service-token pair, not a rotating PIN). */
  private readonly omniUrl: string;
  private readonly cfAccessId: string;
  private readonly cfAccessSecret: string;
  private readonly omniEnabled: boolean;
  /** Circuit breaker: consecutive failures + skip-until timestamp. */
  private omniFails = 0;
  private omniSkipUntil = 0;
  /** Health gate, maintained by the probe (onModuleInit + 5-min cron). Live
   *  traffic only attempts OmniVoice when this is true, so a down/slow tunnel
   *  never makes a user request wait out the per-call timeout. */
  private omniHealthy = false;

  constructor() {
    this.baseUrl = (process.env.TTS_BASE_URL ?? '').trim();
    this.enabled = !!this.baseUrl;

    this.omniUrl = (process.env.OMNIVOICE_URL ?? '').trim().replace(/\/+$/, '');
    this.cfAccessId = (process.env.OMNIVOICE_CF_ACCESS_CLIENT_ID ?? '').trim();
    this.cfAccessSecret = (process.env.OMNIVOICE_CF_ACCESS_CLIENT_SECRET ?? '').trim();
    this.omniEnabled = !!(this.omniUrl && this.cfAccessId && this.cfAccessSecret);

    if (this.omniEnabled) this.logger.log(`TTS: OmniVoice primary at ${this.omniUrl}`);
    if (this.enabled) this.logger.log(`TTS: reflect_tts sidecar at ${this.baseUrl}`);
    if (!this.enabled && !this.omniEnabled) {
      this.logger.log('TTS disabled (no engine configured) — frontend falls back to browser');
    }
  }

  /** Fire a first health probe (fire-and-forget so a down tunnel never delays
   *  app startup). The cron keeps it fresh thereafter. */
  onModuleInit(): void {
    if (this.omniEnabled) void this.probeOmnivoice();
  }

  async synthesize(
    text: string,
    voiceOrLang: string,
    opts: { gender?: string | null; age?: number | null; voice?: VoiceProfile | null } = {},
  ): Promise<{ audio: Buffer; contentType: string }> {
    if (!this.enabled && !this.omniEnabled) {
      throw new ServiceUnavailableException(
        'TTS-сервіс не налаштовано. Frontend має fallback на browser SpeechSynthesis.',
      );
    }
    // OmniVoice can voice the supported non-verbal cues ([sigh]/[laughter]),
    // so keep them for that path; the Gemini/edge sidecar would read them as
    // words, so it gets the fully-stripped text.
    const omniText = stripStageDirections(text, { keepOmniTags: true });
    const sidecarText = stripStageDirections(text);
    if (!omniText) {
      throw new BadGatewayException('Після очищення тексту нічого не залишилось озвучувати.');
    }

    // ── 1. OmniVoice (best-effort primary) ─────────────────────────────
    // Only for bare-lang requests (the chat default); an explicit voice id
    // (Gemini name / edge id) means the caller wants that voice → sidecar.
    const bareLang = ['uk', 'en', 'fr'].includes(voiceOrLang);
    if (this.omniEnabled && this.omniHealthy && bareLang && Date.now() >= this.omniSkipUntil) {
      try {
        const out = await this.tryOmnivoice(omniText, voiceOrLang, opts.gender ?? null, opts.voice ?? null);
        this.omniFails = 0;
        this.omniHealthy = true;
        return out;
      } catch (e) {
        this.omniFails += 1;
        if (this.omniFails >= 3) {
          this.omniSkipUntil = Date.now() + 120_000; // cool down 2 min
          this.omniFails = 0;
          this.omniHealthy = false; // stop trying until a probe re-confirms
          this.logger.warn('OmniVoice tripped breaker — skipping 120s, using fallback');
        } else {
          this.logger.warn(`OmniVoice failed (${this.omniFails}/3): ${(e as Error).message} — fallback`);
        }
        if (!this.enabled) {
          throw new ServiceUnavailableException('TTS недоступний (OmniVoice впав, fallback не налаштовано).');
        }
        // else: fall through to the sidecar
      }
    }

    // ── 2. reflect_tts sidecar (Gemini/edge) ───────────────────────────
    if (!this.enabled) {
      throw new ServiceUnavailableException('TTS-сервіс недоступний.');
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: sidecarText, voice: voiceOrLang, gender: opts.gender ?? null }),
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

  /** Request headers for the OmniVoice tunnel: JSON + the Cloudflare Access
   *  service-token pair the edge checks before the request reaches the box.
   *  Stable — set once, survives every OmniVoice/PC restart (no PIN). */
  private omniHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'CF-Access-Client-Id': this.cfAccessId,
      'CF-Access-Client-Secret': this.cfAccessSecret,
    };
  }

  /** Call the OmniVoice backend (OpenAI-compatible) via the tunnel. The voice
   *  is set by the engine's structured `instruct` tags — NOT `description`,
   *  which the omnivoice engine ignores (that field is for the VoxCPM2 engine).
   *  A gender tag locks the speaker so the voice can't drift mid-utterance. */
  private async tryOmnivoice(
    text: string,
    lang: string,
    gender: string | null,
    voice: VoiceProfile | null = null,
  ): Promise<{ audio: Buffer; contentType: string }> {
    // Per-character voice (temperament) when resolved; else gender-only.
    // `speed` < 1 keeps delivery calm — raw 1.0 reads too fast for everyone.
    const body: Record<string, unknown> = {
      input: text,
      language: lang,
      instruct: voice?.instruct ?? this.voiceInstruct(gender),
      speed: voice?.speed ?? 0.85,
      response_format: 'mp3',
    };
    if (voice?.tone) body.description = voice.tone;
    const res = await fetch(`${this.omniUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: this.omniHeaders(),
      body: JSON.stringify(body),
      // Warm synth is ~5s; cap at 12s so a cold/slow call falls back fast.
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`omni ${res.status}`);
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 256) throw new Error('omni returned empty audio');
    return { audio, contentType: res.headers.get('content-type') ?? 'audio/mpeg' };
  }

  /** Gender → OmniVoice structured `instruct` tags (the engine's predefined
   *  voice-design tokens: gender + age; pitch/accent are also valid). Always
   *  emit a gender tag so the speaker is pinned and can't drift mid-utterance.
   *  Tags are language-agnostic — the model maps them onto the synthesis
   *  `language`. Unknown gender → female (rare: most characters carry an
   *  explicit Character.gender). */
  private voiceInstruct(gender: string | null): string {
    if (gender === 'male') return 'male, middle-aged';
    return 'female, young adult';
  }

  /** Health probe + keepalive in one. Every 5 min a tiny synth both keeps the
   *  model loaded (it unloads after ~15 min idle → slow cold start) and updates
   *  the health gate, so live traffic only hits OmniVoice when the tunnel is up.
   *  Best-effort; never throws. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async omniHealthCheck(): Promise<void> {
    if (this.omniEnabled) await this.probeOmnivoice();
  }

  /** One probe synth → sets omniHealthy. On success it also clears the breaker,
   *  so a tunnel that comes back online re-enables itself within one cron cycle
   *  (no redeploy). Never throws. */
  private async probeOmnivoice(): Promise<void> {
    try {
      const res = await fetch(`${this.omniUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: this.omniHeaders(),
        body: JSON.stringify({
          input: 'привіт',
          language: 'uk',
          response_format: 'mp3',
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const ok = res.ok && (await res.arrayBuffer()).byteLength > 256;
      this.omniHealthy = ok;
      if (ok) {
        this.omniFails = 0;
        this.omniSkipUntil = 0;
        this.logger.debug('OmniVoice probe ok — engine healthy');
      } else {
        this.logger.debug(`OmniVoice probe not-ok (status ${res.status})`);
      }
    } catch (e) {
      this.omniHealthy = false;
      this.logger.debug(`OmniVoice probe failed: ${(e as Error).message}`);
    }
  }
}
