/**
 * The workflow engine: runs each case as a trace, evaluates the result, and reports per-case
 * outcomes. It is storage-agnostic: finished traces go to the exporter it is given.
 */
import { dirname } from 'node:path';
import {
  ConfigError,
  type DatasetCase,
  type Diagnostic,
  type EvaluatorConfig,
  evaluatorName,
  hasErrors,
  type LoadedWorkflow,
  type ResolvedProject,
  renderDeep,
  resolveParams,
  type WorkflowFile,
} from '@scope-ai/config';
import {
  asText,
  type CaseResult,
  capturePayload,
  ErrorCodes,
  type ErrorInfo,
  EVALUATOR_KINDS,
  type EvaluationRecord,
  type EvaluationStatus,
  type EvaluatorKind,
  errorMessage,
  formatDuration,
  type GateDefinition,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type Logger,
  newId,
  rollupSpans,
  ScopeError,
  silentLogger,
  type TraceBundle,
  toErrorInfo,
  type Usage,
} from '@scope-ai/core';
import {
  type EvaluatorContext,
  type EvaluatorDefinition,
  type EvaluatorOutcome,
  EvaluatorRegistry,
  RESERVED_ARGS,
} from '@scope-ai/evaluators';
import { type FinishReason, ProviderRegistry } from '@scope-ai/providers';
import { type TraceExporter, type TraceHandle, Tracer } from '@scope-ai/sdk';
import { z } from 'zod';
import { callModel, embedTexts } from './model-calls.ts';
import { isModulePath, loadExport } from './modules.ts';
import {
  type FunctionContext,
  type LlmOptions,
  type RetrieveOptions,
  retrieveArgs,
  runRetrieval,
  type StepRegistry,
  type StepState,
  StepRegistry as Steps,
  toModelCall,
} from './steps.ts';
import { validateWorkflow } from './validate.ts';

// biome-ignore lint/suspicious/noExplicitAny: evaluators have heterogeneous argument types
type AnyEvaluatorDefinition = EvaluatorDefinition<any>;

export interface ResolvedEvaluator {
  name: string;
  config: EvaluatorConfig;
  definition: AnyEvaluatorDefinition;
  /** Pass threshold for score-based verdicts. */
  threshold: number;
  custom: boolean;
}

export interface PreparedWorkflow {
  loaded: LoadedWorkflow;
  definition: WorkflowFile;
  name: string;
  variant: string | null;
  params: JsonObject;
  baseDir: string;
  evaluators: ResolvedEvaluator[];
  gates: GateDefinition[];
  warnings: Diagnostic[];
}

export interface CaseExecution {
  caseId: string;
  traceId: string;
  status: 'ok' | 'error';
  error: ErrorInfo | null;
  output: JsonValue | null;
  durationMs: number;
  usage: Usage;
  costUsd: number | null;
  unpricedModels: string[];
  evaluations: EvaluationRecord[];
}

export interface RunOptions {
  runId: string | null;
  concurrency?: number;
  /** Stop scheduling new cases after the first case that does not pass. */
  bail?: boolean;
  signal?: AbortSignal;
  onCaseStart?: (c: DatasetCase) => void;
  onCaseComplete?: (execution: CaseExecution, c: DatasetCase) => void;
}

export interface EngineOptions {
  project: Pick<ResolvedProject, 'root' | 'providers' | 'pricing' | 'privacy' | 'defaults'>;
  exporter: TraceExporter;
  providers?: ProviderRegistry;
  evaluators?: EvaluatorRegistry;
  steps?: StepRegistry;
  logger?: Logger;
  env?: Readonly<Record<string, string | undefined>>;
}

const EVALUATOR_TIMEOUT_MS = { model: 180_000, other: 30_000 };

/** An abort signal that fires on timeout or when the parent signal aborts. */
function timeoutSignal(ms: number, label: string, parent: AbortSignal | undefined, hint: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new ScopeError(ErrorCodes.stepTimeout, `${label} timed out after ${formatDuration(ms)}`, {
        hint,
        retryable: true,
      }),
    );
  }, ms);
  const onAbort = () => {
    const reason: unknown = parent?.reason;
    controller.abort(
      reason instanceof ScopeError
        ? reason
        : new ScopeError(ErrorCodes.cancelled, 'Run cancelled', { cause: reason }),
    );
  };
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

/** Runs work with a timeout and parent cancellation; stops waiting even if the work ignores the signal. */
async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
  parent: AbortSignal | undefined,
  hint: string,
): Promise<T> {
  const t = timeoutSignal(ms, label, parent, hint);
  try {
    return await Promise.race([
      work(t.signal),
      new Promise<never>((_, reject) => {
        if (t.signal.aborted) reject(t.signal.reason);
        t.signal.addEventListener('abort', () => reject(t.signal.reason), { once: true });
      }),
    ]);
  } finally {
    t.dispose();
  }
}

function customEvaluatorSchema(value: unknown, ref: string): AnyEvaluatorDefinition {
  const v = value as Partial<AnyEvaluatorDefinition> | null;
  if (!v || typeof v !== 'object' || typeof v.evaluate !== 'function') {
    throw new ScopeError(ErrorCodes.functionLoadFailed, `${ref} does not export an evaluator`, {
      hint: 'Export an object with `kind` and `evaluate(input, ctx)`, e.g. `export default defineEvaluator({...})`.',
    });
  }
  if (!v.kind || !EVALUATOR_KINDS.includes(v.kind as EvaluatorKind)) {
    throw new ScopeError(
      ErrorCodes.functionLoadFailed,
      `${ref}: evaluator "kind" must be one of ${EVALUATOR_KINDS.join(', ')}`,
      {
        hint: 'Declare how the evaluator judges: deterministic (a rule), heuristic (an approximation) or model (a model’s judgment).',
      },
    );
  }
  return {
    type: v.type ?? ref,
    kind: v.kind,
    description: v.description ?? `Custom evaluator ${ref}`,
    argsSchema: v.argsSchema ?? z.record(z.string(), z.unknown()),
    ...(v.defaultThreshold !== undefined ? { defaultThreshold: v.defaultThreshold } : {}),
    ...(v.requires ? { requires: v.requires } : {}),
    evaluate: v.evaluate,
  } as AnyEvaluatorDefinition;
}

export class Engine {
  readonly providers: ProviderRegistry;
  readonly evaluators: EvaluatorRegistry;
  readonly steps: StepRegistry;
  readonly #options: EngineOptions;
  readonly #logger: Logger;
  readonly #tracer: Tracer;
  readonly #captured = new Map<string, TraceBundle>();

  constructor(options: EngineOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.providers =
      options.providers ??
      new ProviderRegistry({
        providers: options.project.providers,
        ...(options.env ? { env: options.env } : {}),
      });
    this.evaluators = options.evaluators ?? new EvaluatorRegistry();
    this.steps = options.steps ?? new Steps();
    this.#tracer = new Tracer({
      exporter: {
        export: async (bundle) => {
          this.#captured.set(bundle.trace.id, bundle);
          await options.exporter.export(bundle);
        },
        flush: () => options.exporter.flush?.() ?? Promise.resolve(),
      },
      privacy: options.project.privacy,
      pricing: options.project.pricing,
      // A case is complete when its trace function returns: evaluation and the run summary read
      // its trace right away, so spans left open are closed then rather than waited for.
      openSpanGraceMs: 0,
      logger: this.#logger,
    });
  }

  get tracer(): Tracer {
    return this.#tracer;
  }

  /** Plugin-aware validation. Returns every diagnostic; does not throw. */
  validate(loaded: LoadedWorkflow, variant?: string | null): Diagnostic[] {
    return validateWorkflow(loaded, {
      steps: this.steps,
      evaluators: this.evaluators,
      providers: this.providers,
      ...(variant !== undefined ? { variant } : {}),
    });
  }

  /** Validates, resolves params for the variant and loads custom evaluators. */
  async prepare(
    loaded: LoadedWorkflow,
    options: { variant?: string | null } = {},
  ): Promise<PreparedWorkflow> {
    const variant = options.variant ?? null;
    const params = resolveParams(loaded.definition, variant);
    const diagnostics = this.validate(loaded, variant);
    if (hasErrors(diagnostics))
      throw new ConfigError(diagnostics, { [loaded.displayPath]: loaded.text });
    const baseDir = dirname(loaded.path);
    const evaluators: ResolvedEvaluator[] = [];
    for (const config of loaded.definition.evaluators ?? []) {
      const custom = isModulePath(config.type);
      const definition = custom
        ? customEvaluatorSchema(
            await loadExport(config.type, 'default', baseDir, 'evaluator'),
            config.type,
          )
        : this.evaluators.get(config.type);
      evaluators.push({
        name: evaluatorName(config),
        config,
        definition,
        threshold: config.threshold ?? definition.defaultThreshold ?? 1,
        custom,
      });
    }
    const gates: GateDefinition[] = (loaded.definition.gates ?? []).map((g) => {
      const gate: GateDefinition = { metric: g.metric };
      if (g.min !== undefined) gate.min = g.min;
      if (g.max !== undefined) gate.max = g.max;
      if (g.max_decrease !== undefined) gate.maxDecrease = g.max_decrease;
      if (g.max_increase !== undefined) gate.maxIncrease = g.max_increase;
      if (g.max_decrease_pct !== undefined) gate.maxDecreasePct = g.max_decrease_pct;
      if (g.max_increase_pct !== undefined) gate.maxIncreasePct = g.max_increase_pct;
      if (g.severity !== undefined) gate.severity = g.severity;
      return gate;
    });
    return {
      loaded,
      definition: loaded.definition,
      name: loaded.definition.name,
      variant,
      params,
      baseDir,
      evaluators,
      gates,
      warnings: diagnostics.filter((d) => d.severity === 'warning'),
    };
  }

  // ─── execution ─────────────────────────────────────────────────────────────────────────────

  async run(
    prepared: PreparedWorkflow,
    cases: readonly DatasetCase[],
    options: RunOptions,
  ): Promise<{ executions: CaseExecution[]; cancelled: boolean }> {
    const concurrency = Math.max(
      1,
      Math.min(64, options.concurrency ?? this.#options.project.defaults.concurrency),
    );
    const executions: CaseExecution[] = new Array(cases.length);
    let next = 0;
    let stop = false;
    const worker = async () => {
      while (!stop && next < cases.length) {
        if (options.signal?.aborted) {
          stop = true;
          break;
        }
        const index = next++;
        const testCase = cases[index] as DatasetCase;
        options.onCaseStart?.(testCase);
        const execution = await this.runCase(prepared, testCase, {
          runId: options.runId,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        executions[index] = execution;
        options.onCaseComplete?.(execution, testCase);
        const passed =
          execution.status === 'ok' &&
          execution.evaluations.every((e) => e.status === 'passed' || e.status === 'skipped');
        if (options.bail && !passed) stop = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
    await this.#tracer.flush();
    return { executions: executions.filter(Boolean), cancelled: options.signal?.aborted ?? false };
  }

  async runCase(
    prepared: PreparedWorkflow,
    testCase: DatasetCase,
    options: { runId: string | null; signal?: AbortSignal },
  ): Promise<CaseExecution> {
    const wf = prepared.definition;
    const retrieved: string[] = [];
    const steps: Record<string, StepState> = {};
    const scope: Record<string, unknown> = {
      inputs: testCase.inputs,
      params: prepared.params,
      steps,
      case: { id: testCase.id, metadata: testCase.metadata, tags: testCase.tags },
      variant: prepared.variant,
    };
    let outputs: JsonValue | null = null;
    /** The declared outputs by name (or the last step's output): what `{{ outputs.* }}` sees. */
    let outputMap: JsonValue | null = null;
    let traceId = '';

    const metadata: Record<string, unknown> = { workflow: prepared.name };
    if (prepared.variant) metadata.variant = prepared.variant;
    if (testCase.tags.length) metadata.tags = testCase.tags;
    if (Object.keys(testCase.metadata).length) metadata.case = testCase.metadata;
    if (testCase.expected !== null) {
      const expected = capturePayload(testCase.expected, this.#tracer.privacy);
      if (expected !== null) metadata.expected = expected;
    }

    try {
      await this.#tracer.trace(
        prepared.name,
        {
          input: testCase.inputs,
          runId: options.runId,
          caseId: testCase.id,
          metadata,
          finalize: async (trace) => {
            // Evaluators judge outputs; a failed execution has none (the case is already errored).
            if (trace.status() === 'error') return;
            await this.#evaluate(prepared, trace, {
              inputs: testCase.inputs,
              expected: testCase.expected,
              outputs,
              outputMap,
              context: retrieved.length ? retrieved.join('\n\n') : null,
              scope,
              signal: options.signal,
            });
          },
        },
        async (trace) => {
          traceId = trace.id;
          trace.root.setAttributes({
            'scope.workflow.name': prepared.name,
            'scope.case.id': testCase.id,
          });
          if (prepared.variant) trace.root.setAttribute('scope.workflow.variant', prepared.variant);
          let last: unknown = null;
          for (const step of wf.steps) {
            const stepType = this.steps.get(step.type);
            const started = performance.now();
            const timeoutMs =
              step.timeout_ms ??
              this.#options.project.defaults.timeoutMs ??
              stepType.defaultTimeoutMs;
            try {
              last = await this.#tracer.span(
                step.name ?? step.id,
                { kind: stepType.kind },
                async (span) => {
                  span.setAttributes({ 'scope.step.id': step.id, 'scope.step.type': step.type });
                  const rendered = renderDeep(step.with ?? {}, scope);
                  const parsed = stepType.argsSchema.safeParse(rendered);
                  if (!parsed.success) {
                    span.setInput(rendered);
                    const issue = parsed.error.issues[0];
                    throw new ScopeError(
                      ErrorCodes.stepFailed,
                      `Step "${step.id}": ${issue?.path.length ? `${issue.path.join('.')}: ` : ''}${issue?.message}`,
                      {
                        hint: 'Check the step arguments and the values the templates produce for this case.',
                      },
                    );
                  }
                  if (step.type !== 'llm' && step.type !== 'retrieve') span.setInput(parsed.data);
                  return bounded(
                    (signal) =>
                      stepType.execute(parsed.data, {
                        stepId: step.id,
                        span,
                        signal,
                        baseDir: prepared.baseDir,
                        root: this.#options.project.root,
                        providers: this.providers,
                        tracer: this.#tracer,
                        recordContext: (text) => retrieved.push(text),
                        functionContext: () =>
                          this.#functionContext(prepared, scope, steps, signal, retrieved),
                      }),
                    timeoutMs,
                    `Step "${step.id}"`,
                    options.signal,
                    `Raise timeout_ms on step "${step.id}" or defaults.timeout_ms in scope.yaml.`,
                  );
                },
              );
              steps[step.id] = {
                output: last,
                status: 'ok',
                duration_ms: round(performance.now() - started),
              };
            } catch (error) {
              if (step.continue_on_error && !(options.signal?.aborted ?? false)) {
                steps[step.id] = {
                  output: null,
                  status: 'error',
                  duration_ms: round(performance.now() - started),
                  error: errorMessage(error),
                };
                last = null;
                continue;
              }
              throw error;
            }
          }
          outputs = (wf.outputs ? renderDeep(wf.outputs, scope) : last) as JsonValue;
          outputMap = outputs;
          const declared = Object.keys(wf.outputs ?? {});
          trace.setOutput(outputs);
          // Evaluators judge the single declared output directly; multiple outputs as an object.
          if (declared.length === 1)
            outputs = (outputs as JsonObject)[declared[0] as string] ?? null;
          return undefined;
        },
      );
    } catch {
      // The trace records the error; the case result reports it.
    }
    return this.#toExecution(testCase, traceId, outputs);
  }

  #toExecution(testCase: DatasetCase, traceId: string, output: JsonValue | null): CaseExecution {
    const bundle = this.#captured.get(traceId);
    this.#captured.delete(traceId);
    if (!bundle) {
      throw new ScopeError(ErrorCodes.internal, `Trace for case "${testCase.id}" was not captured`);
    }
    return {
      caseId: testCase.id,
      traceId,
      status: bundle.trace.status,
      error: bundle.trace.error,
      output,
      durationMs: bundle.trace.durationMs,
      usage: bundle.trace.usage,
      costUsd: bundle.trace.costUsd,
      unpricedModels: rollupSpans(bundle.spans).unpricedModels,
      evaluations: bundle.evaluations,
    };
  }

  #functionContext(
    prepared: PreparedWorkflow,
    scope: Record<string, unknown>,
    steps: Record<string, StepState>,
    signal: AbortSignal,
    retrieved: string[],
  ): FunctionContext {
    const tracer = this.#tracer;
    const providers = this.providers;
    return {
      inputs: scope.inputs as JsonObject,
      params: prepared.params,
      steps,
      case: scope.case as FunctionContext['case'],
      variant: prepared.variant,
      signal,
      llm: (options: LlmOptions) =>
        tracer.span(options.name ?? options.model, { kind: 'llm' }, (span) =>
          callModel(span, providers, toModelCall(options), signal),
        ),
      retrieve: (options: RetrieveOptions) =>
        tracer.span(options.name ?? 'retrieve', { kind: 'retrieval' }, async (span) => {
          const parsed = retrieveArgs.parse({
            query: options.query,
            corpus: options.corpus,
            top_k: options.top_k,
            min_score: options.min_score,
            chunk_size: options.chunk_size,
          });
          const output = await runRetrieval(
            span,
            parsed,
            prepared.baseDir,
            this.#options.project.root,
          );
          retrieved.push(output.text);
          return output;
        }),
      span: (name, options, fn) =>
        tracer.span(
          name,
          {
            kind: options.kind ?? 'custom',
            ...(options.input !== undefined ? { input: options.input } : {}),
          },
          fn,
        ),
      tool: (name, input, fn) => tracer.span(name, { kind: 'tool', input }, () => fn()),
    };
  }

  // ─── evaluation ────────────────────────────────────────────────────────────────────────────

  async #evaluate(
    prepared: PreparedWorkflow,
    trace: TraceHandle,
    data: {
      inputs: JsonObject;
      expected: JsonValue | null;
      /** What evaluators judge by default: the single declared output, or all of them. */
      outputs: JsonValue | null;
      outputMap: JsonValue | null;
      context: string | null;
      scope: Record<string, unknown>;
      signal: AbortSignal | undefined;
    },
  ): Promise<void> {
    if (prepared.evaluators.length === 0) return;
    const metrics = trace.metrics();
    const traceFacts = {
      durationMs: metrics.durationMs ?? 0,
      usage: metrics.usage,
      costUsd: metrics.costUsd,
    };
    await this.#tracer.span('evaluate', { kind: 'evaluation' }, async () => {
      for (const evaluator of prepared.evaluators) {
        let spanId: string | null = null;
        const started = performance.now();
        let record: Omit<EvaluationRecord, 'id' | 'traceId' | 'runId' | 'createdAt'>;
        try {
          record = await this.#tracer.span(evaluator.name, { kind: 'evaluation' }, async (span) => {
            spanId = span.id;
            span.setAttributes({
              'scope.evaluator.name': evaluator.name,
              'scope.evaluator.type': evaluator.definition.type,
              'scope.evaluator.kind': evaluator.definition.kind,
            });
            const result = await this.#runEvaluator(evaluator, {
              ...data,
              trace: traceFacts,
              evalScope: {
                ...data.scope,
                outputs: data.outputMap,
                expected: data.expected,
                trace: {
                  duration_ms: traceFacts.durationMs,
                  total_tokens: traceFacts.usage.totalTokens,
                  cost_usd: traceFacts.costUsd,
                },
              },
            });
            span.setOutput({ status: result.status, score: result.score, reason: result.reason });
            return { ...result, spanId: span.id };
          });
        } catch (error) {
          record = {
            spanId,
            evaluator: evaluator.name,
            type: evaluator.definition.type,
            kind: evaluator.definition.kind,
            status: 'error',
            score: null,
            threshold: null,
            reason: `The evaluator failed: ${errorMessage(error)}`,
            metadata: {
              error: toErrorInfo(error) as unknown as JsonObject,
              ...(isJsonObject((error as { metadata?: JsonValue }).metadata ?? null)
                ? ((error as { metadata: JsonObject }).metadata as JsonObject)
                : {}),
            },
            durationMs: round(performance.now() - started),
          };
        }
        trace.addEvaluation(record);
      }
    });
  }

  async #runEvaluator(
    evaluator: ResolvedEvaluator,
    data: {
      inputs: JsonObject;
      expected: JsonValue | null;
      outputs: JsonValue | null;
      context: string | null;
      trace: { durationMs: number; usage: Usage; costUsd: number | null };
      evalScope: Record<string, unknown>;
      signal: AbortSignal | undefined;
    },
  ): Promise<Omit<EvaluationRecord, 'id' | 'traceId' | 'runId' | 'createdAt' | 'spanId'>> {
    const started = performance.now();
    const def = evaluator.definition;
    const rendered = renderDeep(evaluator.config.with ?? {}, data.evalScope) as Record<
      string,
      unknown
    >;
    const args: Record<string, unknown> = { ...rendered };
    for (const key of RESERVED_ARGS) delete args[key];
    const parsed = def.argsSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ScopeError(
        ErrorCodes.configInvalid,
        `invalid arguments for ${evaluator.name}: ${issue?.path.join('.') || '(root)'}: ${issue?.message}`,
      );
    }
    const context =
      rendered.context !== undefined
        ? rendered.context === null
          ? null
          : asText(rendered.context)
        : data.context;
    const input = {
      input: (rendered.input as JsonValue | undefined) ?? data.inputs,
      output: (rendered.output as JsonValue | undefined) ?? data.outputs,
      expected: rendered.expected !== undefined ? (rendered.expected as JsonValue) : data.expected,
      context,
      trace: data.trace,
      args: parsed.data,
    };
    const timeoutMs =
      def.kind === 'model' ? EVALUATOR_TIMEOUT_MS.model : EVALUATOR_TIMEOUT_MS.other;
    const outcome = await bounded(
      (signal) => {
        const ctx: EvaluatorContext = {
          signal,
          models: {
            complete: (ref, request) =>
              this.#tracer
                .span(ref, { kind: 'llm' }, (s) =>
                  callModel(
                    s,
                    this.providers,
                    {
                      model: ref,
                      messages: request.messages,
                      temperature: request.temperature,
                      maxTokens: request.maxTokens,
                      stop: request.stop,
                      responseFormat: request.responseFormat,
                      jsonSchema: request.jsonSchema,
                      providerOptions: request.providerOptions,
                    },
                    signal,
                  ),
                )
                .then((out) => ({
                  text: out.text,
                  model: out.model,
                  finishReason: out.finish_reason as FinishReason,
                  rawFinishReason: out.finish_reason,
                  usage: {
                    inputTokens: out.usage.input_tokens,
                    outputTokens: out.usage.output_tokens,
                    totalTokens: out.usage.total_tokens,
                  },
                  ignoredParams: [],
                  requestId: null,
                })),
            embed: (ref, texts) =>
              this.#tracer.span(`embed ${ref}`, { kind: 'llm' }, (s) =>
                embedTexts(s, this.providers, ref, texts, signal),
              ),
          },
        };
        return Promise.resolve(def.evaluate(input, ctx)) as Promise<EvaluatorOutcome>;
      },
      timeoutMs,
      `Evaluator "${evaluator.name}"`,
      data.signal,
      'Model-based evaluators wait up to 3 minutes; check the judge model and provider.',
    );
    if (!outcome || typeof outcome.reason !== 'string') {
      throw new ScopeError(
        ErrorCodes.evaluatorFailed,
        `${evaluator.name} returned no result with a reason`,
        {
          hint: 'Evaluators must return { score, reason } (and optionally passed, metadata, skipped).',
        },
      );
    }
    const scoreBased = outcome.passed === undefined;
    let status: EvaluationStatus;
    if (outcome.skipped) status = 'skipped';
    else if (outcome.passed !== undefined) status = outcome.passed ? 'passed' : 'failed';
    else
      status =
        outcome.score !== null && outcome.score >= evaluator.threshold - 1e-9 ? 'passed' : 'failed';
    const score = outcome.score === null ? null : Math.min(1, Math.max(0, outcome.score));
    return {
      evaluator: evaluator.name,
      type: def.type,
      kind: def.kind,
      status,
      score,
      threshold:
        scoreBased && !outcome.skipped && def.kind !== 'deterministic' ? evaluator.threshold : null,
      reason: outcome.reason,
      metadata: (outcome.metadata ?? {}) as JsonObject,
      durationMs: round(performance.now() - started),
    };
  }

  /**
   * Re-scores a stored trace with the prepared evaluators (for `scope evaluate`). No workflow
   * steps run; model-based evaluators do call their models (untraced).
   */
  async evaluateStored(
    prepared: PreparedWorkflow,
    stored: {
      traceId: string;
      runId: string | null;
      input: JsonValue | null;
      output: JsonValue | null;
      expected: JsonValue | null;
      context: string | null;
      durationMs: number;
      usage: Usage;
      costUsd: number | null;
    },
    signal?: AbortSignal,
  ): Promise<EvaluationRecord[]> {
    const records: EvaluationRecord[] = [];
    const declared = Object.keys(prepared.definition.outputs ?? {});
    const outputs =
      declared.length === 1 && isJsonObject(stored.output)
        ? (stored.output[declared[0] as string] ?? null)
        : stored.output;
    const inputs = (isJsonObject(stored.input) ? stored.input : {}) as JsonObject;
    for (const evaluator of prepared.evaluators) {
      const started = performance.now();
      let result: Omit<EvaluationRecord, 'id' | 'traceId' | 'runId' | 'createdAt' | 'spanId'>;
      try {
        result = await this.#runEvaluator(evaluator, {
          inputs,
          expected: stored.expected,
          outputs,
          context: stored.context,
          trace: { durationMs: stored.durationMs, usage: stored.usage, costUsd: stored.costUsd },
          evalScope: {
            inputs,
            params: prepared.params,
            steps: {},
            case: {},
            variant: prepared.variant,
            // The stored trace output is the declared-outputs map, as `{{ outputs.* }}` expects.
            outputs: stored.output,
            expected: stored.expected,
            trace: {
              duration_ms: stored.durationMs,
              total_tokens: stored.usage.totalTokens,
              cost_usd: stored.costUsd,
            },
          },
          signal,
        });
      } catch (error) {
        result = {
          evaluator: evaluator.name,
          type: evaluator.definition.type,
          kind: evaluator.definition.kind,
          status: 'error',
          score: null,
          threshold: null,
          reason: `The evaluator failed: ${errorMessage(error)}`,
          metadata: {},
          durationMs: round(performance.now() - started),
        };
      }
      records.push({
        ...result,
        id: newId('ev'),
        traceId: stored.traceId,
        runId: stored.runId,
        spanId: null,
        createdAt: Date.now(),
      });
    }
    return records;
  }
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/** Converts an execution into the facts used for run summaries. */
export function toCaseResult(execution: CaseExecution): CaseResult {
  return {
    caseId: execution.caseId,
    traceId: execution.traceId,
    status: execution.status,
    durationMs: execution.durationMs,
    usage: execution.usage,
    costUsd: execution.costUsd,
    unpricedModels: execution.unpricedModels,
    evaluations: execution.evaluations.map((e) => ({
      evaluator: e.evaluator,
      type: e.type,
      kind: e.kind,
      status: e.status,
      score: e.score,
    })),
  };
}
