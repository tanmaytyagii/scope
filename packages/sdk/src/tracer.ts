/**
 * The tracer: creates traces and spans, propagates context through async calls, and hands
 * finished traces to an exporter.
 *
 *   const tracer = createTracer();
 *   await tracer.trace('answer-question', { input: { question } }, async () => {
 *     const docs = await tracer.span('retrieve', { kind: 'retrieval' }, () => search(question));
 *     …
 *   });
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  capture,
  createPrivacyPolicy,
  DEFAULT_PRIVACY_POLICY,
  type EvaluationRecord,
  type JsonObject,
  type Logger,
  newId,
  newSpanId,
  newTraceId,
  type PriceTable,
  type PrivacyOptions,
  type PrivacyPolicy,
  redactText,
  rollupSpans,
  type SpanKind,
  type SpanRecord,
  type SpanStatus,
  silentLogger,
  type TraceBundle,
  type TraceRecord,
  toJsonValue,
  type Usage,
} from '@scope-ai/core';
import { type SpanHandle, SpanRecorder, type SpanSettings } from './span.ts';

export interface TraceExporter {
  /** Receives each finished trace. Must not throw for transient failures; queue and retry instead. */
  export(bundle: TraceBundle): Promise<void> | void;
  /** Sends anything queued. */
  flush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface TracerOptions {
  exporter: TraceExporter;
  privacy?: PrivacyPolicy | PrivacyOptions;
  pricing?: PriceTable;
  /** Spans beyond this limit in one trace are not recorded (the work still runs). */
  maxSpansPerTrace?: number;
  /** Include stack traces in recorded errors. Off by default: stacks reveal file paths. */
  includeStacks?: boolean;
  logger?: Logger;
}

export interface TraceOptions {
  input?: unknown;
  metadata?: Record<string, unknown>;
  runId?: string | null;
  caseId?: string | null;
  /** Use a specific trace id (32 hex), e.g. to continue an upstream W3C trace. */
  traceId?: string;
  /** Kind of the root span. */
  kind?: SpanKind;
  /**
   * Runs after the root span has ended and before the trace is exported, with the trace as the
   * current context but no parent span. Spans created here become additional root spans —
   * used for evaluation, so that the trace's timing reflects the workflow alone.
   */
  finalize?: (trace: TraceHandle) => Promise<void> | void;
}

export interface SpanOptions {
  kind?: SpanKind;
  input?: unknown;
  attributes?: Record<string, string | number | boolean | string[] | number[] | boolean[]>;
}

export interface TraceMetrics {
  /** Root span duration; null while the root span is still running. */
  durationMs: number | null;
  usage: Usage;
  costUsd: number | null;
}

export interface TraceHandle {
  readonly id: string;
  readonly root: SpanHandle;
  /** Rollups over the spans finished so far (evaluation spans excluded). */
  metrics(): TraceMetrics;
  /** Status of the root span ("error" when the traced function threw). */
  status(): SpanStatus;
  setInput(value: unknown): void;
  setOutput(value: unknown): void;
  setMetadata(key: string, value: unknown): void;
  addEvaluation(
    evaluation: Omit<EvaluationRecord, 'id' | 'traceId' | 'runId' | 'createdAt'> & {
      id?: string;
      createdAt?: number;
    },
  ): void;
}

interface TraceState {
  id: string;
  runId: string | null;
  caseId: string | null;
  name: string;
  spans: SpanRecorder[];
  finished: SpanRecord[];
  evaluations: EvaluationRecord[];
  metadata: JsonObject;
  dropped: number;
  rootDurationMs: number | null;
  handle: TraceHandle;
}

interface ActiveContext {
  trace: TraceState;
  span: SpanRecorder | null;
}

export class Tracer {
  readonly #storage = new AsyncLocalStorage<ActiveContext>();
  readonly #exporter: TraceExporter;
  readonly #settings: SpanSettings;
  readonly #maxSpans: number;
  readonly #logger: Logger;
  readonly #pending = new Set<Promise<void>>();

  constructor(options: TracerOptions) {
    this.#exporter = options.exporter;
    const privacy =
      options.privacy === undefined
        ? DEFAULT_PRIVACY_POLICY
        : 'rules' in options.privacy
          ? (options.privacy as PrivacyPolicy)
          : createPrivacyPolicy(options.privacy as PrivacyOptions);
    this.#settings = {
      privacy,
      pricing: options.pricing ?? {},
      includeStacks: options.includeStacks ?? false,
    };
    this.#maxSpans = options.maxSpansPerTrace ?? 1000;
    this.#logger = options.logger ?? silentLogger;
  }

  get privacy(): PrivacyPolicy {
    return this.#settings.privacy;
  }

  /** The span currently in scope, if any. */
  currentSpan(): SpanHandle | undefined {
    return this.#storage.getStore()?.span ?? undefined;
  }

  currentTrace(): TraceHandle | undefined {
    return this.#storage.getStore()?.trace.handle;
  }

  async trace<T>(
    name: string,
    options: TraceOptions,
    fn: (trace: TraceHandle) => Promise<T> | T,
  ): Promise<T> {
    const traceId = options.traceId ?? newTraceId();
    const state: TraceState = {
      id: traceId,
      runId: options.runId ?? null,
      caseId: options.caseId ?? null,
      name,
      spans: [],
      finished: [],
      evaluations: [],
      metadata: options.metadata ? (toJsonValue(options.metadata) as JsonObject) : {},
      dropped: 0,
      rootDurationMs: null,
      handle: undefined as unknown as TraceHandle,
    };
    const root = new SpanRecorder({
      id: newSpanId(),
      traceId,
      parentId: null,
      name,
      kind: options.kind ?? 'workflow',
      settings: this.#settings,
    });
    state.spans.push(root);
    if (options.input !== undefined) root.setInput(options.input);
    state.handle = {
      id: traceId,
      root,
      status: () => root.status,
      metrics: () => {
        const rollup = rollupSpans(state.spans.filter((s) => s.ended).map((s) => s.end()));
        return { durationMs: state.rootDurationMs, usage: rollup.usage, costUsd: rollup.costUsd };
      },
      setInput: (v) => root.setInput(v),
      setOutput: (v) => root.setOutput(v),
      setMetadata: (k, v) => {
        state.metadata[k] = toJsonValue(v);
      },
      addEvaluation: (e) => {
        const privacy = this.#settings.privacy;
        const evidence = capture(e.metadata, privacy).value;
        state.evaluations.push({
          ...e,
          // Evaluators see the unredacted output, so their reasons and evidence can quote it.
          reason: redactText(e.reason, privacy).text,
          // Evidence often quotes the output, so it follows the content policy.
          metadata:
            evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : {},
          id: e.id ?? newId('ev'),
          traceId,
          runId: state.runId,
          createdAt: e.createdAt ?? Date.now(),
        });
      },
    };

    let result: T | undefined;
    let failure: unknown;
    let failed = false;
    try {
      result = await this.#storage.run({ trace: state, span: root }, () => fn(state.handle));
      if (result !== undefined && root.status === 'ok' && !root.hasOutput) root.setOutput(result);
    } catch (error) {
      failed = true;
      failure = error;
      root.recordError(error);
    }
    const rootRecord = root.end();
    state.rootDurationMs = rootRecord.durationMs;

    if (options.finalize) {
      try {
        await this.#storage.run({ trace: state, span: null }, () =>
          options.finalize?.(state.handle),
        );
      } catch (error) {
        this.#logger.error('trace finalize hook failed', { traceId, error });
      }
    }

    // Close spans left open by un-awaited work, so the trace is complete.
    for (const span of state.spans)
      if (!span.ended) span.setStatus('error', 'span did not end before its trace').end();
    const spans = state.spans.map((s) => s.end());
    const rollup = rollupSpans(spans);
    if (state.dropped > 0) state.metadata['scope.dropped_spans'] = state.dropped;

    const trace: TraceRecord = {
      id: traceId,
      runId: state.runId,
      caseId: state.caseId,
      name,
      status: rootRecord.status,
      startTime: rootRecord.startTime,
      endTime: rootRecord.endTime,
      durationMs: rootRecord.durationMs,
      input: rootRecord.input,
      output: rootRecord.output,
      // Metadata is structure: kept without content capture, always redacted and bounded.
      metadata: (capture(state.metadata, { ...this.#settings.privacy, captureContent: true })
        .value ?? {}) as JsonObject,
      error: rootRecord.error,
      usage: rollup.usage,
      costUsd: rollup.costUsd,
      spanCount: spans.length,
      llmCallCount: rollup.llmCallCount,
    };
    await this.#export({ trace, spans, evaluations: state.evaluations });

    if (failed) throw failure;
    return result as T;
  }

  async span<T>(
    name: string,
    options: SpanOptions,
    fn: (span: SpanHandle) => Promise<T> | T,
  ): Promise<T> {
    const context = this.#storage.getStore();
    if (!context) {
      // Outside a trace: run the work without recording. Instrumentation never changes behaviour.
      return fn(NOOP_SPAN);
    }
    if (context.trace.spans.length >= this.#maxSpans) {
      context.trace.dropped++;
      return fn(NOOP_SPAN);
    }
    const span = new SpanRecorder({
      id: newSpanId(),
      traceId: context.trace.id,
      parentId: context.span?.id ?? null,
      name,
      kind: options.kind ?? 'custom',
      settings: this.#settings,
    });
    context.trace.spans.push(span);
    if (options.input !== undefined) span.setInput(options.input);
    if (options.attributes) span.setAttributes(options.attributes);
    try {
      const result = await this.#storage.run({ trace: context.trace, span }, () => fn(span));
      // Record the return value unless the callback set an output itself.
      if (result !== undefined && span.status === 'ok' && !span.hasOutput) span.setOutput(result);
      return result;
    } catch (error) {
      span.recordError(error);
      throw error;
    } finally {
      span.end();
    }
  }

  async #export(bundle: TraceBundle): Promise<void> {
    const task = (async () => {
      try {
        await this.#exporter.export(bundle);
      } catch (error) {
        this.#logger.error('trace export failed', { traceId: bundle.trace.id, error });
      }
    })();
    this.#pending.add(task);
    try {
      await task;
    } finally {
      this.#pending.delete(task);
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.#pending);
    await this.#exporter.flush?.();
  }

  async shutdown(): Promise<void> {
    await this.flush();
    await this.#exporter.shutdown?.();
  }
}

const NOOP_SPAN: SpanHandle = {
  id: '0000000000000000',
  traceId: '00000000000000000000000000000000',
  kind: 'custom',
  setInput() {
    return this;
  },
  setOutput() {
    return this;
  },
  setAttribute() {
    return this;
  },
  setAttributes() {
    return this;
  },
  addEvent() {
    return this;
  },
  setStatus() {
    return this;
  },
  recordError() {
    return this;
  },
  recordModelCall() {
    return this;
  },
};
