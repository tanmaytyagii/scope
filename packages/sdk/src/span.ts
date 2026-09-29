/**
 * Mutable span handles. A handle collects data while the operation runs and produces an
 * immutable SpanRecord when it ends.
 */
import {
  type Attributes,
  type AttributeValue,
  capture,
  type ErrorInfo,
  estimateCost,
  type PriceTable,
  type PrivacyPolicy,
  redactAttributes,
  redactAttributeValue,
  redactText,
  type SpanEvent,
  type SpanKind,
  type SpanRecord,
  type SpanStatus,
  toErrorInfo,
  type Usage,
} from '@scope-ai/core';

export interface ModelCallInfo {
  /** Configured provider name, e.g. "openai". */
  provider: string;
  /** Provider implementation type ("openai", "anthropic", "local", …), when it differs. */
  providerType?: string;
  /** Requested model. */
  model: string;
  /** Model that served the request, when the provider reports it. */
  responseModel?: string | null;
  usage?: Partial<Usage> | null;
  finishReason?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  ignoredParams?: string[];
  requestId?: string | null;
  /** Explicit cost; when omitted it is estimated from the pricing table. */
  costUsd?: number | null;
  attributes?: Record<string, AttributeValue>;
}

export interface SpanHandle {
  readonly id: string;
  readonly traceId: string;
  readonly kind: SpanKind;
  setInput(value: unknown): this;
  setOutput(value: unknown): this;
  setAttribute(key: string, value: AttributeValue | null | undefined): this;
  setAttributes(attributes: Record<string, AttributeValue | null | undefined>): this;
  addEvent(name: string, attributes?: Attributes): this;
  setStatus(status: SpanStatus, message?: string): this;
  recordError(error: unknown): this;
  /** Records a model call using OpenTelemetry GenAI attribute names, and estimates its cost. */
  recordModelCall(call: ModelCallInfo): this;
}

/**
 * Epoch milliseconds from the monotonic clock. Using one clock for start and end times keeps
 * sibling spans correctly ordered (Date.now() and performance.now() drift apart).
 */
export function hrNow(): number {
  return performance.timeOrigin + performance.now();
}

/** Epoch ms with microsecond resolution: enough to order spans that start in the same millisecond. */
function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface SpanSettings {
  privacy: PrivacyPolicy;
  pricing: PriceTable;
  includeStacks: boolean;
}

export class SpanRecorder implements SpanHandle {
  readonly id: string;
  readonly traceId: string;
  readonly kind: SpanKind;
  readonly parentId: string | null;
  readonly name: string;
  readonly startTime: number;
  readonly #startMark: number;
  readonly #settings: SpanSettings;
  #input: SpanRecord['input'] = null;
  #output: SpanRecord['output'] = null;
  #attributes: Attributes = {};
  #events: SpanEvent[] = [];
  #status: SpanStatus = 'ok';
  #statusMessage: string | null = null;
  #error: ErrorInfo | null = null;
  #provider: string | null = null;
  #model: string | null = null;
  #inputTokens: number | null = null;
  #outputTokens: number | null = null;
  #costUsd: number | null = null;
  #redactions = 0;
  #hasOutput = false;
  #ended: SpanRecord | null = null;

  constructor(init: {
    id: string;
    traceId: string;
    parentId: string | null;
    name: string;
    kind: SpanKind;
    settings: SpanSettings;
  }) {
    this.id = init.id;
    this.traceId = init.traceId;
    this.parentId = init.parentId;
    this.name = init.name;
    this.kind = init.kind;
    this.#settings = init.settings;
    this.#startMark = hrNow();
    this.startTime = roundMs(this.#startMark);
  }

  get ended(): boolean {
    return this.#ended !== null;
  }

  get status(): SpanStatus {
    return this.#status;
  }

  /** Whether an output has been set explicitly. */
  get hasOutput(): boolean {
    return this.#hasOutput;
  }

  #capture(value: unknown, which: 'input' | 'output'): SpanRecord['input'] {
    const result = capture(value, this.#settings.privacy);
    this.#redactions += result.redactions;
    if (result.truncated) this.#attributes[`scope.${which}.truncated`] = true;
    if (!this.#settings.privacy.captureContent && value !== undefined)
      this.#attributes['scope.content.omitted'] = true;
    return result.value;
  }

  setInput(value: unknown): this {
    if (!this.#ended) this.#input = this.#capture(value, 'input');
    return this;
  }

  setOutput(value: unknown): this {
    if (!this.#ended) {
      this.#output = this.#capture(value, 'output');
      this.#hasOutput = true;
    }
    return this;
  }

  setAttribute(key: string, value: AttributeValue | null | undefined): this {
    if (this.#ended || value === null || value === undefined) return this;
    if (typeof value === 'number' && !Number.isFinite(value)) return this;
    // Attributes are kept even without content capture, so they are always redacted here —
    // spans written by `scope run` never pass through the server's ingestion.
    const redacted = redactAttributeValue(key, value, this.#settings.privacy);
    this.#redactions += redacted.redactions;
    this.#attributes[key] = redacted.value;
    return this;
  }

  setAttributes(attributes: Record<string, AttributeValue | null | undefined>): this {
    for (const [k, v] of Object.entries(attributes)) this.setAttribute(k, v);
    return this;
  }

  addEvent(name: string, attributes?: Attributes): this {
    if (this.#ended) return this;
    const event: SpanEvent = { name, time: roundMs(hrNow()) };
    if (attributes) {
      const redacted = redactAttributes(attributes, this.#settings.privacy);
      this.#redactions += redacted.redactions;
      event.attributes = redacted.attributes;
    }
    this.#events.push(event);
    return this;
  }

  setStatus(status: SpanStatus, message?: string): this {
    if (this.#ended) return this;
    this.#status = status;
    this.#statusMessage = message === undefined ? null : this.#redact(message);
    return this;
  }

  #redact(text: string): string {
    const r = redactText(text, this.#settings.privacy);
    this.#redactions += r.redactions;
    return r.text;
  }

  recordError(error: unknown): this {
    if (this.#ended) return this;
    const info = toErrorInfo(error, { includeStack: this.#settings.includeStacks });
    // Error messages can quote secrets (e.g. an invalid key echoed back). They are structure, kept
    // even without content capture, so they are always redacted — and so is the stack, whose
    // first line repeats the message.
    info.message = this.#redact(info.message);
    if (info.stack) info.stack = this.#redact(info.stack);
    if (info.hint) info.hint = this.#redact(info.hint);
    this.#error = info;
    this.#status = 'error';
    this.#statusMessage = info.message;
    const eventAttributes: Attributes = {
      'exception.type': info.type,
      'exception.message': info.message,
    };
    if (info.code) eventAttributes['exception.code'] = info.code;
    this.addEvent('exception', eventAttributes);
    return this;
  }

  recordModelCall(call: ModelCallInfo): this {
    if (this.#ended) return this;
    this.#provider = call.provider;
    this.#model = call.model;
    const usage = call.usage ?? {};
    this.#inputTokens = usage.inputTokens ?? null;
    this.#outputTokens = usage.outputTokens ?? null;
    this.setAttributes({
      'gen_ai.provider.name': call.provider,
      'gen_ai.request.model': call.model,
      'gen_ai.response.model': call.responseModel ?? undefined,
      'gen_ai.usage.input_tokens': usage.inputTokens,
      'gen_ai.usage.output_tokens': usage.outputTokens,
      'gen_ai.usage.cache_read_input_tokens': usage.cacheReadTokens || undefined,
      'gen_ai.usage.cache_creation_input_tokens': usage.cacheWriteTokens || undefined,
      'gen_ai.request.temperature': call.temperature ?? undefined,
      'gen_ai.request.max_tokens': call.maxTokens ?? undefined,
      'gen_ai.response.finish_reasons': call.finishReason ? [call.finishReason] : undefined,
      'gen_ai.response.id': call.requestId ?? undefined,
      'scope.provider.type': call.providerType,
      'scope.usage.estimated': usage.estimated ? true : undefined,
      'scope.request.ignored_params': call.ignoredParams?.length ? call.ignoredParams : undefined,
    });
    if (call.attributes) this.setAttributes(call.attributes);

    if (call.costUsd !== undefined) {
      this.#costUsd = call.costUsd;
    } else if (call.providerType === 'local') {
      this.#costUsd = 0;
    } else {
      const tokens = {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      };
      let estimate = call.responseModel
        ? estimateCost(call.provider, call.responseModel, tokens, this.#settings.pricing)
        : null;
      if (!estimate || estimate.usd === null)
        estimate = estimateCost(call.provider, call.model, tokens, this.#settings.pricing);
      this.#costUsd = estimate.usd;
      if (estimate.priceKey) this.setAttribute('scope.cost.price_key', estimate.priceKey);
      if (estimate.asOf) this.setAttribute('scope.cost.as_of', estimate.asOf);
    }
    if (this.#costUsd !== null) {
      this.setAttribute('scope.cost.usd', this.#costUsd);
      this.setAttribute('scope.cost.estimated', true);
    }
    return this;
  }

  end(): SpanRecord {
    if (this.#ended) return this.#ended;
    const endMark = hrNow();
    const durationMs = Math.round((endMark - this.#startMark) * 1000) / 1000;
    if (this.#redactions > 0) this.#attributes['scope.redactions'] = this.#redactions;
    this.#ended = {
      traceId: this.traceId,
      id: this.id,
      parentId: this.parentId,
      name: this.name,
      kind: this.kind,
      status: this.#status,
      statusMessage: this.#statusMessage,
      startTime: this.startTime,
      endTime: roundMs(endMark),
      durationMs,
      input: this.#input,
      output: this.#output,
      attributes: this.#attributes,
      events: this.#events,
      error: this.#error,
      provider: this.#provider,
      model: this.#model,
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      costUsd: this.#costUsd,
    };
    return this.#ended;
  }
}
