/**
 * The SCOPE domain model: traces, spans, evaluations and runs.
 *
 * The trace and span shapes are aligned with OpenTelemetry (see docs/decisions/0003). All
 * timestamps are epoch milliseconds.
 */
import type { ErrorInfo } from './errors.ts';
import type { JsonObject, JsonValue } from './json.ts';

export const SPAN_KINDS = [
  'workflow',
  'step',
  'llm',
  'retrieval',
  'tool',
  'function',
  'evaluation',
  'custom',
] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];

export type SpanStatus = 'ok' | 'error';

export type AttributeValue = string | number | boolean | string[] | number[] | boolean[];
export type Attributes = Record<string, AttributeValue>;

export interface SpanEvent {
  name: string;
  time: number;
  attributes?: Attributes;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Tokens read from a provider-side prompt cache, when reported. */
  cacheReadTokens?: number;
  /** Tokens written to a provider-side prompt cache, when reported. */
  cacheWriteTokens?: number;
  /** True when counts were estimated locally rather than reported by the provider. */
  estimated?: boolean;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export interface SpanRecord {
  traceId: string;
  id: string;
  parentId: string | null;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  statusMessage: string | null;
  startTime: number;
  endTime: number;
  durationMs: number;
  input: JsonValue | null;
  output: JsonValue | null;
  attributes: Attributes;
  events: SpanEvent[];
  error: ErrorInfo | null;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface TraceRecord {
  id: string;
  runId: string | null;
  caseId: string | null;
  name: string;
  status: SpanStatus;
  startTime: number;
  endTime: number;
  durationMs: number;
  input: JsonValue | null;
  output: JsonValue | null;
  metadata: JsonObject;
  error: ErrorInfo | null;
  usage: Usage;
  /** Estimated cost in USD, or null when any model call in the trace has no known price. */
  costUsd: number | null;
  spanCount: number;
  llmCallCount: number;
}

export type EvaluatorKind = 'deterministic' | 'heuristic' | 'model';
export const EVALUATOR_KINDS: readonly EvaluatorKind[] = ['deterministic', 'heuristic', 'model'];

export type EvaluationStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface EvaluationRecord {
  id: string;
  traceId: string;
  runId: string | null;
  spanId: string | null;
  /** Configured evaluator name, unique within a workflow (e.g. "grounded"). */
  evaluator: string;
  /** Evaluator type (e.g. "groundedness"). */
  type: string;
  kind: EvaluatorKind;
  status: EvaluationStatus;
  score: number | null;
  threshold: number | null;
  reason: string;
  metadata: JsonObject;
  durationMs: number;
  createdAt: number;
}

/** Everything produced by one trace, exported together. */
export interface TraceBundle {
  trace: TraceRecord;
  spans: SpanRecord[];
  evaluations: EvaluationRecord[];
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type GateStatus = 'passed' | 'failed' | 'warned' | 'none';
export type RunTrigger = 'cli' | 'ci' | 'api';

export interface GitInfo {
  commit: string | null;
  branch: string | null;
  dirty: boolean | null;
  /** Pull-request number, when running in CI for a pull request. */
  pullRequest: number | null;
  repository: string | null;
}

export interface DatasetInfo {
  name: string;
  source: string | null;
  caseCount: number;
  hash: string;
}

/** Outcome of one case in a run. */
export type CaseOutcome = 'passed' | 'failed' | 'errored';

/** The minimal per-case facts needed to summarize and compare runs. */
export interface CaseResult {
  caseId: string;
  traceId: string;
  status: SpanStatus;
  durationMs: number;
  usage: Usage;
  costUsd: number | null;
  /** Models whose price is unknown, for calls in this case. */
  unpricedModels: string[];
  evaluations: Array<Pick<EvaluationRecord, 'evaluator' | 'type' | 'kind' | 'status' | 'score'>>;
}

export function caseOutcome(result: Pick<CaseResult, 'status' | 'evaluations'>): CaseOutcome {
  if (result.status === 'error') return 'errored';
  if (result.evaluations.some((e) => e.status === 'error')) return 'errored';
  if (result.evaluations.some((e) => e.status === 'failed')) return 'failed';
  return 'passed';
}
