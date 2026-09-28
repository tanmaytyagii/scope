#!/usr/bin/env node
/**
 * Sets one version on every package (SCOPE versions all packages together).
 *
 *   npm run release:version -- 0.2.0 [--date 2026-10-01]
 *
 * Updates every workspace manifest, internal dependency ranges (pinned exactly), SCOPE_VERSION
 * in @scope-ai/core, the lockfile, and turns CHANGELOG.md's "Unreleased" section into the
 * release section. It does not commit, tag or publish — see RELEASING.md.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { internalNames, ROOT, workspaces } from './lib/workspaces.mjs';

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--'));
const dateIndex = args.indexOf('--date');
const date = dateIndex >= 0 ? args[dateIndex + 1] : new Date().toISOString().slice(0, 10);

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(
    'usage: npm run release:version -- <major.minor.patch[-prerelease]> [--date YYYY-MM-DD]',
  );
  process.exit(2);
}

const internal = internalNames();
for (const w of workspaces()) {
  const manifest = w.manifest;
  manifest.version = version;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      if (internal.has(dep)) manifest[field][dep] = version;
    }
  }
  writeFileSync(w.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${w.name.padEnd(22)} ${version}`);
}

const core = join(ROOT, 'packages/core/src/index.ts');
const coreText = readFileSync(core, 'utf8');
const updated = coreText.replace(
  /export const SCOPE_VERSION = '[^']*';/,
  `export const SCOPE_VERSION = '${version}';`,
);
if (updated === coreText && !coreText.includes(`'${version}'`)) {
  console.error('SCOPE_VERSION not found in packages/core/src/index.ts');
  process.exit(1);
}
writeFileSync(core, updated);

const changelogPath = join(ROOT, 'CHANGELOG.md');
const changelog = readFileSync(changelogPath, 'utf8');
if (changelog.includes(`## [${version}]`)) {
  console.log(`CHANGELOG.md already has a ${version} section`);
} else if (changelog.includes('## [Unreleased]')) {
  writeFileSync(
    changelogPath,
    changelog.replace('## [Unreleased]', `## [Unreleased]\n\n## [${version}] - ${date}`),
  );
  console.log(`CHANGELOG.md: Unreleased → ${version} (${date})`);
}

execFileSync(
  'npm',
  ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
  {
    cwd: ROOT,
    stdio: 'inherit',
  },
);
console.log(
  `\nNext: review the diff, run npm run check, commit "chore(release): v${version}", tag v${version}.`,
);
