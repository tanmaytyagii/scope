/**
 * Query parameters of the list and aggregate endpoints. Values arrive as strings; these
 * schemas coerce and validate them.
 */
import { z } from 'zod';
import { PageQuery } from './common.ts';
import { EvaluationStatus, EvaluatorKind, GateStatus, RunStatus, SpanStatus } from './domain.ts';

const RunReference = z.string().min(1).max(64).describe('A run id or run number ("42" or "#42").');

export const RunsQuery = PageQuery.extend({
  workflow: z.string().max(256).optional().describe('Only runs of this workflow.'),
  variant: z.string().max(256).optional().describe('Only runs of this variant.'),
  status: RunStatus.optional(),
  gateStatus: GateStatus.optional(),
});

export const RunCasesQuery = PageQuery.extend({
  outcome: z.enum(['passed', 'failed', 'errored']).optional(),
  evaluator: z
    .string()
    .max(256)
    .optional()
    .describe('Only cases where this evaluator failed or errored.'),
  q: z.string().max(256).optional().describe('Search case ids, inputs and outputs.'),
});

export const ComparisonQuery = z.object({
  base: RunReference,
  head: RunReference,
  includeUnchanged: z
    .enum(['true', 'false'])
    .optional()
    .describe('Include unchanged cases in `cases` (default false).'),
});

export const TRACE_SORTS = ['newest', 'oldest', 'slowest', 'costliest'] as const;

export const TracesQuery = PageQuery.extend({
  run: RunReference.optional(),
  name: z.string().max(512).optional().describe('Exact trace (workflow) name.'),
  status: SpanStatus.optional(),
  eval: z
    .enum(['passed', 'failed', 'errored', 'none'])
    .optional()
    .describe('Evaluation outcome; "none" means no judged evaluations.'),
  model: z.string().max(256).optional().describe('"model" or "provider:model".'),
  q: z.string().max(256).optional().describe('Search names, ids, case ids, inputs and outputs.'),
  case: z.string().max(256).optional().describe('Exact case id.'),
  since: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
  sort: z.enum(TRACE_SORTS).optional().describe('Default "newest".'),
});

export const EvaluationsQuery = PageQuery.extend({
  evaluator: z.string().max(256).optional(),
  status: EvaluationStatus.optional(),
  kind: EvaluatorKind.optional(),
  run: RunReference.optional(),
});

export type RunsQuery = z.output<typeof RunsQuery>;
export type RunCasesQuery = z.output<typeof RunCasesQuery>;
export type ComparisonQuery = z.output<typeof ComparisonQuery>;
export type TracesQuery = z.output<typeof TracesQuery>;
export type TraceSort = (typeof TRACE_SORTS)[number];
export type EvaluationsQuery = z.output<typeof EvaluationsQuery>;
