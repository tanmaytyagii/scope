#!/usr/bin/env node
/**
 * Package smoke test: packs every publishable workspace package and installs them the way users
 * will — `npm install scope-ai` (with the @scope-ai/* dependencies resolved to the local tarballs
 * instead of the registry) — then runs `scope init`, `scope run` and `scope ui` from the installed
 * command. Also installs @scope-ai/sdk on its own and traces a span with it.
 *
 * Catches what workspace hoisting hides: undeclared dependencies, missing files in `files`,
 * broken `exports`, and dist output that only works with the source condition.
 *
 * Usage: npm run build && node scripts/smoke-pack.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'scope-smoke-'));
const packs = join(work, 'packs');
const app = join(work, 'app');
const sdkApp = join(work, 'sdk-app');

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
    if (!pkg.private) workspaces.push(pkg);
  }
}

/** The packed tarball of a package, as `npm pack` names it. */
const tarball = (pkg) =>
  join(packs, `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`);

/**
 * Installs one package into an empty project whose npm resolves the other SCOPE packages to their
 * local tarballs — so its dependencies arrive exactly as they would from the registry.
 */
function install(dir, pkg) {
  run('mkdir', ['-p', dir], work);
  const overrides = Object.fromEntries(
    workspaces.filter((p) => p !== pkg).map((p) => [p.name, `file:${tarball(p)}`]),
  );
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'smoke', private: true, type: 'module', overrides }, null, 2)}\n`,
  );
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', tarball(pkg)], dir);
}

try {
  run('mkdir', ['-p', packs], work);
  for (const pkg of workspaces)
    run('npm', ['pack', '-w', pkg.name, '--pack-destination', packs, '--silent'], root);
  const byName = (name) => workspaces.find((p) => p.name === name);

  // npm install scope-ai
  install(app, byName('scope-ai'));
  const scope = join(app, 'node_modules', '.bin', 'scope');
  const env = { NO_COLOR: '1', CI: 'true' };
  process.stdout.write(run(scope, ['--version'], app, env));
  // A global install links scope-ai's own bin (locally, npm may link the hoisted CLI's instead).
  const umbrella = join(app, 'node_modules', 'scope-ai', 'bin.js');
  const version = run(process.execPath, [umbrella, 'version', '--json'], app, env);
  if (JSON.parse(version).scope !== byName('scope-ai').version)
    throw new Error(`scope-ai/bin.js printed ${version}`);
  run(scope, ['init', 'demo'], app, env);
  process.stdout.write(
    run(scope, ['run', 'workflows/support.yaml', '--quiet'], join(app, 'demo'), env),
  );
  await checkDashboard(scope, join(app, 'demo'), env);

  // npm install @scope-ai/sdk — tracing an application needs nothing else
  install(sdkApp, byName('@scope-ai/sdk'));
  const installed = readdirSync(join(sdkApp, 'node_modules', '@scope-ai')).sort();
  if (installed.join() !== 'core,sdk') throw new Error(`the SDK installed ${installed.join(', ')}`);
  writeFileSync(
    join(sdkApp, 'trace.js'),
    [
      "import { MemoryExporter, Tracer } from '@scope-ai/sdk';",
      'const exporter = new MemoryExporter();',
      'const tracer = new Tracer({ exporter });',
      "await tracer.trace('answer', {}, () => tracer.span('llm', { kind: 'llm' }, () => 'ok'));",
      'const [bundle] = exporter.bundles;',
      "if (bundle?.spans.length !== 2) throw new Error('the installed SDK did not trace');",
      "console.log('traced', bundle.spans.length, 'spans with the installed SDK');",
    ].join('\n'),
  );
  process.stdout.write(run(process.execPath, ['trace.js'], sdkApp));
  process.stdout.write('\nsmoke test passed\n');
} finally {
  if (!process.env.KEEP_SMOKE) rmSync(work, { recursive: true, force: true });
}
