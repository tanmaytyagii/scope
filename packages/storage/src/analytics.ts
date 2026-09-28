/**
 * Aggregations for the dashboard: overview, model usage, evaluator health.
 *
 * Counts and sums run in SQL. Percentiles are computed in JavaScript over a bounded sample of
 * the most recent rows (portable across SQLite and PostgreSQL); responses say when a sample
 * was used.
 */
import type { EvaluationStatus, EvaluatorKind, GateStatus, RunSummary } from '@scope-ai/core';
import { type Kysely, sql } from 'kysely';
import type { Page, TraceSummary } from './records.ts';
import type { Database } from './schema.ts';
import { mapTraceSummary, selectTraceSummaries } from './traces.ts';
import { decodeCursor, encodeCursor, pageSize, percentileOf, readJsonOrNull } from './util.ts';

export const PERCENTILE_SAMPLE = 50_000;

export interface TimeWindow {
  since: number;
  until: number;
}

export interface OverviewOptions extends TimeWindow {
  /** Width of each time-series bucket in ms. */
  bucketMs: number;
}

export interface Overview {
  window: OverviewOptions;
  traces: {
    total: number;
    errors: number;
    errorRate: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    totalTokens: number;
    costUsd: number;
    unpricedTraces: number;
    /** True when percentiles were computed over the most recent PERCENTILE_SAMPLE traces. */
    sampled: boolean;
  };
  evaluations: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
    skipped: number;
    passRate: number | null;
  };
  runs: { total: number; passed: number; failed: number; warned: number; none: number };
  series: Array<{
    start: number;
    ok: number;
    error: number;
    p50Ms: number | null;
    p95Ms: number | null;
    costUsd: number;
  }>;
  runTrend: Array<{
    id: string;
    number: number;
    workflowName: string;
    variant: string | null;
    startedAt: number;
    passRate: number | null;
    gateStatus: GateStatus;
  }>;
  recentFailures: TraceSummary[];
  failingEvaluators: Array<{
    evaluator: string;
    kind: EvaluatorKind;
    total: number;
    failed: number;
    passRate: number | null;
  }>;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export async function overview(
  db: Kysely<Database>,
  projectId: string,
  options: OverviewOptions,
): Promise<Overview> {
  const { since, until, bucketMs } = options;
  const [totals, sample, evalRows, runRows, trendRows, failureRows, evaluatorRows] =
    await Promise.all([
      db
        .selectFrom('traces')
        .select([
          (eb) => eb.fn.countAll<number>().as('total'),
          sql<number>`sum(case when status = 'error' then 1 else 0 end)`.as('errors'),
          sql<number>`coalesce(sum(total_tokens), 0)`.as('tokens'),
          sql<number>`coalesce(sum(cost_usd), 0)`.as('cost'),
          sql<number>`sum(case when cost_usd is null and llm_call_count > 0 then 1 else 0 end)`.as(
            'unpriced',
          ),
        ])
        .where('project_id', '=', projectId)
        .where('start_time', '>=', since)
        .where('start_time', '<', until)
        .executeTakeFirst(),
      db
        .selectFrom('traces')
        .select(['start_time', 'duration_ms', 'status', 'cost_usd'])
        .where('project_id', '=', projectId)
        .where('start_time', '>=', since)
        .where('start_time', '<', until)
        .orderBy('start_time', 'desc')
        .limit(PERCENTILE_SAMPLE)
        .execute(),
      db
        .selectFrom('evaluations')
        .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
        .where('project_id', '=', projectId)
        .where('created_at', '>=', since)
        .where('created_at', '<', until)
        .groupBy('status')
        .execute(),
      db
        .selectFrom('runs')
        .select(['gate_status', (eb) => eb.fn.countAll<number>().as('n')])
        .where('project_id', '=', projectId)
        .where('started_at', '>=', since)
        .where('started_at', '<', until)
        .groupBy('gate_status')
        .execute(),
      db
        .selectFrom('runs')
        .select([
          'id',
          'number',
          'workflow_name',
          'variant',
          'started_at',
          'pass_rate',
          'gate_status',
        ])
        .where('project_id', '=', projectId)
        .where('status', '=', 'completed')
        .orderBy('number', 'desc')
        .limit(30)
        .execute(),
      selectTraceSummaries(db, projectId)
        .where((eb) =>
          eb.or([
            eb('traces.status', '=', 'error'),
            eb('traces.eval_status', 'in', ['failed', 'errored']),
          ]),
        )
        .where('traces.start_time', '>=', since)
        .where('traces.start_time', '<', until)
        .orderBy('traces.start_time', 'desc')
        .limit(8)
        .execute(),
      db
        .selectFrom('evaluations')
        .select([
          'evaluator',
          'kind',
          (eb) => eb.fn.countAll<number>().as('total'),
          sql<number>`sum(case when status in ('failed', 'error') then 1 else 0 end)`.as('failed'),
          sql<number>`sum(case when status = 'passed' then 1 else 0 end)`.as('passed'),
        ])
        .where('project_id', '=', projectId)
        .where('created_at', '>=', since)
        .where('created_at', '<', until)
        .groupBy(['evaluator', 'kind'])
        .execute(),
    ]);

  const durations = sample.map((r) => r.duration_ms).sort((a, b) => a - b);
  const buckets = new Map<
    number,
    { ok: number; error: number; durations: number[]; cost: number }
  >();
  const firstBucket = Math.floor(since / bucketMs) * bucketMs;
  for (let t = firstBucket; t < until; t += bucketMs)
    buckets.set(t, { ok: 0, error: 0, durations: [], cost: 0 });
  for (const row of sample) {
    const key = Math.floor(row.start_time / bucketMs) * bucketMs;
    const bucket = buckets.get(key);
    if (!bucket) continue;
    if (row.status === 'error') bucket.error++;
    else bucket.ok++;
    bucket.durations.push(row.duration_ms);
    bucket.cost += row.cost_usd ?? 0;
  }

  const evalCounts: Record<string, number> = {};
  for (const r of evalRows) evalCounts[r.status] = num(r.n);
  const passed = evalCounts.passed ?? 0;
  const failed = evalCounts.failed ?? 0;
  const errored = evalCounts.error ?? 0;
  const judged = passed + failed + errored;
  const runCounts: Record<string, number> = {};
  for (const r of runRows) runCounts[r.gate_status] = num(r.n);
  const total = num(totals?.total);
  const errors = num(totals?.errors);

  return {
    window: options,
    traces: {
      total,
      errors,
      errorRate: total === 0 ? null : errors / total,
      p50Ms: percentileOf(durations, 50),
      p95Ms: percentileOf(durations, 95),
      totalTokens: num(totals?.tokens),
      costUsd: num(totals?.cost),
      unpricedTraces: num(totals?.unpriced),
      sampled: total > sample.length,
    },
    evaluations: {
      total: judged + (evalCounts.skipped ?? 0),
      passed,
      failed,
      errored,
      skipped: evalCounts.skipped ?? 0,
      passRate: judged === 0 ? null : passed / judged,
    },
    runs: {
      total: Object.values(runCounts).reduce((a, b) => a + b, 0),
      passed: runCounts.passed ?? 0,
      failed: runCounts.failed ?? 0,
      warned: runCounts.warned ?? 0,
      none: runCounts.none ?? 0,
    },
    series: [...buckets.entries()].map(([start, b]) => {
      const sorted = b.durations.sort((x, y) => x - y);
      return {
        start,
        ok: b.ok,
        error: b.error,
        p50Ms: percentileOf(sorted, 50),
        p95Ms: percentileOf(sorted, 95),
        costUsd: b.cost,
      };
    }),
    runTrend: trendRows.reverse().map((r) => ({
      id: r.id,
      number: r.number,
      workflowName: r.workflow_name,
      variant: r.variant,
      startedAt: r.started_at,
      passRate: r.pass_rate,
      gateStatus: r.gate_status as GateStatus,
    })),
    recentFailures: failureRows.map((r) =>
      mapTraceSummary(r as Parameters<typeof mapTraceSummary>[0]),
    ),
    failingEvaluators: evaluatorRows
      .map((r) => {
        const t = num(r.total);
        const f = num(r.failed);
        const p = num(r.passed);
        return {
          evaluator: r.evaluator,
          kind: r.kind as EvaluatorKind,
          total: t,
          failed: f,
          passRate: p + f === 0 ? null : p / (p + f),
        };
      })
      .filter((r) => r.failed > 0)
      .sort((a, b) => b.failed - a.failed)
      .slice(0, 6),
  };
}

// ─── models ──────────────────────────────────────────────────────────────────────────────────

export interface ModelUsage {
  provider: string | null;
  model: string;
  /** "workflow" for application calls, "evaluation" for judge/embedding calls made by evaluators. */
  usage: 'workflow' | 'evaluation';
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unpricedCalls: number;
  p50Ms: number | null;
  p95Ms: number | null;
  lastUsedAt: number;
}

export async function modelUsage(
  db: Kysely<Database>,
  projectId: string,
  window: TimeWindow,
): Promise<ModelUsage[]> {
  const [groups, sample] = await Promise.all([
    db
      .selectFrom('spans')
      .select([
        'provider',
        'model',
        'in_evaluation',
        (eb) => eb.fn.countAll<number>().as('calls'),
        sql<number>`sum(case when status = 'error' then 1 else 0 end)`.as('errors'),
        sql<number>`coalesce(sum(input_tokens), 0)`.as('input_tokens'),
        sql<number>`coalesce(sum(output_tokens), 0)`.as('output_tokens'),
        sql<number>`coalesce(sum(cost_usd), 0)`.as('cost'),
        sql<number>`sum(case when cost_usd is null then 1 else 0 end)`.as('unpriced'),
        (eb) => eb.fn.max<number>('start_time').as('last'),
      ])
      .where('project_id', '=', projectId)
      .where('kind', '=', 'llm')
      .where('model', 'is not', null)
      .where('start_time', '>=', window.since)
      .where('start_time', '<', window.until)
      .groupBy(['provider', 'model', 'in_evaluation'])
      .execute(),
    db
      .selectFrom('spans')
      .select(['provider', 'model', 'in_evaluation', 'duration_ms'])
      .where('project_id', '=', projectId)
      .where('kind', '=', 'llm')
      .where('model', 'is not', null)
      .where('start_time', '>=', window.since)
      .where('start_time', '<', window.until)
      .orderBy('start_time', 'desc')
      .limit(PERCENTILE_SAMPLE)
      .execute(),
  ]);
  const durations = new Map<string, number[]>();
  for (const s of sample) {
    const key = `${s.provider}|${s.model}|${s.in_evaluation}`;
    const list = durations.get(key) ?? [];
    list.push(s.duration_ms);
    durations.set(key, list);
  }
  return groups
    .map((g) => {
      const sorted = (durations.get(`${g.provider}|${g.model}|${g.in_evaluation}`) ?? []).sort(
        (a, b) => a - b,
      );
      return {
        provider: g.provider,
        model: g.model as string,
        usage: g.in_evaluation ? ('evaluation' as const) : ('workflow' as const),
        calls: num(g.calls),
        errors: num(g.errors),
        inputTokens: num(g.input_tokens),
        outputTokens: num(g.output_tokens),
        costUsd: num(g.cost),
        unpricedCalls: num(g.unpriced),
        p50Ms: percentileOf(sorted, 50),
        p95Ms: percentileOf(sorted, 95),
        lastUsedAt: num(g.last),
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

// ─── evaluators ──────────────────────────────────────────────────────────────────────────────

export interface EvaluatorHealth {
  evaluator: string;
  type: string;
  kind: EvaluatorKind;
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  passRate: number | null;
  meanScore: number | null;
  lastSeenAt: number;
  /** Pass rate in recent completed runs, oldest first. */
  trend: Array<{ runNumber: number; passRate: number | null; meanScore: number | null }>;
}

export async function evaluatorHealth(
  db: Kysely<Database>,
  projectId: string,
  window: TimeWindow,
): Promise<EvaluatorHealth[]> {
  const [rows, runs] = await Promise.all([
    db
      .selectFrom('evaluations')
      .select([
        'evaluator',
        'type',
        'kind',
        'status',
        (eb) => eb.fn.countAll<number>().as('n'),
        sql<number | null>`avg(case when status in ('passed', 'failed') then score end)`.as('mean'),
        (eb) => eb.fn.max<number>('created_at').as('last'),
      ])
      .where('project_id', '=', projectId)
      .where('created_at', '>=', window.since)
      .where('created_at', '<', window.until)
      .groupBy(['evaluator', 'type', 'kind', 'status'])
      .execute(),
    db
      .selectFrom('runs')
      .select(['number', 'summary'])
      .where('project_id', '=', projectId)
      .where('status', '=', 'completed')
      .orderBy('number', 'desc')
      .limit(20)
      .execute(),
  ]);
  const map = new Map<string, EvaluatorHealth & { scoreSum: number; scoreN: number }>();
  for (const r of rows) {
    const key = r.evaluator;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        evaluator: r.evaluator,
        type: r.type,
        kind: r.kind as EvaluatorKind,
        total: 0,
        passed: 0,
        failed: 0,
        errored: 0,
        skipped: 0,
        passRate: null,
        meanScore: null,
        lastSeenAt: 0,
        trend: [],
        scoreSum: 0,
        scoreN: 0,
      };
      map.set(key, entry);
    }
    const n = num(r.n);
    entry.total += n;
    const status = r.status as EvaluationStatus;
    if (status === 'passed') entry.passed += n;
    else if (status === 'failed') entry.failed += n;
    else if (status === 'error') entry.errored += n;
    else entry.skipped += n;
    if (r.mean !== null && r.mean !== undefined) {
      entry.scoreSum += Number(r.mean) * n;
      entry.scoreN += n;
    }
    entry.lastSeenAt = Math.max(entry.lastSeenAt, num(r.last));
  }
  const summaries = runs
    .reverse()
    .map((r) => ({ number: r.number, summary: readJsonOrNull<RunSummary>(r.summary) }));
  return [...map.values()]
    .map(({ scoreSum, scoreN, ...e }) => {
      const judged = e.passed + e.failed + e.errored;
      return {
        ...e,
        passRate: judged === 0 ? null : e.passed / judged,
        meanScore: scoreN === 0 ? null : scoreSum / scoreN,
        trend: summaries
          .map((s) => {
            const found = s.summary?.evaluators.find((x) => x.name === e.evaluator);
            return found
              ? { runNumber: s.number, passRate: found.passRate, meanScore: found.meanScore }
              : null;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null),
      };
    })
    .sort((a, b) => a.evaluator.localeCompare(b.evaluator));
}

export interface EvaluationListItem {
  id: string;
  traceId: string;
  traceName: string;
  caseId: string | null;
  runId: string | null;
  runNumber: number | null;
  evaluator: string;
  type: string;
  kind: EvaluatorKind;
  status: EvaluationStatus;
  score: number | null;
  threshold: number | null;
  reason: string;
  outputPreview: string;
  createdAt: number;
}

export async function listEvaluations(
  db: Kysely<Database>,
  projectId: string,
  filters: {
    evaluator?: string;
    status?: EvaluationStatus;
    kind?: EvaluatorKind;
    runId?: string;
    since?: number;
    limit?: number;
    cursor?: string | null;
  } = {},
): Promise<Page<EvaluationListItem>> {
  const limit = pageSize(filters.limit);
  const cursor = decodeCursor(filters.cursor);
  let query = db
    .selectFrom('evaluations')
    .innerJoin('traces', 'traces.id', 'evaluations.trace_id')
    .leftJoin('runs', 'runs.id', 'evaluations.run_id')
    .select([
      'evaluations.id',
      'evaluations.trace_id',
      'traces.name as trace_name',
      'traces.case_id',
      'evaluations.run_id',
      'runs.number as run_number',
      'evaluations.evaluator',
      'evaluations.type',
      'evaluations.kind',
      'evaluations.status',
      'evaluations.score',
      'evaluations.threshold',
      'evaluations.reason',
      'traces.output_preview',
      'evaluations.created_at',
    ])
    .where('evaluations.project_id', '=', projectId);
  if (filters.evaluator) query = query.where('evaluations.evaluator', '=', filters.evaluator);
  if (filters.status) query = query.where('evaluations.status', '=', filters.status);
  if (filters.kind) query = query.where('evaluations.kind', '=', filters.kind);
  if (filters.runId) query = query.where('evaluations.run_id', '=', filters.runId);
  if (filters.since !== undefined)
    query = query.where('evaluations.created_at', '>=', filters.since);
  if (cursor) {
    const v = Number(cursor.v);
    query = query.where((eb) =>
      eb.or([
        eb('evaluations.created_at', '<', v),
        eb.and([eb('evaluations.created_at', '=', v), eb('evaluations.id', '<', cursor.id)]),
      ]),
    );
  }
  const rows = await query
    .orderBy('evaluations.created_at', 'desc')
    .orderBy('evaluations.id', 'desc')
    .limit(limit + 1)
    .execute();
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    traceId: r.trace_id,
    traceName: r.trace_name,
    caseId: r.case_id,
    runId: r.run_id,
    runNumber: r.run_number,
    evaluator: r.evaluator,
    type: r.type,
    kind: r.kind as EvaluatorKind,
    status: r.status as EvaluationStatus,
    score: r.score,
    threshold: r.threshold,
    reason: r.reason,
    outputPreview: r.output_preview,
    createdAt: r.created_at,
  }));
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      rows.length > limit && last ? encodeCursor({ v: last.createdAt, id: last.id }) : null,
  };
}

/** Row counts for the settings page and `scope doctor`. */
export async function projectStats(
  db: Kysely<Database>,
  projectId: string,
): Promise<{
  runs: number;
  traces: number;
  spans: number;
  evaluations: number;
  oldestTrace: number | null;
}> {
  const [runs, traces, spans, evaluations] = await Promise.all([
    db
      .selectFrom('runs')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('project_id', '=', projectId)
      .executeTakeFirst(),
    db
      .selectFrom('traces')
      .select([
        (eb) => eb.fn.countAll<number>().as('n'),
        (eb) => eb.fn.min<number>('start_time').as('oldest'),
      ])
      .where('project_id', '=', projectId)
      .executeTakeFirst(),
    db
      .selectFrom('spans')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('project_id', '=', projectId)
      .executeTakeFirst(),
    db
      .selectFrom('evaluations')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('project_id', '=', projectId)
      .executeTakeFirst(),
  ]);
  return {
    runs: num(runs?.n),
    traces: num(traces?.n),
    spans: num(spans?.n),
    evaluations: num(evaluations?.n),
    oldestTrace:
      traces?.oldest === null || traces?.oldest === undefined ? null : Number(traces.oldest),
  };
}
