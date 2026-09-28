/**
 * Baseline files (docs/decisions/0006): committed snapshots used for regression gates.
 */
import { existsSync, readFileSync } from 'node:fs';
import { BASELINE_SCHEMA, type Baseline, ErrorCodes, ScopeError } from '@scope-ai/core';
import { z } from 'zod';

const nullableNumber = z.number().nullable();

const EvaluatorSummarySchema = z.object({
  name: z.string(),
  type: z.string(),
  kind: z.enum(['deterministic', 'heuristic', 'model']),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  errored: z.number(),
  skipped: z.number(),
  passRate: nullableNumber,
  meanScore: nullableNumber,
});

const SummarySchema = z.object({
  cases: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    errored: z.number(),
  }),
  passRate: nullableNumber,
  errorRate: nullableNumber,
  latency: z.object({
    p50Ms: nullableNumber,
    p95Ms: nullableNumber,
    meanMs: nullableNumber,
    maxMs: nullableNumber,
  }),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    total: z.number(),
    meanPerCase: nullableNumber,
    estimated: z.boolean(),
  }),
  cost: z.object({
    totalUsd: nullableNumber,
    meanPerCaseUsd: nullableNumber,
    incomplete: z.boolean(),
    unpricedModels: z.array(z.string()),
  }),
  evaluators: z.array(EvaluatorSummarySchema),
});

const CaseSnapshotSchema = z.object({
  outcome: z.enum(['passed', 'failed', 'errored']),
  durationMs: z.number(),
  traceId: z.string().nullable(),
  evaluators: z.record(
    z.string(),
    z.object({ status: z.enum(['passed', 'failed', 'error', 'skipped']), score: nullableNumber }),
  ),
});

const GitSchema = z
  .object({
    commit: z.string().nullable(),
    branch: z.string().nullable(),
    dirty: z.boolean().nullable(),
    pullRequest: z.number().nullable(),
    repository: z.string().nullable(),
  })
  .nullable();

export const BaselineSchema = z.object({
  schema: z.literal(BASELINE_SCHEMA),
  workflow: z.string(),
  variant: z.string().nullable(),
  createdAt: z.string(),
  source: z.object({ runId: z.string(), runNumber: z.number(), git: GitSchema }),
  dataset: z.object({ name: z.string(), caseCount: z.number(), hash: z.string() }).nullable(),
  summary: SummarySchema,
  cases: z.record(z.string(), CaseSnapshotSchema),
});

export function parseBaseline(text: string, file: string): Baseline {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ScopeError(
      ErrorCodes.baselineInvalid,
      `${file} is not valid JSON: ${(error as Error).message}`,
      {
        hint: 'Regenerate it with `scope baseline save`.',
      },
    );
  }
  const schema = (data as { schema?: unknown } | null)?.schema;
  if (schema !== BASELINE_SCHEMA) {
    throw new ScopeError(
      ErrorCodes.baselineInvalid,
      `${file} is not a SCOPE baseline (schema is ${JSON.stringify(schema ?? null)}, expected "${BASELINE_SCHEMA}")`,
      { hint: 'Baseline files are created by `scope baseline save`.' },
    );
  }
  const result = BaselineSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ScopeError(
      ErrorCodes.baselineInvalid,
      `${file} is malformed at ${issue?.path.join('.') || '(root)'}: ${issue?.message}`,
      {
        hint: 'Regenerate it with `scope baseline save`; baseline files should not be edited by hand.',
      },
    );
  }
  return result.data as Baseline;
}

export function readBaseline(path: string, display = path): Baseline {
  if (!existsSync(path)) {
    throw new ScopeError(ErrorCodes.baselineInvalid, `Baseline file not found: ${display}`, {
      hint: 'Create one from a run you trust with `scope baseline save <run>`.',
    });
  }
  return parseBaseline(readFileSync(path, 'utf8'), display);
}

/** Deterministic, diff-friendly JSON (two-space indent, trailing newline). */
export function serializeBaseline(baseline: Baseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

/** Conventional baseline file name for a workflow and variant. */
export function baselineFileName(workflow: string, variant: string | null): string {
  return variant ? `${workflow}.${variant}.json` : `${workflow}.json`;
}
