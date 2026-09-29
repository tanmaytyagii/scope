/**
 * Query plans of the hot paths, checked on SQLite: no statement may scan a whole table of spans,
 * traces or evaluations, or walk every span or evaluation of a project to find a few. That is
 * the shape of the slowdowns that grow with the database — v0.3 found one by benchmark (OTLP
 * ingestion reading spans through the project's model index). This test catches the next one
 * deterministically, whatever machine runs it.
 *
 * The store's own statements are captured (`onQuery`) while it does real work, and each distinct
 * statement is explained with its real parameters. Statements that deliberately look at a whole
 * project are listed in ALLOWED with the reason.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TraceBundle } from '@scope-ai/core';
import { MemoryExporter, Tracer } from '@scope-ai/sdk';
import { expect, it } from 'vitest';
import { type ExecutedQuery, Store } from './store.ts';

/** Project-wide statements that are expected, and why. Matched against the SQL. */
const ALLOWED: Array<{ sql: RegExp; why: string }> = [
  {
    sql: /^select count\(\*\) as "n" from "(spans|evaluations)" where "project_id" = \?$/,
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

it('keeps the hot queries off whole-table and whole-project scans', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'scope-plans-')), 'scope.db');
  const captured: ExecutedQuery[] = [];
  let capturing = false;
  const store = await Store.open(`sqlite:${file}`, {
    onQuery: (q) => {
      if (capturing) captured.push(q);
    },
  });
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

  capturing = true;
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
  // Retention.
  await store.planPrune({ projectIds: [project.id], before: Date.now() - 86_400_000 });
  await store.prune({ projectIds: [project.id], traceId: sample.trace.id });
  capturing = false;
  await store.close();

  const db = new DatabaseSync(file, { readOnly: true });
  const problems: string[] = [];
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
    const bad = plan.filter((line) => BAD_PLAN.some((pattern) => pattern.test(line)));
    if (bad.length) problems.push(`${q.sql}\n    ${bad.join('\n    ')}`);
  }
  db.close();
  expect(seen.size).toBeGreaterThan(20);
  expect(problems).toEqual([]);
});
