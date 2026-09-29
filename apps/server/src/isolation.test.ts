/**
 * Project isolation on a shared server, for every route in the route table. Two projects hold
 * data that is easy to recognise; with project A's key, every route is asked for project B's
 * runs, traces, spans and workflows by id — each must answer 404 — and every other route must
 * return nothing of B's. Driven by ROUTES, so a new route is covered as soon as it exists.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, summarizeRun, type TraceBundle } from '@scope-ai/core';
import { API_BASE, ROUTES } from '@scope-ai/protocol';
import { MemoryExporter, Tracer } from '@scope-ai/sdk';
import { type Project, Store } from '@scope-ai/storage';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp, type ScopeApp } from './app.ts';

let store: Store;
let app: ScopeApp['app'];
const keys: Record<'a' | 'b', string> = { a: '', b: '' };
/** Project B's identifiers, and text that appears only in its data. */
const secret = { runId: '', runNumber: 0, traceId: '', spanId: '', workflow: 'b-private-workflow' };
const MARK = 'B-PRIVATE';

async function seed(project: Project, workflow: string, mark: string) {
  const { workflowId, versionId } = await store.registerWorkflowVersion(project.id, {
    name: workflow,
    description: mark,
    hash: `${workflow}-1`,
    definition: { note: mark },
    source: `# ${mark}`,
    path: `workflows/${workflow}.yaml`,
  });
  const run = await store.createRun({
    projectId: project.id,
    workflowId,
    workflowVersionId: versionId,
    workflowName: workflow,
    variant: null,
    params: { note: mark },
    dataset: null,
    git: null,
    trigger: 'cli',
    baseline: {
      file: `baselines/${workflow}.json`,
      runNumber: 1,
      commit: null,
      createdAt: new Date().toISOString(),
    },
    caseCount: 1,
  });
  const exporter = new MemoryExporter();
  const tracer = new Tracer({ exporter });
  for (const runId of [run.id, null])
    await tracer.trace(
      `${workflow}-trace`,
      {
        input: { question: `${mark} question` },
        runId,
        caseId: runId ? 'case-1' : null,
        finalize: (trace) =>
          trace.addEvaluation({
            evaluator: `${workflow}-judge`,
            type: 'contains',
            kind: 'deterministic',
            status: 'failed',
            score: 0,
            threshold: null,
            reason: `${mark} reason`,
            metadata: {},
            durationMs: 1,
            spanId: null,
          }),
      },
      () =>
        tracer.span('answer', { kind: 'llm' }, (span) => {
          span.recordModelCall({
            provider: 'openai',
            model: `${workflow}-model`,
            usage: { inputTokens: 1, outputTokens: 1 },
          });
          return `${mark} answer`;
        }),
    );
  await store.ingest(project.id, exporter.bundles);
  await store.completeRun(run.id, {
    status: 'completed',
    summary: summarizeRun([]),
    gates: [],
    gateStatus: 'failed',
  });
  await store.saveBaselineComparison(project.id, {
    runId: run.id,
    baseline: {
      file: `baselines/${workflow}.json`,
      runNumber: 1,
      commit: null,
      createdAt: new Date().toISOString(),
    },
    metrics: [],
    counts: { regressed: 0, fixed: 0, changed: 0, unchanged: 0, added: 0, removed: 0 } as never,
    cases: [],
    config: null,
  });
  const trace = exporter.bundles.find((b) => b.trace.runId === null) as TraceBundle;
  return { run, trace };
}

beforeAll(async () => {
  store = await Store.open(`sqlite:${join(mkdtempSync(join(tmpdir(), 'scope-iso-')), 'db')}`);
  const a = await store.ensureProject('project-a');
  const b = await store.ensureProject('project-b');
  await seed(a, 'a-workflow', 'A-VISIBLE');
  const seeded = await seed(b, secret.workflow, MARK);
  secret.runId = seeded.run.id;
  secret.runNumber = seeded.run.number;
  secret.traceId = seeded.trace.trace.id;
  secret.spanId = seeded.trace.spans[0]?.id as string;
  keys.a = (await store.createApiKey(a.id, 'a', ['read', 'ingest'])).secret;
  keys.b = (await store.createApiKey(b.id, 'b', ['read', 'ingest'])).secret;
  ({ app } = createApp({ store, auth: { mode: 'api-key' } }));
});

afterAll(async () => {
  await store?.close();
});

const get = async (path: string, key: string) => {
  const res = await app.request(`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return { status: res.status, text: await res.text() };
};

/** Every GET route, with B's identifiers wherever a route takes one. */
function pathsWithBIds(route: (typeof ROUTES)[number]): string[] {
  const fill = (path: string) =>
    path
      .replace('{run}', secret.runId)
      .replace('{trace}', secret.traceId)
      .replace('{span}', secret.spanId)
      .replace('{workflow}', secret.workflow);
  if (route.path === '/comparisons')
    return [`/comparisons?base=${secret.runId}&head=1`, `/comparisons?base=1&head=${secret.runId}`];
  // Next to one of A's own runs, so the request is otherwise valid.
  if (route.path === '/comparisons/matrix') return [`/comparisons/matrix?runs=1,${secret.runId}`];
  return [fill(route.path)];
}

it('never shows one project’s data through another project’s key, on any route', async () => {
  // B's key sees B's data — so the ids below are real and reachable.
  expect((await get(`/traces/${secret.traceId}`, keys.b)).status).toBe(200);
  expect((await get(`/runs/${secret.runId}`, keys.b)).status).toBe(200);

  const checked: string[] = [];
  for (const route of ROUTES.filter((r) => r.method === 'get' && r.access !== 'public')) {
    for (const path of pathsWithBIds(route)) {
      const res = await get(path, keys.a);
      checked.push(path);
      if (route.path.includes('{')) expect(res.status, `${path} with project A's key`).toBe(404);
      else if (route.path.startsWith('/comparisons'))
        expect(res.status, `${path} with project A's key`).toBe(404);
      else expect(res.status, path).toBe(200);
      expect(res.text, `${path} leaks project B's data`).not.toContain(MARK);
      // A 404 names what was asked for; anything else must not mention B's ids at all.
      if (res.status !== 404) {
        expect(res.text, path).not.toContain(secret.traceId);
        expect(res.text, path).not.toContain(secret.workflow);
      }
    }
  }
  // Also by run number: A has its own run #1, and must get it, never B's.
  const byNumber = await get(`/runs/${secret.runNumber}`, keys.a);
  expect(byNumber.text).not.toContain(MARK);
  expect(checked.length).toBeGreaterThanOrEqual(
    ROUTES.filter((r) => r.method === 'get').length - 2,
  );
});

it('refuses to write into another project with a key', async () => {
  const res = await app.request(`${API_BASE}/ingest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${keys.a}`, 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'project-b', traces: [], spans: [], evaluations: [] }),
  });
  expect(res.status).toBe(403);
  const otlp = await app.request('/v1/traces', {
    method: 'POST',
    headers: { authorization: `Bearer ${keys.a}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'scope.project', value: { stringValue: 'project-b' } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'e'.repeat(32),
                  spanId: 'e'.repeat(16),
                  name: 'into-b',
                  startTimeUnixNano: '1700000000000000000',
                  endTimeUnixNano: '1700000000100000000',
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  expect(otlp.status).toBe(403);
  // Reusing B's trace id from A's key must not touch B's trace.
  const hijack = await app.request('/v1/traces', {
    method: 'POST',
    headers: { authorization: `Bearer ${keys.a}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: {},
          scopeSpans: [
            {
              spans: [
                {
                  traceId: secret.traceId,
                  spanId: 'f'.repeat(16),
                  name: 'hijack',
                  startTimeUnixNano: '1700000000000000000',
                  endTimeUnixNano: '1700000000100000000',
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  expect(hijack.status).toBe(200);
  expect(await hijack.json()).toMatchObject({ partialSuccess: { rejectedSpans: '1' } });
  const detail = await get(`/traces/${secret.traceId}`, keys.b);
  expect(detail.text).not.toContain('hijack');
});

it('logs which key and project each request used, never the key', async () => {
  const readKey = (
    await store.createApiKey(
      (
        await store.getProjectBySlug('project-b')
      )?.id as string,
      'read-only',
      ['read'],
    )
  ).secret;
  const raw: string[] = [];
  const logger = createLogger({ level: 'info', format: 'json', write: (line) => raw.push(line) });
  const { app: logged } = createApp({ store, auth: { mode: 'api-key' }, logger });
  await logged.request(`${API_BASE}/runs`, { headers: { authorization: `Bearer ${keys.b}` } });
  const lines = raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  const request = lines.find((l) => l.msg === 'request');
  expect(request).toMatchObject({ project: 'project-b', keyId: expect.stringMatching(/^key_/) });
  // A refused request names its key too; health checks that pass are not logged.
  await logged.request(`${API_BASE}/ingest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${readKey}`, 'content-type': 'application/json' },
    body: '{"traces":[],"spans":[],"evaluations":[]}',
  });
  await logged.request('/healthz');
  const after = raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(after.find((l) => l.status === 403)).toMatchObject({
    keyId: expect.stringMatching(/^key_/),
  });
  expect(after.some((l) => l.route === '/healthz')).toBe(false);
  expect(raw.join('\n')).not.toContain(keys.b);
});
