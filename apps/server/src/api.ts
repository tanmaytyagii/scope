/**
 * Read endpoints of /api/v1. Handlers stay thin: parse → query storage → map to a resource.
 */
import {
  compareConfig,
  compareMany,
  compareRuns,
  ErrorCodes,
  headlineMetrics,
  MAX_COMPARED_RUNS,
  SCOPE_VERSION,
  ScopeError,
} from '@scope-ai/core';
import type * as api from '@scope-ai/protocol';
import {
  ComparisonQuery,
  EvaluationsQuery,
  INGEST_PROTOCOL_VERSION,
  RunCasesQuery,
  RunMatrixQuery,
  RunsQuery,
  type TimeWindowName,
  TraceQuery,
  TracesQuery,
  WINDOW_SPANS,
  WindowQuery,
} from '@scope-ai/protocol';
import type { Hono } from 'hono';
import { requireAccess } from './auth.ts';
import {
  apiKeyDto,
  evaluationListItemDto,
  evaluatorHealthDto,
  iso,
  isoOrNull,
  modelUsageDto,
  overviewDto,
  pricingDto,
  runCaseDto,
  runDto,
  spanDto,
  traceDetailDto,
  traceSummaryDto,
  workflowDetailDto,
  workflowSummaryDto,
} from './dto.ts';
import { notFound } from './errors.ts';
import { handleIngest } from './ingest.ts';
import type { AppContext, AppEnv, Deps } from './types.ts';
import { isoToMs, parseQuery, resolveRun } from './validate.ts';

function window(deps: Deps, name: TimeWindowName | undefined) {
  const span = WINDOW_SPANS[name ?? '7d'];
  const until = deps.now();
  return { since: until - span.ms, until, bucketMs: span.bucketMs };
}

async function comparison(c: AppContext, deps: Deps): Promise<api.Comparison> {
  const query = parseQuery(c, ComparisonQuery);
  const project = c.get('project');
  const [base, head] = await Promise.all([
    resolveRun(c, deps, query.base),
    resolveRun(c, deps, query.head),
  ]);
  for (const run of [base, head]) {
    if (!run.summary) {
      throw new ScopeError(
        ErrorCodes.badRequest,
        `Run #${run.number} has no summary yet (status: ${run.status})`,
        { hint: 'Compare runs that have completed.' },
      );
    }
  }
  const [baseCases, headCases] = await Promise.all([
    deps.store.runCaseSnapshots(project.id, base.id),
    deps.store.runCaseSnapshots(project.id, head.id),
  ]);
  const baseSummary = base.summary as NonNullable<typeof base.summary>;
  const headSummary = head.summary as NonNullable<typeof head.summary>;
  const result = compareRuns(
    { summary: baseSummary, cases: baseCases },
    { summary: headSummary, cases: headCases },
  );
  const side = (run: typeof base, summary: typeof baseSummary) => ({
    run: { id: run.id, number: run.number, workflow: run.workflowName, variant: run.variant },
    summary,
  });
  return {
    base: side(base, baseSummary),
    head: side(head, headSummary),
    metrics: result.metrics,
    headline: headlineMetrics(result.metrics, headSummary.evaluators).map((m) => m.id),
    counts: result.counts,
    cases:
      query.includeUnchanged === 'true'
        ? result.cases
        : result.cases.filter((change) => change.kind !== 'unchanged'),
    // Versions are stored once per content hash, so equal version ids mean an identical file.
    config: compareConfig(
      {
        params: base.params,
        workflow: base.workflowVersionId,
        datasetHash: base.dataset?.hash ?? null,
      },
      {
        params: head.params,
        workflow: head.workflowVersionId,
        datasetHash: head.dataset?.hash ?? null,
      },
    ),
  };
}

/** Differing cases listed per matrix; the rest are counted. */
const MAX_MATRIX_CASES = 500;

async function runMatrix(c: AppContext, deps: Deps): Promise<api.RunMatrix> {
  const query = parseQuery(c, RunMatrixQuery);
  const project = c.get('project');
  const refs = [
    ...new Set(
      query.runs
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
    ),
  ];
  if (refs.length < 2 || refs.length > MAX_COMPARED_RUNS) {
    throw new ScopeError(
      ErrorCodes.badRequest,
      `Compare 2 to ${MAX_COMPARED_RUNS} runs side by side (got ${refs.length})`,
      { hint: 'Pass run numbers separated by commas, e.g. runs=12,13,14.' },
    );
  }
  const runs = await Promise.all(refs.map((ref) => resolveRun(c, deps, ref)));
  for (const run of runs) {
    if (!run.summary) {
      throw new ScopeError(
        ErrorCodes.badRequest,
        `Run #${run.number} has no summary yet (status: ${run.status})`,
        { hint: 'Compare runs that have completed.' },
      );
    }
  }
  const sides = await Promise.all(
    runs.map(async (run) => ({
      summary: run.summary as NonNullable<typeof run.summary>,
      cases: await deps.store.runCaseSnapshots(project.id, run.id),
    })),
  );
  const matrix = compareMany(sides);
  const evaluators = sides.flatMap((s) => s.summary.evaluators);
  return {
    runs: runs.map((run, i) => ({
      run: { id: run.id, number: run.number, workflow: run.workflowName, variant: run.variant },
      params: run.params,
      summary: sides[i]?.summary as NonNullable<typeof run.summary>,
    })),
    metrics: matrix.metrics,
    headline: headlineMetrics(matrix.metrics, evaluators).map((m) => m.id),
    caseCount: matrix.caseCount,
    cases: matrix.cases.slice(0, MAX_MATRIX_CASES),
    omittedCases: Math.max(0, matrix.cases.length - MAX_MATRIX_CASES),
  };
}

export function registerApi(app: Hono<AppEnv>, deps: Deps): void {
  const read = requireAccess(deps, 'read');
  const { store } = deps;

  app.get('/api/v1/info', (c) =>
    c.json({
      name: 'scope',
      version: SCOPE_VERSION,
      protocol: INGEST_PROTOCOL_VERSION,
      auth: deps.auth.mode,
    } satisfies api.ServerInfo),
  );

  app.get('/api/v1/project', read, async (c) => {
    const project = c.get('project');
    const [stats, migrations] = await Promise.all([
      store.projectStats(project.id),
      store.migrationState(),
    ]);
    const body: api.ProjectInfo = {
      project: {
        id: project.id,
        slug: project.slug,
        name: project.name,
        createdAt: iso(project.createdAt),
      },
      server: {
        version: SCOPE_VERSION,
        auth: deps.auth.mode,
        storage: { dialect: store.dialect, location: store.target.display },
        migrations: { applied: migrations.applied, pending: migrations.pending },
      },
      privacy: {
        captureContent: deps.privacy.captureContent,
        maxPayloadBytes: deps.privacy.maxPayloadBytes,
        redactionRules: deps.privacy.rules.map((r) => r.name),
        sensitiveKeys: [...deps.privacy.sensitiveKeys].sort(),
      },
      pricing: pricingDto(deps.pricing),
      stats: {
        runs: stats.runs,
        traces: stats.traces,
        spans: stats.spans,
        evaluations: stats.evaluations,
        oldestTrace: isoOrNull(stats.oldestTrace),
      },
    };
    return c.json(body);
  });

  app.get('/api/v1/api-keys', read, async (c) => {
    const keys = await store.listApiKeys(c.get('project').id);
    return c.json({ items: keys.map(apiKeyDto) } satisfies api.ApiKeyList);
  });

  app.get('/api/v1/overview', read, async (c) => {
    const q = parseQuery(c, WindowQuery);
    const overview = await store.overview(c.get('project').id, window(deps, q.window));
    return c.json(overviewDto(overview) satisfies api.Overview);
  });

  app.get('/api/v1/runs', read, async (c) => {
    const q = parseQuery(c, RunsQuery);
    const page = await store.listRuns(c.get('project').id, {
      ...(q.workflow ? { workflow: q.workflow } : {}),
      ...(q.variant ? { variant: q.variant } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.gateStatus ? { gateStatus: q.gateStatus } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
      cursor: q.cursor ?? null,
    });
    return c.json({
      items: page.items.map(runDto),
      nextCursor: page.nextCursor,
    } satisfies api.RunPage);
  });

  app.get('/api/v1/runs/:run', read, async (c) => {
    const run = await resolveRun(c, deps, c.req.param('run'));
    return c.json(runDto(run) satisfies api.Run);
  });

  app.get('/api/v1/runs/:run/baseline-comparison', read, async (c) => {
    const project = c.get('project');
    const run = await resolveRun(c, deps, c.req.param('run'));
    const stored = await store.getBaselineComparison(project.id, run.id);
    if (!stored) {
      throw notFound(
        `A baseline comparison of run #${run.number}`,
        run.baseline
          ? 'This run was recorded before SCOPE kept baseline comparisons (0.2); compare runs instead.'
          : `Run #${run.number} was not compared with a baseline. Runs use baselines/<workflow>.json when it exists; save one with scope baseline save.`,
      );
    }
    const source = stored.baseline.runId
      ? await store.getRun(project.id, stored.baseline.runId)
      : null;
    return c.json({
      run: { id: run.id, number: run.number, workflow: run.workflowName, variant: run.variant },
      baseline: { ...stored.baseline, runId: stored.baseline.runId ?? null },
      baselineRun: source ? { id: source.id, number: source.number } : null,
      metrics: stored.metrics,
      headline: headlineMetrics(stored.metrics, run.summary?.evaluators ?? []).map((m) => m.id),
      counts: stored.counts,
      cases: stored.cases,
      omittedCases: stored.omittedCases,
      config: stored.config ?? null,
    } satisfies api.BaselineComparison);
  });

  app.get('/api/v1/runs/:run/cases', read, async (c) => {
    const q = parseQuery(c, RunCasesQuery);
    const run = await resolveRun(c, deps, c.req.param('run'));
    const page = await store.listRunCases(c.get('project').id, run.id, {
      ...(q.outcome ? { outcome: q.outcome } : {}),
      ...(q.evaluator ? { evaluator: q.evaluator } : {}),
      ...(q.q ? { q: q.q } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
      cursor: q.cursor ?? null,
    });
    return c.json({
      items: page.items.map(runCaseDto),
      nextCursor: page.nextCursor,
    } satisfies api.RunCasePage);
  });

  app.get('/api/v1/comparisons', read, async (c) => c.json(await comparison(c, deps)));
  app.get('/api/v1/comparisons/matrix', read, async (c) => c.json(await runMatrix(c, deps)));

  app.get('/api/v1/traces', read, async (c) => {
    const q = parseQuery(c, TracesQuery);
    const project = c.get('project');
    const run = q.run ? await resolveRun(c, deps, q.run) : null;
    const since = isoToMs(q.since);
    const until = isoToMs(q.until);
    const page = await store.listTraces(project.id, {
      ...(run ? { runId: run.id } : {}),
      ...(q.name ? { name: q.name } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.eval ? { eval: q.eval } : {}),
      ...(q.model ? { model: q.model } : {}),
      ...(q.q ? { q: q.q } : {}),
      ...(q.case ? { caseId: q.case } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(q.sort ? { sort: q.sort } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
      cursor: q.cursor ?? null,
    });
    return c.json({
      items: page.items.map(traceSummaryDto),
      nextCursor: page.nextCursor,
    } satisfies api.TracePage);
  });

  app.get('/api/v1/traces/:trace', read, async (c) => {
    const project = c.get('project');
    const ref = c.req.param('trace');
    const q = parseQuery(c, TraceQuery);
    const detail = await store.getTrace(
      project.id,
      ref,
      q.contentBudget === undefined ? {} : { contentBudget: q.contentBudget },
    );
    if (!detail) {
      throw notFound(
        `Trace "${ref}"`,
        /^[0-9a-f]{4,32}$/i.test(ref)
          ? `No trace with this id in project "${project.slug}".`
          : 'Trace ids are hexadecimal; use the full id or a unique prefix of at least 4 characters.',
      );
    }
    return c.json(traceDetailDto(detail) satisfies api.TraceDetail);
  });

  app.get('/api/v1/traces/:trace/spans/:span', read, async (c) => {
    const project = c.get('project');
    const ref = c.req.param('trace');
    const spanId = c.req.param('span');
    const found = await store.getSpan(project.id, ref, spanId);
    if (!found) {
      throw notFound(
        `Span "${spanId}" of trace "${ref}"`,
        /^[0-9a-f]{16}$/.test(spanId)
          ? `No such span in a trace of project "${project.slug}".`
          : 'Span ids are 16 lowercase hexadecimal characters.',
      );
    }
    return c.json(spanDto(found.span, found.origin) satisfies api.Span);
  });

  app.get('/api/v1/evaluators', read, async (c) => {
    const q = parseQuery(c, WindowQuery);
    const w = window(deps, q.window);
    const items = await store.evaluatorHealth(c.get('project').id, w);
    return c.json({
      window: { since: iso(w.since), until: iso(w.until) },
      items: items.map(evaluatorHealthDto),
    } satisfies api.EvaluatorHealthList);
  });

  app.get('/api/v1/evaluations', read, async (c) => {
    const q = parseQuery(c, EvaluationsQuery);
    const run = q.run ? await resolveRun(c, deps, q.run) : null;
    const page = await store.listEvaluations(c.get('project').id, {
      ...(q.evaluator ? { evaluator: q.evaluator } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(run ? { runId: run.id } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
      cursor: q.cursor ?? null,
    });
    return c.json({
      items: page.items.map(evaluationListItemDto),
      nextCursor: page.nextCursor,
    } satisfies api.EvaluationPage);
  });

  app.get('/api/v1/workflows', read, async (c) => {
    const items = await store.listWorkflows(c.get('project').id);
    return c.json({ items: items.map(workflowSummaryDto) } satisfies api.WorkflowList);
  });

  app.get('/api/v1/workflows/:workflow', read, async (c) => {
    const project = c.get('project');
    const name = c.req.param('workflow');
    const [workflow, variants] = await Promise.all([
      store.getWorkflow(project.id, name),
      store.listVariants(project.id, name),
    ]);
    if (!workflow) {
      throw notFound(
        `Workflow "${name}"`,
        'Workflows appear here after their first `scope run`. List them with GET /api/v1/workflows.',
      );
    }
    return c.json(workflowDetailDto(workflow, variants) satisfies api.WorkflowDetail);
  });

  app.get('/api/v1/models', read, async (c) => {
    const q = parseQuery(c, WindowQuery);
    const w = window(deps, q.window);
    const items = await store.modelUsage(c.get('project').id, w);
    return c.json({
      window: { since: iso(w.since), until: iso(w.until) },
      items: items.map((m) => modelUsageDto(m, deps.pricing)),
    } satisfies api.ModelUsageList);
  });

  app.post('/api/v1/ingest', requireAccess(deps, 'ingest'), async (c) =>
    c.json(await handleIngest(c, deps)),
  );
}
