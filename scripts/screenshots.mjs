#!/usr/bin/env node
/**
 * Regenerates the README screenshots (docs/images) from real runs: seeds a project with the CLI —
 * the starter workflow, a baseline, a regression, and its variants — serves it with `scope ui`,
 * and captures pages with Playwright at 1440×900, 2× scale.
 *
 *   npm run build -w @scope-ai/web && node scripts/screenshots.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const bin = join(root, 'packages/cli/src/bin.ts');
const images = join(root, 'docs/images');
const work = mkdtempSync(join(tmpdir(), 'scope-shots-'));
const project = join(work, 'support-bot');
const env = { ...process.env, NO_COLOR: '1', CI: '', SCOPE_DATABASE_URL: '' };
const PORT = 4797;

const scope = (args, cwd = project) => {
  try {
    execFileSync(process.execPath, ['--conditions=source', bin, ...args], {
      cwd,
      env,
      stdio: 'ignore',
    });
  } catch (error) {
    if (error.status !== 1) throw error; // 1: gates failed, which the regression run should
  }
};

scope(['init', 'support-bot'], work);
scope(['run']); // #1
scope(['baseline', 'save', '1']);
const workflow = join(project, 'workflows', 'support.yaml');
const original = readFileSync(workflow, 'utf8');
writeFileSync(workflow, original.replace(/^ {2}sentences: 2$/m, '  sentences: 1'));
scope(['run']); // #2: answers keep one sentence and fail the regression gate
writeFileSync(workflow, original);
scope(['run', '--all-variants', '--no-baseline']); // #3 defaults, #4 terse, #5 narrow

const ui = spawn(process.execPath, ['--conditions=source', bin, 'ui', '--port', String(PORT)], {
  cwd: project,
  env,
  stdio: 'ignore',
});
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/readyz`)).ok) break;
  } catch {
    // not listening yet
  }
  await new Promise((r) => setTimeout(r, 100));
}

const failing = await (await fetch(`${base}/api/v1/runs/2/cases?outcome=failed&limit=1`)).json();
const trace = failing.items[0].traceId;
const shots = [
  ['overview.png', '/', 'light'],
  ['trace-explorer.png', `/traces/${trace}`, 'light'],
  ['compare.png', '/compare?base=1&head=2', 'light'],
  ['run-dark.png', '/runs/2', 'dark'],
  ['side-by-side.png', '/compare?runs=3,4,5', 'light'],
];

const browser = await chromium.launch();
try {
  for (const [file, path, scheme] of shots) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
    });
    await page.goto(`${base}${path}`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: join(images, file) });
    await page.close();
    console.log(`docs/images/${file}  ${path} (${scheme})`);
  }
} finally {
  await browser.close();
  ui.kill('SIGINT');
  rmSync(work, { recursive: true, force: true });
}
