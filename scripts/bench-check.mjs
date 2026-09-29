#!/usr/bin/env node
/**
 * A performance regression check that is stable on shared CI runners: it measures the same
 * operations at two database sizes (25 times apart) on the same machine and compares them with each other, never
 * with absolute numbers. Ingestion and reads that do not depend on the database's size must stay
 * roughly as fast when it is ten times larger; a query that walks a whole table or project gets
 * about ten times slower and fails the check.
 *
 *   node --conditions=scope-source scripts/bench-check.mjs [--small 2000] [--large 50000]
 *
 * Exit code 1 when a ratio is out of bounds. The thresholds are loose on purpose (they allow for
 * B-tree growth and noisy neighbours); what they catch is work that grows with the data.
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
const SMALL = arg('small', 2000);
const LARGE = arg('large', 50_000);

const dir = mkdtempSync(join(tmpdir(), 'scope-bench-check-'));
const store = await Store.open(`sqlite:${join(dir, 'bench.db')}`);
const project = await store.ensureProject('bench');
const { app } = createApp({ store, auth: { mode: 'none', defaultProject: project } });

async function bundles(count, offset) {
  const exporter = new MemoryExporter();
  const tracer = new Tracer({ exporter });
  for (let i = 0; i < count; i++) {
    const n = offset + i;
    await tracer.trace(
      'support',
      {
        input: { question: `How does order ${n} work?` },
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
        for (let s = 0; s < 4; s++) await tracer.span(`step-${s}`, { kind: 'step' }, () => s);
        return tracer.span('answer', { kind: 'llm' }, (span) => {
          span.recordModelCall({
            provider: 'openai',
            model: n % 3 ? 'gpt-5' : 'gpt-5-mini',
            usage: { inputTokens: 800, outputTokens: 120 },
          });
          return `answer ${n}`;
        });
      },
    );
  }
  return exporter.bundles;
}

let stored = 0;
/** Batches of traces stored by the SDK ingest measurement, whose ids never collide. */
let batches = 0;
async function growTo(total) {
  while (stored < total) {
    const batch = Math.min(500, total - stored);
    await store.ingest(project.id, await bundles(batch, stored));
    stored += batch;
  }
}

const hex = (n, width) => n.toString(16).padStart(width, '0');
let otlpTrace = 0;
/** One OTLP request with 100 traces of 6 spans, as an OpenTelemetry exporter batches them. */
function otlpRequest() {
  const spans = [];
  const t0 = BigInt(Date.now() - 60_000) * 1_000_000n;
  for (let t = 0; t < 100; t++) {
    const traceId = `c${hex(++otlpTrace, 31)}`;
    for (let s = 0; s < 6; s++)
      spans.push({
        traceId,
        spanId: hex(s + 1, 16),
        ...(s > 0 && { parentSpanId: hex(1, 16) }),
        name: s === 0 ? 'otlp' : `step-${s}`,
        startTimeUnixNano: String(t0 + BigInt(s) * 1_000_000n),
        endTimeUnixNano: String(t0 + BigInt(s) * 1_000_000n + 500_000n),
        attributes:
          s === 5
            ? [
                { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                { key: 'gen_ai.request.model', value: { stringValue: 'gpt-5' } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: '100' } },
              ]
            : [],
      });
  }
  return JSON.stringify({ resourceSpans: [{ resource: {}, scopeSpans: [{ spans }] }] });
}

/** Median wall time of `fn` over `runs` runs. */
async function median(runs, fn) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(runs / 2)];
}

async function get(path) {
  const res = await app.request(`/api/v1${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  await res.text();
}

async function measure() {
  const [first] = (await store.listTraces(project.id, { limit: 1 })).items;
  return {
    'OTLP ingest, 100 traces a request': await median(7, async () => {
      const res = await app.request('/v1/traces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: otlpRequest(),
      });
      if (!res.ok) throw new Error(`OTLP ${res.status}`);
    }),
    'SDK ingest, 100 traces': await (async () => {
      // Traces are built before the clock starts: only storing them is measured.
      const ready = [];
      for (let i = 0; i < 7; i++) ready.push(await bundles(100, 1_000_000 + batches++ * 100));
      return median(7, () => store.ingest(project.id, ready.shift()));
    })(),
    'traces, first page': await median(9, () => get('/traces?limit=50')),
    'traces, search': await median(9, () => get('/traces?limit=50&q=order%2012')),
    'traces, failed evaluations': await median(9, () => get('/traces?limit=50&eval=failed')),
    'traces, by model': await median(9, () => get('/traces?limit=50&model=gpt-5-mini')),
    'trace detail': await median(9, () => get(`/traces/${first.id}`)),
  };
}

await growTo(SMALL);
await measure(); // warm-up
const small = await measure();
await growTo(LARGE);
const large = await measure();

/**
 * Reported, not checked:
 * - substring search (`q`) scans traces until it has a page of matches, so a rare term costs
 *   time in proportion to the traces it passes (docs/performance.md);
 * - SDK ingestion's statements take the same time at both sizes, but commits (WAL checkpoints)
 *   and garbage collection make its total vary from run to run. Its queries' plans are checked
 *   deterministically by packages/storage/src/query-plans.test.ts.
 */
const INFORMATIONAL = new Set(['traces, search', 'SDK ingest, 100 traces']);

// Ratio large/small allowed per operation. 10x the data, so work that grows with the data is
// about 10x slower; B-tree depth and noise account for up to ~2x.
const LIMIT = 4;
const LIMITS = {};
let failed = 0;
console.log(
  `${'operation'.padEnd(36)} ${String(SMALL).padStart(9)} ${String(LARGE).padStart(9)}  ratio`,
);
for (const [name, a] of Object.entries(small)) {
  const b = large[name];
  // Sub-millisecond timings are dominated by noise: compare them against a 1 ms floor.
  const ratio = Math.max(b, 1) / Math.max(a, 1);
  const informational = INFORMATIONAL.has(name);
  const limit = LIMITS[name] ?? LIMIT;
  const ok = informational || ratio <= limit;
  if (!ok) failed++;
  console.log(
    `${name.padEnd(36)} ${a.toFixed(1).padStart(7)}ms ${b.toFixed(1).padStart(7)}ms  ${ratio.toFixed(2)}${informational ? '  (reported, not checked)' : ok ? '' : `  > ${limit}: grows with the database`}`,
  );
}
await store.close();
rmSync(dir, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} operation(s) slowed down with the size of the database.`);
  process.exit(1);
}
console.log('\nNo operation grows with the size of the database.');
