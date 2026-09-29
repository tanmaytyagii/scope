#!/usr/bin/env node
/**
 * E2E fixture server: seeds a project with real runs through the CLI, then serves it twice —
 * `scope ui` on 4799 (no auth) and `scope server` on 4798 (API keys). Nothing is mocked: the
 * dashboard is tested against data the product itself produced.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const bin = join(root, 'packages/cli/src/bin.ts');
const work = mkdtempSync(join(tmpdir(), 'scope-e2e-'));
const project = join(work, 'demo');
const env = { ...process.env, NO_COLOR: '1', CI: 'true', SCOPE_DATABASE_URL: '' };

const scope = (args, { allowFailure = false } = {}) => {
  try {
    return execFileSync(process.execPath, ['--conditions=scope-source', bin, ...args], {
      cwd: args[0] === 'init' ? work : project,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (allowFailure) return error.stdout;
    throw error;
  }
};

scope(['init', 'demo']);
scope(['run', 'workflows/support.yaml', '--quiet']); // run #1
scope(['baseline', 'save', '1']);
// #2: a variant that answers in one sentence regresses against the baseline and fails its gate.
scope(
  [
    'run',
    'workflows/support.yaml',
    '--variant',
    'terse',
    '--baseline',
    'baselines/support.json',
    '--quiet',
  ],
  {
    allowFailure: true,
  },
);
scope(['run', 'workflows/support.yaml', '--variant', 'narrow', '--no-baseline', '--quiet']); // #3
const key = JSON.parse(scope(['keys', 'create', '--name', 'e2e', '--scope', 'read', '--json']));
const ingestKey = JSON.parse(
  scope(['keys', 'create', '--name', 'e2e-ingest', '--scope', 'ingest', '--json']),
);

const children = [];
const start = (args) => {
  const child = spawn(process.execPath, ['--conditions=scope-source', bin, ...args], {
    cwd: project,
    env: { ...env, SCOPE_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(child);
  return child;
};

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not become healthy`);
}

start(['server', '--host', '127.0.0.1', '--port', '4798']);
await waitFor('http://127.0.0.1:4798/healthz');

// A large trace, sent over OTLP as an instrumented application would: 30 spans with ~60 KB of
// input and output each (3.6 MB), more than the explorer downloads with a trace.
const largeTraceId = 'b1'.repeat(16);
const text = (n) => `part ${n}: ${'lorem ipsum dolor sit amet '.repeat(2200)}`;
const start0 = BigInt(Date.now() - 60_000) * 1_000_000n;
const attr = (key, value) => ({ key, value: { stringValue: value } });
const spans = Array.from({ length: 31 }, (_, i) => ({
  traceId: largeTraceId,
  spanId: (i + 1).toString(16).padStart(16, '0'),
  ...(i > 0 && { parentSpanId: '1'.padStart(16, '0') }),
  name: i === 0 ? 'large-trace' : `part-${i}`,
  startTimeUnixNano: String(start0 + BigInt(i) * 1_000_000n),
  endTimeUnixNano: String(start0 + BigInt(i) * 1_000_000n + 500_000n),
  attributes: i === 0 ? [] : [attr('input.value', text(i)), attr('output.value', text(i))],
}));
const otlp = await fetch('http://127.0.0.1:4798/v1/traces', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ingestKey.secret}` },
  body: JSON.stringify({ resourceSpans: [{ resource: {}, scopeSpans: [{ spans }] }] }),
});
if (!otlp.ok)
  throw new Error(`seeding the large trace failed: ${otlp.status} ${await otlp.text()}`);

writeFileSync(
  join(import.meta.dirname, '.state.json'),
  JSON.stringify({ project, readKey: key.secret, largeTraceId }),
);
start(['ui', '--port', '4799']);

const stop = () => {
  for (const child of children) child.kill('SIGINT');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
