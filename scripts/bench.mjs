#!/usr/bin/env node
/**
 * Performance measurements on a synthetic project, so changes that affect speed are measured,
 * not guessed. Data is generated with the real tracer (clearly benchmark data, in a temporary
 * database), ingested through the store, and read through the HTTP API as the dashboard does.
 *
 *   node --conditions=scope-source scripts/bench.mjs [--traces 20000] [--spans 1000]
 *     [--database postgres://…]
 *
 * Prints ingestion throughput, API timings (median of 5) and response sizes, including one
 * trace with the maximum number of spans, then OTLP ingestion through POST /v1/traces: whole
 * traces per request, one large trace arriving in pieces, and concurrent requests; retention;
 * the database's size and the process's peak memory. By default the database is a temporary
 * SQLite file; with --database, use an empty PostgreSQL database or schema.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
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
const DATABASE = (() => {
  const i = process.argv.indexOf('--database');
  return i >= 0 ? process.argv[i + 1] : null;
})();

let peakRss = 0;
const sampleMemory = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
setInterval(sampleMemory, 200).unref();

const dir = mkdtempSync(join(tmpdir(), 'scope-bench-'));
const store = await Store.open(DATABASE ?? `sqlite:${join(dir, 'bench.db')}`);
console.log(`database ${store.target.display}`);
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
await time('traces, by model', '/traces?limit=50&model=gpt-5');
await time('evaluators (30d)', '/evaluators?window=30d');
await time('evaluations, failed', '/evaluations?status=failed&limit=50');
await time('models (30d)', '/models?window=30d');
await time(`trace with ${BIG_SPANS} spans`, `/traces/${big.trace.id}`);
await time(
  `trace with ${BIG_SPANS} spans, 2 MiB budget`,
  `/traces/${big.trace.id}?contentBudget=2097152`,
);
// A term that matches one old trace: the search passes ~90% of the traces to find it.
await time(
  'traces, search (rare term)',
  `/traces?limit=50&q=${encodeURIComponent(`order ${Math.floor(TRACES / 10)}?`)}`,
);

// ─── OTLP ingestion ──────────────────────────────────────────────────────────────────────────
// Through POST /v1/traces as OpenTelemetry exporters send it (JSON encoding), measured after the
// reads so it does not change them. Spans of one trace can arrive in several requests; each
// request recomputes the traces it touches from all their stored spans.
const OTLP_TRACES = Math.min(TRACES, 5000);
const OTLP_PER_REQUEST = 100;
const hex = (n, width) => n.toString(16).padStart(width, '0');
const t0 = BigInt(Date.now() - 3_600_000) * 1_000_000n;
const text = (key, value) => ({ key, value: { stringValue: value } });
const int = (key, value) => ({ key, value: { intValue: String(value) } });

/** Spans `from`..`to` of benchmark trace `n`: a root, steps, and every third span a model call. */
function otlpSpans(n, from, to) {
  const traceId = `b${hex(n, 31)}`;
  const spans = [];
  for (let s = from; s < to; s++) {
    const llm = s > 0 && s % 3 === 0;
    const start = t0 + BigInt(n) * 1_000_000_000n + BigInt(s) * 1_000_000n;
    spans.push({
      traceId,
      spanId: hex(s + 1, 16),
      ...(s > 0 && { parentSpanId: hex(1, 16) }),
      name: s === 0 ? 'support' : llm ? 'chat gpt-5' : `step-${s}`,
      startTimeUnixNano: String(start),
      endTimeUnixNano: String(start + 800_000n),
      attributes: llm
        ? [
            text('gen_ai.operation.name', 'chat'),
            text('gen_ai.provider.name', 'openai'),
            text('gen_ai.request.model', 'gpt-5'),
            int('gen_ai.usage.input_tokens', 800 + (n % 100)),
            int('gen_ai.usage.output_tokens', 120),
            text('gen_ai.input.messages', JSON.stringify([{ role: 'user', content: pick(n) }])),
          ]
        : [text('input.value', `How does ${pick(n)} work for order ${n}?`)],
      status: { code: 1 },
    });
  }
  return spans;
}

async function sendOtlp(spans) {
  const body = JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [text('service.name', 'bench')] },
        scopeSpans: [{ scope: { name: 'bench' }, spans }],
      },
    ],
  });
  const res = await app.request('/v1/traces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const result = await res.text();
  if (!res.ok || result.includes('rejectedSpans')) throw new Error(`OTLP: ${res.status} ${result}`);
  return body.length;
}

console.log('\nOTLP (POST /v1/traces, JSON)');
started = performance.now();
let otlpBytes = 0;
for (let n = 0; n < OTLP_TRACES; n += OTLP_PER_REQUEST) {
  const spans = [];
  for (let i = n; i < Math.min(n + OTLP_PER_REQUEST, OTLP_TRACES); i++)
    spans.push(...otlpSpans(i, 0, 6));
  otlpBytes += await sendOtlp(spans);
}
const otlpMs = ms(started);
console.log(
  `ingest   ${OTLP_TRACES} traces × 6 spans, ${OTLP_PER_REQUEST} traces a request, in ${otlpMs} ms ` +
    `(${Math.round(OTLP_TRACES / (otlpMs / 1000))} traces/s, ${Math.round(otlpBytes / 1024 / (OTLP_TRACES / OTLP_PER_REQUEST))} KiB a request)`,
);

const PIECE = 100;
const pieces = [];
for (let from = 0; from < BIG_SPANS; from += PIECE) {
  const t = performance.now();
  await sendOtlp(otlpSpans(OTLP_TRACES, from, Math.min(from + PIECE, BIG_SPANS)));
  pieces.push(ms(t));
}
console.log(
  `ingest   1 trace × ${BIG_SPANS} spans in ${pieces.length} requests of ${PIECE}: ` +
    `first ${pieces[0]} ms, last ${pieces.at(-1)} ms, total ${Math.round(pieces.reduce((a, b) => a + b, 0))} ms`,
);

// Concurrent OTLP requests, as several application instances send at once.
const CONCURRENT = 8;
started = performance.now();
let next = OTLP_TRACES + 1;
await Promise.all(
  Array.from({ length: CONCURRENT }, async () => {
    for (let r = 0; r < 5; r++) {
      const spans = [];
      for (let i = 0; i < OTLP_PER_REQUEST; i++) spans.push(...otlpSpans(next++, 0, 6));
      await sendOtlp(spans);
    }
  }),
);
const concurrentMs = ms(started);
const concurrentTraces = CONCURRENT * 5 * OTLP_PER_REQUEST;
console.log(
  `ingest   ${concurrentTraces} traces in ${CONCURRENT} concurrent streams of ${OTLP_PER_REQUEST}-trace requests in ${concurrentMs} ms (${Math.round(concurrentTraces / (concurrentMs / 1000))} traces/s)`,
);

// ─── retention ───────────────────────────────────────────────────────────────────────────────
const OLD = Math.max(1000, Math.round(TRACES / 20));
const age = 90 * 86_400_000;
for (let offset = 0; offset < OLD; offset += BATCH) {
  const batch = await bundles(Math.min(BATCH, OLD - offset), 6, 50_000_000 + offset);
  await store.ingest(
    project.id,
    batch.map((b) => ({
      ...b,
      trace: { ...b.trace, startTime: b.trace.startTime - age, endTime: b.trace.endTime - age },
      spans: b.spans.map((sp) => ({
        ...sp,
        startTime: sp.startTime - age,
        endTime: sp.endTime - age,
      })),
    })),
  );
}
const selection = { projectIds: [project.id], before: Date.now() - 60 * 86_400_000 };
started = performance.now();
const plan = await store.planPrune(selection);
const planMs = ms(started);
started = performance.now();
const deleted = await store.prune(selection);
console.log(
  `\nprune    plan ${planMs} ms; delete ${deleted.traces} traces (${deleted.spans} spans) in ${ms(started)} ms` +
    (plan.traces === OLD ? '' : ` (planned ${plan.traces} of ${OLD})`),
);

// ─── size and memory ─────────────────────────────────────────────────────────────────────────
let bytes = null;
if (store.dialect === 'sqlite') {
  bytes = 0;
  for (const suffix of ['', '-wal'])
    try {
      bytes += statSync(`${store.target.location}${suffix}`).size;
    } catch {}
} else {
  const { sql } = await import('kysely');
  const row =
    await sql`select sum(pg_total_relation_size(c.oid))::bigint as bytes from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = current_schema() and c.relkind = 'r'`.execute(
      store.db,
    );
  bytes = Number(row.rows[0]?.bytes ?? 0);
}
sampleMemory();
const stats = await store.projectStats(project.id);
console.log(
  `size     ${(bytes / 1024 / 1024).toFixed(0)} MiB for ${stats.traces} traces, ${stats.spans} spans (${Math.round(bytes / stats.spans)} bytes a span); benchmark process peak memory (with data generation) ${Math.round(peakRss / 1024 / 1024)} MiB`,
);

await store.close();
rmSync(dir, { recursive: true, force: true });
