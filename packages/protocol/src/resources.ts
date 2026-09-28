/**
 * API resources: the response bodies of `/api/v1`. Each is an explicit shape — database rows
 * are never serialized directly. Timestamps are ISO-8601 strings; durations and offsets are
 * milliseconds.
 */
import { z } from 'zod';
import { components, JsonObject, JsonValue, pageOf, Timestamp } from './common.ts';
import {
  Attributes,
  CaseChange,
  CaseOutcome,
  DatasetInfo,
  ErrorInfo,
  EvaluationStatus,
  EvaluatorKind,
  GateResult,
  GateStatus,
  GitInfo,
  MetricDelta,
  RunStatus,
  RunSummary,
  RunTrigger,
  SpanKind,
  SpanStatus,
  TraceEvalStatus,
  Usage,
} from './domain.ts';

// ─── server & project ────────────────────────────────────────────────────────────────────────

export const AuthMode = z
  .enum(['none', 'api-key'])
  .describe('"none" for a local `scope ui`; "api-key" for a shared server.');

export const ServerInfo = z
  .strictObject({
    name: z.literal('scope'),
    version: z.string(),
    protocol: z.number().int().describe('Ingestion protocol version (the scope-protocol header).'),
    auth: AuthMode,
  })
  .register(components, {
    id: 'ServerInfo',
    description: 'Public server information. Does not require authentication.',
  });

export const ModelPriceEntry = z
  .strictObject({
    model: z.string().describe('provider:model'),
    input: z.number().describe('USD per 1M input tokens.'),
    output: z.number().describe('USD per 1M output tokens.'),
    cacheRead: z.number().nullable(),
    cacheWrite: z.number().nullable(),
    asOf: z.string().describe('When the price was recorded.'),
    source: z.string().describe('Where the price came from.'),
    origin: z.enum(['builtin', 'project']),
  })
  .register(components, { id: 'ModelPrice' });

export const ProjectInfo = z
  .strictObject({
    project: z.strictObject({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      createdAt: Timestamp,
    }),
    server: z.strictObject({
      version: z.string(),
      auth: AuthMode,
      storage: z.strictObject({
        dialect: z.enum(['sqlite', 'postgres']),
        location: z.string().describe('Database location with credentials removed.'),
      }),
      migrations: z.strictObject({ applied: z.array(z.string()), pending: z.array(z.string()) }),
    }),
    privacy: z.strictObject({
      captureContent: z.boolean(),
      maxPayloadBytes: z.number().int(),
      redactionRules: z.array(z.string()),
      sensitiveKeys: z.array(z.string()),
    }),
    pricing: z.array(ModelPriceEntry),
    stats: z.strictObject({
      runs: z.number().int(),
      traces: z.number().int(),
      spans: z.number().int(),
      evaluations: z.number().int(),
      oldestTrace: Timestamp.nullable(),
    }),
  })
  .register(components, { id: 'ProjectInfo' });

export const ApiKey = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    prefix: z.string().describe('The first characters of the key, for recognition.'),
    scopes: z.array(z.enum(['ingest', 'read'])),
    createdAt: Timestamp,
    lastUsedAt: Timestamp.nullable(),
    revokedAt: Timestamp.nullable(),
  })
  .register(components, {
    id: 'ApiKey',
    description: 'API key metadata. Secrets are never returned.',
  });

export const ApiKeyList = z
  .strictObject({ items: z.array(ApiKey) })
  .register(components, { id: 'ApiKeyList' });

// ─── runs ────────────────────────────────────────────────────────────────────────────────────

export const RunRef = z.strictObject({
  id: z.string(),
  number: z.number().int(),
});

export const Run = z
  .strictObject({
    id: z.string(),
    number: z.number().int().describe('Per-project sequential number, shown as #42.'),
    workflow: z.string(),
    workflowVersionId: z.string(),
    variant: z.string().nullable(),
    status: RunStatus,
    gateStatus: GateStatus,
    trigger: RunTrigger,
    params: JsonObject,
    dataset: DatasetInfo.nullable(),
    git: GitInfo.nullable(),
    baseline: z
      .strictObject({
        file: z.string(),
        runNumber: z.number().int(),
        commit: z.string().nullable(),
        createdAt: z.string(),
      })
      .nullable()
      .describe('The baseline file regression gates compared against, if any.'),
    caseCount: z.number().int(),
    passRate: z.number().nullable(),
    summary: RunSummary.nullable(),
    gates: z.array(GateResult),
    error: ErrorInfo.nullable(),
    startedAt: Timestamp,
    endedAt: Timestamp.nullable(),
    durationMs: z.number().nullable(),
  })
  .register(components, { id: 'Run' });

export const RunPage = pageOf(Run, 'RunPage');

export const CaseEvaluation = z.strictObject({
  evaluator: z.string(),
  type: z.string(),
  kind: EvaluatorKind,
  status: EvaluationStatus,
  score: z.number().nullable(),
  reason: z.string(),
});

export const RunCase = z
  .strictObject({
    caseId: z.string(),
    traceId: z.string(),
    status: SpanStatus,
    outcome: CaseOutcome,
    durationMs: z.number(),
    totalTokens: z.number(),
    costUsd: z.number().nullable(),
    inputPreview: z.string(),
    outputPreview: z.string(),
    error: ErrorInfo.nullable(),
    evaluations: z.array(CaseEvaluation),
  })
  .register(components, { id: 'RunCase' });

export const RunCasePage = pageOf(RunCase, 'RunCasePage');

export const ComparisonSide = z.strictObject({
  run: RunRef.extend({ workflow: z.string(), variant: z.string().nullable() }),
  summary: RunSummary,
});

export const Comparison = z
  .strictObject({
    base: ComparisonSide,
    head: ComparisonSide,
    metrics: z.array(MetricDelta).describe('Every metric present in either run.'),
    headline: z
      .array(z.string())
      .describe('Ids of the metrics worth showing first, in display order.'),
    counts: z.strictObject({
      regressed: z.number().int(),
      fixed: z.number().int(),
      changed: z.number().int(),
      unchanged: z.number().int(),
      added: z.number().int(),
      removed: z.number().int(),
    }),
    cases: z
      .array(CaseChange)
      .describe('Changed cases, worst first. Unchanged cases only with includeUnchanged=true.'),
  })
  .register(components, { id: 'Comparison' });

// ─── traces ──────────────────────────────────────────────────────────────────────────────────

const TraceUsage = z.strictObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  estimated: z.boolean(),
});

export const TraceSummary = z
  .strictObject({
    id: z.string().describe('32 lowercase hex characters (W3C trace id).'),
    name: z.string(),
    status: SpanStatus,
    caseId: z.string().nullable(),
    run: RunRef.nullable(),
    startTime: Timestamp,
    durationMs: z.number(),
    inputPreview: z.string(),
    outputPreview: z.string(),
    usage: TraceUsage,
    costUsd: z.number().nullable().describe('Estimated; null when a model’s price is unknown.'),
    spanCount: z.number().int(),
    llmCallCount: z.number().int(),
    evalStatus: TraceEvalStatus,
    evalCount: z.number().int(),
    error: ErrorInfo.nullable(),
  })
  .register(components, { id: 'TraceSummary' });

export const TracePage = pageOf(TraceSummary, 'TracePage');

export const SpanEvent = z.strictObject({
  name: z.string(),
  time: Timestamp,
  offsetMs: z.number().describe('Milliseconds since the start of the trace.'),
  attributes: Attributes,
});

export const Span = z
  .strictObject({
    id: z.string().describe('16 lowercase hex characters.'),
    parentId: z.string().nullable(),
    name: z.string(),
    kind: SpanKind,
    status: SpanStatus,
    statusMessage: z.string().nullable(),
    startTime: Timestamp,
    offsetMs: z.number().describe('Milliseconds since the start of the trace (sub-ms precision).'),
    durationMs: z.number(),
    input: JsonValue.nullable(),
    output: JsonValue.nullable(),
    attributes: Attributes.describe('OpenTelemetry-style attributes, e.g. gen_ai.request.model.'),
    events: z.array(SpanEvent),
    error: ErrorInfo.nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    costUsd: z.number().nullable(),
  })
  .register(components, { id: 'Span' });

export const Evaluation = z
  .strictObject({
    id: z.string(),
    spanId: z.string().nullable(),
    evaluator: z.string().describe('Configured name, e.g. "grounded".'),
    type: z.string().describe('Evaluator type, e.g. "groundedness".'),
    kind: EvaluatorKind,
    status: EvaluationStatus,
    score: z.number().nullable().describe('Normalized 0–1; null when not applicable.'),
    threshold: z.number().nullable(),
    reason: z.string(),
    metadata: JsonObject.describe('Evidence: matched sentences, unsupported claims, judge output.'),
    durationMs: z.number(),
    createdAt: Timestamp,
  })
  .register(components, { id: 'Evaluation' });

export const TraceDetail = z
  .strictObject({
    trace: z.strictObject({
      id: z.string(),
      name: z.string(),
      status: SpanStatus,
      caseId: z.string().nullable(),
      startTime: Timestamp,
      endTime: Timestamp,
      durationMs: z.number(),
      input: JsonValue.nullable(),
      output: JsonValue.nullable(),
      metadata: JsonObject,
      error: ErrorInfo.nullable(),
      usage: Usage,
      costUsd: z.number().nullable(),
      spanCount: z.number().int(),
      llmCallCount: z.number().int(),
      evalStatus: TraceEvalStatus,
    }),
    run: RunRef.extend({ workflow: z.string(), variant: z.string().nullable() }).nullable(),
    spans: z.array(Span).describe('Ordered by start time.'),
    evaluations: z.array(Evaluation).describe('In the order the evaluators ran.'),
  })
  .register(components, { id: 'TraceDetail' });

// ─── evaluations ─────────────────────────────────────────────────────────────────────────────

export const EvaluatorHealth = z
  .strictObject({
    evaluator: z.string(),
    type: z.string(),
    kind: EvaluatorKind,
    total: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    errored: z.number().int(),
    skipped: z.number().int(),
    passRate: z.number().nullable(),
    meanScore: z.number().nullable(),
    lastSeenAt: Timestamp,
    trend: z
      .array(
        z.strictObject({
          runNumber: z.number().int(),
          passRate: z.number().nullable(),
          meanScore: z.number().nullable(),
        }),
      )
      .describe('Per-run results in recent completed runs, oldest first.'),
  })
  .register(components, { id: 'EvaluatorHealth' });

export const EvaluatorHealthList = z
  .strictObject({
    window: z.strictObject({ since: Timestamp, until: Timestamp }),
    items: z.array(EvaluatorHealth),
  })
  .register(components, { id: 'EvaluatorHealthList' });

export const EvaluationListItem = z
  .strictObject({
    id: z.string(),
    traceId: z.string(),
    traceName: z.string(),
    caseId: z.string().nullable(),
    run: RunRef.nullable(),
    evaluator: z.string(),
    type: z.string(),
    kind: EvaluatorKind,
    status: EvaluationStatus,
    score: z.number().nullable(),
    threshold: z.number().nullable(),
    reason: z.string(),
    outputPreview: z.string(),
    createdAt: Timestamp,
  })
  .register(components, { id: 'EvaluationListItem' });

export const EvaluationPage = pageOf(EvaluationListItem, 'EvaluationPage');

// ─── overview & models ───────────────────────────────────────────────────────────────────────

export const Overview = z
  .strictObject({
    window: z.strictObject({ since: Timestamp, until: Timestamp, bucketMs: z.number().int() }),
    traces: z.strictObject({
      total: z.number().int(),
      errors: z.number().int(),
      errorRate: z.number().nullable(),
      p50Ms: z.number().nullable(),
      p95Ms: z.number().nullable(),
      totalTokens: z.number(),
      costUsd: z.number().describe('Estimated cost of traces with a known price.'),
      unpricedTraces: z.number().int().describe('Traces whose cost is unknown.'),
      sampled: z
        .boolean()
        .describe('True when percentiles come from the most recent 50,000 traces.'),
    }),
    evaluations: z.strictObject({
      total: z.number().int(),
      passed: z.number().int(),
      failed: z.number().int(),
      errored: z.number().int(),
      skipped: z.number().int(),
      passRate: z.number().nullable(),
    }),
    runs: z.strictObject({
      total: z.number().int(),
      passed: z.number().int(),
      failed: z.number().int(),
      warned: z.number().int(),
      none: z.number().int(),
    }),
    series: z.array(
      z.strictObject({
        start: Timestamp,
        ok: z.number().int(),
        error: z.number().int(),
        p50Ms: z.number().nullable(),
        p95Ms: z.number().nullable(),
        costUsd: z.number(),
      }),
    ),
    runTrend: z
      .array(
        RunRef.extend({
          workflow: z.string(),
          variant: z.string().nullable(),
          startedAt: Timestamp,
          passRate: z.number().nullable(),
          gateStatus: GateStatus,
        }),
      )
      .describe('The last 30 completed runs, oldest first.'),
    recentFailures: z.array(TraceSummary),
    failingEvaluators: z.array(
      z.strictObject({
        evaluator: z.string(),
        kind: EvaluatorKind,
        total: z.number().int(),
        failed: z.number().int(),
        passRate: z.number().nullable(),
      }),
    ),
  })
  .register(components, { id: 'Overview' });

export const ModelUsage = z
  .strictObject({
    provider: z.string().nullable(),
    model: z.string(),
    usage: z
      .enum(['workflow', 'evaluation'])
      .describe('"evaluation" for judge and embedding calls made by evaluators.'),
    calls: z.number().int(),
    errors: z.number().int(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number(),
    unpricedCalls: z.number().int(),
    p50Ms: z.number().nullable(),
    p95Ms: z.number().nullable(),
    lastUsedAt: Timestamp,
    price: ModelPriceEntry.nullable().describe('The price used for cost estimates, if known.'),
    local: z.boolean().describe('True for SCOPE’s deterministic offline stand-ins (local:*).'),
  })
  .register(components, { id: 'ModelUsage' });

export const ModelUsageList = z
  .strictObject({
    window: z.strictObject({ since: Timestamp, until: Timestamp }),
    items: z.array(ModelUsage),
  })
  .register(components, { id: 'ModelUsageList' });

// ─── workflows ───────────────────────────────────────────────────────────────────────────────

export const WorkflowSummary = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    versionCount: z.number().int(),
    runCount: z.number().int(),
    updatedAt: Timestamp,
    lastRun: RunRef.extend({
      variant: z.string().nullable(),
      status: RunStatus,
      gateStatus: GateStatus,
      passRate: z.number().nullable(),
      startedAt: Timestamp,
    }).nullable(),
  })
  .register(components, { id: 'WorkflowSummary' });

export const WorkflowList = z
  .strictObject({ items: z.array(WorkflowSummary) })
  .register(components, { id: 'WorkflowList' });

export const WorkflowDetail = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    updatedAt: Timestamp,
    versions: z.array(
      z.strictObject({
        id: z.string(),
        hash: z.string(),
        path: z.string().nullable(),
        createdAt: Timestamp,
      }),
    ),
    latest: z
      .strictObject({
        id: z.string(),
        hash: z.string(),
        path: z.string().nullable(),
        source: z
          .string()
          .describe('The workflow file as it was run (env references, not values).'),
        definition: JsonValue,
      })
      .nullable(),
    variants: z.array(z.string()).describe('Variant names that have been run.'),
  })
  .register(components, { id: 'WorkflowDetail' });

// ─── inferred types ──────────────────────────────────────────────────────────────────────────

export type AuthMode = z.output<typeof AuthMode>;
export type ServerInfo = z.output<typeof ServerInfo>;
export type ModelPriceEntry = z.output<typeof ModelPriceEntry>;
export type ProjectInfo = z.output<typeof ProjectInfo>;
export type ApiKey = z.output<typeof ApiKey>;
export type ApiKeyList = z.output<typeof ApiKeyList>;
export type RunRef = z.output<typeof RunRef>;
export type Run = z.output<typeof Run>;
export type RunPage = z.output<typeof RunPage>;
export type CaseEvaluation = z.output<typeof CaseEvaluation>;
export type RunCase = z.output<typeof RunCase>;
export type RunCasePage = z.output<typeof RunCasePage>;
export type Comparison = z.output<typeof Comparison>;
export type TraceSummary = z.output<typeof TraceSummary>;
export type TracePage = z.output<typeof TracePage>;
export type SpanEvent = z.output<typeof SpanEvent>;
export type Span = z.output<typeof Span>;
export type Evaluation = z.output<typeof Evaluation>;
export type TraceDetail = z.output<typeof TraceDetail>;
export type EvaluatorHealth = z.output<typeof EvaluatorHealth>;
export type EvaluatorHealthList = z.output<typeof EvaluatorHealthList>;
export type EvaluationListItem = z.output<typeof EvaluationListItem>;
export type EvaluationPage = z.output<typeof EvaluationPage>;
export type Overview = z.output<typeof Overview>;
export type ModelUsage = z.output<typeof ModelUsage>;
export type ModelUsageList = z.output<typeof ModelUsageList>;
export type WorkflowSummary = z.output<typeof WorkflowSummary>;
export type WorkflowList = z.output<typeof WorkflowList>;
export type WorkflowDetail = z.output<typeof WorkflowDetail>;
