import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivacyPolicy, isScopeError, SCOPE_VERSION } from '@scope-ai/core';
import {
  API_BASE,
  type Run as ApiRun,
  type BaselineComparison,
  ErrorBody,
  ROUTES,
  type RunCasePage,
  type RunMatrix,
  type TraceDetail,
  type TracePage,
} from '@scope-ai/protocol';
import { HttpExporter, Tracer } from '@scope-ai/sdk';
import { type Project, type Run, Store } from '@scope-ai/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWorkflow, writeProject } from './__tests__/seed.ts';
import { createApp } from './app.ts';
import { isLoopbackHost, startServer } from './server.ts';

let store: Store;
let project: Project;
let runs: Run[];
let app: ReturnType<typeof createApp>['app'];

const hex = (n: number, fill: string) => fill.repeat(n);

beforeAll(async () => {
  const root = writeProject();
  store = await Store.open(`sqlite:${join(root, '.scope', 'scope.db')}`);
  project = await store.ensureProject('demo');
  const first = await runWorkflow(store, project, root);
  // The terse variant, compared with a baseline saved from the first run.
  runs = [first, await runWorkflow(store, project, root, 'terse', first)];
  ({ app } = createApp({ store, auth: { mode: 'none', defaultProject: project } }));
});

afterAll(async () => {
  await store?.close();
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await app.request(path, { headers });
  return { res, status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function ingest(target: typeof app, body: unknown, headers: Record<string, string> = {}) {
  return target.request(`${API_BASE}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function sdkTrace(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    runId: null,
    caseId: null,
    name: 'chat',
    status: 'ok',
    startTime: 1_000,
    endTime: 1_050,
    durationMs: 50,
    input: { question: 'hi' },
    output: 'hello',
    metadata: {},
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    costUsd: 0,
    spanCount: 1,
    llmCallCount: 0,
    ...extra,
  };
}

function sdkSpan(traceId: string, id: string, extra: Record<string, unknown> = {}) {
  return {
    traceId,
    id,
    parentId: null,
    name: 'chat',
    kind: 'workflow',
    status: 'ok',
    statusMessage: null,
    startTime: 1_000,
    endTime: 1_050,
    durationMs: 50,
    input: null,
    output: null,
    attributes: {},
    events: [],
    error: null,
    provider: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    ...extra,
  };
}

describe('contract', () => {
  it('serves every route in the route table with a body that matches its schema', async () => {
    const [first, second] = runs as [Run, Run];
    const trace = (await get(`${API_BASE}/traces?limit=1`)).body as unknown as TracePage;
    const traceId = trace.items[0]?.id as string;
    const concrete: Record<string, string> = {
      '/runs/{run}': `/runs/${first.number}`,
      '/runs/{run}/cases': `/runs/${first.id}/cases`,
      '/runs/{run}/baseline-comparison': `/runs/${second.number}/baseline-comparison`,
      '/comparisons': `/comparisons?base=${first.number}&head=${second.number}`,
      '/comparisons/matrix': `/comparisons/matrix?runs=${first.number},${second.number}`,
      '/traces/{trace}': `/traces/${traceId}`,
      '/workflows/{workflow}': '/workflows/support',
    };
    for (const route of ROUTES.filter((r) => r.method === 'get')) {
      const path = `${API_BASE}${concrete[route.path] ?? route.path}`;
      const { status, body } = await get(path);
      expect(status, path).toBe(200);
      const parsed = route.response.safeParse(body);
      expect(parsed.error?.issues ?? [], path).toEqual([]);
    }
  });

  it('serves the OpenAPI document', async () => {
    const { status, body } = await get(`${API_BASE}/openapi.json`);
    expect(status).toBe(200);
    expect(body.openapi).toBe('3.1.0');
  });

  it('answers unknown API routes with the error envelope', async () => {
    const { status, body, res } = await get(`${API_BASE}/nope`);
    expect(status).toBe(404);
    expect(ErrorBody.parse(body).error).toMatchObject({ code: 'not_found' });
    expect((body.error as { requestId: string }).requestId).toBe(res.headers.get('x-request-id'));
  });
});

describe('runs', () => {
  it('lists newest first with keyset pagination', async () => {
    const page1 = await get(`${API_BASE}/runs?limit=1`);
    const items1 = page1.body.items as Array<{ number: number }>;
    expect(items1.map((r) => r.number)).toEqual([2]);
    const page2 = await get(`${API_BASE}/runs?limit=1&cursor=${page1.body.nextCursor}`);
    expect((page2.body.items as Array<{ number: number }>).map((r) => r.number)).toEqual([1]);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('filters by variant', async () => {
    const { body } = await get(`${API_BASE}/runs?variant=terse`);
    expect((body.items as Array<{ variant: string }>).map((r) => r.variant)).toEqual(['terse']);
  });

  it('finds runs by number, #number and id', async () => {
    const run = runs[0] as Run;
    for (const ref of ['1', '%231', run.id]) {
      const { status, body } = await get(`${API_BASE}/runs/${ref}`);
      expect(status, ref).toBe(200);
      expect(body).toMatchObject({
        id: run.id,
        number: 1,
        workflow: 'support',
        status: 'completed',
      });
    }
  });

  it('treats odd run references as not found, never as server errors', async () => {
    for (const path of ['/runs/%25', '/runs/%2525', '/traces?run=%25', '/runs/%E2%9C%93/cases']) {
      const { status, body } = await get(`${API_BASE}${path}`);
      expect(status, path).toBe(404);
      expect((body.error as { code: string }).code, path).toBe('not_found');
    }
  });

  it('returns 404 with a hint for unknown runs', async () => {
    const { status, body } = await get(`${API_BASE}/runs/99`);
    expect(status).toBe(404);
    expect(body.error).toMatchObject({ code: 'not_found', message: 'Run #99 not found' });
    expect((body.error as { hint: string }).hint).toContain('/api/v1/runs');
  });

  it('lists a run’s failed cases with their evaluations', async () => {
    const { body } = await get(`${API_BASE}/runs/1/cases?outcome=failed`);
    const items = body.items as Array<{ caseId: string; evaluations: Array<{ status: string }> }>;
    expect(items.map((c) => c.caseId)).toContain('store-hours');
    for (const c of items) expect(c.evaluations.some((e) => e.status === 'failed')).toBe(true);
  });

  it('compares two runs', async () => {
    const { status, body } = await get(`${API_BASE}/comparisons?base=1&head=2`);
    expect(status).toBe(200);
    expect(body.base).toMatchObject({ run: { number: 1, variant: null } });
    expect(body.head).toMatchObject({ run: { number: 2, variant: 'terse' } });
    expect(body.headline).toContain('pass_rate');
    // The terse variant of the same workflow file, over the same dataset.
    expect(body.config).toEqual({
      params: [{ key: 'sentences', base: 2, head: 1 }],
      workflowChanged: false,
      datasetChanged: false,
      paramsKnown: true,
    });
    const counts = body.counts as Record<string, number>;
    const cases = body.cases as Array<{ kind: string }>;
    expect(cases.every((c) => c.kind !== 'unchanged')).toBe(true);
    const all = await get(`${API_BASE}/comparisons?base=1&head=2&includeUnchanged=true`);
    expect((all.body.cases as unknown[]).length).toBe(
      Object.values(counts).reduce((a, b) => a + b, 0),
    );
  });

  it('rejects comparisons with a missing parameter', async () => {
    const { status, body } = await get(`${API_BASE}/comparisons?base=1`);
    expect(status).toBe(400);
    expect(body.error).toMatchObject({ code: 'bad_request' });
    expect(
      (body.error as { details: { issues: Array<{ path: string }> } }).details.issues[0]?.path,
    ).toBe('head');
  });
});

describe('traces', () => {
  it('filters by run and evaluation outcome', async () => {
    const { body } = await get(`${API_BASE}/traces?run=1&eval=failed`);
    const items = (body as unknown as TracePage).items;
    expect(items.length).toBeGreaterThan(0);
    for (const t of items) {
      expect(t.run?.number).toBe(1);
      expect(t.evalStatus).toBe('failed');
    }
  });

  it('searches inputs', async () => {
    const { body } = await get(`${API_BASE}/traces?q=gift%20card`);
    const items = (body as unknown as TracePage).items;
    expect(items.map((t) => t.caseId)).toEqual(['gift-cards', 'gift-cards']);
  });

  it('sorts and paginates without overlap', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let previous = Number.POSITIVE_INFINITY;
    do {
      const query: string = `${API_BASE}/traces?sort=slowest&limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await get(query)).body as unknown as TracePage;
      for (const t of page.items) {
        expect(seen.has(t.id)).toBe(false);
        expect(t.durationMs).toBeLessThanOrEqual(previous);
        previous = t.durationMs;
        seen.add(t.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(10);
  });

  it('validates query parameters', async () => {
    const bad = await get(`${API_BASE}/traces?sort=random&limit=1000`);
    expect(bad.status).toBe(400);
    const paths = (
      bad.body.error as { details: { issues: Array<{ path: string }> } }
    ).details.issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['sort', 'limit']));
    const cursor = await get(`${API_BASE}/traces?cursor=garbage`);
    expect(cursor.status).toBe(400);
    expect((cursor.body.error as { message: string }).message).toBe('Invalid pagination cursor');
  });

  it('returns the full trace with span offsets and evaluations', async () => {
    const list = (await get(`${API_BASE}/traces?run=1&case=refund-time`))
      .body as unknown as TracePage;
    const id = list.items[0]?.id as string;
    const detail = (await get(`${API_BASE}/traces/${id.slice(0, 8)}`))
      .body as unknown as TraceDetail;
    expect(detail.trace.id).toBe(id);
    expect(detail.run).toMatchObject({ number: 1, workflow: 'support' });
    const kinds = detail.spans.map((s) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(['workflow', 'retrieval', 'llm', 'evaluation']));
    for (const s of detail.spans) expect(s.offsetMs).toBeGreaterThanOrEqual(0);
    const llm = detail.spans.find((s) => s.kind === 'llm');
    expect(llm).toMatchObject({ provider: 'local', model: 'extractive' });
    expect(detail.evaluations.map((e) => e.evaluator)).toEqual(['grounded', 'key_facts']);
    expect(detail.trace.metadata.expected).toEqual(['5 to 7 business days']);
  });

  it('lays two to four runs side by side', async () => {
    const [first, second] = runs as [Run, Run];
    const { status, body } = await get(
      `${API_BASE}/comparisons/matrix?runs=${first.number},${second.id}`,
    );
    expect(status).toBe(200);
    const matrix = body as unknown as RunMatrix;
    expect(matrix.runs.map((r) => r.run.variant)).toEqual([null, 'terse']);
    expect(matrix.runs[1]?.params).toMatchObject({ sentences: 1 });
    const passRate = matrix.metrics.find((m) => m.id === 'pass_rate');
    expect(passRate?.values).toEqual([first.passRate, second.passRate]);
    expect(matrix.headline[0]).toBe('pass_rate');
    expect(matrix.caseCount).toBe(5);
    for (const row of matrix.cases) expect(new Set(row.outcomes).size).toBeGreaterThan(1);

    const one = await get(`${API_BASE}/comparisons/matrix?runs=${first.number}`);
    expect(one.status).toBe(400);
    expect((one.body.error as { message: string }).message).toBe(
      'Compare 2 to 4 runs side by side (got 1)',
    );
    const five = await get(`${API_BASE}/comparisons/matrix?runs=1,2,3,4,5`);
    expect(five.status).toBe(400);
    const missing = await get(`${API_BASE}/comparisons/matrix?runs=1,99`);
    expect(missing.status).toBe(404);
  });

  it('returns the comparison a run made with its baseline', async () => {
    const [first, second] = runs as [Run, Run];
    const { status, body } = await get(`${API_BASE}/runs/${second.number}/baseline-comparison`);
    expect(status).toBe(200);
    const data = body as unknown as BaselineComparison;
    expect(data.run).toMatchObject({ number: second.number, variant: 'terse' });
    expect(data.baseline).toMatchObject({ file: 'baselines/support.json', runId: first.id });
    expect(data.baselineRun).toEqual({ id: first.id, number: first.number });
    expect(data.config).toEqual({
      params: [{ key: 'sentences', base: 2, head: 1 }],
      workflowChanged: false,
      datasetChanged: false,
      paramsKnown: true,
    });
    expect(data.headline[0]).toBe('pass_rate');
    // Every case is counted; only the changed ones are listed.
    const counted = Object.values(data.counts).reduce((a, b) => a + b, 0);
    expect(counted).toBe(5);
    expect(data.cases).toHaveLength(counted - data.counts.unchanged);
    expect(data.cases.map((c) => c.kind)).not.toContain('unchanged');
    expect(data.omittedCases).toBe(0);
    // The run itself names its baseline's source run by id.
    const run = (await get(`${API_BASE}/runs/${second.number}`)).body as unknown as ApiRun;
    expect(run.baseline).toMatchObject({ runId: first.id, runNumber: first.number });

    const none = await get(`${API_BASE}/runs/${first.number}/baseline-comparison`);
    expect(none.status).toBe(404);
    expect((none.body.error as { hint: string }).hint).toContain('scope baseline save');
  });

  it('places each case among the failing cases of its run', async () => {
    let failingSeen = 0;
    for (const run of [1, 2]) {
      const { items } = (await get(`${API_BASE}/runs/${run}/cases`)).body as unknown as RunCasePage;
      const failing = items.filter((c) => c.outcome !== 'passed');
      failingSeen += failing.length;
      for (const c of items) {
        const detail = (await get(`${API_BASE}/traces/${c.traceId}`))
          .body as unknown as TraceDetail;
        const at = failing.findIndex((f) => f.traceId === c.traceId);
        const before = failing.filter((f) => f.caseId < c.caseId);
        const after = failing.filter((f) => f.caseId > c.caseId);
        const link = (f: (typeof failing)[number] | undefined) =>
          f ? { caseId: f.caseId, traceId: f.traceId } : null;
        expect(detail.failingCases, `run ${run} ${c.caseId}`).toEqual({
          total: failing.length,
          position: at >= 0 ? at + 1 : null,
          previous: link(before.at(-1)),
          next: link(after[0]),
        });
      }
    }
    expect(failingSeen).toBeGreaterThan(1);
  });

  it('returns 404 for unknown traces and explains malformed ids', async () => {
    const missing = await get(`${API_BASE}/traces/${hex(32, 'f')}`);
    expect(missing.status).toBe(404);
    const malformed = await get(`${API_BASE}/traces/not-an-id`);
    expect(malformed.status).toBe(404);
    expect((malformed.body.error as { hint: string }).hint).toContain('hexadecimal');
  });
});

describe('analytics', () => {
  it('summarizes the project in the overview', async () => {
    const { body } = await get(`${API_BASE}/overview?window=24h`);
    expect(body.traces).toMatchObject({ total: 10, errors: 0 });
    expect(body.runs).toMatchObject({ total: 2 });
    // Hour-aligned buckets: the first and last are partial, so 24 hours span 24 or 25 buckets.
    expect((body.series as unknown[]).length).toBeGreaterThanOrEqual(24);
    expect((body.series as unknown[]).length).toBeLessThanOrEqual(25);
    expect((body.runTrend as Array<{ number: number }>).map((r) => r.number)).toEqual([1, 2]);
    expect((body.recentFailures as Array<{ caseId: string }>).map((t) => t.caseId)).toContain(
      'store-hours',
    );
  });

  it('labels local models and their missing prices honestly', async () => {
    const { body } = await get(`${API_BASE}/models`);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      provider: 'local',
      model: 'extractive',
      usage: 'workflow',
      calls: 10,
      local: true,
      price: null,
    });
  });

  it('reports evaluator health with a per-run trend', async () => {
    const { body } = await get(`${API_BASE}/evaluators`);
    const keyFacts = (body.items as Array<Record<string, unknown>>).find(
      (e) => e.evaluator === 'key_facts',
    );
    expect(keyFacts).toMatchObject({
      kind: 'deterministic',
      type: 'contains',
      trend: [{ runNumber: 1 }, { runNumber: 2 }],
    });
  });

  it('lists failing evaluation results for a run', async () => {
    const { body } = await get(`${API_BASE}/evaluations?run=1&status=failed&evaluator=key_facts`);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const e of items) expect(e).toMatchObject({ evaluator: 'key_facts', status: 'failed' });
  });

  it('shows workflow definitions and variants', async () => {
    const { body } = await get(`${API_BASE}/workflows/support`);
    expect(body.variants).toEqual(['terse']);
    expect((body.latest as { source: string }).source).toContain('name: support');
    expect((await get(`${API_BASE}/workflows/nope`)).status).toBe(404);
  });

  it('describes the project, storage and privacy policy', async () => {
    const { body } = await get(`${API_BASE}/project`);
    expect(body.project).toMatchObject({ slug: 'demo' });
    expect(body.server).toMatchObject({ auth: 'none', storage: { dialect: 'sqlite' } });
    expect((body.privacy as { redactionRules: string[] }).redactionRules).toContain('openai_key');
    expect(body.stats).toMatchObject({ runs: 2, traces: 10 });
  });
});

describe('ingestion', () => {
  it('stores SDK traces sent over HTTP', async () => {
    const server = await startServer({
      store,
      auth: { mode: 'none', defaultProject: project },
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const tracer = new Tracer({
        exporter: new HttpExporter({ url: server.url, flushIntervalMs: 10 }),
      });
      await tracer.trace('sdk-app', { input: { question: 'what is scope?' } }, async () => {
        await tracer.span('lookup', { kind: 'retrieval' }, () => ['doc']);
        return tracer.span('generate', { kind: 'llm' }, (span) => {
          span.recordModelCall({
            provider: 'openai',
            model: 'gpt-5',
            usage: { inputTokens: 1000, outputTokens: 200 },
          });
          return 'an observability tool';
        });
      });
      await tracer.flush();
      const page = (await get(`${API_BASE}/traces?name=sdk-app`)).body as unknown as TracePage;
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ run: null, spanCount: 3, llmCallCount: 1 });
      expect(page.items[0]?.costUsd).toBeCloseTo((1000 * 1.25 + 200 * 10) / 1e6);
      // Outside a run there are no failing cases to step through.
      const detail = (await get(`${API_BASE}/traces/${page.items[0]?.id}`))
        .body as unknown as TraceDetail;
      expect(detail.failingCases).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('redacts secrets and recomputes rollups on the server', async () => {
    const id = hex(32, 'a');
    const res = await ingest(app, {
      traces: [
        sdkTrace(id, {
          input: { prompt: 'use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' },
          usage: { inputTokens: 999_999, outputTokens: 0, totalTokens: 999_999 },
          costUsd: 12,
        }),
      ],
      spans: [
        sdkSpan(id, hex(16, '1')),
        sdkSpan(id, hex(16, '2'), {
          parentId: hex(16, '1'),
          kind: 'llm',
          provider: 'acme',
          model: 'm',
          inputTokens: 10,
          outputTokens: 5,
          costUsd: null,
          attributes: {
            'http.header': 'Bearer abcdefghijklmnopqrstuvwxyz',
            // Masked by key, whatever the value looks like (a client that skips the SDK).
            'http.request.header.authorization': 'Basic dXNlcjpwYXNz',
            'app.openai_api_key': 'plain-value',
          },
        }),
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ project: 'demo', accepted: { traces: 1, spans: 2 } });
    const detail = (await get(`${API_BASE}/traces/${id}`)).body as unknown as TraceDetail;
    expect(JSON.stringify(detail.trace.input)).toContain('[redacted:anthropic_key]');
    expect(detail.trace.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(detail.trace.costUsd).toBeNull();
    expect(detail.spans[1]?.attributes).toMatchObject({
      'http.header': 'Bearer [redacted:bearer_token]',
      'http.request.header.authorization': '[redacted:sensitive_field]',
      'app.openai_api_key': '[redacted:sensitive_field]',
    });
  });

  it('drops content when the server does not capture it', async () => {
    const { app: private_ } = createApp({
      store,
      auth: { mode: 'none', defaultProject: project },
      privacy: createPrivacyPolicy({ captureContent: false }),
    });
    const id = hex(32, 'b');
    await ingest(private_, {
      traces: [sdkTrace(id)],
      spans: [sdkSpan(id, hex(16, '1'), { input: { secret: 'x' }, output: 'y' })],
    });
    const detail = (await get(`${API_BASE}/traces/${id}`)).body as unknown as TraceDetail;
    expect(detail.trace.input).toBeNull();
    expect(detail.trace.output).toBeNull();
    expect(detail.spans[0]).toMatchObject({ input: null, output: null });
    expect(detail.spans[0]?.attributes['scope.content.omitted']).toBe(true);
  });

  it('keeps at most the configured spans per trace, roots first', async () => {
    const { app: limited } = createApp({
      store,
      auth: { mode: 'none', defaultProject: project },
      maxSpansPerTrace: 2,
    });
    const id = hex(32, 'c');
    const children = ['2', '3', '4'].map((n, i) =>
      sdkSpan(id, hex(16, n), { parentId: hex(16, '1'), startTime: 1_010 + i }),
    );
    const res = await ingest(limited, {
      traces: [sdkTrace(id)],
      spans: [...children, sdkSpan(id, hex(16, '1'))],
    });
    expect(await res.json()).toMatchObject({ accepted: { spans: 2 }, droppedSpans: 2 });
    const detail = (await get(`${API_BASE}/traces/${id}`)).body as unknown as TraceDetail;
    expect(detail.spans.map((s) => s.id)).toEqual([hex(16, '1'), hex(16, '2')]);
    expect(detail.trace.metadata['scope.dropped_spans']).toBe(2);
  });

  it('is idempotent per trace id', async () => {
    const id = hex(32, 'd');
    const body = { traces: [sdkTrace(id)], spans: [sdkSpan(id, hex(16, '1'))] };
    await ingest(app, body);
    await ingest(app, body);
    const page = (await get(`${API_BASE}/traces?q=${id}`)).body as unknown as TracePage;
    expect(page.items).toHaveLength(1);
  });

  it('routes traces to a named project without authentication', async () => {
    const id = hex(32, 'e');
    const res = await ingest(app, { project: 'side-project', traces: [sdkTrace(id)] });
    expect(await res.json()).toMatchObject({ project: 'side-project' });
    const own = (await get(`${API_BASE}/traces?q=${id}`)).body as unknown as TracePage;
    expect(own.items).toHaveLength(0);
    const other = (await get(`${API_BASE}/traces?q=${id}`, { 'x-scope-project': 'side-project' }))
      .body as unknown as TracePage;
    expect(other.items).toHaveLength(1);
    const unknown = await get(`${API_BASE}/traces`, { 'x-scope-project': 'nope' });
    expect(unknown.status).toBe(404);
    const invalid = await ingest(app, { project: 'Bad Name!', traces: [] });
    expect(invalid.status).toBe(400);
  });

  it('rejects malformed requests with precise errors', async () => {
    const id = hex(32, 'f');
    const cases: Array<[string, Response, number, RegExp]> = [
      ['invalid JSON', await ingest(app, '{'), 400, /not valid JSON/],
      [
        'wrong content type',
        await app.request(`${API_BASE}/ingest`, { method: 'POST', body: '{}' }),
        415,
        /application\/json/,
      ],
      ['missing traces', await ingest(app, {}), 400, /traces/],
      [
        'bad span id',
        await ingest(app, { traces: [sdkTrace(id)], spans: [sdkSpan(id, 'xyz')] }),
        400,
        /spans\.0\.id/,
      ],
      [
        'orphan span',
        await ingest(app, { traces: [sdkTrace(id)], spans: [sdkSpan(hex(32, '9'), hex(16, '1'))] }),
        400,
        /not in this request/,
      ],
      [
        'unknown run',
        await ingest(app, { traces: [sdkTrace(id, { runId: 'run_01J00000000000000000000000' })] }),
        400,
        /does not exist/,
      ],
      [
        'protocol version',
        await ingest(app, { traces: [] }, { 'scope-protocol': '9' }),
        400,
        /Unsupported scope-protocol/,
      ],
    ];
    for (const [label, res, status, message] of cases) {
      expect(res.status, label).toBe(status);
      const body = ErrorBody.parse(await res.json());
      expect(body.error.message, label).toMatch(message);
    }
  });

  it('enforces the body size limit', async () => {
    const { app: small } = createApp({
      store,
      auth: { mode: 'none', defaultProject: project },
      maxIngestBytes: 1024,
    });
    const res = await ingest(small, {
      traces: [sdkTrace(hex(32, '7'), { output: 'x'.repeat(4096) })],
    });
    expect(res.status).toBe(413);
    expect(ErrorBody.parse(await res.json()).error.code).toBe('payload_too_large');
  });
});

describe('API keys', () => {
  let keyed: typeof app;
  let readKey: string;
  let ingestKey: string;
  let otherKey: string;

  beforeAll(async () => {
    ({ app: keyed } = createApp({ store, auth: { mode: 'api-key' } }));
    readKey = (await store.createApiKey(project.id, 'dashboard', ['read'])).secret;
    ingestKey = (await store.createApiKey(project.id, 'app', ['ingest'])).secret;
    const other = await store.ensureProject('other');
    otherKey = (await store.createApiKey(other.id, 'other', ['read', 'ingest'])).secret;
  });

  const auth = (key: string) => ({ authorization: `Bearer ${key}` });

  it('requires a key, except for /info', async () => {
    const missing = await keyed.request(`${API_BASE}/runs`);
    expect(missing.status).toBe(401);
    expect(ErrorBody.parse(await missing.json()).error.hint).toContain('scope keys create');
    const bad = await keyed.request(`${API_BASE}/runs`, { headers: auth('scope_nope') });
    expect(bad.status).toBe(401);
    const info = await keyed.request(`${API_BASE}/info`);
    expect(await info.json()).toMatchObject({ auth: 'api-key' });
  });

  it('checks scopes', async () => {
    expect((await keyed.request(`${API_BASE}/runs`, { headers: auth(readKey) })).status).toBe(200);
    const read = await keyed.request(`${API_BASE}/runs`, { headers: auth(ingestKey) });
    expect(read.status).toBe(403);
    expect(ErrorBody.parse(await read.json()).error.message).toContain('"read" scope');
    expect((await ingest(keyed, { traces: [] }, auth(readKey))).status).toBe(403);
    expect((await ingest(keyed, { traces: [] }, auth(ingestKey))).status).toBe(200);
  });

  it('bounds every query by the key’s project', async () => {
    const res = await keyed.request(`${API_BASE}/runs/1`, { headers: auth(otherKey) });
    expect(res.status).toBe(404);
    const mismatch = await ingest(keyed, { project: 'demo', traces: [] }, auth(otherKey));
    expect(mismatch.status).toBe(403);
  });

  it('never returns key secrets or hashes', async () => {
    const res = await keyed.request(`${API_BASE}/api-keys`, { headers: auth(readKey) });
    const text = await res.text();
    expect(text).not.toContain(readKey);
    expect(text).not.toContain('hash');
    expect(JSON.parse(text).items.map((k: { name: string }) => k.name)).toEqual(
      expect.arrayContaining(['dashboard', 'app']),
    );
  });
});

describe('dashboard hosting', () => {
  it('explains how to build the dashboard when it is missing', async () => {
    const res = await app.request('/traces/abc');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('npm run build -w @scope-ai/web');
  });

  it('serves assets and falls back to the app shell', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'scope-web-'));
    const web = join(parent, 'dist');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(parent, 'secret.txt'), 'do not serve');
    writeFileSync(join(web, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(web, 'assets', 'app-123.js'), 'console.log(1)');
    const { app: hosted } = createApp({
      store,
      auth: { mode: 'none', defaultProject: project },
      webRoot: web,
    });
    const asset = await hosted.request('/assets/app-123.js');
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    for (const path of ['/', '/runs/1', '/traces/abc?span=1'])
      expect(await (await hosted.request(path)).text(), path).toContain('id="root"');
    expect((await hosted.request('/assets/missing.js')).status).toBe(404);
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const res = await hosted.request(path);
      expect(await res.text(), path).not.toContain('do not serve');
    }
    expect((await hosted.request(`${API_BASE}/nope`)).status).toBe(404);
  });
});

describe('operations', () => {
  it('reports health and readiness', async () => {
    expect(await (await app.request('/healthz')).json()).toEqual({ status: 'ok' });
    expect(await (await app.request('/readyz')).json()).toEqual({ status: 'ready' });
  });

  it('exposes Prometheus metrics with bounded route labels', async () => {
    await app.request(`${API_BASE}/runs/1`);
    const text = await (await app.request('/metrics')).text();
    expect(text).toContain(`scope_build_info{version="${SCOPE_VERSION}"} 1`);
    expect(text).toMatch(
      /scope_http_requests_total\{method="GET",route="\/api\/v1\/runs\/:run",status="200"\} \d+/,
    );
    expect(text).toContain('scope_http_request_duration_seconds_bucket');
  });

  it('sets security headers and request ids', async () => {
    const res = await app.request('/api/v1/info', { headers: { 'x-request-id': 'abc-123' } });
    expect(res.headers.get('x-request-id')).toBe('abc-123');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const replaced = await app.request('/api/v1/info', { headers: { 'x-request-id': 'bad id!' } });
    expect(replaced.headers.get('x-request-id')).toMatch(/^req_/);
  });

  it('rejects requests addressed to other hosts when allowed hosts are set (DNS rebinding)', async () => {
    const { app: local } = createApp({
      store,
      auth: { mode: 'none', defaultProject: project },
      allowedHosts: ['localhost', '127.0.0.1', '::1'],
    });
    const rebound = await local.request('http://attacker.example:4700/api/v1/runs');
    expect(rebound.status).toBe(403);
    expect(ErrorBody.parse(await rebound.json()).error.message).toContain('"attacker.example"');
    for (const origin of ['http://localhost:4700', 'http://127.0.0.1:4700', 'http://[::1]:4700']) {
      expect((await local.request(`${origin}/api/v1/info`)).status, origin).toBe(200);
    }
  });

  it('reports a port that is already in use', async () => {
    const first = await startServer({
      store,
      auth: { mode: 'none', defaultProject: project },
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const error = await startServer({
        store,
        auth: { mode: 'none', defaultProject: project },
        host: '127.0.0.1',
        port: first.port,
      }).catch((e: unknown) => e);
      expect(isScopeError(error, 'usage')).toBe(true);
      expect((error as Error).message).toBe(`Port ${first.port} is already in use`);
    } finally {
      await first.close();
    }
  });

  it('recognizes loopback hosts', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3'])
      expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.2', 'example.com'])
      expect(isLoopbackHost(h), h).toBe(false);
  });
});
