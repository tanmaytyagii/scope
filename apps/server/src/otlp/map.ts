/**
 * Mapping OpenTelemetry spans to SCOPE spans.
 *
 * The OpenTelemetry GenAI semantic conventions come first (`gen_ai.*`: operation, provider,
 * model, usage, input and output messages). Instrumentations that predate or diverge from them
 * are recognized where they differ:
 *
 * - OpenLLMetry (Traceloop): `traceloop.span.kind`, indexed `gen_ai.prompt.N.*` and
 *   `gen_ai.completion.N.*`, `gen_ai.usage.prompt_tokens`/`completion_tokens`.
 * - OpenInference (Arize/Phoenix): `openinference.span.kind`, `llm.*`, `input.value`,
 *   `output.value`, `retrieval.documents.N.document.*`.
 * - The Vercel AI SDK's own attributes: `ai.prompt*`, `ai.response.*`, `ai.toolCall.*`,
 *   `ai.usage.*`, `ai.model.*`.
 *
 * Content (prompts, responses, tool arguments, documents) is moved from attributes into the
 * span's input and output, so the content policy applies to it like to any other trace. Every
 * other attribute is kept, flattened to SCOPE's attribute types.
 */
import {
  type Attributes,
  type AttributeValue,
  type ErrorInfo,
  estimateCost,
  type JsonObject,
  type JsonValue,
  type PriceTable,
  type SpanKind,
} from '@scope-ai/core';
import type { IngestSpan } from '@scope-ai/protocol';
import type { OtlpAttributes, OtlpResourceSpans, OtlpSpan, OtlpValue } from './decode.ts';

export interface MappedTrace {
  traceId: string;
  /** The SCOPE project named by the resource attribute `scope.project`, if any. */
  project: string | null;
  spans: IngestSpan[];
  /** Resource attributes (service.name, …): the trace's metadata. */
  metadata: JsonObject;
}

export interface MappedBatch {
  traces: MappedTrace[];
  /** Spans without valid trace and span ids. */
  rejectedSpans: number;
}

const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);
const MAX_NAME = 256;
const MAX_METADATA_KEYS = 64;

const LLM_OPERATIONS = new Set([
  'chat',
  'text_completion',
  'generate_content',
  'embeddings',
  'completion',
]);
const OPENINFERENCE_KINDS: Record<string, SpanKind> = {
  LLM: 'llm',
  EMBEDDING: 'llm',
  TOOL: 'tool',
  RETRIEVER: 'retrieval',
  RERANKER: 'retrieval',
  CHAIN: 'step',
  AGENT: 'step',
  GUARDRAIL: 'step',
  EVALUATOR: 'evaluation',
};
const TRACELOOP_KINDS: Record<string, SpanKind> = {
  workflow: 'workflow',
  task: 'step',
  agent: 'step',
  tool: 'tool',
};

// ─── values ──────────────────────────────────────────────────────────────────────────────────

const str = (v: OtlpValue | undefined): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

function num(v: OtlpValue | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return null;
}

function firstNum(attrs: OtlpAttributes, keys: readonly string[]): number | null {
  for (const key of keys) {
    const v = num(attrs[key]);
    if (v !== null) return v;
  }
  return null;
}

function firstStr(attrs: OtlpAttributes, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = str(attrs[key]);
    if (v !== null) return v;
  }
  return null;
}

/** Values that hold JSON text (message lists, tool arguments) are parsed; others kept. */
function jsonish(v: OtlpValue): JsonValue {
  if (typeof v === 'string') {
    const t = v.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return JSON.parse(t) as JsonValue;
      } catch {
        return v;
      }
    }
    return v;
  }
  return v as JsonValue;
}

function toAttribute(v: OtlpValue): AttributeValue | null {
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null) return null;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'string')) return v as string[];
    if (v.every((x) => typeof x === 'number' && Number.isFinite(x))) return v as number[];
    if (v.every((x) => typeof x === 'boolean')) return v as boolean[];
  }
  return JSON.stringify(v);
}

function toAttributes(attrs: OtlpAttributes): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    const a = toAttribute(v);
    if (a !== null) out[k] = a;
  }
  return out;
}

const nanosToMs = (ns: bigint) => Number(ns / 1000n) / 1000;

// ─── classification ──────────────────────────────────────────────────────────────────────────

export function spanKind(span: OtlpSpan): SpanKind {
  const a = span.attributes;
  const op = str(a['gen_ai.operation.name']);
  if (op && LLM_OPERATIONS.has(op)) return 'llm';
  if (op === 'execute_tool') return 'tool';
  // An agent invocation that starts the trace is its workflow; nested ones are steps.
  if (op === 'invoke_agent' || op === 'create_agent')
    return span.parentSpanId ? 'step' : 'workflow';
  if (op === 'agent_step') return 'step';
  const oi = str(a['openinference.span.kind'])?.toUpperCase();
  if (oi && OPENINFERENCE_KINDS[oi]) return OPENINFERENCE_KINDS[oi];
  const tl = str(a['traceloop.span.kind'])?.toLowerCase();
  if (tl && TRACELOOP_KINDS[tl]) return TRACELOOP_KINDS[tl];
  // Instrumentations without an operation name still name the model of a model call.
  if (!op && (str(a['gen_ai.request.model']) || str(a['llm.request.type']))) return 'llm';
  if (span.name === 'ai.toolCall' || span.name.startsWith('ai.toolCall ')) return 'tool';
  return span.parentSpanId ? 'custom' : 'workflow';
}

/**
 * The provider, as SCOPE's pricing table names it. The AI SDK names providers by API
 * ("openai.chat", "anthropic.messages"); the GenAI conventions by vendor ("openai",
 * "gcp.gemini"), which is kept as is.
 */
function providerName(a: OtlpAttributes): string | null {
  const raw = firstStr(a, [
    'gen_ai.provider.name',
    'gen_ai.system',
    'llm.provider',
    'llm.system',
    'ai.model.provider',
  ]);
  if (!raw) return null;
  const v = raw.toLowerCase();
  const vendor = v.split('.')[0] as string;
  return vendor === 'openai' || vendor === 'anthropic' ? vendor : v;
}

// ─── content ─────────────────────────────────────────────────────────────────────────────────

type Message = { [key: string]: JsonValue; role: string; content: string };

/** GenAI conventions: `[{ role, parts: [{ type: 'text', content }] }]`. Also accepts `content`. */
function genAiMessages(value: JsonValue): Message[] | null {
  if (!Array.isArray(value)) return null;
  const out: Message[] = [];
  for (const m of value) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const role = typeof m.role === 'string' ? m.role : 'user';
    let content: string;
    if (Array.isArray(m.parts)) {
      // Text parts are the message; other parts (tool calls, files) are shown as JSON when a
      // message has no text.
      const texts = m.parts.flatMap((p) =>
        p &&
        typeof p === 'object' &&
        !Array.isArray(p) &&
        p.type === 'text' &&
        typeof p.content === 'string'
          ? [p.content]
          : [],
      );
      content =
        texts.length > 0 ? texts.join('\n') : m.parts.map((p) => JSON.stringify(p)).join('\n');
    } else if (typeof m.content === 'string') content = m.content;
    else content = JSON.stringify(m.content ?? null);
    out.push({ role, content });
  }
  return out;
}

/** Indexed attributes such as `gen_ai.prompt.0.role` / `gen_ai.prompt.0.content`. */
function indexedMessages(
  a: OtlpAttributes,
  prefix: string,
  roleKey: string,
  contentKey: string,
  consumed: Set<string>,
): Message[] | null {
  const pattern = new RegExp(`^${prefix.replace(/\./g, '\\.')}\\.(\\d+)\\.(.+)$`);
  const byIndex = new Map<number, Record<string, OtlpValue>>();
  for (const [key, value] of Object.entries(a)) {
    const match = pattern.exec(key);
    if (!match) continue;
    consumed.add(key);
    const index = Number(match[1]);
    const entry = byIndex.get(index) ?? {};
    entry[match[2] as string] = value;
    byIndex.set(index, entry);
  }
  if (byIndex.size === 0) return null;
  return [...byIndex.entries()]
    .sort(([x], [y]) => x - y)
    .map(([, e]) => {
      const content = e[contentKey];
      return {
        role: str(e[roleKey]) ?? 'user',
        content: typeof content === 'string' ? content : JSON.stringify(jsonish(content ?? null)),
      };
    });
}

function text(messages: Message[]): string {
  return messages.map((m) => m.content).join('\n');
}

/**
 * What a model or agent answered: the text parts of its output messages (an agent's output lists
 * the tool calls it made along the way too); JSON of the parts only when there is no text.
 */
function outputText(value: JsonValue): string | null {
  if (!Array.isArray(value)) return null;
  const texts: string[] = [];
  for (const m of value) {
    if (!m || typeof m !== 'object' || Array.isArray(m) || !Array.isArray(m.parts)) continue;
    for (const p of m.parts)
      if (p && typeof p === 'object' && !Array.isArray(p) && p.type === 'text')
        if (typeof p.content === 'string') texts.push(p.content);
  }
  if (texts.length > 0) return texts.join('\n');
  const messages = genAiMessages(value);
  return messages ? text(messages) : null;
}

/**
 * Moves content attributes into input and output, in SCOPE's shapes: model calls as
 * `{ messages }` → `{ text }`, retrievals as `→ { documents }`, anything else as given.
 */
function extractContent(
  span: OtlpSpan,
  kind: SpanKind,
  consumed: Set<string>,
): { input: JsonValue | null; output: JsonValue | null } {
  const a = span.attributes;
  const take = (key: string): OtlpValue | undefined => {
    if (!(key in a)) return undefined;
    consumed.add(key);
    return a[key];
  };
  let input: JsonValue | null = null;
  let output: JsonValue | null = null;

  // GenAI conventions (current): JSON message lists.
  const inMessages = take('gen_ai.input.messages');
  const system = take('gen_ai.system_instructions');
  const outMessages = take('gen_ai.output.messages');
  if (inMessages !== undefined) {
    const messages = genAiMessages(jsonish(inMessages)) ?? [];
    const sys = system === undefined ? null : jsonish(system);
    const instructions = Array.isArray(sys)
      ? genAiMessages([{ role: 'system', parts: sys }])
      : typeof sys === 'string'
        ? [{ role: 'system', content: sys }]
        : null;
    input = { messages: [...(instructions ?? []), ...messages] };
  }
  if (outMessages !== undefined) {
    const answer = outputText(jsonish(outMessages));
    output = answer !== null ? { text: answer } : jsonish(outMessages);
  }

  // OpenLLMetry: indexed prompt and completion attributes.
  const tlIn = indexedMessages(a, 'gen_ai.prompt', 'role', 'content', consumed);
  const tlOut = indexedMessages(a, 'gen_ai.completion', 'role', 'content', consumed);
  if (input === null && tlIn) input = { messages: tlIn };
  if (output === null && tlOut) output = { text: text(tlOut) };

  // OpenInference: indexed messages, retrieved documents, generic input.value / output.value.
  const oiIn = indexedMessages(
    a,
    'llm.input_messages',
    'message.role',
    'message.content',
    consumed,
  );
  const oiOut = indexedMessages(
    a,
    'llm.output_messages',
    'message.role',
    'message.content',
    consumed,
  );
  if (input === null && oiIn) input = { messages: oiIn };
  if (output === null && oiOut) output = { text: text(oiOut) };
  const docs = new Map<number, Record<string, OtlpValue>>();
  for (const [key, value] of Object.entries(a)) {
    const m = /^retrieval\.documents\.(\d+)\.document\.(.+)$/.exec(key);
    if (!m) continue;
    consumed.add(key);
    const entry = docs.get(Number(m[1])) ?? {};
    entry[m[2] as string] = value;
    docs.set(Number(m[1]), entry);
  }
  if (output === null && docs.size > 0) {
    output = {
      documents: [...docs.entries()]
        .sort(([x], [y]) => x - y)
        .map(([i, d]) => ({
          id: str(d.id) ?? String(i),
          text:
            typeof d.content === 'string' ? d.content : JSON.stringify(jsonish(d.content ?? null)),
          score: num(d.score),
        })),
    };
  }

  // The AI SDK's own attributes.
  const aiMessages = take('ai.prompt.messages');
  const aiPrompt = take('ai.prompt');
  if (input === null && aiMessages !== undefined) {
    const messages = genAiMessages(jsonish(aiMessages));
    input = messages ? { messages } : jsonish(aiMessages);
  }
  if (input === null && aiPrompt !== undefined) input = jsonish(aiPrompt);
  const aiText = take('ai.response.text');
  const aiObject = take('ai.response.object');
  if (output === null && aiText !== undefined) output = { text: String(aiText) };
  if (output === null && aiObject !== undefined) output = jsonish(aiObject);

  // Tool calls.
  const toolArgs = take('gen_ai.tool.call.arguments') ?? take('ai.toolCall.args');
  const toolResult = take('gen_ai.tool.call.result') ?? take('ai.toolCall.result');
  if (input === null && toolArgs !== undefined) input = jsonish(toolArgs);
  if (output === null && toolResult !== undefined) output = jsonish(toolResult);

  // Generic values (OpenInference, and others that follow it).
  const inValue = take('input.value');
  const outValue = take('output.value');
  if (input === null && inValue !== undefined) input = jsonish(inValue);
  if (output === null && outValue !== undefined) output = jsonish(outValue);

  // Older GenAI conventions: content as span events.
  for (const e of span.events) {
    if (
      e.name === 'gen_ai.content.prompt' &&
      input === null &&
      e.attributes['gen_ai.prompt'] !== undefined
    )
      input = jsonish(e.attributes['gen_ai.prompt'] ?? null);
    if (
      e.name === 'gen_ai.content.completion' &&
      output === null &&
      e.attributes['gen_ai.completion'] !== undefined
    )
      output = jsonish(e.attributes['gen_ai.completion'] ?? null);
  }
  if (kind === 'llm' && typeof output === 'string') output = { text: output };
  return { input, output };
}

// ─── spans ───────────────────────────────────────────────────────────────────────────────────

export function mapSpan(span: OtlpSpan, scope: string, pricing: PriceTable): IngestSpan {
  const a = span.attributes;
  const kind = spanKind(span);
  const consumed = new Set<string>();
  const { input, output } = extractContent(span, kind, consumed);

  const startTime = nanosToMs(span.startTimeUnixNano);
  const endTime = Math.max(startTime, nanosToMs(span.endTimeUnixNano));
  const exception = span.events.find((e) => e.name === 'exception');
  const failed = span.status.code === 2;
  let error: ErrorInfo | null = null;
  if (exception || failed) {
    const ex = exception?.attributes ?? {};
    error = {
      type: str(ex['exception.type']) ?? 'Error',
      message:
        str(ex['exception.message']) ?? (span.status.message || 'The span ended with an error'),
    };
    const stack = str(ex['exception.stacktrace']);
    if (stack) error.stack = stack;
  }

  let provider: string | null = null;
  let model: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let costUsd: number | null = null;
  const attributes = toAttributes(
    Object.fromEntries(Object.entries(a).filter(([k]) => !consumed.has(k))),
  );
  if (scope) attributes['otel.scope.name'] = scope;
  if (kind === 'llm') {
    provider = providerName(a);
    model = firstStr(a, [
      'gen_ai.request.model',
      'gen_ai.response.model',
      'llm.model_name',
      'ai.model.id',
    ]);
    const cacheRead =
      firstNum(a, [
        'gen_ai.usage.cache_read.input_tokens',
        'gen_ai.usage.cache_read_input_tokens',
      ]) ?? 0;
    const cacheWrite =
      firstNum(a, [
        'gen_ai.usage.cache_creation.input_tokens',
        'gen_ai.usage.cache_creation_input_tokens',
      ]) ?? 0;
    const reportedInput = firstNum(a, [
      'gen_ai.usage.input_tokens',
      'gen_ai.usage.prompt_tokens',
      'llm.token_count.prompt',
      'ai.usage.inputTokens',
      'ai.usage.promptTokens',
    ]);
    outputTokens = firstNum(a, [
      'gen_ai.usage.output_tokens',
      'gen_ai.usage.completion_tokens',
      'llm.token_count.completion',
      'ai.usage.outputTokens',
      'ai.usage.completionTokens',
    ]);
    // SCOPE's names for cache tokens, which trace rollups add up.
    if (cacheRead) attributes['gen_ai.usage.cache_read_input_tokens'] = cacheRead;
    if (cacheWrite) attributes['gen_ai.usage.cache_creation_input_tokens'] = cacheWrite;
    // Reported input tokens include cached ones (GenAI conventions, AI SDK); SCOPE prices them
    // separately, so they are counted once.
    inputTokens =
      reportedInput === null
        ? null
        : reportedInput >= cacheRead + cacheWrite
          ? reportedInput - cacheRead - cacheWrite
          : reportedInput;
    if (provider && model && (inputTokens !== null || outputTokens !== null)) {
      const estimate = estimateCost(
        provider,
        model,
        {
          inputTokens: inputTokens ?? 0,
          outputTokens: outputTokens ?? 0,
          ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
          ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
        },
        pricing,
      );
      costUsd = estimate.usd;
      if (estimate.usd !== null) {
        attributes['scope.cost.usd'] = estimate.usd;
        attributes['scope.cost.estimated'] = true;
        if (estimate.priceKey) attributes['scope.cost.price_key'] = estimate.priceKey;
      }
    }
  }

  return {
    traceId: span.traceId,
    id: span.spanId,
    parentId: span.parentSpanId,
    name: (span.name || 'span').slice(0, MAX_NAME),
    kind,
    status: failed || exception ? 'error' : 'ok',
    statusMessage: span.status.message || null,
    startTime,
    endTime,
    durationMs: Math.round((endTime - startTime) * 1000) / 1000,
    input,
    output,
    attributes,
    events: span.events
      .filter((e) => e.name !== 'gen_ai.content.prompt' && e.name !== 'gen_ai.content.completion')
      .slice(0, 1000)
      .map((e) => ({
        name: (e.name || 'event').slice(0, MAX_NAME),
        time: nanosToMs(e.timeUnixNano),
        attributes: toAttributes(e.attributes),
      })),
    error,
    provider,
    model,
    inputTokens,
    outputTokens,
    costUsd,
  } as IngestSpan;
}

function metadataOf(resource: OtlpAttributes): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(resource).slice(0, MAX_METADATA_KEYS)) {
    if (k === 'scope.project') continue;
    const a = toAttribute(v);
    if (a !== null) out[k] = a as JsonValue;
  }
  return out;
}

/** Groups spans by trace (and the project their resource names) and maps them. */
export function mapResourceSpans(batch: OtlpResourceSpans[], pricing: PriceTable): MappedBatch {
  const traces = new Map<string, MappedTrace>();
  let rejectedSpans = 0;
  for (const rs of batch) {
    const project = str(rs.resource['scope.project']);
    const metadata = metadataOf(rs.resource);
    for (const ss of rs.scopeSpans) {
      for (const span of ss.spans) {
        if (
          !/^[0-9a-f]{32}$/.test(span.traceId) ||
          span.traceId === ZERO_TRACE ||
          !/^[0-9a-f]{16}$/.test(span.spanId) ||
          span.spanId === ZERO_SPAN
        ) {
          rejectedSpans++;
          continue;
        }
        const key = `${project ?? ''}\u0000${span.traceId}`;
        let trace = traces.get(key);
        if (!trace) {
          trace = { traceId: span.traceId, project, spans: [], metadata };
          traces.set(key, trace);
        }
        trace.spans.push(mapSpan(span, ss.scope.name, pricing));
      }
    }
  }
  return { traces: [...traces.values()], rejectedSpans };
}
