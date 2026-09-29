/**
 * Automatic model-call spans for the OpenAI and Anthropic TypeScript SDKs.
 *
 *   const openai = instrumentOpenAI(new OpenAI(), { tracer });
 *   const anthropic = instrumentAnthropic(new Anthropic(), { tracer });
 *
 * Every call becomes a model span — inside the current trace, or as a trace of its own — with the
 * request, the response text, the model that answered, token usage and estimated cost. Streams
 * are recorded as they are consumed, including through the SDKs' stream helpers
 * (`client.chat.completions.stream()`, `client.messages.stream()`), which call `create()`. The client is changed in place and keeps its exact behavior:
 * the same return values (`withResponse()`, `asResponse()` and stream helpers keep working), the
 * same errors, the same timing.
 *
 * The wrappers are structural: they need no dependency on either SDK and work with any client
 * that has the same methods — including the OpenAI SDK pointed at an OpenAI-compatible server
 * (Ollama, vLLM, OpenRouter, …) with `provider` naming it.
 */
import type { SpanHandle } from './span.ts';
import type { Tracer } from './tracer.ts';

export interface InstrumentOptions {
  tracer: Tracer;
  /** Provider name recorded on spans and used for prices. Default: "openai" / "anthropic". */
  provider?: string;
}

type AnyFn = (...args: unknown[]) => unknown;
type Obj = Record<string | symbol, unknown>;

const INSTRUMENTED = Symbol.for('scope-ai.instrumented');
/** Distinct tool calls kept from one streamed response. */
const MAX_STREAM_TOOL_CALLS = 128;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** A token count or stream index: responses are not trusted to send sensible numbers. */
const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

/** What a finished call reports. */
interface CallResult {
  output: unknown;
  model?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  finishReason?: string | undefined;
  requestId?: string | undefined;
  /**
   * Why a streamed output is partial: the application stopped reading (`cancelled`), or did not
   * read it to the end within the tracer's grace period (`abandoned`).
   */
  incomplete?: 'cancelled' | 'abandoned' | undefined;
}

interface CallSpec {
  tracer: Tracer;
  provider: string;
  providerType: string;
  operation: 'chat' | 'embeddings';
  model: string;
  input: unknown;
  params: Obj;
}

/**
 * Runs `observe` inside a model span — a child of the current span, or the root of a new trace
 * when there is none. `observe` resolves when the call has finished (or its stream is consumed).
 */
function observeCall(spec: CallSpec, observe: (span: SpanHandle) => Promise<CallResult>): void {
  const name = `${spec.operation} ${spec.model}`;
  const record = async (span: SpanHandle) => {
    span.setInput(spec.input);
    span.setAttribute('gen_ai.operation.name', spec.operation);
    try {
      const result = await observe(span);
      span.setOutput(result.output);
      if (result.incomplete) {
        // The output is what arrived before the stream stopped, not the whole response.
        span.setAttribute('scope.stream.incomplete', result.incomplete);
        if (result.incomplete === 'abandoned')
          span.setStatus(
            'error',
            `the stream was not read to the end within ${Math.round(spec.tracer.openSpanGraceMs / 1000)} s`,
          );
      }
      span.recordModelCall({
        provider: spec.provider,
        providerType: spec.providerType,
        model: spec.model,
        responseModel: result.model ?? null,
        usage:
          result.inputTokens === undefined && result.outputTokens === undefined
            ? null
            : {
                inputTokens: result.inputTokens ?? 0,
                outputTokens: result.outputTokens ?? 0,
                totalTokens:
                  (result.inputTokens ?? 0) +
                  (result.outputTokens ?? 0) +
                  (result.cacheReadTokens ?? 0) +
                  (result.cacheWriteTokens ?? 0),
                ...(result.cacheReadTokens ? { cacheReadTokens: result.cacheReadTokens } : {}),
                ...(result.cacheWriteTokens ? { cacheWriteTokens: result.cacheWriteTokens } : {}),
              },
        finishReason: result.finishReason ?? null,
        temperature: num(spec.params.temperature) ?? null,
        maxTokens:
          num(spec.params.max_tokens) ??
          num(spec.params.max_completion_tokens) ??
          num(spec.params.max_output_tokens) ??
          null,
        requestId: result.requestId ?? null,
      });
    } catch (error) {
      span.recordError(error);
    }
  };
  // Recording never changes what the application sees, so its promise is not awaited here.
  const done = spec.tracer.currentTrace()
    ? spec.tracer.span(name, { kind: 'llm' }, record)
    : spec.tracer.trace(name, { kind: 'llm' }, (trace) => record(trace.root));
  done.catch(() => {});
}

/**
 * Calls `original` and returns its result unchanged, observing it: plain responses as a side
 * effect, streams through a proxy that watches iteration (the SDKs' `_thenUnwrap` keeps
 * `withResponse()` working when the stream is wrapped).
 */
function intercept(
  original: AnyFn,
  self: unknown,
  args: unknown[],
  spec: Omit<CallSpec, 'input' | 'params' | 'model'> & {
    input: (params: Obj) => unknown;
    fromResponse: (response: Obj) => CallResult;
    fromStream?: () => { onEvent(event: unknown): void; result(): CallResult };
  },
): unknown {
  const params = isObj(args[0]) ? args[0] : {};
  const model = str(params.model) ?? 'unknown';
  const call: CallSpec = { ...spec, model, params, input: spec.input(params) };
  const promise = original.apply(self, args) as PromiseLike<unknown> & {
    _thenUnwrap?: (fn: (value: unknown) => unknown) => unknown;
  };
  if (!promise || typeof promise.then !== 'function') return promise;

  if (params.stream === true && spec.fromStream) {
    const collector = spec.fromStream();
    let finish!: (error?: unknown) => void;
    let cancelled = false;
    const finished = new Promise<void>((resolve, reject) => {
      finish = (error) => (error === undefined ? resolve() : reject(error));
    });
    observeCall(call, async () => {
      // A stream nobody reads to the end would hold its span (and trace) forever.
      const grace = spec.tracer.openSpanGraceMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abandoned = new Promise<'abandoned'>((resolve) => {
        if (grace <= 0) return;
        timer = setTimeout(() => resolve('abandoned'), grace);
        timer.unref?.();
      });
      try {
        const ended = finished.then(() => 'ended' as const);
        // Handled even when the grace period wins the race and the stream fails afterwards: an
        // unhandled rejection would crash the application.
        ended.catch(() => {});
        const outcome = await Promise.race([ended, abandoned]);
        const result = collector.result();
        if (outcome === 'abandoned') result.incomplete = 'abandoned';
        else if (cancelled) result.incomplete = 'cancelled';
        return result;
      } finally {
        clearTimeout(timer);
      }
    });
    const wrap = (stream: unknown) =>
      watchStream(stream, collector.onEvent, finish, () => {
        cancelled = true;
      });
    const wrapped = (
      typeof promise._thenUnwrap === 'function'
        ? promise._thenUnwrap(wrap)
        : Promise.resolve(promise).then(wrap)
    ) as PromiseLike<unknown>;
    // Observed on the promise the application gets (the SDKs cache its parsed result), so the
    // response is parsed once and a failed request ends the span.
    wrapped.then(undefined, (error: unknown) => finish(error));
    return wrapped;
  }

  observeCall(call, async () => {
    const response = await promise;
    return spec.fromResponse(isObj(response) ? response : {});
  });
  return promise;
}

/**
 * A proxy of an async-iterable stream that reports each event, the end of iteration, and
 * whether the application stopped reading before the end (`onCancel`).
 */
function watchStream(
  stream: unknown,
  onEvent: (event: unknown) => void,
  finish: (error?: unknown) => void,
  onCancel: () => void,
): unknown {
  if (!isObj(stream) || typeof stream[Symbol.asyncIterator] !== 'function') {
    finish();
    return stream;
  }
  let done = false;
  const end = (error?: unknown) => {
    if (done) return;
    done = true;
    finish(error);
  };
  return new Proxy(stream, {
    get(target, key, receiver) {
      if (key !== Symbol.asyncIterator) return Reflect.get(target, key, receiver);
      return () => {
        const iterator = (target[Symbol.asyncIterator] as () => AsyncIterator<unknown>).call(
          target,
        );
        return {
          async next() {
            try {
              const step = await iterator.next();
              if (step.done) end();
              else {
                try {
                  onEvent(step.value);
                } catch {
                  // recording must never break the application's stream
                }
              }
              return step;
            } catch (error) {
              end(error);
              throw error;
            }
          },
          async return(value?: unknown) {
            if (!done) onCancel();
            end();
            return iterator.return ? iterator.return(value) : { done: true, value };
          },
          async throw(error?: unknown) {
            end(error);
            if (iterator.throw) return iterator.throw(error);
            throw error;
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      };
    },
  });
}

function patch(target: unknown, method: string, make: (original: AnyFn) => AnyFn): void {
  if (!isObj(target) || typeof target[method] !== 'function') return;
  const original = target[method] as AnyFn;
  const wrapped = make(original);
  Object.defineProperty(target, method, { value: wrapped, configurable: true, writable: true });
}

function markOnce(client: unknown): boolean {
  if (!isObj(client)) return false;
  if (client[INSTRUMENTED]) return false;
  Object.defineProperty(client, INSTRUMENTED, { value: true });
  return true;
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────────────────────

/** Chat messages with text-only content flattened to strings, as the dashboard shows them. */
function openAiMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!isObj(m) || !Array.isArray(m.content)) return m;
    const parts = m.content as unknown[];
    const texts = parts.every((p) => isObj(p) && p.type === 'text' && typeof p.text === 'string');
    return texts ? { ...m, content: parts.map((p) => (p as Obj).text).join('\n') } : m;
  });
}

function requestInput(params: Obj, messages: unknown): Obj {
  const { stream: _stream, ...rest } = params;
  return { ...rest, messages };
}

function chatOutput(message: Obj | undefined): unknown {
  if (!message) return null;
  const text = str(message.content) ?? str(message.refusal) ?? '';
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls = calls.filter(isObj).map((c) => {
    const fn = isObj(c.function) ? c.function : {};
    return { name: str(fn.name) ?? '', arguments: str(fn.arguments) ?? '' };
  });
  return toolCalls.length ? { text, toolCalls } : { text };
}

function responsesText(response: Obj): string {
  if (typeof response.output_text === 'string') return response.output_text;
  const texts: string[] = [];
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (!isObj(item) || !Array.isArray(item.content)) continue;
    for (const c of item.content)
      if (isObj(c) && c.type === 'output_text' && typeof c.text === 'string') texts.push(c.text);
  }
  return texts.join('');
}

export function instrumentOpenAI<T>(client: T, options: InstrumentOptions): T {
  if (!markOnce(client)) return client;
  const provider = options.provider ?? 'openai';
  const base = {
    tracer: options.tracer,
    provider,
    providerType: provider === 'openai' ? 'openai' : 'openai-compatible',
  };
  const c = client as Obj;

  const completions = isObj(c.chat) ? c.chat.completions : undefined;
  patch(
    completions,
    'create',
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        return intercept(original, this, args, {
          ...base,
          operation: 'chat',
          input: (p) => requestInput(p, openAiMessages(p.messages)),
          fromResponse: (r) => {
            const choice = Array.isArray(r.choices) && isObj(r.choices[0]) ? r.choices[0] : {};
            const usage = isObj(r.usage) ? r.usage : {};
            const cached =
              count(
                isObj(usage.prompt_tokens_details)
                  ? usage.prompt_tokens_details.cached_tokens
                  : undefined,
              ) ?? 0;
            const prompt = count(usage.prompt_tokens);
            return {
              output: chatOutput(isObj(choice.message) ? choice.message : undefined),
              model: str(r.model),
              inputTokens: prompt === undefined ? undefined : Math.max(0, prompt - cached),
              outputTokens: count(usage.completion_tokens),
              cacheReadTokens: cached || undefined,
              finishReason: str(choice.finish_reason),
              requestId: str(r._request_id) ?? str(r.id),
            };
          },
          fromStream: () => {
            let text = '';
            let result: CallResult = { output: null };
            const tools = new Map<number, { name: string; arguments: string }>();
            return {
              onEvent(chunk) {
                if (!isObj(chunk)) return;
                result.model ??= str(chunk.model);
                result.requestId ??= str(chunk.id);
                const choice =
                  Array.isArray(chunk.choices) && isObj(chunk.choices[0])
                    ? chunk.choices[0]
                    : undefined;
                const delta = choice && isObj(choice.delta) ? choice.delta : undefined;
                if (delta && typeof delta.content === 'string') text += delta.content;
                for (const t of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
                  if (!isObj(t)) continue;
                  const index = count(t.index) ?? 0;
                  // Real responses have a handful of tool calls; indexes past this are noise.
                  if (!tools.has(index) && tools.size >= MAX_STREAM_TOOL_CALLS) continue;
                  const entry = tools.get(index) ?? { name: '', arguments: '' };
                  const fn = isObj(t.function) ? t.function : {};
                  entry.name += str(fn.name) ?? '';
                  entry.arguments += str(fn.arguments) ?? '';
                  tools.set(index, entry);
                }
                if (choice && typeof choice.finish_reason === 'string')
                  result.finishReason = choice.finish_reason;
                // Present when the request sets stream_options.include_usage.
                if (isObj(chunk.usage)) {
                  const u = chunk.usage;
                  const cached =
                    count(
                      isObj(u.prompt_tokens_details)
                        ? u.prompt_tokens_details.cached_tokens
                        : undefined,
                    ) ?? 0;
                  const prompt = count(u.prompt_tokens);
                  result = {
                    ...result,
                    inputTokens: prompt === undefined ? undefined : Math.max(0, prompt - cached),
                    outputTokens: count(u.completion_tokens),
                    cacheReadTokens: cached || undefined,
                  };
                }
              },
              result() {
                // Deltas that never carried a name or arguments are not tool calls.
                const calls = [...tools.entries()]
                  .sort(([a], [b]) => a - b)
                  .map(([, call]) => call)
                  .filter((call) => call.name !== '' || call.arguments !== '');
                return {
                  ...result,
                  output: calls.length ? { text, toolCalls: calls } : { text },
                };
              },
            };
          },
        });
      },
  );

  patch(
    c.responses,
    'create',
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        return intercept(original, this, args, {
          ...base,
          operation: 'chat',
          input: (p) => {
            const { stream: _stream, input, instructions, ...rest } = p;
            const messages =
              typeof input === 'string'
                ? [{ role: 'user', content: input }]
                : openAiMessages(input);
            return {
              ...rest,
              messages: instructions
                ? [
                    { role: 'system', content: instructions },
                    ...(Array.isArray(messages) ? messages : [messages]),
                  ]
                : messages,
            };
          },
          fromResponse: (r) => responsesResult(r),
          fromStream: () => {
            let text = '';
            let result: CallResult = { output: null };
            return {
              onEvent(event) {
                if (!isObj(event)) return;
                if (event.type === 'response.output_text.delta' && typeof event.delta === 'string')
                  text += event.delta;
                if (event.type === 'response.completed' && isObj(event.response))
                  result = responsesResult(event.response);
              },
              result() {
                return {
                  ...result,
                  output: {
                    text: text || (isObj(result.output) ? (result.output as Obj).text : ''),
                  },
                };
              },
            };
          },
        });
      },
  );

  patch(
    c.embeddings,
    'create',
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        return intercept(original, this, args, {
          ...base,
          operation: 'embeddings',
          input: (p) => ({ model: p.model, inputs: Array.isArray(p.input) ? p.input.length : 1 }),
          fromResponse: (r) => {
            const data = Array.isArray(r.data) ? r.data : [];
            const first =
              isObj(data[0]) && Array.isArray(data[0].embedding) ? data[0].embedding : [];
            return {
              output: { embeddings: data.length, dimensions: first.length },
              model: str(r.model),
              inputTokens: count(isObj(r.usage) ? r.usage.prompt_tokens : undefined),
              outputTokens: 0,
            };
          },
        });
      },
  );
  return client;
}

function responsesResult(r: Obj): CallResult {
  const usage = isObj(r.usage) ? r.usage : {};
  const cached =
    count(
      isObj(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : undefined,
    ) ?? 0;
  const input = count(usage.input_tokens);
  return {
    output: { text: responsesText(r) },
    model: str(r.model),
    inputTokens: input === undefined ? undefined : Math.max(0, input - cached),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: cached || undefined,
    finishReason: str(r.status),
    requestId: str(r._request_id) ?? str(r.id),
  };
}

// ─── Anthropic ───────────────────────────────────────────────────────────────────────────────

function anthropicInput(p: Obj): Obj {
  const { stream: _stream, system, messages, ...rest } = p;
  const flat = Array.isArray(messages)
    ? messages.map((m) => {
        if (!isObj(m) || !Array.isArray(m.content)) return m;
        const blocks = m.content as unknown[];
        const texts = blocks.every(
          (b) => isObj(b) && b.type === 'text' && typeof b.text === 'string',
        );
        return texts ? { ...m, content: blocks.map((b) => (b as Obj).text).join('\n') } : m;
      })
    : messages;
  const systemText = Array.isArray(system)
    ? system.map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : '')).join('\n')
    : system;
  return {
    ...rest,
    messages: systemText
      ? [{ role: 'system', content: systemText }, ...(Array.isArray(flat) ? flat : [])]
      : flat,
  };
}

function anthropicResult(message: Obj): CallResult {
  const content = Array.isArray(message.content) ? message.content.filter(isObj) : [];
  const text = content
    .filter((b) => b.type === 'text')
    .map((b) => str(b.text) ?? '')
    .join('');
  const toolCalls = content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ name: str(b.name) ?? '', arguments: JSON.stringify(b.input ?? null) }));
  const usage = isObj(message.usage) ? message.usage : {};
  return {
    output: toolCalls.length ? { text, toolCalls } : { text },
    model: str(message.model),
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens) || undefined,
    cacheWriteTokens: count(usage.cache_creation_input_tokens) || undefined,
    finishReason: str(message.stop_reason),
    requestId: str(message._request_id) ?? str(message.id),
  };
}

export function instrumentAnthropic<T>(client: T, options: InstrumentOptions): T {
  if (!markOnce(client)) return client;
  const provider = options.provider ?? 'anthropic';
  const base = { tracer: options.tracer, provider, providerType: 'anthropic' };
  const messages = (client as Obj).messages;

  patch(
    messages,
    'create',
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        return intercept(original, this, args, {
          ...base,
          operation: 'chat',
          input: anthropicInput,
          fromResponse: anthropicResult,
          fromStream: () => {
            let message: Obj = { content: [] };
            // Keyed by the event's index; an array would let one huge index hang the app.
            const blocks = new Map<number, Obj>();
            return {
              onEvent(event) {
                if (!isObj(event)) return;
                if (event.type === 'message_start' && isObj(event.message))
                  message = { ...event.message };
                if (event.type === 'content_block_start' && isObj(event.content_block))
                  blocks.set(count(event.index) ?? blocks.size, { ...event.content_block });
                if (event.type === 'content_block_delta' && isObj(event.delta)) {
                  const index = count(event.index) ?? 0;
                  const block = blocks.get(index) ?? { type: 'text', text: '' };
                  if (event.delta.type === 'text_delta')
                    block.text = `${str(block.text) ?? ''}${str(event.delta.text) ?? ''}`;
                  if (event.delta.type === 'input_json_delta')
                    block.partial = `${str(block.partial) ?? ''}${str(event.delta.partial_json) ?? ''}`;
                  blocks.set(index, block);
                }
                if (event.type === 'message_delta') {
                  if (isObj(event.delta) && typeof event.delta.stop_reason === 'string')
                    message.stop_reason = event.delta.stop_reason;
                  if (isObj(event.usage))
                    message.usage = {
                      ...(isObj(message.usage) ? message.usage : {}),
                      ...event.usage,
                    };
                }
              },
              result() {
                const content = [...blocks.entries()]
                  .sort(([a], [b]) => a - b)
                  .map(([, b]) => {
                    if (b.type !== 'tool_use' || typeof b.partial !== 'string') return b;
                    try {
                      return { ...b, input: JSON.parse(b.partial) };
                    } catch {
                      return { ...b, input: b.partial };
                    }
                  });
                return anthropicResult({ ...message, content });
              },
            };
          },
        });
      },
  );

  return client;
}
