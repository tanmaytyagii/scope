#!/usr/bin/env node
/** Removes build output (dist/, *.tsbuildinfo) from every workspace package. Keeps node_modules. */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const removed = [];
const remove = (path) => {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
  removed.push(path.slice(root.length + 1));
};
for (const dir of ['packages', 'apps']) {
  for (const name of readdirSync(join(root, dir))) {
    remove(join(root, dir, name, 'dist'));
    for (const file of readdirSync(join(root, dir, name)))
      if (file.endsWith('.tsbuildinfo')) remove(join(root, dir, name, file));
  }
}
for (const file of readdirSync(root)) if (file.endsWith('.tsbuildinfo')) remove(join(root, file));
for (const dir of ['test-results', 'playwright-report', 'coverage']) remove(join(root, dir));
process.stdout.write(removed.length ? `removed ${removed.join(', ')}\n` : 'nothing to clean\n');
