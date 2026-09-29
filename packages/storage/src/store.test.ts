import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isScopeError, type TraceBundle } from '@scope-ai/core';
import { MemoryExporter, Tracer } from '@scope-ai/sdk';
import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseStorageUrl } from './dialects.ts';
import { ScopeMigrations } from './migrations.ts';
import { Store } from './store.ts';

/** Builds realistic trace bundles with the real tracer. */
async function makeBundles(
  cases: Array<{
    caseId: string;
    runId?: string | null;
    fail?: boolean;
    score?: number;
    model?: string;
    delayMs?: number;
    question?: string;
  }>,
): Promise<TraceBundle[]> {
  const exporter = new MemoryExporter();
  const tracer = new Tracer({
    exporter,
    pricing: { 'acme:m1': { input: 1, output: 2, asOf: '2026-01-01', source: 'test' } },
  });
  for (const c of cases) {
    await tracer
      .trace(
        'support',
        {
          input: { question: c.question ?? `question for ${c.caseId}` },
          runId: c.runId ?? null,
          caseId: c.caseId,
          finalize: async (trace) => {
            await tracer.span('evaluate', { kind: 'evaluation' }, async () => {
              await tracer.span('judge', { kind: 'llm' }, (span) => {
                span.recordModelCall({
                  provider: 'acme',
                  model: 'judge',
                  usage: { inputTokens: 50, outputTokens: 5 },
                });
              });
            });
            const score = c.score ?? 0.9;
            trace.addEvaluation({
              evaluator: 'grounded',
              type: 'groundedness',
              kind: 'heuristic',
              status: score >= 0.7 ? 'passed' : 'failed',
              score,
              threshold: 0.7,
              reason: 'test',
              metadata: {},
              durationMs: 1,
              spanId: null,
            });
          },
        },
        async () => {
          await tracer.span('retrieve', { kind: 'retrieval' }, () => ['doc']);
          return tracer.span('answer', { kind: 'llm' }, async (span) => {
            if (c.delayMs) await new Promise((r) => setTimeout(r, c.delayMs));
            span.recordModelCall({
              provider: 'acme',
              model: c.model ?? 'm1',
              usage: { inputTokens: 100, outputTokens: 20 },
            });
            if (c.fail) throw new Error('provider unavailable');
            return `answer ${c.caseId}`;
          });
        },
      )
      .catch(() => {});
  }
  return exporter.bundles;
}

function storeSuite(label: string, url: () => string, reset?: (store: Store) => Promise<void>) {
  describe(`Store (${label})`, () => {
    let store: Store;
    let projectId: string;
    let otherProjectId: string;

    beforeAll(async () => {
      store = await Store.open(url());
      await reset?.(store);
      await store.migrate();
      projectId = (await store.ensureProject('acme', 'Acme')).id;
      otherProjectId = (await store.ensureProject('other')).id;
    });

    afterAll(async () => {
      await store?.close();
    });

    it('applies migrations once and reports state', async () => {
      expect(await store.migrationState()).toEqual({
        applied: ['0001_initial', '0002_run_comparisons'],
        pending: [],
      });
      expect(await store.migrate()).toEqual([]);
      expect((await store.ensureProject('acme')).id).toBe(projectId);
    });

    it('versions workflows by content hash', async () => {
      const a = await store.registerWorkflowVersion(projectId, {
        name: 'support',
        description: 'd',
        hash: 'h1',
        definition: { v: 1 },
        source: 'v: 1',
        path: 'wf.yaml',
      });
      const b = await store.registerWorkflowVersion(projectId, {
        name: 'support',
        description: 'd',
        hash: 'h1',
        definition: { v: 1 },
        source: 'v: 1',
        path: 'wf.yaml',
      });
      const c = await store.registerWorkflowVersion(projectId, {
        name: 'support',
        description: 'd2',
        hash: 'h2',
        definition: { v: 2 },
        source: 'v: 2',
        path: 'wf.yaml',
      });
      expect(b).toEqual(a);
      expect(c.workflowId).toBe(a.workflowId);
      expect(c.versionId).not.toBe(a.versionId);
      const detail = await store.getWorkflow(projectId, 'support');
      expect(detail?.latest).toMatchObject({ hash: 'h2', definition: { v: 2 } });
      expect(detail?.versions).toHaveLength(2);
      expect(await store.getWorkflow(otherProjectId, 'support')).toBeNull();
    });

    let runId = '';

    it('allocates unique run numbers, even concurrently', async () => {
      const { workflowId, versionId } = await store.registerWorkflowVersion(projectId, {
        name: 'support',
        description: null,
        hash: 'h2',
        definition: {},
        source: '',
        path: null,
      });
      const base = {
        projectId,
        workflowId,
        workflowVersionId: versionId,
        workflowName: 'support',
        params: { top_k: 3 },
        dataset: null,
        git: null,
        trigger: 'cli' as const,
        baseline: null,
        caseCount: 4,
      };
      const runs = await Promise.all(
        [1, 2, 3, 4, 5].map((i) => store.createRun({ ...base, variant: i % 2 ? null : 'narrow' })),
      );
      expect(runs.map((r) => r.number).sort()).toEqual([1, 2, 3, 4, 5]);
      runId = (runs.find((r) => r.number === 1) as { id: string }).id;
      expect(await store.getRun(projectId, '#3')).toMatchObject({ number: 3 });
      expect(await store.getRun(projectId, '4')).toMatchObject({ number: 4 });
      expect(await store.getRun(projectId, runId)).toMatchObject({
        id: runId,
        params: { top_k: 3 },
        status: 'running',
      });
      expect((await store.getRun(projectId, runId.slice(4, 22).toLowerCase()))?.id).toBe(runId);
      await expect(store.getRun(projectId, runId.slice(4, 12))).rejects.toThrow(/ambiguous/);
      expect(await store.getRun(otherProjectId, runId)).toBeNull();
      expect(await store.listVariants(projectId, 'support')).toEqual(['narrow']);
      const page1 = await store.listRuns(projectId, { limit: 2 });
      expect(page1.items.map((r) => r.number)).toEqual([5, 4]);
      const page2 = await store.listRuns(projectId, { limit: 2, cursor: page1.nextCursor });
      expect(page2.items.map((r) => r.number)).toEqual([3, 2]);
    });

    it('ingests traces idempotently and computes rollups', async () => {
      const bundles = await makeBundles([
        { caseId: 'c1', runId, score: 0.9, question: 'How do refunds work?' },
        { caseId: 'c2', runId, score: 0.4, delayMs: 15 },
        { caseId: 'c3', runId, fail: true },
        { caseId: 'c4', runId, score: 0.95, model: 'm2' },
      ]);
      const first = await store.ingest(projectId, bundles);
      expect(first).toMatchObject({ traces: 4, rejected: 0 });
      await store.ingest(projectId, bundles);
      const page = await store.listTraces(projectId, { runId });
      expect(page.items).toHaveLength(4);
      const c1 = page.items.find((t) => t.caseId === 'c1');
      // The judge call inside evaluation is excluded from the trace's usage and cost.
      expect(c1).toMatchObject({
        totalTokens: 120,
        llmCallCount: 1,
        evalStatus: 'passed',
        runNumber: 1,
        inputPreview: '{ "question": "How do refunds work?" }',
      });
      expect(c1?.costUsd).toBeCloseTo(0.00014);
      expect(page.items.find((t) => t.caseId === 'c4')?.costUsd).toBeNull();
    });

    it('filters, searches, sorts and paginates traces', async () => {
      expect(
        (await store.listTraces(projectId, { status: 'error' })).items.map((t) => t.caseId),
      ).toEqual(['c3']);
      expect(
        (await store.listTraces(projectId, { eval: 'failed' })).items.map((t) => t.caseId),
      ).toEqual(['c2']);
      expect(
        (await store.listTraces(projectId, { q: 'REFUNDS work' })).items.map((t) => t.caseId),
      ).toEqual(['c1']);
      expect((await store.listTraces(projectId, { q: '100%_' })).items).toHaveLength(0);
      expect(
        (await store.listTraces(projectId, { model: 'acme:m2' })).items.map((t) => t.caseId),
      ).toEqual(['c4']);
      expect(
        (await store.listTraces(projectId, { sort: 'slowest', limit: 1 })).items[0]?.caseId,
      ).toBe('c2');
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await store.listTraces(projectId, { limit: 3, cursor });
        seen.push(...page.items.map((t) => t.caseId ?? ''));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen.sort()).toEqual(['c1', 'c2', 'c3', 'c4']);
      expect((await store.listTraces(otherProjectId)).items).toHaveLength(0);
      await expect(store.listTraces(projectId, { cursor: 'garbage' })).rejects.toThrow(
        'Invalid pagination cursor',
      );
    });

    it('returns trace detail by id or prefix, scoped to the project', async () => {
      const { items } = await store.listTraces(projectId, { caseId: 'c3' });
      const id = items[0]?.id as string;
      const detail = await store.getTrace(projectId, id.slice(0, 10));
      expect(detail?.trace).toMatchObject({
        id,
        status: 'error',
        caseId: 'c3',
        error: { message: 'provider unavailable' },
      });
      expect(detail?.spans.map((s) => s.name)).toEqual([
        'support',
        'retrieve',
        'answer',
        'evaluate',
        'judge',
      ]);
      expect(detail?.run).toMatchObject({ number: 1, workflowName: 'support' });
      expect(detail?.evaluations[0]).toMatchObject({ evaluator: 'grounded', kind: 'heuristic' });
      expect(await store.getTrace(otherProjectId, id)).toBeNull();
      expect(await store.getTrace(projectId, 'zz')).toBeNull();
    });

    it('rejects ingestion that reuses another project’s trace id', async () => {
      const { items } = await store.listTraces(projectId, { caseId: 'c1' });
      const [bundle] = await makeBundles([{ caseId: 'evil' }]);
      const hijack = {
        ...(bundle as TraceBundle),
        trace: { ...(bundle as TraceBundle).trace, id: items[0]?.id as string },
      };
      expect(await store.ingest(otherProjectId, [hijack])).toMatchObject({
        traces: 0,
        rejected: 1,
      });
      const detail = await store.getTrace(projectId, items[0]?.id as string);
      expect(detail?.spans.every((s) => s.name !== 'evil')).toBe(true);
      expect(detail?.trace.caseId).toBe('c1');
    });

    it('bounds the content a trace read returns, and serves omitted spans one by one', async () => {
      const exporter = new MemoryExporter();
      const tracer = new Tracer({ exporter });
      const text = (n: number) => 'x'.repeat(n);
      await tracer.trace('large', {}, async () => {
        await tracer.span('small', { input: { q: text(100) } }, () => text(100));
        await tracer.span('big', { input: { q: text(20_000) } }, () => text(20_000));
        await tracer.span('empty', {}, () => undefined);
        await tracer.span('fits-after', { input: { q: text(100) } }, () => text(100));
      });
      const [bundle] = exporter.bundles;
      // Its own project, so the counts other tests assert do not change.
      const pid = (await store.ensureProject('large-traces')).id;
      await store.ingest(pid, [bundle as TraceBundle]);
      const id = (bundle as TraceBundle).trace.id;

      const full = await store.getTrace(pid, id);
      expect(full?.omittedContent).toEqual([]);
      expect(full?.spans.find((s) => s.name === 'big')?.output).toBe(text(20_000));

      const bounded = await store.getTrace(pid, id, { contentBudget: 5000 });
      const byName = new Map(bounded?.spans.map((s) => [s.name, s]));
      const big = byName.get('big');
      expect(bounded?.omittedContent).toEqual([big?.id]);
      expect(big).toMatchObject({
        input: null,
        output: null,
        name: 'big',
        durationMs: expect.any(Number),
      });
      expect(byName.get('small')?.output).toBe(text(100));
      expect(byName.get('fits-after')?.output).toBe(text(100));
      expect(bounded?.spans.map((s) => s.name)).toEqual(full?.spans.map((s) => s.name));

      const one = await store.getSpan(pid, id.slice(0, 8), big?.id as string);
      expect(one?.span).toMatchObject({ name: 'big', output: text(20_000) });
      expect(one?.origin).toBe(bounded?.trace.startTime);
      expect(await store.getSpan(otherProjectId, id, big?.id as string)).toBeNull();
      expect(await store.getSpan(pid, id, 'not-a-span')).toBeNull();
    });

    it('summarizes run cases and supports outcome filters', async () => {
      const results = await store.runCaseResults(projectId, runId);
      expect(results.map((r) => r.caseId)).toEqual(['c1', 'c2', 'c3', 'c4']);
      expect(results.find((r) => r.caseId === 'c4')?.unpricedModels).toEqual(['acme:m2']);
      const snapshots = await store.runCaseSnapshots(projectId, runId);
      expect(snapshots.c2).toMatchObject({
        outcome: 'failed',
        evaluators: { grounded: { status: 'failed', score: 0.4 } },
      });
      expect(snapshots.c3?.outcome).toBe('errored');
      const failed = await store.listRunCases(projectId, runId, { outcome: 'failed' });
      expect(failed.items.map((c) => c.caseId)).toEqual(['c2']);
      const byEvaluator = await store.listRunCases(projectId, runId, { evaluator: 'grounded' });
      expect(byEvaluator.items.map((c) => c.caseId)).toEqual(['c2']);
      const paged = await store.listRunCases(projectId, runId, { limit: 3 });
      const rest = await store.listRunCases(projectId, runId, {
        limit: 3,
        cursor: paged.nextCursor,
      });
      expect([...paged.items, ...rest.items].map((c) => c.caseId)).toEqual([
        'c1',
        'c2',
        'c3',
        'c4',
      ]);
    });

    it('completes runs with summaries and gates', async () => {
      const run = await store.completeRun(runId, {
        status: 'completed',
        summary: {
          cases: { total: 4, passed: 2, failed: 1, errored: 1 },
          passRate: 0.5,
          errorRate: 0.25,
          latency: { p50Ms: 1, p95Ms: 2, meanMs: 1, maxMs: 3 },
          tokens: { input: 1, output: 1, total: 2, meanPerCase: 0.5, estimated: false },
          cost: { totalUsd: 0, meanPerCaseUsd: 0, incomplete: true, unpricedModels: ['acme:m2'] },
          evaluators: [
            {
              name: 'grounded',
              type: 'groundedness',
              kind: 'heuristic',
              total: 3,
              passed: 2,
              failed: 1,
              errored: 0,
              skipped: 0,
              passRate: 2 / 3,
              meanScore: 0.75,
            },
          ],
        },
        gates: [],
        gateStatus: 'failed',
      });
      expect(run).toMatchObject({ status: 'completed', gateStatus: 'failed', passRate: 0.5 });
      expect(run.durationMs).toBeGreaterThanOrEqual(0);
      expect(
        (await store.latestRun(projectId, { workflow: 'support', status: 'completed' }))?.id,
      ).toBe(runId);
    });

    it('stores the comparison with the baseline, apart from the run', async () => {
      expect(await store.getBaselineComparison(projectId, runId)).toBeNull();
      const snapshot = { outcome: 'passed' as const, durationMs: 1, traceId: null, evaluators: {} };
      const change = (i: number, kind: 'regressed' | 'unchanged') => ({
        caseId: `c${String(i).padStart(3, '0')}`,
        kind,
        base: snapshot,
        head: {
          ...snapshot,
          outcome: kind === 'regressed' ? ('failed' as const) : ('passed' as const),
        },
        evaluators: [],
      });
      const baseline = {
        file: 'baselines/support.json',
        runId: 'run_01',
        runNumber: 1,
        commit: 'abc1234',
        createdAt: '2026-09-01T00:00:00.000Z',
      };
      const counts = { regressed: 600, fixed: 0, changed: 0, unchanged: 5, added: 0, removed: 0 };
      await store.saveBaselineComparison(projectId, {
        runId,
        baseline,
        metrics: [],
        counts,
        cases: [
          ...Array.from({ length: 5 }, (_, i) => change(i, 'unchanged')),
          ...Array.from({ length: 600 }, (_, i) => change(i + 5, 'regressed')),
        ],
      });
      const stored = await store.getBaselineComparison(projectId, runId);
      expect(stored).toMatchObject({ runId, baseline, counts, omittedCases: 100 });
      expect(stored?.cases).toHaveLength(500);
      expect(stored?.cases.every((c) => c.kind === 'regressed')).toBe(true);
      expect(await store.getBaselineComparison(otherProjectId, runId)).toBeNull();
      // Run lists never carry it.
      expect(Object.keys((await store.getRun(projectId, runId)) ?? {})).not.toContain('cases');
    });

    it('re-scores a trace by replacing its evaluations', async () => {
      const { items } = await store.listTraces(projectId, { caseId: 'c2' });
      const traceId = items[0]?.id as string;
      await store.replaceEvaluations(projectId, traceId, [
        {
          id: 'ev_rescored',
          traceId,
          runId,
          spanId: null,
          evaluator: 'grounded',
          type: 'groundedness',
          kind: 'heuristic',
          status: 'passed',
          score: 0.8,
          threshold: 0.7,
          reason: 'r',
          metadata: {},
          durationMs: 1,
          createdAt: Date.now(),
        },
      ]);
      expect((await store.listTraces(projectId, { caseId: 'c2' })).items[0]?.evalStatus).toBe(
        'passed',
      );
      expect((await store.getTrace(projectId, traceId))?.evaluations.map((e) => e.id)).toEqual([
        'ev_rescored',
      ]);
    });

    it('aggregates the overview, model usage and evaluator health', async () => {
      const now = Date.now();
      const window = { since: now - 3_600_000, until: now + 60_000 };
      const ov = await store.overview(projectId, { ...window, bucketMs: 600_000 });
      expect(ov.traces).toMatchObject({
        total: 4,
        errors: 1,
        errorRate: 0.25,
        totalTokens: 480,
        unpricedTraces: 1,
        sampled: false,
      });
      expect(ov.traces.p95Ms).toBeGreaterThan(0);
      expect(ov.series.reduce((n, b) => n + b.ok + b.error, 0)).toBe(4);
      expect(ov.recentFailures.map((t) => t.caseId).sort()).toEqual(['c3']);
      expect(ov.runs.total).toBe(5);
      expect(ov.runTrend.map((r) => r.number)).toEqual([1]);

      const models = await store.modelUsage(projectId, window);
      const m1 = models.find((m) => m.model === 'm1' && m.usage === 'workflow');
      expect(m1).toMatchObject({
        provider: 'acme',
        calls: 3,
        errors: 1,
        inputTokens: 300,
        unpricedCalls: 0,
      });
      expect(models.find((m) => m.model === 'judge')).toMatchObject({
        usage: 'evaluation',
        calls: 4,
        unpricedCalls: 4,
      });

      const health = await store.evaluatorHealth(projectId, window);
      expect(health[0]).toMatchObject({
        evaluator: 'grounded',
        kind: 'heuristic',
        passed: 4,
        failed: 0,
        trend: [{ runNumber: 1, passRate: 2 / 3 }],
      });

      const evaluations = await store.listEvaluations(projectId, {
        evaluator: 'grounded',
        limit: 2,
      });
      expect(evaluations.items).toHaveLength(2);
      expect(evaluations.nextCursor).not.toBeNull();
      expect((await store.projectStats(projectId)).traces).toBe(4);
    });

    it('manages API keys with hashed storage and revocation', async () => {
      const { key, secret } = await store.createApiKey(projectId, 'ci', ['ingest', 'read']);
      expect(secret).toMatch(/^scope_[A-Za-z0-9]{32}$/);
      expect(key.prefix).toBe(secret.slice(0, 12));
      const row = await store.db
        .selectFrom('api_keys')
        .selectAll()
        .where('id', '=', key.id)
        .executeTakeFirstOrThrow();
      expect(row.hash).not.toContain(secret);
      expect(await store.authenticateApiKey(secret)).toMatchObject({
        id: key.id,
        projectId,
        scopes: ['ingest', 'read'],
      });
      expect(await store.authenticateApiKey(`${secret}x`)).toBeNull();
      expect(await store.revokeApiKey(otherProjectId, key.id)).toBe(false);
      expect(await store.revokeApiKey(projectId, key.id)).toBe(true);
      expect(await store.authenticateApiKey(secret)).toBeNull();
    });

    it('prunes runs and application traces by age, project, run and trace', async () => {
      // Projects of their own, so the counts other tests assert do not change.
      const pid = (await store.ensureProject('retention')).id;
      const other = (await store.ensureProject('retention-other')).id;
      const now = Date.now();
      const day = 86_400_000;
      const aged = (bundle: TraceBundle, ms: number): TraceBundle => ({
        ...bundle,
        trace: {
          ...bundle.trace,
          startTime: bundle.trace.startTime - ms,
          endTime: bundle.trace.endTime - ms,
        },
        spans: bundle.spans.map((sp) => ({
          ...sp,
          startTime: sp.startTime - ms,
          endTime: sp.endTime - ms,
        })),
      });
      const { workflowId, versionId } = await store.registerWorkflowVersion(pid, {
        name: 'retained',
        description: null,
        hash: 'r1',
        definition: {},
        source: '',
        path: null,
      });
      const run = async (ageMs: number, done = true) => {
        const r = await store.createRun({
          projectId: pid,
          workflowId,
          workflowVersionId: versionId,
          workflowName: 'retained',
          variant: null,
          params: {},
          dataset: null,
          git: null,
          trigger: 'cli',
          baseline: null,
          caseCount: 2,
          startedAt: now - ageMs,
        });
        const bundles = await makeBundles([
          { caseId: 'a', runId: r.id },
          { caseId: 'b', runId: r.id },
        ]);
        await store.ingest(
          pid,
          bundles.map((b) => aged(b, ageMs)),
        );
        if (done)
          await store.completeRun(r.id, {
            status: 'completed',
            summary: null,
            gates: [],
            gateStatus: 'passed',
            endedAt: now - ageMs + 1000,
          } as never);
        return r;
      };
      const oldRun = await run(40 * day);
      const newRun = await run(0);
      const stuck = await run(30 * 3_600_000, false); // "running" for 30 hours: abandoned
      const live = await run(2 * 3_600_000, false); // running for 2 hours: kept
      const [oldApp, newApp] = await makeBundles([{ caseId: 'x' }, { caseId: 'y' }]);
      await store.ingest(pid, [aged(oldApp as TraceBundle, 40 * day), newApp as TraceBundle]);
      const [otherOld] = await makeBundles([{ caseId: 'z' }]);
      await store.ingest(other, [aged(otherOld as TraceBundle, 40 * day)]);

      // Traces made by makeBundles have 5 spans and 1 evaluation each.
      const selection = { projectIds: [pid], before: now - 3_600_000 };
      const plan = await store.planPrune(selection, now);
      expect(plan).toMatchObject({ runs: 2, runTraces: 4, traces: 1, spans: 25, evaluations: 5 });
      expect(plan.oldest).toBe(now - 40 * day);
      // Planning deletes nothing.
      expect(await store.getRun(pid, oldRun.id)).not.toBeNull();

      expect(await store.prune(selection, now)).toEqual(plan);
      expect(await store.getRun(pid, oldRun.id)).toBeNull();
      expect(await store.getRun(pid, stuck.id)).toBeNull();
      expect(await store.getRun(pid, newRun.id)).not.toBeNull();
      expect(await store.getRun(pid, live.id)).not.toBeNull();
      expect(await store.getTrace(pid, (oldApp as TraceBundle).trace.id)).toBeNull();
      expect(await store.getTrace(pid, (newApp as TraceBundle).trace.id)).not.toBeNull();
      expect(await store.getTrace(other, (otherOld as TraceBundle).trace.id)).not.toBeNull();
      expect(await store.planPrune(selection, now)).toMatchObject({ runs: 0, traces: 0, spans: 0 });

      // Only application traces; a run's own traces are never deleted one by one.
      expect(
        await store.planPrune({ projectIds: [other], before: now, only: 'runs' }, now),
      ).toMatchObject({ runs: 0, traces: 0 });
      const runTrace = (await store.listTraces(pid, { runId: newRun.id })).items[0]?.id as string;
      expect(await store.planPrune({ projectIds: [pid], traceId: runTrace }, now)).toMatchObject({
        traces: 0,
      });
      // One run, one trace, and every project at once.
      expect(await store.prune({ projectIds: [pid], runId: newRun.id }, now)).toMatchObject({
        runs: 1,
        runTraces: 2,
      });
      expect(
        await store.prune({ projectIds: [pid], traceId: (newApp as TraceBundle).trace.id }, now),
      ).toMatchObject({ traces: 1, spans: 5 });
      expect(await store.prune({ projectIds: null, before: now - day }, now)).toMatchObject({
        traces: 1,
      });
      expect(await store.getTrace(other, (otherOld as TraceBundle).trace.id)).toBeNull();
    });

    it('cascades run deletion to traces, spans, evaluations and comparisons', async () => {
      // Counted in this project: other tests store traces in projects of their own.
      const count = async (table: 'traces' | 'spans' | 'evaluations' | 'run_comparisons') =>
        Number(
          (
            await store.db
              .selectFrom(table)
              .select((eb) => eb.fn.countAll<number>().as('n'))
              .where('project_id', '=', projectId)
              .executeTakeFirst()
          )?.n,
        );
      expect(await count('traces')).toBe(4);
      expect(await store.deleteRun(projectId, runId)).toBe(true);
      expect(await count('traces')).toBe(0);
      expect(await count('spans')).toBe(0);
      expect(await count('evaluations')).toBe(0);
      expect(await count('run_comparisons')).toBe(0);
    });
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'scope-store-'));
storeSuite('sqlite', () => `sqlite:${join(tmp, 'scope.db')}`);

const pgUrl = process.env.SCOPE_TEST_DATABASE_URL;
if (pgUrl) {
  storeSuite(
    'postgres',
    () => pgUrl,
    async (store) => {
      await sql`drop schema public cascade`.execute(store.db);
      await sql`create schema public`.execute(store.db);
    },
  );
}

describe('storage urls and errors', () => {
  it('parses urls and hides passwords', () => {
    expect(parseStorageUrl('sqlite:/tmp/x.db')).toMatchObject({
      dialect: 'sqlite',
      location: '/tmp/x.db',
    });
    expect(parseStorageUrl('postgres://u:secret@db:5432/scope').display).toBe(
      'postgres://u:***@db:5432/scope',
    );
    expect(() => parseStorageUrl('mysql://x')).toThrow(/Unsupported storage URL "mysql:…"/);
  });

  it('explains an unreachable PostgreSQL server', async () => {
    const error = await Store.open('postgres://scope:scope@127.0.0.1:9/nope').catch((e) => e);
    expect(isScopeError(error, 'storage_unavailable')).toBe(true);
    expect(error.message).toMatch(
      /^Unable to connect to PostgreSQL at postgres:\/\/scope:\*\*\*@127.0.0.1:9\/nope/,
    );
    expect(error.hint).toContain('SCOPE_DATABASE_URL');
  });

  it('upgrades a database created by an earlier version', async () => {
    const url = `sqlite:${join(mkdtempSync(join(tmpdir(), 'scope-upgrade-')), 'scope.db')}`;
    const old = await Store.open(url, { autoMigrate: false });
    const migrations = await new ScopeMigrations('sqlite').getMigrations();
    const { error } = await new Migrator({
      db: old.db,
      provider: { getMigrations: async () => ({ '0001_initial': migrations['0001_initial'] }) },
      migrationTableName: 'scope_migrations',
      migrationLockTableName: 'scope_migrations_lock',
    } as ConstructorParameters<typeof Migrator>[0]).migrateToLatest();
    expect(error).toBeUndefined();
    const project = await old.ensureProject('legacy');
    await old.close();

    const store = await Store.open(url);
    expect(await store.migrationState()).toEqual({
      applied: ['0001_initial', '0002_run_comparisons'],
      pending: [],
    });
    expect((await store.ensureProject('legacy')).id).toBe(project.id);
    await store.close();
  });

  it('opens an in-memory database', async () => {
    const store = await Store.open('sqlite::memory:');
    expect((await store.migrationState()).pending).toEqual([]);
    await store.close();
  });
});
