/**
 * Anthropic models through the official `@anthropic-ai/sdk`, loaded on first use.
 *
 * Credentials: an explicit `api_key` in scope.yaml wins; otherwise the SDK resolves them itself
 * (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
 *
 * SCOPE never enables server-side model fallbacks on its own: the model is the variable under
 * evaluation. Users can opt in through `provider_options`; the serving model is always recorded.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { ErrorCodes, ScopeError, type Usage } from '@scope-ai/core';
import { toProviderError } from './errors.ts';
import type {
  CallOptions,
  CompletionRequest,
  CompletionResponse,
  FinishReason,
  ModelProvider,
} from './types.ts';

export interface AnthropicProviderOptions {
  name: string;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  headers?: Record<string, string> | undefined;
}

/** `max_tokens` is required by the Messages API; this default avoids truncating answers. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 16_000;

/** Current Claude models reject sampling parameters (temperature) with a 400. */
const SAMPLING_REMOVED = /^claude-(?:opus-4-[7-9]|opus-[5-9]|sonnet-[5-9]|fable|mythos)/;

function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'refusal';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'other';
  }
}

export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  let client: Promise<Anthropic> | null = null;
  const getClient = () => {
    client ??= import('@anthropic-ai/sdk').then(({ default: AnthropicClient }) => {
      const config: ConstructorParameters<typeof AnthropicClient>[0] = {
        timeout: options.timeoutMs ?? 600_000,
        maxRetries: options.maxRetries ?? 2,
        defaultHeaders: options.headers ?? {},
      };
      if (options.apiKey) config.apiKey = options.apiKey;
      if (options.baseUrl) config.baseURL = options.baseUrl;
      return new AnthropicClient(config);
    });
    return client;
  };
  const unsupportedParams = (model: string) =>
    SAMPLING_REMOVED.test(model) ? ['temperature'] : [];

  return {
    name: options.name,
    type: 'anthropic',
    unsupportedParams,
    async complete(
      request: CompletionRequest,
      call: CallOptions = {},
    ): Promise<CompletionResponse> {
      const system = request.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const messages: Anthropic.MessageParam[] = request.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      if (messages[0]?.role !== 'user') {
        throw new ScopeError(
          ErrorCodes.providerBadRequest,
          'Anthropic requires the first non-system message to come from the user',
          {
            hint: 'Start `messages:` with a user message, or use `prompt:` instead.',
          },
        );
      }
      const ignoredParams = unsupportedParams(request.model).filter(
        (p) => p === 'temperature' && request.temperature !== undefined,
      );
      const body: Record<string, unknown> = {
        model: request.model,
        max_tokens: request.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
        messages,
      };
      if (system) body.system = system;
      if (request.temperature !== undefined && !ignoredParams.includes('temperature'))
        body.temperature = request.temperature;
      if (request.stop?.length) body.stop_sequences = request.stop;
      const extra = { ...(request.providerOptions ?? {}) };
      if (request.responseFormat === 'json' && request.jsonSchema) {
        const outputConfig = (extra.output_config ?? {}) as Record<string, unknown>;
        extra.output_config = {
          ...outputConfig,
          format: { type: 'json_schema', schema: request.jsonSchema },
        };
      }
      Object.assign(body, extra);

      let response: Anthropic.Message;
      try {
        const anthropic = await getClient();
        response = (await anthropic.messages.create(
          body as unknown as Anthropic.MessageCreateParamsNonStreaming,
          {
            signal: call.signal ?? null,
          },
        )) as Anthropic.Message;
      } catch (error) {
        throw toProviderError(error, {
          provider: options.name,
          model: request.model,
          credentialEnv: 'ANTHROPIC_API_KEY',
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        });
      }

      let text = '';
      for (const block of response.content) if (block.type === 'text') text += block.text;
      const cacheRead = response.usage.cache_read_input_tokens ?? 0;
      const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
      const usage: Usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens:
          response.usage.input_tokens + response.usage.output_tokens + cacheRead + cacheWrite,
      };
      if (cacheRead) usage.cacheReadTokens = cacheRead;
      if (cacheWrite) usage.cacheWriteTokens = cacheWrite;
      const attributes: Record<string, string | number | boolean> = {};
      const stopDetails = (response as { stop_details?: { category?: string | null } | null })
        .stop_details;
      if (response.stop_reason === 'refusal' && stopDetails?.category) {
        attributes['scope.refusal.category'] = stopDetails.category;
      }
      return {
        text,
        model: response.model,
        finishReason: mapStopReason(response.stop_reason),
        rawFinishReason: response.stop_reason ?? null,
        usage,
        ignoredParams,
        requestId: (response as { _request_id?: string | null })._request_id ?? null,
        attributes,
      };
    },
  };
}
