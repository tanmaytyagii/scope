/**
 * The SDK's HTTP exporter against a real server: batches the server refuses (too large, or with
 * one invalid trace) lose only the traces that cannot be stored, never their neighbours.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TracePage } from '@scope-ai/protocol';
import { HttpExporter, Tracer } from '@scope-ai/sdk';
import { type Project, Store } from '@scope-ai/storage';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type RunningServer, startServer } from './server.ts';

let store: Store;
let project: Project;
let server: RunningServer;

beforeAll(async () => {
  store = await Store.open(`sqlite:${join(mkdtempSync(join(tmpdir(), 'scope-sdk-')), 'scope.db')}`);
  project = await store.ensureProject('demo');
  server = await startServer({
    store,
    auth: { mode: 'none', defaultProject: project },
    host: '127.0.0.1',
    port: 0,
    maxIngestBytes: 256 * 1024,
  });
});

afterAll(async () => {
  await server?.close();
  await store?.close();
});

it('stores every trace the server can accept when batches are refused', async () => {
  // The exporter's batches (up to 4 MiB) are larger than this server accepts (256 KiB).
  const exporter = new HttpExporter({ url: server.url, flushIntervalMs: 60_000 });
  const tracer = new Tracer({ exporter });
  const text = 'refund policy details '.repeat(900); // ~20 KB, twice per trace
  for (let i = 0; i < 20; i++)
    await tracer.trace(`ok-${i}`, { input: { text } }, () =>
      tracer.span('answer', { kind: 'llm' }, () => text),
    );
  // Larger than the server's limit on its own: it cannot be stored, whatever the batch.
  const huge = 'x'.repeat(60_000);
  await tracer.trace('too-large', { input: { a: huge, b: huge, c: huge } }, () =>
    tracer.span('s1', {}, () => huge),
  );
  // Names a run the project does not have: the server refuses this trace alone.
  await tracer.trace('unknown-run', { runId: 'run_missing' }, () => 'x');
  await tracer.shutdown();

  const page = (await (await fetch(`${server.url}/api/v1/traces?limit=100`)).json()) as TracePage;
  expect(page.items.map((t) => t.name).sort()).toEqual(
    Array.from({ length: 20 }, (_, i) => `ok-${i}`).sort(),
  );
  expect(exporter.stats).toMatchObject({ exportedTraces: 20, droppedTraces: 2 });
});
