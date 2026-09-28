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
    return execFileSync(process.execPath, ['--conditions=source', bin, ...args], {
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
writeFileSync(
  join(import.meta.dirname, '.state.json'),
  JSON.stringify({ project, readKey: key.secret }),
);

const children = [];
const start = (args) => {
  const child = spawn(process.execPath, ['--conditions=source', bin, ...args], {
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
start(['ui', '--port', '4799']);

const stop = () => {
  for (const child of children) child.kill('SIGINT');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
