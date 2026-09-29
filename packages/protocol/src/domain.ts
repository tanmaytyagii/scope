/**
 * Schemas for the domain values that appear inside API resources. Each mirrors a type from
 * `@scope-ai/core`; `domain.test.ts` checks at compile time that they stay in sync.
 */
import { SPAN_KINDS } from '@scope-ai/core';
import { z } from 'zod';
import { components } from './common.ts';

export const SpanKind = z.enum(SPAN_KINDS);
export const SpanStatus = z.enum(['ok', 'error']);
export const EvaluatorKind = z
  .enum(['deterministic', 'heuristic', 'model'])
  .describe(
    'How an evaluator judges: deterministic (a rule), heuristic (an approximation) or model (a model’s opinion).',
  );
export const EvaluationStatus = z.enum(['passed', 'failed', 'error', 'skipped']);
export const RunStatus = z.enum(['running', 'completed', 'failed', 'cancelled']);
export const GateStatus = z.enum(['passed', 'failed', 'warned', 'none']);
export const RunTrigger = z.enum(['cli', 'ci', 'api']);
export const CaseOutcome = z.enum(['passed', 'failed', 'errored']);
export const TraceEvalStatus = z
  .enum(['passed', 'failed', 'errored'])
  .nullable()
  .describe('Combined outcome of the trace’s evaluations; null when none were judged.');

export const AttributeValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number()),
  z.array(z.boolean()),
]);
export const Attributes = z.record(z.string(), AttributeValue);

export const Usage = z
  .strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    estimated: z
      .boolean()
      .optional()
      .describe('True when counts were estimated locally rather than reported by the provider.'),
  })
  .register(components, { id: 'Usage' });

export const ErrorInfo = z
  .strictObject({
    type: z.string(),
    message: z.string(),
    code: z.string().optional(),
    hint: z.string().optional(),
    stack: z.string().optional(),
  })
  .register(components, { id: 'ErrorInfo', description: 'An error recorded on a trace or span.' });

export const GitInfo = z
  .strictObject({
    commit: z.string().nullable(),
    branch: z.string().nullable(),
    dirty: z.boolean().nullable(),
    pullRequest: z.number().int().nullable(),
    repository: z.string().nullable(),
  })
  .register(components, { id: 'GitInfo' });

export const DatasetInfo = z
  .strictObject({
    name: z.string(),
    source: z.string().nullable(),
    caseCount: z.number().int(),
    hash: z.string(),
  })
  .register(components, { id: 'DatasetInfo' });

export const EvaluatorSummary = z
  .strictObject({
    name: z.string(),
    type: z.string(),
    kind: EvaluatorKind,
    total: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    errored: z.number().int(),
    skipped: z.number().int(),
    passRate: z.number().nullable().describe('passed / (passed + failed + errored).'),
    meanScore: z.number().nullable(),
  })
  .register(components, { id: 'EvaluatorSummary' });

export const RunSummary = z
  .strictObject({
    cases: z.strictObject({
      total: z.number().int(),
      passed: z.number().int(),
      failed: z.number().int(),
      errored: z.number().int(),
    }),
    passRate: z.number().nullable(),
    errorRate: z.number().nullable(),
    latency: z.strictObject({
      p50Ms: z.number().nullable(),
      p95Ms: z.number().nullable(),
      meanMs: z.number().nullable(),
      maxMs: z.number().nullable(),
    }),
    tokens: z.strictObject({
      input: z.number(),
      output: z.number(),
      total: z.number(),
      meanPerCase: z.number().nullable(),
      estimated: z.boolean(),
    }),
    cost: z.strictObject({
      totalUsd: z.number().nullable(),
      meanPerCaseUsd: z.number().nullable(),
      incomplete: z
        .boolean()
        .describe('True when some cases have an unknown cost, so the total is a lower bound.'),
      unpricedModels: z.array(z.string()),
    }),
    evaluators: z.array(EvaluatorSummary),
  })
  .register(components, { id: 'RunSummary' });

export const MetricUnit = z.enum(['ratio', 'score', 'ms', 'tokens', 'usd']);

export const GateResult = z
  .strictObject({
    metric: z.string(),
    label: z.string(),
    unit: MetricUnit,
    condition: z.enum([
      'min',
      'max',
      'max_decrease',
      'max_increase',
      'max_decrease_pct',
      'max_increase_pct',
    ]),
    expectation: z.string().describe('Human-readable condition, e.g. "≥ 90.0%".'),
    threshold: z.number(),
    severity: z.enum(['fail', 'warn']),
    status: z.enum(['passed', 'failed', 'skipped']),
    actual: z.number().nullable(),
    baseline: z.number().nullable(),
    message: z.string(),
  })
  .register(components, { id: 'GateResult' });

export const ChangeDirection = z.enum(['improved', 'regressed', 'unchanged', 'n/a']);

export const MetricDelta = z
  .strictObject({
    id: z.string().describe('Metric id, e.g. "pass_rate" or "evaluator.grounded.mean_score".'),
    label: z.string(),
    unit: MetricUnit,
    direction: z.enum(['higher', 'lower']).describe('Which direction is an improvement.'),
    base: z.number().nullable(),
    head: z.number().nullable(),
    delta: z.number().nullable(),
    relativePct: z.number().nullable(),
    change: ChangeDirection,
  })
  .register(components, { id: 'MetricDelta' });

export const MetricRow = z
  .strictObject({
    id: z.string(),
    label: z.string(),
    unit: MetricUnit,
    direction: z.enum(['higher', 'lower']).describe('Which direction is an improvement.'),
    values: z.array(z.number().nullable()).describe('One value per run, in request order.'),
    best: z
      .array(z.number().int())
      .describe(
        'Indexes of the runs with the best value; values within noise tolerance of it share it. Empty when there is nothing to choose between.',
      ),
  })
  .register(components, { id: 'MetricRow' });

const EvaluatorCell = z.strictObject({ status: EvaluationStatus, score: z.number().nullable() });

export const CaseSnapshot = z
  .strictObject({
    outcome: CaseOutcome,
    durationMs: z.number(),
    traceId: z.string().nullable(),
    evaluators: z.record(z.string(), EvaluatorCell),
  })
  .register(components, { id: 'CaseSnapshot' });

export const CaseChange = z
  .strictObject({
    caseId: z.string(),
    kind: z.enum(['regressed', 'fixed', 'changed', 'unchanged', 'added', 'removed']),
    base: CaseSnapshot.nullable(),
    head: CaseSnapshot.nullable(),
    evaluators: z.array(
      z.strictObject({
        evaluator: z.string(),
        base: EvaluatorCell.nullable(),
        head: EvaluatorCell.nullable(),
        change: ChangeDirection,
      }),
    ),
  })
  .register(components, { id: 'CaseChange' });

export type MetricRow = z.output<typeof MetricRow>;
export type SpanKind = z.output<typeof SpanKind>;
export type SpanStatus = z.output<typeof SpanStatus>;
export type EvaluatorKind = z.output<typeof EvaluatorKind>;
export type EvaluationStatus = z.output<typeof EvaluationStatus>;
export type RunStatus = z.output<typeof RunStatus>;
export type GateStatus = z.output<typeof GateStatus>;
export type RunTrigger = z.output<typeof RunTrigger>;
export type CaseOutcome = z.output<typeof CaseOutcome>;
export type TraceEvalStatus = z.output<typeof TraceEvalStatus>;
export type AttributeValue = z.output<typeof AttributeValue>;
export type Attributes = z.output<typeof Attributes>;
export type Usage = z.output<typeof Usage>;
export type ErrorInfo = z.output<typeof ErrorInfo>;
export type GitInfo = z.output<typeof GitInfo>;
export type DatasetInfo = z.output<typeof DatasetInfo>;
export type EvaluatorSummary = z.output<typeof EvaluatorSummary>;
export type RunSummary = z.output<typeof RunSummary>;
export type MetricUnit = z.output<typeof MetricUnit>;
export type GateResult = z.output<typeof GateResult>;
export type ChangeDirection = z.output<typeof ChangeDirection>;
export type MetricDelta = z.output<typeof MetricDelta>;
export type CaseSnapshot = z.output<typeof CaseSnapshot>;
export type CaseChange = z.output<typeof CaseChange>;
