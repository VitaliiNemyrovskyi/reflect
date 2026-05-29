import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { PrismaService } from '../prisma/prisma.service';
import { estimateCostUsd } from './pricing';

/**
 * Hard wall-clock cap for a non-streaming chat call.
 *
 * Fast frontier models (DeepSeek V4 Flash, Gemini 2.5 Flash-Lite, Qwen
 * 3.6 Flash) hit first byte in 1-2s and finish a short reply in 5-10s.
 * 60s gives 6× headroom for transient slowdowns while bounding the
 * worst case — much better than the old 180s window which masked the
 * fact that stealth models were stalling for two minutes per turn.
 *
 * Profile-generation calls (~4096 output tokens) still fit comfortably:
 * at 80 tok/s that's ~50s. If a future call needs more, override per
 * call via the maxTokens path or split into chunks.
 *
 * Outer Caddy proxy timeout is 300s, so we still fail cleanly upstream.
 */
const CHAT_TIMEOUT_MS = 60_000;

/**
 * Explicit per-request timeout on the OpenAI Node SDK client. Without
 * this the SDK uses its own internal default which can hang for the
 * full connection-keepalive window when a stealth provider stalls
 * mid-stream. 180s lets a slow first-byte resolve while bounding the
 * worst case.
 */
const OPENAI_SDK_TIMEOUT_MS = 180_000;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * One segment of the system prompt. When `cache: true`, a cache_control
 * marker is placed at the END of the block, so any future request whose
 * system prompt shares this PREFIX (up to and including this block) can
 * be served from cache.
 *
 * Stack multiple blocks to layer cacheability — e.g. for feedback:
 *   [supervisor + protocol]  ← cache=true (stable across ALL sessions ever)
 *   [PROFILE]                ← cache=true (stable per character)
 *   [TRANSCRIPT + NOTES]     ← cache=false (unique per session)
 *
 * On cache hit, only the cached prefix is charged at 10% of input price.
 * On miss, the block is written to cache at 1.25× input price (5 min TTL).
 */
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

export type LlmProvider = 'anthropic' | 'openrouter';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  readonly provider: LlmProvider;
  private readonly anthropic?: Anthropic;
  private readonly openai?: OpenAI;

  readonly modelChat: string;
  /** Optional fallback model for chat() calls. When the primary chat
   *  model times out or returns a 5xx, chat() retries ONCE with this
   *  model. Different vendor than primary is the safest pick — that
   *  way a single provider outage doesn't take chat down. Empty /
   *  unset = no fallback, errors bubble up to the user.
   *  Override via LLM_MODEL_CHAT_FALLBACK env var. */
  readonly modelChatFallback: string | null;
  readonly modelFeedback: string;
  /** Optional fallback model for feedback generation. If the primary
   *  feedback model fails BEFORE any chunk has streamed (timeout /
   *  upstream 5xx / connection reset), the supervisor retry uses
   *  this one. Empty / unset = no fallback, errors bubble up. */
  readonly modelFeedbackFallback: string | null;
  /** Model for the two-pass REVIEWER stage (Pass 2). Used only in
   *  'two-pass' mode. In 'skills' mode, modelSkillsSynthesizer is used
   *  instead. Override via LLM_MODEL_FEEDBACK_REVIEWER env var. */
  readonly modelFeedbackReviewer: string;
  /** Synthesis model for 'skills' feedback mode. Receives Haiku draft +
   *  all parallel skill-check JSONs → produces final coherent feedback.
   *  Qwen 3.7 Max is the recommended default — fast streaming, good at
   *  integrating structured JSON, strong Ukrainian. ~$0.023/session.
   *  Override via LLM_MODEL_SKILLS_SYNTHESIZER env var. */
  readonly modelSkillsSynthesizer: string;
  /** Feedback generation mode:
   *  - 'skills' — production default. 14 parallel Haiku skill checks
   *    (each targeting ONE clinical dimension) + Qwen synthesis.
   *    ~$0.08/session, 14 clinical dimensions, ~35s to first chunk.
   *    No Opus required. Covers suicidality, shame, cognitive
   *    distortions, validation, trauma, nonverbal cues and more.
   *  - 'two-pass' — Haiku draft → tier-based reviewer (Opus/Sonnet).
   *    Reliable fallback if skills mode has issues. ~$0.08-0.16.
   *  - 'single' — legacy one-pass, fast but shallow.
   *  Override via FEEDBACK_MODE env var. */
  readonly feedbackMode: 'single' | 'two-pass' | 'skills';

  constructor(private readonly prisma: PrismaService) {
    this.provider = (process.env.LLM_PROVIDER as LlmProvider) || 'anthropic';

    // ?? falls through only on undefined/null — but Docker compose passes
    // unset vars through as EMPTY strings ("") via `${VAR:-}` interpolation,
    // so we need to also reject blank values. Otherwise the SDK gets
    // model="" and OpenRouter returns 400 "No models provided".
    const envChat = process.env.LLM_MODEL_CHAT?.trim();
    const envChatFallback = process.env.LLM_MODEL_CHAT_FALLBACK?.trim();
    const envFeedback = process.env.LLM_MODEL_FEEDBACK?.trim();
    const envFeedbackFallback = process.env.LLM_MODEL_FEEDBACK_FALLBACK?.trim();
    const envFeedbackReviewer = process.env.LLM_MODEL_FEEDBACK_REVIEWER?.trim();
    const envSkillsSynth = process.env.LLM_MODEL_SKILLS_SYNTHESIZER?.trim();

    // FEEDBACK_MODE drives the feedback pipeline strategy.
    // Default is now 'skills' — the multi-agent pipeline covers 14
    // clinical dimensions at ~$0.08/session without any Opus calls.
    // Set FEEDBACK_MODE=two-pass to revert to the Haiku→reviewer flow.
    const envFeedbackMode = process.env.FEEDBACK_MODE?.trim().toLowerCase();
    this.feedbackMode =
      envFeedbackMode === 'two-pass' ? 'two-pass' :
      envFeedbackMode === 'single'   ? 'single'   :
      'skills'; // default

    if (this.provider === 'anthropic') {
      this.anthropic = new Anthropic();
      // Defaults optimised for cost (~$0.13/session) while keeping
      // feedback quality high — Sonnet handles citation accuracy fine,
      // Haiku handles patient persona under brevity-capped output.
      // Override via LLM_MODEL_CHAT / LLM_MODEL_FEEDBACK env vars if
      // the deployment has different priorities.
      this.modelChat = envChat || 'claude-haiku-4-5';
      // Anthropic-native: no cross-vendor fallback option, so reuse the
      // primary. Set LLM_MODEL_CHAT_FALLBACK explicitly if you have a
      // proxy or want to use a different Anthropic model.
      this.modelChatFallback = envChatFallback || null;
      this.modelFeedback = envFeedback || 'claude-haiku-4-5';
      this.modelFeedbackFallback = envFeedbackFallback || 'claude-haiku-4-5';
      // Reviewer for two-pass mode only. Skills mode uses Sonnet as
      // synthesizer since Anthropic-native doesn't have Qwen.
      this.modelFeedbackReviewer = envFeedbackReviewer || 'claude-opus-4-7';
      this.modelSkillsSynthesizer = envSkillsSynth || 'claude-sonnet-4-6';
    } else if (this.provider === 'openrouter') {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          'LLM_PROVIDER=openrouter, але OPENROUTER_API_KEY не вказаний у .env. Візьми ключ на https://openrouter.ai/settings/keys',
        );
      }
      this.openai = new OpenAI({
        apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
        timeout: OPENAI_SDK_TIMEOUT_MS,
        defaultHeaders: {
          // OpenRouter uses HTTP-Referer + X-Title for analytics. Match
          // FRONTEND_URL when set so analytics group prod traffic correctly.
          'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:4200',
          'X-Title': 'Reflect',
        },
      });
      // Default chat: DeepSeek V4 Flash — 1.1s TTFT, 83-150 tok/s,
      // $0.10/$0.20 per M tokens, strong multilingual (incl. UA).
      // Override via LLM_MODEL_CHAT for experimentation.
      this.modelChat = envChat || 'deepseek/deepseek-v4-flash';
      // Different-vendor fallback so a DeepSeek outage doesn't take chat
      // down. Gemini 2.5 Flash-Lite is OpenRouter's official low-latency
      // pick, similar speed and price.
      this.modelChatFallback = envChatFallback || 'google/gemini-2.5-flash-lite';
      this.modelFeedback = envFeedback || 'openrouter/owl-alpha';
      // Fallback for slow / unstable stealth feedback model.
      this.modelFeedbackFallback = envFeedbackFallback || 'anthropic/claude-haiku-4-5';
      // Reviewer for two-pass mode only (legacy).
      // In skills mode, modelSkillsSynthesizer is used instead.
      this.modelFeedbackReviewer = envFeedbackReviewer || 'anthropic/claude-opus-4-7';
      // Skills synthesizer: Qwen 3.7 Max — fast streaming, strong JSON
      // integration, solid Ukrainian, ~$0.023 per synthesis call.
      // Change via LLM_MODEL_SKILLS_SYNTHESIZER if preferred.
      this.modelSkillsSynthesizer = envSkillsSynth || 'qwen/qwen3.7-max';
    } else {
      throw new Error(`Невідомий LLM_PROVIDER: ${this.provider}`);
    }

    this.logger.log(
      `LLM provider=${this.provider} mode=${this.feedbackMode} ` +
        `chat=${this.modelChat}${this.modelChatFallback ? `→${this.modelChatFallback}` : ''} ` +
        `draft=${this.modelFeedback} ` +
        (this.feedbackMode === 'skills'
          ? `synthesizer=${this.modelSkillsSynthesizer}`
          : `reviewer=${this.modelFeedbackReviewer}`),
    );
  }

  async chat(opts: {
    systemPrompt?: string;
    systemBlocks?: SystemBlock[];
    history: ChatMessage[];
    model?: string;
    maxTokens?: number;
    cacheSystem?: boolean;
  }): Promise<string> {
    const primaryModel = opts.model ?? this.modelChat;
    // Default hard cap 512 — chat replies should be SHORT per brevity
    // instruction in the system prompt. 512 tokens ≈ 380 words EN /
    // 250-300 UA, well above the soft caps (20-180 words). Acts as a
    // safety net against runaway monologues. Caller can override.
    const maxTokens = opts.maxTokens ?? 512;
    const blocks = toSystemBlocks(opts);

    const callWithModel = (model: string) => (signal: AbortSignal) =>
      this.provider === 'anthropic'
        ? this.chatAnthropic(blocks, opts.history, model, maxTokens, signal)
        : this.chatOpenRouter(joinBlocks(blocks), opts.history, model, maxTokens, signal);

    // Only auto-fallback when caller didn't pin a specific model — if
    // they passed opts.model they're likely benchmarking or testing,
    // so respect their choice. modelChatFallback null = no fallback,
    // errors bubble up.
    const fallbackModel = !opts.model && this.modelChatFallback ? this.modelChatFallback : null;

    try {
      return await this.withRateLimitRetry(() =>
        this.withTimeout(callWithModel(primaryModel), CHAT_TIMEOUT_MS),
      );
    } catch (primaryErr: unknown) {
      if (!fallbackModel || !this.shouldFallback(primaryErr)) {
        throw this.translateError(primaryErr);
      }
      this.logger.warn(
        `chat ${primaryModel} failed (${describeError(primaryErr)}) — retrying with fallback ${fallbackModel}`,
      );
      try {
        return await this.withRateLimitRetry(() =>
          this.withTimeout(callWithModel(fallbackModel), CHAT_TIMEOUT_MS),
        );
      } catch (fallbackErr: unknown) {
        // Surface the fallback's error — it's the one closer in time to
        // when we gave up. The primary error is already logged above
        // so we have both data points for debugging.
        throw this.translateError(fallbackErr);
      }
    }
  }

  /**
   * Decide whether `chat()` should auto-retry with the fallback model
   * after the primary failed. We retry on signals that suggest the
   * model/provider is the problem (timeout, 5xx, connection reset),
   * NOT on signals that mean the user / caller made a mistake (4xx
   * other than 429, validation errors, auth failures). 429s are already
   * handled in-place by withRateLimitRetry before we get here.
   */
  private shouldFallback(e: unknown): boolean {
    if (e instanceof GatewayTimeoutException) return true;
    const status = (e as { status?: number })?.status;
    if (status && status >= 500 && status < 600) return true;
    // OpenAI/Anthropic SDKs raise ECONNRESET, ENETUNREACH etc. as the
    // bare cause — surface as APIConnectionError with no status.
    const code = (e as { code?: string })?.code;
    if (code === 'ECONNRESET' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') return true;
    return false;
  }

  /**
   * Wrap a call that takes an AbortSignal in a hard wall-clock timeout.
   * On timeout, aborts the signal (so SDKs can clean up their HTTP
   * connection) and throws GatewayTimeoutException — translateError
   * passes through 504 untouched.
   */
  private async withTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    ms: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fn(controller.signal);
    } catch (e: unknown) {
      if (controller.signal.aborted) {
        throw new GatewayTimeoutException(
          `LLM не відповідає більше ${Math.round(ms / 1000)}с — модель перевантажена або зависла. Спробуй ще раз або зменши контекст.`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run `fn` and retry once on 429 (rate-limit) after a short wait. Free
   * tiers (especially OpenRouter's `:free` and stealth providers) hit
   * 429 intermittently — a single 1.5s back-off usually clears it without
   * the user having to re-click. We deliberately keep the retry tight
   * because the frontend is already showing a loading state and longer
   * waits feel worse than a clean error.
   *
   * Streaming endpoints don't use this — they have their own first-byte
   * latency budget and the caller chooses when to retry.
   */
  private async withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e: unknown) {
      const status = (e as { status?: number })?.status;
      if (status !== 429) throw e;
      this.logger.warn(`${this.provider} 429 — retrying in 1.5s`);
      await new Promise((r) => setTimeout(r, 1500));
      return await fn();
    }
  }

  /**
   * Streaming variant of chat(). Yields text chunks as they arrive from the
   * provider. Caller is responsible for handling translation errors.
   */
  async *chatStream(opts: {
    systemPrompt?: string;
    systemBlocks?: SystemBlock[];
    history: ChatMessage[];
    model?: string;
    maxTokens?: number;
    cacheSystem?: boolean;
  }): AsyncGenerator<string, void, unknown> {
    const model = opts.model ?? this.modelChat;
    // Default hard cap 512 — chat replies should be SHORT per brevity
    // instruction in the system prompt. 512 tokens ≈ 380 words EN /
    // 250-300 UA, well above the soft caps (20-180 words). Acts as a
    // safety net against runaway monologues. Caller can override.
    const maxTokens = opts.maxTokens ?? 512;
    const blocks = toSystemBlocks(opts);

    try {
      if (this.provider === 'anthropic') {
        yield* this.streamAnthropic(blocks, opts.history, model, maxTokens);
      } else {
        yield* this.streamOpenRouter(joinBlocks(blocks), opts.history, model, maxTokens);
      }
    } catch (e: unknown) {
      throw this.translateError(e);
    }
  }

  private async *streamAnthropic(
    systemBlocks: SystemBlock[],
    history: ChatMessage[],
    model: string,
    maxTokens: number,
  ): AsyncGenerator<string, void, unknown> {
    const stream = this.anthropic!.messages.stream({
      model,
      max_tokens: maxTokens,
      system: toAnthropicSystem(systemBlocks),
      messages: history.map((m) => ({ role: m.role, content: m.content })),
    });

    // Usage arrives across stream events: input on message_start, cumulative
    // output on message_delta. Record in finally so a client disconnect
    // (generator early-return) still logs what was billed — guarded so we
    // skip rows for streams that died before any usage landed.
    let inTok = 0, outTok = 0;
    try {
      for await (const event of stream) {
        if (event.type === 'message_start') {
          inTok = event.message.usage?.input_tokens ?? 0;
        } else if (event.type === 'message_delta') {
          outTok = event.usage?.output_tokens ?? outTok;
        } else if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield event.delta.text;
        }
      }
    } finally {
      if (inTok || outTok) this.recordUsage('anthropic', model, inTok, outTok);
    }
  }

  private async *streamOpenRouter(
    systemPrompt: string,
    history: ChatMessage[],
    model: string,
    maxTokens: number,
  ): AsyncGenerator<string, void, unknown> {
    const stream = await this.openai!.chat.completions.create({
      model,
      max_tokens: maxTokens,
      stream: true,
      // Ask the provider to emit a final usage chunk (empty choices, has
      // `usage`). OpenRouter forwards this to providers that support it; if
      // one ignores it we simply don't record (inTok/outTok stay 0).
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    let inTok = 0, outTok = 0, cost = 0;
    try {
      for await (const chunk of stream) {
        if (chunk.usage) {
          inTok = chunk.usage.prompt_tokens ?? inTok;
          outTok = chunk.usage.completion_tokens ?? outTok;
          cost = (chunk.usage as { cost?: number }).cost ?? cost;
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          yield delta;
        }
      }
    } finally {
      if (inTok || outTok) this.recordUsage('openrouter', model, inTok, outTok, cost || undefined);
    }
  }

  private async chatAnthropic(
    systemBlocks: SystemBlock[],
    history: ChatMessage[],
    model: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const msg = await this.anthropic!.messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: toAnthropicSystem(systemBlocks),
        messages: history.map((m) => ({ role: m.role, content: m.content })),
      },
      { signal },
    );

    this.recordUsage('anthropic', model, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);

    return (msg.content || [])
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  private async chatOpenRouter(
    systemPrompt: string,
    history: ChatMessage[],
    model: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const completion = await this.openai!.chat.completions.create(
      {
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history.map((m) => ({ role: m.role, content: m.content })),
        ],
      },
      { signal },
    );
    this.recordUsage(
      'openrouter',
      model,
      completion.usage?.prompt_tokens ?? 0,
      completion.usage?.completion_tokens ?? 0,
      (completion.usage as { cost?: number } | undefined)?.cost,
    );

    const reply = completion.choices?.[0]?.message?.content ?? '';
    return reply.trim();
  }

  /**
   * Fire-and-forget record of one completion's token usage + estimated
   * cost. Never throws into the LLM path — a logging failure must not break
   * a chat/feedback call. Captures the non-streaming completions, which are
   * the bulk of token volume (feedback draft + 15 skill agents + diary +
   * world-tick); the streamed synthesis (~1 call/session) is not yet
   * captured here.
   */
  private recordUsage(
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
    actualCostUsd?: number,
  ): void {
    // Prefer the provider-reported cost when present (OpenRouter returns an
    // exact USD `cost` in its usage payload) — it accounts for the real
    // per-model price, cache discounts, etc. Fall back to our static price
    // map only when the provider doesn't tell us (e.g. Anthropic).
    const costUsd =
      actualCostUsd != null && actualCostUsd > 0
        ? actualCostUsd
        : estimateCostUsd(model, promptTokens, completionTokens);
    void this.prisma.llmUsage
      .create({ data: { provider, model, promptTokens, completionTokens, costUsd } })
      .catch((e) => this.logger.warn(`llmUsage record failed: ${(e as Error).message}`));
  }

  private translateError(e: unknown): Error {
    // Pass GatewayTimeoutException through unchanged — the message is
    // already user-facing and we don't want translateError to strip the
    // 504 status by re-wrapping it as 502.
    if (e instanceof GatewayTimeoutException) return e;
    const status = (e as { status?: number })?.status;
    const anthropicMsg = (e as { error?: { error?: { message?: string } } })?.error
      ?.error?.message;
    const openaiMsg = (e as { error?: { message?: string } })?.error?.message;
    const msg =
      anthropicMsg ?? openaiMsg ?? (e as { message?: string })?.message ?? 'LLM API error';

    if (status === 401) {
      this.logger.warn(`${this.provider} 401 — invalid API key`);
      const keyVar =
        this.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY';
      return new UnauthorizedException(
        `${this.provider} відмовив у доступі (401). Перевір ${keyVar} у .env — там, схоже, заглушка або старий ключ.`,
      );
    }
    if (status === 400 && /credit balance/i.test(msg)) {
      return new BadGatewayException(
        'На Anthropic-акаунті закінчились кредити. Зайди на console.anthropic.com → Plans & Billing і поповни баланс (на тестовий місяць вистачить $5).',
      );
    }
    if (status === 402 || /insufficient|payment required/i.test(msg)) {
      return new BadGatewayException(
        `${this.provider}: недостатньо балансу або платний тариф. ${msg}`,
      );
    }
    if (status === 429) {
      return new ServiceUnavailableException(
        `${this.provider} rate limit (429). Free-tier ліміт або перевантажена модель — зачекай хвилину.`,
      );
    }
    if (typeof status === 'number') {
      return new BadGatewayException(`${this.provider} ${status}: ${msg}`);
    }
    this.logger.error(e);
    return new BadGatewayException(`LLM-виклик упав: ${msg}`);
  }
}

/**
 * Normalize either the legacy {systemPrompt, cacheSystem} pair or the new
 * {systemBlocks} array into a single SystemBlock[] for the provider
 * adapters. Empty/undefined systemPrompt collapses to a [] so a caller
 * can omit the system param entirely (rare — most prompts need one).
 */
function toSystemBlocks(opts: {
  systemPrompt?: string;
  systemBlocks?: SystemBlock[];
  cacheSystem?: boolean;
}): SystemBlock[] {
  if (opts.systemBlocks?.length) return opts.systemBlocks;
  if (opts.systemPrompt && opts.systemPrompt.length > 0) {
    return [{ text: opts.systemPrompt, cache: !!opts.cacheSystem }];
  }
  return [];
}

/**
 * Translate SystemBlock[] into Anthropic's `system` parameter format.
 * Each block becomes a text content block; if `cache:true`, attach the
 * cache_control marker so prefix matching ends at this block.
 */
function toAnthropicSystem(
  blocks: SystemBlock[],
): Array<Anthropic.Messages.TextBlockParam> {
  return blocks.map((b) =>
    b.cache
      ? { type: 'text' as const, text: b.text, cache_control: { type: 'ephemeral' as const } }
      : { type: 'text' as const, text: b.text },
  );
}

/**
 * OpenRouter / OpenAI-compatible providers don't support per-block cache
 * markers, so flatten the structured blocks back into a single string for
 * those adapters. Cache flags are dropped silently — they're an Anthropic
 * optimisation, not a portability concern.
 */
function joinBlocks(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join('');
}

/**
 * Compact one-line summary of an error for fallback-retry logging. We
 * surface what the operator needs to triage — status, exception name,
 * trimmed message — without dumping a full stack trace into the log
 * stream (that lands in ErrorLog if the call ultimately fails).
 */
function describeError(e: unknown): string {
  const status = (e as { status?: number })?.status;
  const name = (e as { name?: string })?.name ?? (e as { constructor?: { name?: string } })?.constructor?.name;
  const msg = (e as { message?: string })?.message ?? String(e);
  const trimmed = msg.length > 120 ? msg.slice(0, 117) + '…' : msg;
  return [status ? `status=${status}` : null, name, trimmed].filter(Boolean).join(' | ');
}
