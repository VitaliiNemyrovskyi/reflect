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

/**
 * Hard wall-clock cap for a non-streaming LLM call. Free OpenRouter
 * stealth tiers (owl-alpha & co) sometimes spend 30-60s on first byte
 * for long-context calls (full transcript + protocol + profile in the
 * feedback flow). 120s gives that headroom while still failing clean
 * well before Caddy's outer 300s. Frontend shows a "⏳" the whole time.
 */
const CHAT_TIMEOUT_MS = 120_000;

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
  private readonly provider: LlmProvider;
  private readonly anthropic?: Anthropic;
  private readonly openai?: OpenAI;

  readonly modelChat: string;
  readonly modelFeedback: string;
  /** Optional fallback model for feedback generation. If the primary
   *  feedback model fails BEFORE any chunk has streamed (timeout /
   *  upstream 5xx / connection reset), the supervisor retry uses
   *  this one. Empty / unset = no fallback, errors bubble up. */
  readonly modelFeedbackFallback: string | null;
  /** Feedback generation mode:
   *  - 'single' — one supervisor pass (legacy, fast, ~$0.02/sess).
   *  - 'two-pass' — first supervisor drafts, second supervisor
   *    reviews+amends. ~2× cost and latency but catches misses,
   *    cuts truisms, calibrates tone. Default.
   *  Override via FEEDBACK_MODE env var. */
  readonly feedbackMode: 'single' | 'two-pass';

  constructor() {
    this.provider = (process.env.LLM_PROVIDER as LlmProvider) || 'anthropic';

    // ?? falls through only on undefined/null — but Docker compose passes
    // unset vars through as EMPTY strings ("") via `${VAR:-}` interpolation,
    // so we need to also reject blank values. Otherwise the SDK gets
    // model="" and OpenRouter returns 400 "No models provided".
    const envChat = process.env.LLM_MODEL_CHAT?.trim();
    const envFeedback = process.env.LLM_MODEL_FEEDBACK?.trim();
    const envFeedbackFallback = process.env.LLM_MODEL_FEEDBACK_FALLBACK?.trim();

    // FEEDBACK_MODE drives whether feedback uses single supervisor or
    // a draft → reviewer 2-pass pipeline. Default 'two-pass' since
    // the reviewer catches enough misses + truisms to justify the
    // ~2× cost in this domain. Set FEEDBACK_MODE=single to revert.
    const envFeedbackMode = process.env.FEEDBACK_MODE?.trim().toLowerCase();
    this.feedbackMode = envFeedbackMode === 'single' ? 'single' : 'two-pass';

    if (this.provider === 'anthropic') {
      this.anthropic = new Anthropic();
      // Defaults optimised for cost (~$0.13/session) while keeping
      // feedback quality high — Sonnet handles citation accuracy fine,
      // Haiku handles patient persona under brevity-capped output.
      // Override via LLM_MODEL_CHAT / LLM_MODEL_FEEDBACK env vars if
      // the deployment has different priorities.
      this.modelChat = envChat || 'claude-haiku-4-5';
      this.modelFeedback = envFeedback || 'claude-sonnet-4-6';
      this.modelFeedbackFallback = envFeedbackFallback || 'claude-haiku-4-5';
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
      this.modelChat = envChat || 'openrouter/owl-alpha';
      this.modelFeedback = envFeedback || 'openrouter/owl-alpha';
      // Fallback for slow / unstable stealth feedback model. Haiku via
      // OpenRouter is fast and cheap (~$0.01/call), pays off as the
      // safety net the moment primary is overloaded.
      this.modelFeedbackFallback = envFeedbackFallback || 'anthropic/claude-haiku-4-5';
    } else {
      throw new Error(`Невідомий LLM_PROVIDER: ${this.provider}`);
    }

    this.logger.log(
      `LLM provider=${this.provider} chat=${this.modelChat} feedback=${this.modelFeedback} mode=${this.feedbackMode}`,
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
    const model = opts.model ?? this.modelChat;
    // Default hard cap 512 — chat replies should be SHORT per brevity
    // instruction in the system prompt. 512 tokens ≈ 380 words EN /
    // 250-300 UA, well above the soft caps (20-180 words). Acts as a
    // safety net against runaway monologues. Caller can override.
    const maxTokens = opts.maxTokens ?? 512;
    const blocks = toSystemBlocks(opts);

    const callOnce = (signal: AbortSignal) =>
      this.provider === 'anthropic'
        ? this.chatAnthropic(blocks, opts.history, model, maxTokens, signal)
        : this.chatOpenRouter(joinBlocks(blocks), opts.history, model, maxTokens, signal);

    try {
      return await this.withRateLimitRetry(() => this.withTimeout(callOnce, CHAT_TIMEOUT_MS));
    } catch (e: unknown) {
      throw this.translateError(e);
    }
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

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield event.delta.text;
      }
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
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        yield delta;
      }
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
    const reply = completion.choices?.[0]?.message?.content ?? '';
    return reply.trim();
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
