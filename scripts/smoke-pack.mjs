#!/usr/bin/env node
/**
 * Package smoke test: packs every publishable workspace package, installs the tarballs into an
 * empty directory, and runs `scope init`, `scope run` and `scope ui` from the installed CLI.
 *
 * Catches what workspace hoisting hides: undeclared dependencies, missing files in `files`,
 * broken `exports`, and dist output that only works with the source condition.
 *
 * Usage: npm run build && node scripts/smoke-pack.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'scope-smoke-'));
const packs = join(work, 'packs');
const app = join(work, 'app');

const run = (cmd, args, cwd, env = {}) => {
  process.stdout.write(`$ ${cmd} ${args.join(' ')}\n`);
  return execFileSync(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
};

/** Starts the installed `scope ui` and checks that it serves the API, the app shell and its assets. */
async function checkDashboard(scope, cwd, env) {
  process.stdout.write('$ scope ui --port 0 --json\n');
  const child = spawn(scope, ['ui', '--port', '0', '--json'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const url = await new Promise((done, fail) => {
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
        try {
          done(JSON.parse(out).url);
        } catch {
          // wait for the whole document
        }
      });
      child.on('exit', (code) => fail(new Error(`scope ui exited with ${code}`)));
    });
    const runs = await (await fetch(`${url}/api/v1/runs`)).json();
    if (runs.items?.length !== 1) throw new Error('the API did not return the run');
    const html = await (await fetch(`${url}/runs/1`)).text();
    if (!html.includes('id="root"'))
      throw new Error('the dashboard is not in the installed packages');
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    const asset = script ? await fetch(`${url}${script}`) : null;
    if (!asset?.ok) throw new Error(`dashboard asset ${script} is missing`);
    process.stdout.write(`dashboard served at ${url} (${script})\n`);
  } finally {
    child.kill('SIGINT');
  }
}

const workspaces = [];
for (const dir of ['packages', 'apps']) {
  for (const name of readdirSync(join(root, dir))) {
    const manifest = join(root, dir, name, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (!pkg.private) workspaces.push(pkg.name);
  }
}

try {
  run('mkdir', ['-p', packs, app], work);
  for (const ws of workspaces)
    run('npm', ['pack', '-w', ws, '--pack-destination', packs, '--silent'], root);
  const tarballs = readdirSync(packs).map((f) => join(packs, f));
  run('npm', ['init', '-y', '--silent'], app);
  run('npm', ['install', '--no-audit', '--no-fund', '--silent', ...tarballs], app);
  const scope = join(app, 'node_modules', '.bin', 'scope');
  const env = { NO_COLOR: '1', CI: 'true' };
  process.stdout.write(run(scope, ['--version'], app, env));
  run(scope, ['init', 'demo'], app, env);
  process.stdout.write(
    run(scope, ['run', 'workflows/support.yaml', '--quiet'], join(app, 'demo'), env),
  );
  await checkDashboard(scope, join(app, 'demo'), env);
  process.stdout.write('\nsmoke test passed\n');
} finally {
  if (!process.env.KEEP_SMOKE) rmSync(work, { recursive: true, force: true });
}
