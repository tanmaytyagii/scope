#!/usr/bin/env node
/**
 * The SCOPE GitHub Action's runner: runs each workflow with `scope run`, which applies gates
 * (including regression gates against committed baselines), appends a Markdown report to the
 * job summary and annotates failed gates. Plain Node, no dependencies.
 *
 * Exit code: 0 when every gate passed, 1 when a gate failed, 2 or 3 when a workflow could not
 * run (configuration or execution error) — the same codes as `scope run`.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';

const env = process.env;
const cli = env.SCOPE_CLI;
if (!cli || !fs.existsSync(cli)) {
  console.error(`::error title=SCOPE::The SCOPE CLI was not built (expected ${cli}).`);
  process.exit(3);
}

const scope = (args, options = {}) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...options });

function listWorkflows() {
  const requested = (env.SCOPE_ACTION_WORKFLOWS ?? '').split(/\s+/).filter(Boolean);
  if (requested.length === 0) {
    const validated = scope(['validate', '--json']);
    try {
      return JSON.parse(validated.stdout).workflows.map((w) => w.path);
    } catch {
      process.stderr.write(validated.stderr);
      return [];
    }
  }
  const files = [];
  for (const pattern of requested) {
    if (/[*?[]/.test(pattern) && typeof fs.globSync === 'function')
      files.push(...fs.globSync(pattern).sort());
    else files.push(pattern);
  }
  return [...new Set(files)];
}

/** Run records in a `scope run --report-file` report (one run, or several with variants). */
function runsOf(report) {
  if (!report) return [];
  return Array.isArray(report.runs) ? report.runs.map((r) => r.run) : [report.run].filter(Boolean);
}

function variantArgs(value) {
  const v = (value ?? 'default').trim();
  if (v === '' || v === 'default') return [];
  if (v === 'all') return ['--all-variants'];
  return v
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .flatMap((name) => ['--variant', name]);
}

function baselineArgs(value) {
  const v = (value ?? 'auto').trim();
  if (v === '' || v === 'auto') return [];
  if (v === 'none') return ['--no-baseline'];
  return ['--baseline', v];
}

const workflows = listWorkflows();
if (workflows.length === 0) {
  console.error(
    '::error title=SCOPE::No workflows to run. Set the "workflows" input, or list them under "workflows:" in scope.yaml.',
  );
  process.exit(2);
}

const outDir = join('.scope', 'action');
fs.mkdirSync(outDir, { recursive: true });
const summaryFile = env.GITHUB_STEP_SUMMARY;
const common = [
  ...variantArgs(env.SCOPE_ACTION_VARIANTS),
  ...baselineArgs(env.SCOPE_ACTION_BASELINE),
  ...(env.SCOPE_ACTION_FAIL_ON_GATES === 'false' ? ['--no-fail'] : []),
  ...(summaryFile ? ['--summary-file', summaryFile] : []),
];

const results = [];
for (const [i, workflow] of workflows.entries()) {
  const reportFile = join(outDir, `report-${i + 1}.json`);
  fs.rmSync(reportFile, { force: true });
  console.log(`::group::SCOPE · ${workflow}`);
  const run = scope(['run', workflow, ...common, '--report-file', reportFile], {
    stdio: 'inherit',
  });
  console.log('::endgroup::');
  const code = run.status ?? 3;
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch {
    // the workflow did not run far enough to produce a report
  }
  if (code >= 2 && summaryFile) {
    fs.appendFileSync(
      summaryFile,
      `### ⚠️ SCOPE · \`${workflow}\` could not run (exit ${code})\n\nThe job log has the error and a hint for fixing it.\n\n`,
    );
  }
  // The exit code is 0 with fail-on-gates: false, so read the gate outcome from the report.
  const gatesFailed = code === 1 || runsOf(report).some((r) => r.gateStatus === 'failed');
  results.push({ workflow, exitCode: code, gatesFailed, report });
  const label = code >= 2 ? `error (exit ${code})` : gatesFailed ? 'gates failed' : 'passed';
  console.log(`SCOPE · ${workflow}: ${label}`);
}

const errored = results.find((r) => r.exitCode >= 2);
const failed = results.some((r) => r.gatesFailed);
const result = errored ? 'error' : failed ? 'failed' : 'passed';
const combined = join(outDir, 'report.json');
fs.writeFileSync(
  combined,
  `${JSON.stringify({ schema: 'scope.action-report/v1', result, workflows: results }, null, 2)}\n`,
);
if (env.GITHUB_OUTPUT) {
  fs.appendFileSync(env.GITHUB_OUTPUT, `result=${result}\nreport=${relative('.', combined)}\n`);
}
process.exit(errored ? errored.exitCode : results.some((r) => r.exitCode === 1) ? 1 : 0);
