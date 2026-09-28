/**
 * Traced model calls, shared by `llm` steps, function steps and model-based evaluators.
 */
import { ErrorCodes, type JsonValue, ScopeError } from '@scope-ai/core';
import type {
  ChatMessage,
  CompletionResponse,
  EmbeddingResponse,
  ProviderRegistry,
} from '@scope-ai/providers';
import type { SpanHandle } from '@scope-ai/sdk';

export interface ModelCall {
  /** provider:model */
  model: string;
  messages: ChatMessage[];
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  stop?: string[] | undefined;
  responseFormat?: 'text' | 'json' | undefined;
  jsonSchema?: Record<string, unknown> | undefined;
  providerOptions?: Record<string, unknown> | undefined;
}

/** What an `llm` step (and `ctx.llm()`) returns; available to later steps as `steps.<id>.output`. */
export interface LlmOutput {
  text: string;
  /** Parsed JSON when `response_format: json`; null when parsing failed. */
  json: JsonValue | null;
  model: string;
  finish_reason: string;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number; estimated?: boolean };
}

/** Extracts JSON from model text, tolerating a Markdown code fence. */
export function parseModelJson(text: string): JsonValue | null {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  try {
    return JSON.parse(fenced ? (fenced[1] as string) : trimmed) as JsonValue;
  } catch {
    return null;
  }
}

/**
 * `provider_options` is keyed by provider name — `{ anthropic: {...}, openai: {...} }` — so a
 * workflow whose variants switch providers never sends one provider's options to another.
 */
export function optionsFor(
  providerOptions: Record<string, unknown> | undefined,
  provider: { name: string; type: string },
): Record<string, unknown> | undefined {
  if (!providerOptions) return undefined;
  const value =
    providerOptions[provider.name] ??
    (provider.type !== provider.name ? providerOptions[provider.type] : undefined);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function callModel(
  span: SpanHandle,
  providers: ProviderRegistry,
  call: ModelCall,
  signal: AbortSignal,
): Promise<LlmOutput> {
  const { provider, model } = providers.resolve(call.model);
  const providerOptions = optionsFor(call.providerOptions, provider);
  const requestInput: Record<string, unknown> = { model: call.model, messages: call.messages };
  if (call.temperature !== undefined) requestInput.temperature = call.temperature;
  if (call.maxTokens !== undefined) requestInput.max_tokens = call.maxTokens;
  if (call.responseFormat === 'json') requestInput.response_format = 'json';
  span.setInput(requestInput);
  span.setAttribute('gen_ai.operation.name', 'chat');

  let response: CompletionResponse;
  try {
    response = await provider.complete(
      {
        model,
        messages: call.messages,
        ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
        ...(call.maxTokens !== undefined ? { maxTokens: call.maxTokens } : {}),
        ...(call.stop ? { stop: call.stop } : {}),
        ...(call.responseFormat ? { responseFormat: call.responseFormat } : {}),
        ...(call.jsonSchema ? { jsonSchema: call.jsonSchema } : {}),
        ...(providerOptions ? { providerOptions } : {}),
      },
      { signal },
    );
  } catch (error) {
    span.recordModelCall({
      provider: provider.name,
      providerType: provider.type,
      model,
      temperature: call.temperature ?? null,
      maxTokens: call.maxTokens ?? null,
    });
    throw error;
  }

  span.recordModelCall({
    provider: provider.name,
    providerType: provider.type,
    model,
    responseModel: response.model,
    usage: response.usage,
    finishReason: response.finishReason,
    temperature: call.temperature ?? null,
    maxTokens: call.maxTokens ?? null,
    ignoredParams: response.ignoredParams,
    requestId: response.requestId,
    ...(response.attributes ? { attributes: response.attributes } : {}),
  });
  if (response.finishReason === 'length') {
    span.addEvent('output_truncated', { reason: 'max_tokens reached' });
  }
  if (response.finishReason === 'refusal') span.addEvent('refusal');
  if (response.ignoredParams.length > 0) {
    span.addEvent('parameters_ignored', { params: response.ignoredParams });
  }

  let json: JsonValue | null = null;
  if (call.responseFormat === 'json') {
    json = parseModelJson(response.text);
    if (json === null) span.addEvent('json_parse_failed');
  }
  const output: LlmOutput = {
    text: response.text,
    json,
    model: response.model,
    finish_reason: response.finishReason,
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
      total_tokens: response.usage.totalTokens,
      ...(response.usage.estimated ? { estimated: true } : {}),
    },
  };
  span.setOutput(
    call.responseFormat === 'json' ? { text: output.text, json } : { text: output.text },
  );
  return output;
}

export async function embedTexts(
  span: SpanHandle,
  providers: ProviderRegistry,
  modelRef: string,
  input: string[],
  signal: AbortSignal,
): Promise<EmbeddingResponse> {
  const { provider, model } = providers.resolve(modelRef);
  if (!provider.embed) {
    throw new ScopeError(
      ErrorCodes.providerBadRequest,
      `Provider "${provider.name}" does not support embeddings`,
      {
        hint: 'Use an embedding model from a provider that supports them, e.g. openai:text-embedding-3-small.',
      },
    );
  }
  span.setAttribute('gen_ai.operation.name', 'embeddings');
  span.setInput({ model: modelRef, input_count: input.length });
  const response = await provider.embed({ model, input }, { signal });
  span.recordModelCall({
    provider: provider.name,
    providerType: provider.type,
    model,
    responseModel: response.model,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: 0,
      totalTokens: response.usage.inputTokens,
    },
  });
  span.setOutput({
    vectors: response.vectors.length,
    dimensions: response.vectors[0]?.length ?? 0,
  });
  return response;
}
