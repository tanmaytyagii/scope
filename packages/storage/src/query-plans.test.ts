/**
 * Query plans of the hot paths: no statement may scan a whole table of spans, traces or
 * evaluations, or walk every span or evaluation of a project to find a few. That is the shape of
 * the slowdowns that grow with the database — v0.3 found one by benchmark (OTLP ingestion reading
 * spans through the project's model index), v0.4 another (retention's plan on PostgreSQL). This
 * test catches the next one deterministically, whatever machine runs it.
 *
 * The store's own statements are captured (`onQuery`) while it does real work, and each distinct
 * statement is explained with its real parameters: on SQLite always, on PostgreSQL when
 * SCOPE_TEST_DATABASE_URL is set. Statements that deliberately look at a whole project are
 * listed in ALLOWED with the reason.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TraceBundle } from '@scope-ai/core';
import { MemoryExporter, Tracer } from '@scope-ai/sdk';
import { CompiledQuery, sql } from 'kysely';
import { expect, it } from 'vitest';
import { type ExecutedQuery, Store } from './store.ts';

/** Project-wide statements that are expected, and why. Matched against the SQL. */
const ALLOWED: Array<{ sql: RegExp; why: string }> = [
  {
    sql: /^select count\(\*\) as "n" from "(spans|evaluations)" where "project_id" = (\?|\$1)$/,
    why: 'project row counts for GET /project and `scope ui` start-up: a count, by design',
  },
];

const BAD_PLAN = [
  // A full scan of a large table, with or without an index.
  /^SCAN (spans|traces|evaluations)\b/,
  // Every span or evaluation of a project, to find a few of them.
  /^SEARCH (spans|evaluations) USING (COVERING )?INDEX \w+ \(project_id=\?\)$/,
];

async function bundles(count: number, runId: string | null, offset: number) {
  const exporter = new MemoryExporter();
  const tracer = new Tracer({ exporter });
  for (let i = 0; i < count; i++) {
    const n = offset + i;
    await tracer.trace(
      'support',
      {
        input: { question: `refund ${n}` },
        runId,
        caseId: runId ? `case-${i}` : null,
        finalize: (trace) =>
          trace.addEvaluation({
            evaluator: 'grounded',
            type: 'groundedness',
            kind: 'heuristic',
            status: n % 3 ? 'passed' : 'failed',
            score: n % 3 ? 0.9 : 0.3,
            threshold: 0.7,
            reason: 'r',
            metadata: {},
            durationMs: 1,
            spanId: null,
          }),
      },
      async () => {
        await tracer.span('retrieve', { kind: 'retrieval', input: { q: n } }, () => ['doc']);
        return tracer.span('answer', { kind: 'llm' }, (span) => {
          span.recordModelCall({
            provider: 'openai',
            model: n % 2 ? 'gpt-5' : 'gpt-5-mini',
            usage: { inputTokens: 100, outputTokens: 20 },
          });
          return `answer ${n}`;
        });
      },
    );
  }
  return exporter.bundles;
}

/** Seeds two projects and a run, then does the store's hot paths between `capture(true)` and
 * `capture(false)`: ingestion, trace and run reads, the dashboard's aggregates, retention. */
async function exercise(store: Store, capture: (on: boolean) => void): Promise<void> {
  const project = await store.ensureProject('plans');
  const other = await store.ensureProject('other');
  const { workflowId, versionId } = await store.registerWorkflowVersion(project.id, {
    name: 'support',
    description: null,
    hash: 'h',
    definition: {},
    source: '',
    path: null,
  });
  const run = await store.createRun({
    projectId: project.id,
    workflowId,
    workflowVersionId: versionId,
    workflowName: 'support',
    variant: null,
    params: {},
    dataset: null,
    git: null,
    trigger: 'cli',
    baseline: null,
    caseCount: 20,
  });
  await store.ingest(project.id, await bundles(20, run.id, 0));
  await store.ingest(project.id, await bundles(300, null, 100));
  await store.ingest(other.id, await bundles(100, null, 1000));
  const [sample] = (await bundles(1, null, 5000)) as [TraceBundle];
  const otlpBatch = await bundles(20, null, 6000);

  capture(true);
  // Ingestion: SDK batches, and OpenTelemetry spans arriving over several requests.
  await store.ingest(project.id, await bundles(50, null, 2000));
  await store.ingestSpans(
    project.id,
    [{ traceId: sample.trace.id, spans: sample.spans.slice(0, 2), metadata: {} }],
    1000,
  );
  await store.ingestSpans(
    project.id,
    [{ traceId: sample.trace.id, spans: sample.spans.slice(2), metadata: {} }],
    1000,
  );
  // An exporter batch holds spans of many traces.
  await store.ingestSpans(
    project.id,
    otlpBatch.map((b) => ({ traceId: b.trace.id, spans: b.spans, metadata: {} })),
    1000,
  );
  // Reading traces as the dashboard and CLI do.
  const page = await store.listTraces(project.id, { limit: 50 });
  await store.listTraces(project.id, { limit: 50, cursor: page.nextCursor ?? undefined });
  await store.listTraces(project.id, { limit: 50, q: 'refund 12' });
  await store.listTraces(project.id, { limit: 50, model: 'gpt-5' });
  await store.listTraces(project.id, { limit: 50, eval: 'failed' });
  await store.listTraces(project.id, { limit: 50, runId: run.id });
  await store.listTraces(project.id, { limit: 50, sort: 'slowest' });
  const id = page.items[0]?.id as string;
  await store.getTrace(project.id, id);
  const bounded = await store.getTrace(project.id, id, { contentBudget: 10 });
  await store.getSpan(project.id, id, bounded?.spans[1]?.id as string);
  await store.getTrace(
    project.id,
    run.id ? ((await store.listTraces(project.id, { runId: run.id })).items[0]?.id as string) : id,
  );
  // Runs.
  await store.getRun(project.id, String(run.number));
  await store.listRunCases(project.id, run.id, { limit: 50 });
  await store.listRunCases(project.id, run.id, { outcome: 'failed' });
  await store.runCaseResults(project.id, run.id);
  await store.runCaseSnapshots(project.id, run.id);
  // The dashboard's window aggregates and evaluation lists.
  const window = { since: Date.now() - 30 * 86_400_000, until: Date.now() + 60_000 };
  await store.overview(project.id, { ...window, bucketMs: 86_400_000 });
  await store.modelUsage(project.id, window);
  await store.evaluatorHealth(project.id, window);
  await store.listEvaluations(project.id, { status: 'failed', limit: 50 });
  // Retention.
  await store.planPrune({ projectIds: [project.id], before: Date.now() - 86_400_000 });
  await store.prune({ projectIds: [project.id], traceId: sample.trace.id });
  capture(false);
}

it('keeps the hot queries off whole-table and whole-project scans', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'scope-plans-')), 'scope.db');
  const captured: ExecutedQuery[] = [];
  let capturing = false;
  const store = await Store.open(`sqlite:${file}`, {
    onQuery: (q) => {
      if (capturing) captured.push(q);
    },
  });
  await exercise(store, (on) => {
    capturing = on;
  });
  await store.close();

  const db = new DatabaseSync(file, { readOnly: true });
  const problems: string[] = [];
  const plans = new Map<string, string>();
  const seen = new Set<string>();
  for (const q of captured) {
    if (seen.has(q.sql) || !/^\s*select|^\s*delete|^\s*update/i.test(q.sql)) continue;
    seen.add(q.sql);
    if (ALLOWED.some((a) => a.sql.test(q.sql))) continue;
    const params = q.parameters.map((p) =>
      typeof p === 'boolean'
        ? Number(p)
        : p !== null && typeof p === 'object'
          ? JSON.stringify(p)
          : p,
    ) as Array<string | number | null>;
    const plan = db
      .prepare(`explain query plan ${q.sql}`)
      .all(...params)
      .map((row) => String((row as { detail: string }).detail));
    plans.set(q.sql, plan.join(' | '));
    const bad = plan.filter((line) => BAD_PLAN.some((pattern) => pattern.test(line)));
    if (bad.length) problems.push(`${q.sql}\n    ${bad.join('\n    ')}`);
  }
  db.close();
  expect(seen.size).toBeGreaterThan(20);
  expect(problems).toEqual([]);
  // The window aggregates read covering indexes in time order (migration 0004), not rows.
  for (const [pattern, index] of [
    [/from "spans" where "project_id" = \? and "kind" = \?/, 'spans_model_calls_idx'],
    [/from "traces" where "project_id" = \? and "start_time" >= \?/, 'traces_project_window_idx'],
    [
      /from "evaluations" where "project_id" = \? and "created_at" >= \?/,
      'evaluations_project_window_idx',
    ],
  ] as const) {
    const q = captured.find((c) => pattern.test(c.sql) && /count\(\*\)|sum\(/.test(c.sql));
    expect(q, String(pattern)).toBeDefined();
    expect(plans.get(q?.sql ?? ''), String(pattern)).toContain(index);
  }
});

const pgUrl = process.env.SCOPE_TEST_DATABASE_URL;
const PG_SCHEMA = 'scope_plans_test';

interface PgPlan {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Filter?: string;
  Plans?: PgPlan[];
}

function* pgNodes(node: PgPlan): Generator<PgPlan> {
  yield node;
  for (const child of node.Plans ?? []) yield* pgNodes(child);
}

/**
 * A scan that reads a whole table of spans, traces or evaluations — sequentially, or through an
 * index with no condition — or every span or evaluation of a project.
 */
function badPgScan(node: PgPlan): boolean {
  const table = node['Relation Name'];
  if (table !== 'spans' && table !== 'traces' && table !== 'evaluations') return false;
  if (node['Node Type'] === 'Seq Scan') return true;
  if (node['Node Type'] !== 'Index Scan' && node['Node Type'] !== 'Index Only Scan') return false;
  const cond = node['Index Cond'];
  return cond === undefined || (table !== 'traces' && /^\(project_id = \$\d+\)$/.test(cond));
}

function describePgScan(node: PgPlan): string {
  const index = node['Index Name'] ? ` using ${node['Index Name']}` : '';
  const cond = node['Index Cond'] ?? node.Filter ?? '';
  return `${node['Node Type']} on ${node['Relation Name']}${index} ${cond}`.trim();
}

/** The connection URL with PostgreSQL session settings (`-c name=value …`). */
function withOptions(connection: string, options: string): string {
  const url = new URL(connection);
  url.searchParams.set('options', options);
  return url.toString();
}

// PostgreSQL chooses plans by cost, and on tables this small reading everything is cheapest, so
// its plans are checked with sequential scans switched off: a statement that can use an index
// then does, and one that still scans spans, traces or evaluations has no index to use — it reads
// the whole table at any size, as retention's plan did before (`run_id in (…) or id in (…)`).
it.runIf(pgUrl)('keeps the hot queries on indexes on PostgreSQL', async () => {
  // Its own schema: the storage suite resets `public` concurrently.
  const admin = await Store.open(pgUrl as string, { autoMigrate: false });
  await sql`drop schema if exists ${sql.id(PG_SCHEMA)} cascade`.execute(admin.db);
  await sql`create schema ${sql.id(PG_SCHEMA)}`.execute(admin.db);
  await admin.close();

  const captured: ExecutedQuery[] = [];
  let capturing = false;
  const store = await Store.open(withOptions(pgUrl as string, `-c search_path=${PG_SCHEMA}`), {
    onQuery: (q) => {
      if (capturing) captured.push(q);
    },
  });
  await exercise(store, (on) => {
    capturing = on;
  });
  await store.close();

  const explain = await Store.open(
    withOptions(pgUrl as string, `-c search_path=${PG_SCHEMA} -c enable_seqscan=off`),
    { autoMigrate: false },
  );
  const problems: string[] = [];
  const seen = new Set<string>();
  let explained = 0;
  for (const q of captured) {
    if (seen.has(q.sql) || !/^\s*select|^\s*delete|^\s*update/i.test(q.sql)) continue;
    seen.add(q.sql);
    if (ALLOWED.some((a) => a.sql.test(q.sql))) continue;
    const result = await explain.db.executeQuery<{ 'QUERY PLAN': string }>(
      CompiledQuery.raw(`explain (format json) ${q.sql}`, [...q.parameters]),
    );
    // The store reads JSON columns as text.
    const [{ Plan: root }] = JSON.parse(result.rows[0]?.['QUERY PLAN'] ?? '') as [{ Plan: PgPlan }];
    explained++;
    const bad = [...pgNodes(root)].filter(badPgScan).map(describePgScan);
    if (bad.length) problems.push(`${q.sql}\n    ${bad.join('\n    ')}`);
  }
  await sql`drop schema ${sql.id(PG_SCHEMA)} cascade`.execute(explain.db);
  await explain.close();
  expect(explained).toBeGreaterThan(20);
  expect(problems).toEqual([]);
});
