#!/usr/bin/env node
/**
 * Package smoke test: packs every publishable workspace package, installs the tarballs into an
 * empty directory, and runs `scope init` + `scope run` from the installed CLI.
 *
 * Catches what workspace hoisting hides: undeclared dependencies, missing files in `files`,
 * broken `exports`, and dist output that only works with the source condition.
 *
 * Usage: npm run build && node scripts/smoke-pack.mjs
 */
import { execFileSync } from 'node:child_process';
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
  process.stdout.write('\nsmoke test passed\n');
} finally {
  if (!process.env.KEEP_SMOKE) rmSync(work, { recursive: true, force: true });
}
