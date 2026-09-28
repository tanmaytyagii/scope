/**
 * Step types. Each step becomes a span; the step's arguments (after template rendering) are
 * validated against its schema before it runs.
 */
import {
  ErrorCodes,
  type JsonObject,
  type JsonValue,
  ScopeError,
  type SpanKind,
  suggest,
} from '@scope-ai/core';
import type { ChatMessage, ProviderRegistry } from '@scope-ai/providers';
import type { SpanHandle, Tracer } from '@scope-ai/sdk';
import { z } from 'zod';
import { loadCorpus, type RetrievedDocument } from './corpus.ts';
import { callModel, type LlmOutput } from './model-calls.ts';
import { loadExport } from './modules.ts';

/** Outputs of earlier steps, as seen by templates and function steps. */
export interface StepState {
  output: unknown;
  status: 'ok' | 'error';
  duration_ms: number;
  error?: string;
}

export interface RetrievalOutput {
  query: string;
  documents: RetrievedDocument[];
  /** Document texts joined with blank lines: convenient for prompts. */
  text: string;
}

export interface LlmOptions {
  model: string;
  prompt?: string;
  system?: string;
  messages?: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
  response_format?: 'text' | 'json';
  json_schema?: Record<string, unknown>;
  provider_options?: Record<string, unknown>;
  /** Span name (defaults to the model reference). */
  name?: string;
}

export interface RetrieveOptions {
  query: string;
  corpus: string | string[];
  top_k?: number;
  min_score?: number;
  chunk_size?: number;
  name?: string;
}

/**
 * The context passed to `function` steps. Everything done through it is traced.
 *
 *   export default async function classify(args, ctx) {
 *     const result = await ctx.llm({ model: 'openai:gpt-5', prompt: `Classify: ${ctx.inputs.message}` });
 *     return result.text.trim();
 *   }
 */
export interface FunctionContext {
  inputs: Readonly<JsonObject>;
  params: Readonly<JsonObject>;
  steps: Readonly<Record<string, StepState>>;
  case: Readonly<{ id: string; metadata: JsonObject; tags: string[] }>;
  variant: string | null;
  signal: AbortSignal;
  llm(options: LlmOptions): Promise<LlmOutput>;
  retrieve(options: RetrieveOptions): Promise<RetrievalOutput>;
  span<T>(
    name: string,
    options: { kind?: SpanKind; input?: unknown },
    fn: (span: SpanHandle) => Promise<T> | T,
  ): Promise<T>;
  /** Shorthand for a `tool` span that records the input and return value. */
  tool<T>(name: string, input: unknown, fn: () => Promise<T> | T): Promise<T>;
}

export interface StepContext {
  stepId: string;
  span: SpanHandle;
  signal: AbortSignal;
  baseDir: string;
  root: string;
  providers: ProviderRegistry;
  tracer: Tracer;
  /** Makes retrieved text available as the default `context` for evaluators. */
  recordContext(text: string): void;
  functionContext(): FunctionContext;
}

export interface StepType<Args = Record<string, unknown>> {
  type: string;
  kind: SpanKind;
  description: string;
  argsSchema: z.ZodType<Args>;
  defaultTimeoutMs: number;
  execute(args: Args, ctx: StepContext): Promise<unknown>;
}

const messageSchema = z.strictObject({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});
const modelRef = z
  .string()
  .regex(
    /^[^:\s]+:\S+$/,
    'use provider:model, e.g. openai:gpt-5, anthropic:claude-opus-5 or local:extractive',
  );

export const llmArgs = z
  .strictObject({
    model: modelRef,
    prompt: z.string().optional(),
    system: z.string().optional(),
    messages: z.array(messageSchema).optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    stop: z.array(z.string()).optional(),
    response_format: z.enum(['text', 'json']).optional(),
    json_schema: z.record(z.string(), z.json()).optional(),
    provider_options: z.record(z.string(), z.json()).optional(),
  })
  .refine((a) => a.prompt !== undefined || (a.messages?.length ?? 0) > 0, {
    error: 'set `prompt` or `messages`',
  });

export function toModelCall(args: z.infer<typeof llmArgs> | LlmOptions) {
  const messages: ChatMessage[] = [];
  if (args.system) messages.push({ role: 'system', content: args.system });
  if (args.messages) messages.push(...args.messages);
  if (args.prompt !== undefined) messages.push({ role: 'user', content: args.prompt });
  if (!messages.some((m) => m.role !== 'system')) {
    throw new ScopeError(
      ErrorCodes.configInvalid,
      'A model call needs a prompt or at least one user message',
      {
        hint: 'Set `prompt` (or `messages`).',
      },
    );
  }
  return {
    model: args.model,
    messages,
    temperature: args.temperature,
    maxTokens: args.max_tokens,
    stop: args.stop,
    responseFormat: args.response_format ?? (args.json_schema ? ('json' as const) : undefined),
    jsonSchema: args.json_schema as Record<string, unknown> | undefined,
    providerOptions: args.provider_options as Record<string, unknown> | undefined,
  };
}

export const llmStep: StepType<z.infer<typeof llmArgs>> = {
  type: 'llm',
  kind: 'llm',
  description: 'Calls a model through a provider (provider:model).',
  argsSchema: llmArgs,
  defaultTimeoutMs: 300_000,
  execute: (args, ctx) => callModel(ctx.span, ctx.providers, toModelCall(args), ctx.signal),
};

export const retrieveArgs = z.strictObject({
  query: z.string(),
  corpus: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  top_k: z.number().int().min(1).max(100).default(4),
  min_score: z.number().min(0).default(0),
  chunk_size: z.number().int().min(100).max(20_000).default(800),
});

export async function runRetrieval(
  span: SpanHandle,
  options: z.infer<typeof retrieveArgs>,
  baseDir: string,
  root: string,
): Promise<RetrievalOutput> {
  const corpus = loadCorpus(options.corpus, { baseDir, root, chunkSize: options.chunk_size });
  const documents = options.query.trim()
    ? corpus.search(options.query, options.top_k, options.min_score)
    : [];
  span.setInput({ query: options.query, corpus: options.corpus, top_k: options.top_k });
  span.setAttributes({
    'scope.retrieval.method': 'bm25',
    'scope.retrieval.top_k': options.top_k,
    'scope.retrieval.returned': documents.length,
    'scope.retrieval.corpus_documents': corpus.documents.length,
  });
  const output: RetrievalOutput = {
    query: options.query,
    documents,
    text: documents.map((d) => d.text).join('\n\n'),
  };
  span.setOutput(output);
  return output;
}

export const retrieveStep: StepType<z.infer<typeof retrieveArgs>> = {
  type: 'retrieve',
  kind: 'retrieval',
  description: 'BM25 search over local files (Markdown, text, JSONL).',
  argsSchema: retrieveArgs,
  defaultTimeoutMs: 30_000,
  async execute(args, ctx) {
    const output = await runRetrieval(ctx.span, args, ctx.baseDir, ctx.root);
    ctx.recordContext(output.text);
    return output;
  },
};

export const transformArgs = z.strictObject({
  value: z.json(),
  parse: z.enum(['json']).optional(),
});

export const transformStep: StepType<z.infer<typeof transformArgs>> = {
  type: 'transform',
  kind: 'step',
  description: 'Computes a value from templates, optionally parsing JSON text.',
  argsSchema: transformArgs,
  defaultTimeoutMs: 10_000,
  async execute(args) {
    if (args.parse === 'json') {
      if (typeof args.value !== 'string') return args.value;
      try {
        return JSON.parse(args.value) as JsonValue;
      } catch (error) {
        throw new ScopeError(
          ErrorCodes.stepFailed,
          `transform could not parse JSON: ${(error as Error).message}`,
        );
      }
    }
    return args.value;
  },
};

export const functionArgs = z.strictObject({
  module: z.string().min(1),
  export: z.string().min(1).default('default'),
  args: z.json().optional(),
});

export const functionStep: StepType<z.infer<typeof functionArgs>> = {
  type: 'function',
  kind: 'function',
  description: 'Calls an exported function from a JavaScript or TypeScript module in the project.',
  argsSchema: functionArgs,
  defaultTimeoutMs: 300_000,
  async execute(args, ctx) {
    const fn = await loadExport<unknown>(args.module, args.export, ctx.baseDir, 'function');
    if (typeof fn !== 'function') {
      throw new ScopeError(
        ErrorCodes.functionLoadFailed,
        `${args.module} export "${args.export}" is not a function`,
      );
    }
    ctx.span.setAttributes({
      'scope.function.module': args.module,
      'scope.function.export': args.export,
    });
    return (fn as (a: unknown, c: FunctionContext) => unknown)(
      args.args ?? {},
      ctx.functionContext(),
    );
  },
};

// biome-ignore lint/suspicious/noExplicitAny: registry of heterogeneous step types
type AnyStep = StepType<any>;

export const BUILTIN_STEPS: readonly AnyStep[] = [
  llmStep,
  retrieveStep,
  transformStep,
  functionStep,
];

export class StepRegistry {
  readonly #steps = new Map<string, AnyStep>();
  constructor(steps: readonly AnyStep[] = BUILTIN_STEPS) {
    for (const s of steps) this.#steps.set(s.type, s);
  }
  register(step: AnyStep): void {
    this.#steps.set(step.type, step);
  }
  has(type: string): boolean {
    return this.#steps.has(type);
  }
  get(type: string): AnyStep {
    const step = this.#steps.get(type);
    if (!step) {
      const guess = suggest(type, this.#steps.keys());
      throw new ScopeError(ErrorCodes.configInvalid, `Unknown step type "${type}"`, {
        hint: guess
          ? `Did you mean "${guess}"?`
          : `Step types: ${[...this.#steps.keys()].join(', ')}.`,
      });
    }
    return step;
  }
  list(): AnyStep[] {
    return [...this.#steps.values()];
  }
}
