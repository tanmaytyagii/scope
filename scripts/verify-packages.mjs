#!/usr/bin/env node
/**
 * Checks that every publishable package is ready to publish.
 *
 *   node scripts/verify-packages.mjs            # manifests (fast, no build needed)
 *   node scripts/verify-packages.mjs --packed   # also what `npm pack` would ship (after a build)
 *
 * Manifests: one version across all packages and SCOPE_VERSION, exact internal dependency
 * versions, the metadata npm shows, a README and the license in each package.
 * Packed: every export, type and bin target is in the tarball, and nothing else leaks in.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { internalNames, publishOrder, ROOT, workspaces } from './lib/workspaces.mjs';

const packed = process.argv.includes('--packed');
const problems = [];
const problem = (where, message) => problems.push(`${where}: ${message}`);

const all = workspaces();
const internal = internalNames();
const version = all.find((w) => w.name === '@scope-ai/core')?.manifest.version;
const scopeVersion = /export const SCOPE_VERSION = '([^']*)';/.exec(
  readFileSync(join(ROOT, 'packages/core/src/index.ts'), 'utf8'),
)?.[1];
if (scopeVersion !== version)
  problem(
    'packages/core/src/index.ts',
    `SCOPE_VERSION is ${scopeVersion}, packages are ${version}`,
  );

const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes('## [Unreleased]') && !changelog.includes(`## [${version}]`))
  problem('CHANGELOG.md', `needs an "Unreleased" or "${version}" section`);

for (const w of all) {
  const m = w.manifest;
  if (m.version !== version) problem(w.name, `version ${m.version}, expected ${version}`);
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const [dep, range] of Object.entries(m[field] ?? {})) {
      if (internal.has(dep) && range !== version)
        problem(
          w.name,
          `${field}.${dep} is "${range}"; internal packages are pinned to ${version}`,
        );
      if (/^(workspace|file|link):/.test(range))
        problem(w.name, `${field}.${dep} uses "${range}", which npm cannot install`);
    }
  }
  if (m.private) continue;

  for (const key of ['description', 'keywords', 'homepage', 'bugs', 'files'])
    if (!m[key]) problem(w.name, `missing "${key}"`);
  if (m.license !== 'Apache-2.0') problem(w.name, `license is ${m.license}`);
  if (m.repository?.directory !== w.dir)
    problem(w.name, `repository.directory is ${m.repository?.directory}, expected ${w.dir}`);
  if (m.publishConfig?.access !== 'public')
    problem(w.name, 'publishConfig.access must be "public"');
  if (w.name !== '@scope-ai/web' && !m.engines?.node) problem(w.name, 'missing engines.node');
  if (!existsSync(join(ROOT, w.dir, 'README.md'))) problem(w.name, 'missing README.md');
  const own = join(ROOT, w.dir, 'LICENSE');
  if (!existsSync(own) || readFileSync(own, 'utf8') !== license)
    problem(w.name, 'LICENSE is missing or differs from the repository LICENSE');
  for (const [dep] of Object.entries(m.dependencies ?? {})) {
    const inner = all.find((x) => x.name === dep);
    if (inner?.manifest.private) problem(w.name, `depends on private package ${dep}`);
  }
}

/** Every file a manifest points at: export conditions (except `source`), types and bins. */
function targets(m) {
  const out = new Set();
  const walk = (node) => {
    if (typeof node === 'string') out.add(node);
    else if (node && typeof node === 'object')
      for (const [condition, value] of Object.entries(node))
        if (condition !== 'scope-source') walk(value);
  };
  walk(m.exports);
  if (typeof m.bin === 'string') out.add(m.bin);
  else for (const bin of Object.values(m.bin ?? {})) out.add(bin);
  if (m.types) out.add(m.types);
  if (m.main) out.add(m.main);
  return [...out].map((p) => p.replace(/^\.\//, ''));
}

if (packed) {
  for (const w of publishOrder()) {
    const [report] = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '-w', w.name], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    const files = new Set(report.files.map((f) => f.path));
    for (const target of targets(w.manifest))
      if (!files.has(target)) problem(w.name, `the tarball lacks ${target}`);
    for (const required of ['package.json', 'README.md', 'LICENSE'])
      if (!files.has(required)) problem(w.name, `the tarball lacks ${required}`);
    for (const file of files) {
      if (/(^|\/)(src|__tests__)\/|\.test\.|\.tsbuildinfo$|(^|\/)\.env/.test(file))
        problem(w.name, `the tarball includes ${file}`);
    }
    if (w.name === '@scope-ai/web' && !files.has('dist/index.html'))
      problem(w.name, 'the tarball lacks the built dashboard (run npm run build)');
    const kib = (report.size / 1024).toFixed(0);
    console.log(
      `${w.name.padEnd(22)} ${String(report.entryCount).padStart(4)} files  ${kib.padStart(5)} KiB`,
    );
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(
  `\n${all.length} packages at ${version} are ready to publish${packed ? '' : ' (manifests)'}.`,
);
