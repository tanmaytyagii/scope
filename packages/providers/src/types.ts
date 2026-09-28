import type { Usage } from '@scope-ai/core';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  /** Model name without the provider prefix, e.g. "gpt-5". */
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /** Ask for JSON output. With `jsonSchema`, providers that support schemas enforce it. */
  responseFormat?: 'text' | 'json';
  jsonSchema?: Record<string, unknown>;
  /** Provider-specific request fields, merged into the request body as-is. */
  providerOptions?: Record<string, unknown>;
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'refusal'
  | 'content_filter'
  | 'tool_calls'
  | 'other';

export interface CompletionResponse {
  text: string;
  /** The model that actually served the request, as reported by the provider. */
  model: string;
  finishReason: FinishReason;
  /** Provider's raw finish/stop reason, for display. */
  rawFinishReason: string | null;
  usage: Usage;
  /** Request parameters the model does not accept, which were omitted. */
  ignoredParams: string[];
  requestId: string | null;
  /** Provider-specific facts worth recording on the span (flat, primitive values). */
  attributes?: Record<string, string | number | boolean>;
}

export interface EmbeddingRequest {
  model: string;
  input: string[];
}

export interface EmbeddingResponse {
  vectors: number[][];
  model: string;
  usage: { inputTokens: number };
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface ModelProvider {
  /** Configured provider name, e.g. "openai" or "ollama". */
  readonly name: string;
  /** Implementation type: "openai", "anthropic", "openai-compatible" or "local". */
  readonly type: string;
  complete(request: CompletionRequest, options?: CallOptions): Promise<CompletionResponse>;
  embed?(request: EmbeddingRequest, options?: CallOptions): Promise<EmbeddingResponse>;
  /** Request parameters this provider would omit for a model (for validation warnings). */
  unsupportedParams?(model: string): string[];
}
