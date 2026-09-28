#!/usr/bin/env node
/**
 * Publishes every package to npm, dependencies first. Run after `npm run build`.
 *
 *   node scripts/publish.mjs --dry-run   # what would be published, without publishing
 *   node scripts/publish.mjs             # publish (the release workflow runs this)
 *
 * Versions already on the registry are skipped, so a release that failed half-way can be re-run.
 * Prereleases (1.2.0-rc.1) are published under the "next" dist-tag, never "latest". On GitHub
 * Actions with an OIDC token, packages are published with provenance.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { publishOrder, ROOT } from './lib/workspaces.mjs';

const dryRun = process.argv.includes('--dry-run');
const packages = publishOrder();
const version = packages[0]?.manifest.version;
const tag = version?.includes('-') ? 'next' : 'latest';
const provenance = Boolean(process.env.GITHUB_ACTIONS && process.env.ACTIONS_ID_TOKEN_REQUEST_URL);

execFileSync(process.execPath, ['scripts/verify-packages.mjs', '--packed'], {
  cwd: ROOT,
  stdio: 'inherit',
});

/** Whether name@version is already on the registry. */
function published(name) {
  const r = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status === 0) return r.stdout.trim() !== '';
  if (/E404|404 Not Found/.test(r.stderr)) return false;
  throw new Error(`npm view ${name}@${version} failed:\n${r.stderr}`);
}

console.log(
  `\n${dryRun ? 'Dry run: ' : ''}publishing ${version} (dist-tag ${tag}${provenance ? ', with provenance' : ''})`,
);
const done = [];
for (const w of packages) {
  if (published(w.name)) {
    console.log(`${w.name}@${version} is already published — skipped`);
    continue;
  }
  const args = ['publish', '-w', w.name, '--access', 'public', '--tag', tag];
  if (provenance) args.push('--provenance');
  if (dryRun) args.push('--dry-run');
  console.log(`$ npm ${args.join(' ')}`);
  const r = spawnSync('npm', args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\nPublishing ${w.name} failed. Published so far: ${done.join(', ') || 'none'}.`);
    console.error('Fix the cause and re-run: published versions are skipped.');
    process.exit(1);
  }
  done.push(w.name);
}
console.log(
  `\n${dryRun ? 'Would publish' : 'Published'}: ${done.join(', ') || 'nothing (all published)'}`,
);
