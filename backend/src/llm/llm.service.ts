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
 * Hard wall-clock cap for a non-streaming LLM call. Free OpenRouter tiers
 * occasionally hang for >2 minutes (especially on prompts with thick
 * Ukrainian context). The frontend already shows a per-field "⏳" while
 * waiting; surfacing a clean 504 after this many ms is way better UX
 * than letting the request hang until Caddy's 300s outer timeout.
 */
const CHAT_TIMEOUT_MS = 45_000;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
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

  constructor() {
    this.provider = (process.env.LLM_PROVIDER as LlmProvider) || 'anthropic';

    // ?? falls through only on undefined/null — but Docker compose passes
    // unset vars through as EMPTY strings ("") via `${VAR:-}` interpolation,
    // so we need to also reject blank values. Otherwise the SDK gets
    // model="" and OpenRouter returns 400 "No models provided".
    const envChat = process.env.LLM_MODEL_CHAT?.trim();
    const envFeedback = process.env.LLM_MODEL_FEEDBACK?.trim();

    if (this.provider === 'anthropic') {
      this.anthropic = new Anthropic();
      this.modelChat = envChat || 'claude-sonnet-4-6';
      this.modelFeedback = envFeedback || 'claude-opus-4-7';
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
        defaultHeaders: {
          // OpenRouter uses HTTP-Referer + X-Title for analytics. Match
          // FRONTEND_URL when set so analytics group prod traffic correctly.
          'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:4200',
          'X-Title': 'Reflect',
        },
      });
      this.modelChat = envChat || 'openrouter/owl-alpha';
      this.modelFeedback = envFeedback || 'openrouter/owl-alpha';
    } else {
      throw new Error(`Невідомий LLM_PROVIDER: ${this.provider}`);
    }

    this.logger.log(
      `LLM provider=${this.provider} chat=${this.modelChat} feedback=${this.modelFeedback}`,
    );
  }

  async chat(opts: {
    systemPrompt: string;
    history: ChatMessage[];
    model?: string;
    maxTokens?: number;
    cacheSystem?: boolean;
  }): Promise<string> {
    const model = opts.model ?? this.modelChat;
    const maxTokens = opts.maxTokens ?? 1024;

    const callOnce = (signal: AbortSignal) =>
      this.provider === 'anthropic'
        ? this.chatAnthropic(opts.systemPrompt, opts.history, model, maxTokens, !!opts.cacheSystem, signal)
        : this.chatOpenRouter(opts.systemPrompt, opts.history, model, maxTokens, signal);

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
    systemPrompt: string;
    history: ChatMessage[];
    model?: string;
    maxTokens?: number;
    cacheSystem?: boolean;
  }): AsyncGenerator<string, void, unknown> {
    const model = opts.model ?? this.modelChat;
    const maxTokens = opts.maxTokens ?? 1024;

    try {
      if (this.provider === 'anthropic') {
        yield* this.streamAnthropic(opts.systemPrompt, opts.history, model, maxTokens, !!opts.cacheSystem);
      } else {
        yield* this.streamOpenRouter(opts.systemPrompt, opts.history, model, maxTokens);
      }
    } catch (e: unknown) {
      throw this.translateError(e);
    }
  }

  private async *streamAnthropic(
    systemPrompt: string,
    history: ChatMessage[],
    model: string,
    maxTokens: number,
    cacheSystem: boolean,
  ): AsyncGenerator<string, void, unknown> {
    const systemBlock = cacheSystem
      ? [{ type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } }]
      : [{ type: 'text' as const, text: systemPrompt }];

    const stream = this.anthropic!.messages.stream({
      model,
      max_tokens: maxTokens,
      system: systemBlock,
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
    systemPrompt: string,
    history: ChatMessage[],
    model: string,
    maxTokens: number,
    cacheSystem: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    const systemBlock = cacheSystem
      ? [{ type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } }]
      : [{ type: 'text' as const, text: systemPrompt }];

    const msg = await this.anthropic!.messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: systemBlock,
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
