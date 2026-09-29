#!/usr/bin/env node
/**
 * Performance measurements on a synthetic project, so changes that affect speed are measured,
 * not guessed. Data is generated with the real tracer (clearly benchmark data, in a temporary
 * database), ingested through the store, and read through the HTTP API as the dashboard does.
 *
 *   node --conditions=scope-source scripts/bench.mjs [--traces 20000] [--spans 1000]
 *
 * Prints ingestion throughput, API timings (median of 5) and response sizes, including one
 * trace with the maximum number of spans.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryExporter, Tracer } from '@scope-ai/sdk';
import { createApp } from '@scope-ai/server';
import { Store } from '@scope-ai/storage';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const TRACES = arg('traces', 20_000);
const BIG_SPANS = arg('spans', 1000);

const dir = mkdtempSync(join(tmpdir(), 'scope-bench-'));
const store = await Store.open(`sqlite:${join(dir, 'bench.db')}`);
const project = await store.ensureProject('bench');
const { app } = createApp({ store, auth: { mode: 'none', defaultProject: project } });

const words = 'refund shipping order account invoice delivery return exchange warranty'.split(' ');
const pick = (i) => words[i % words.length];

async function bundles(count, spansPerTrace, offset) {
  const exporter = new MemoryExporter();
  const tracer = new Tracer({ exporter });
  for (let i = 0; i < count; i++) {
    const n = offset + i;
    await tracer.trace(
      'support',
      {
        input: { question: `How does ${pick(n)} work for order ${n}?` },
        finalize: (trace) =>
          trace.addEvaluation({
            evaluator: 'grounded',
            type: 'groundedness',
            kind: 'heuristic',
            status: n % 7 === 0 ? 'failed' : 'passed',
            score: n % 7 === 0 ? 0.4 : 0.9,
            threshold: 0.7,
            reason: 'benchmark',
            metadata: {},
            durationMs: 1,
            spanId: null,
          }),
      },
      async () => {
        for (let s = 0; s < spansPerTrace - 2; s++)
          await tracer.span(`step-${s}`, { kind: 'step', input: { s } }, () => `output ${s}`);
        return tracer.span('answer', { kind: 'llm' }, (span) => {
          span.recordModelCall({
            provider: 'openai',
            model: n % 3 ? 'gpt-5' : 'gpt-5-mini',
            usage: { inputTokens: 800 + (n % 100), outputTokens: 120 },
          });
          return `The ${pick(n)} policy for order ${n} is described in the help center.`;
        });
      },
    );
  }
  return exporter.bundles;
}

const ms = (start) => Math.round((performance.now() - start) * 10) / 10;

// ─── ingestion ───────────────────────────────────────────────────────────────────────────────
const BATCH = 500;
let started = performance.now();
for (let offset = 0; offset < TRACES; offset += BATCH) {
  const batch = await bundles(Math.min(BATCH, TRACES - offset), 6, offset);
  await store.ingest(project.id, batch);
}
const ingestMs = ms(started);
console.log(
  `ingest   ${TRACES} traces × 6 spans in ${ingestMs} ms (${Math.round(TRACES / (ingestMs / 1000))} traces/s)`,
);
started = performance.now();
const [big] = await bundles(1, BIG_SPANS, TRACES);
await store.ingest(project.id, [big]);
console.log(`ingest   1 trace × ${BIG_SPANS} spans in ${ms(started)} ms`);

// ─── API ─────────────────────────────────────────────────────────────────────────────────────
async function time(label, path) {
  const samples = [];
  let bytes = 0;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const res = await app.request(`/api/v1${path}`);
    const text = await res.text();
    samples.push(performance.now() - t);
    bytes = text.length;
    if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  samples.sort((a, b) => a - b);
  const median = Math.round((samples[2] ?? 0) * 10) / 10;
  console.log(
    `${label.padEnd(34)} ${String(median).padStart(8)} ms  ${String(Math.round(bytes / 1024)).padStart(6)} KiB`,
  );
}

console.log('\nGET (median of 5)                         time      size');
await time('overview (30d)', '/overview?window=30d');
await time('traces, first page', '/traces?limit=50');
await time('traces, search', `/traces?limit=50&q=${pick(3)}`);
await time('traces, failed evaluations', '/traces?limit=50&eval=failed');
await time('traces, slowest', '/traces?limit=50&sort=slowest');
await time('evaluators (30d)', '/evaluators?window=30d');
await time('evaluations, failed', '/evaluations?status=failed&limit=50');
await time('models (30d)', '/models?window=30d');
await time(`trace with ${BIG_SPANS} spans`, `/traces/${big.trace.id}`);

await store.close();
rmSync(dir, { recursive: true, force: true });
