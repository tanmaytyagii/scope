#!/usr/bin/env node
/**
 * Prints the CHANGELOG.md section of a version, for the GitHub release.
 *
 *   node scripts/release-notes.mjs 0.2.0 > notes.md
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/workspaces.mjs';

const version = process.argv[2]?.replace(/^v/, '');
if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>');
  process.exit(2);
}
const lines = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').split('\n');
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(
    `CHANGELOG.md has no "## [${version}]" section (run npm run release:version first)`,
  );
  process.exit(1);
}
const end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
const body = lines
  .slice(start + 1, end < 0 ? undefined : end)
  // link definitions at the end of the file belong to the whole changelog
  .filter((l) => !/^\[[^\]]+\]: /.test(l))
  .join('\n')
  .trim();
if (!body) {
  console.error(`The ${version} section of CHANGELOG.md is empty`);
  process.exit(1);
}
process.stdout.write(`${body}\n`);
