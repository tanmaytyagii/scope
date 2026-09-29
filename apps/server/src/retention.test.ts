/** Scheduled retention (`scope server --retention`): old data goes, new data stays. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceBundle } from '@scope-ai/core';
import { MemoryExporter, Tracer } from '@scope-ai/sdk';
import { Store } from '@scope-ai/storage';
import { expect, it } from 'vitest';
import { startServer } from './server.ts';

it('deletes data older than the retention age when the server starts, and counts it', async () => {
  const store = await Store.open(`sqlite:${join(mkdtempSync(join(tmpdir(), 'scope-ret-')), 'db')}`);
  const project = await store.ensureProject('demo');
  const exporter = new MemoryExporter();
  const tracer = new Tracer({ exporter });
  await tracer.trace('old', {}, () => 'x');
  await tracer.trace('new', {}, () => 'y');
  const [old, fresh] = exporter.bundles as [TraceBundle, TraceBundle];
  const age = 40 * 86_400_000;
  await store.ingest(project.id, [
    {
      ...old,
      trace: {
        ...old.trace,
        startTime: old.trace.startTime - age,
        endTime: old.trace.endTime - age,
      },
      spans: old.spans.map((s) => ({
        ...s,
        startTime: s.startTime - age,
        endTime: s.endTime - age,
      })),
    },
    fresh,
  ]);
  const server = await startServer({
    store,
    auth: { mode: 'none', defaultProject: project },
    host: '127.0.0.1',
    port: 0,
    retentionMs: 30 * 86_400_000,
  });
  try {
    await server.retention?.runOnce();
    expect(await store.getTrace(project.id, old.trace.id)).toBeNull();
    expect(await store.getTrace(project.id, fresh.trace.id)).not.toBeNull();
    const metrics = await (await fetch(`${server.url}/metrics`)).text();
    expect(metrics).toContain('scope_retention_deleted_total{kind="traces"} 1');
  } finally {
    await server.close();
    await store.close();
  }
});
