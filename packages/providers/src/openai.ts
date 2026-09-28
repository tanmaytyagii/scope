/**
 * OpenAI and OpenAI-compatible endpoints (Ollama, vLLM, LM Studio, OpenRouter, …) through the
 * official `openai` SDK, loaded on first use.
 */
import type { Usage } from '@scope-ai/core';
import type OpenAI from 'openai';
import { toProviderError } from './errors.ts';
import type {
  CallOptions,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  FinishReason,
  ModelProvider,
} from './types.ts';

export interface OpenAIProviderOptions {
  name: string;
  type: 'openai' | 'openai-compatible';
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  organization?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  headers?: Record<string, string> | undefined;
}

/** OpenAI reasoning-style models accept only the default temperature. */
const FIXED_SAMPLING = /^(?:o\d|gpt-5)/;

function mapFinish(reason: string | null | undefined, refused: boolean): FinishReason {
  if (refused) return 'refusal';
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    default:
      return 'other';
  }
}

export function createOpenAIProvider(options: OpenAIProviderOptions): ModelProvider {
  let client: Promise<OpenAI> | null = null;
  const getClient = () => {
    client ??= import('openai').then(({ default: OpenAIClient }) => {
      return new OpenAIClient({
        // Compatible servers such as Ollama need no key, but the SDK requires a value.
        apiKey:
          options.apiKey ?? (options.type === 'openai-compatible' ? 'not-required' : undefined),
        baseURL: options.baseUrl ?? null,
        organization: options.organization ?? null,
        timeout: options.timeoutMs ?? 120_000,
        maxRetries: options.maxRetries ?? 2,
        defaultHeaders: options.headers ?? {},
      });
    });
    return client;
  };
  const ctx = (model: string) => ({
    provider: options.name,
    model,
    ...(options.type === 'openai' ? { credentialEnv: 'OPENAI_API_KEY' } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
  const unsupportedParams = (model: string) =>
    options.type === 'openai' && FIXED_SAMPLING.test(model) ? ['temperature'] : [];

  return {
    name: options.name,
    type: options.type,
    unsupportedParams,
    async complete(
      request: CompletionRequest,
      call: CallOptions = {},
    ): Promise<CompletionResponse> {
      const ignoredParams = unsupportedParams(request.model).filter(
        (p) => p === 'temperature' && request.temperature !== undefined,
      );
      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      };
      if (request.temperature !== undefined && !ignoredParams.includes('temperature'))
        body.temperature = request.temperature;
      if (request.maxTokens !== undefined) {
        body[options.type === 'openai' ? 'max_completion_tokens' : 'max_tokens'] =
          request.maxTokens;
      }
      if (request.stop?.length) body.stop = request.stop;
      if (request.responseFormat === 'json') {
        body.response_format = request.jsonSchema
          ? {
              type: 'json_schema',
              json_schema: { name: 'output', schema: request.jsonSchema, strict: false },
            }
          : { type: 'json_object' };
      }
      Object.assign(body, request.providerOptions ?? {});

      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        const openai = await getClient();
        response = (await openai.chat.completions.create(
          body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
          { signal: call.signal ?? null },
        )) as OpenAI.Chat.Completions.ChatCompletion;
      } catch (error) {
        throw toProviderError(error, ctx(request.model));
      }

      const choice = response.choices[0];
      const refusal = choice?.message?.refusal ?? null;
      const cached = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const prompt = response.usage?.prompt_tokens ?? 0;
      const completion = response.usage?.completion_tokens ?? 0;
      const usage: Usage = {
        inputTokens: Math.max(0, prompt - cached),
        outputTokens: completion,
        totalTokens: prompt + completion,
      };
      if (cached > 0) usage.cacheReadTokens = cached;
      return {
        text: choice?.message?.content ?? refusal ?? '',
        model: response.model ?? request.model,
        finishReason: mapFinish(choice?.finish_reason, refusal !== null),
        rawFinishReason: choice?.finish_reason ?? null,
        usage,
        ignoredParams,
        requestId: (response as { _request_id?: string | null })._request_id ?? null,
      };
    },
    async embed(request: EmbeddingRequest, call: CallOptions = {}): Promise<EmbeddingResponse> {
      try {
        const openai = await getClient();
        const response = await openai.embeddings.create(
          { model: request.model, input: request.input },
          { signal: call.signal ?? null },
        );
        return {
          vectors: response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding),
          model: response.model,
          usage: { inputTokens: response.usage?.prompt_tokens ?? 0 },
        };
      } catch (error) {
        throw toProviderError(error, ctx(request.model));
      }
    },
  };
}
