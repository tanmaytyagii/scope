#!/usr/bin/env node
/**
 * The SCOPE GitHub Action's runner: runs each workflow with `scope run`, which applies gates
 * (including regression gates against committed baselines), appends a Markdown report to the
 * job summary and annotates failed gates. Plain Node, no dependencies.
 *
 * Exit code: 0 when every gate passed, 1 when a gate failed, 2 or 3 when a workflow could not
 * run (configuration or execution error) — the same codes as `scope run`.
 *
 * With `comment: true`, the same report is posted on the pull request as one comment, updated in
 * place on later pushes. A comment that cannot be posted is a warning, never a failed job.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';

const env = process.env;
const cli = env.SCOPE_CLI;
// The GitHub token is for the comment only; `scope run` (and the project code it runs) never
// sees it.
const { SCOPE_ACTION_GITHUB_TOKEN: githubToken, ...childEnv } = env;
/** GitHub rejects comments over 65,536 characters. */
const MAX_COMMENT = 65_000;
if (!cli || !fs.existsSync(cli)) {
  console.error(`::error title=SCOPE::The SCOPE CLI was not built (expected ${cli}).`);
  process.exit(3);
}

const scope = (args, options = {}) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: childEnv, ...options });

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
];

const results = [];
/** The Markdown report: the job summary, and the pull request comment. */
const markdown = [];
for (const [i, workflow] of workflows.entries()) {
  const reportFile = join(outDir, `report-${i + 1}.json`);
  const markdownFile = join(outDir, `report-${i + 1}.md`);
  fs.rmSync(reportFile, { force: true });
  fs.rmSync(markdownFile, { force: true });
  console.log(`::group::SCOPE · ${workflow}`);
  const run = scope(
    ['run', workflow, ...common, '--report-file', reportFile, '--summary-file', markdownFile],
    { stdio: 'inherit' },
  );
  console.log('::endgroup::');
  const code = run.status ?? 3;
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch {
    // the workflow did not run far enough to produce a report
  }
  const section =
    code >= 2
      ? `### ⚠️ SCOPE · \`${workflow}\` could not run (exit ${code})\n\nThe job log has the error and a hint for fixing it.\n\n`
      : fs.existsSync(markdownFile)
        ? fs.readFileSync(markdownFile, 'utf8')
        : '';
  markdown.push(section);
  if (summaryFile && section) fs.appendFileSync(summaryFile, section);
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
const outputs = [`result=${result}`, `report=${relative('.', combined)}`];
if (env.SCOPE_ACTION_COMMENT === 'true') {
  const url = await commentOnPullRequest(markdown.join('\n'));
  if (url) outputs.push(`comment=${url}`);
}
if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
process.exit(errored ? errored.exitCode : results.some((r) => r.exitCode === 1) ? 1 : 0);

// ─── pull request comment ────────────────────────────────────────────────────────────────────

async function github(method, path, body) {
  const res = await fetch(`${env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'scope-github-action',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const error = new Error(`${method} ${path} returned ${res.status}: ${detail.slice(0, 200)}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/**
 * Posts the report on the pull request, or updates the comment an earlier run posted (found by
 * a hidden marker, one per working directory). Returns the comment's URL, or null.
 */
async function commentOnPullRequest(report) {
  let number = null;
  try {
    number = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8')).pull_request?.number;
  } catch {
    // no event payload: not running on GitHub Actions
  }
  if (!number) {
    console.log('SCOPE: not a pull request event, so no comment was posted.');
    return null;
  }
  if (!githubToken || !env.GITHUB_REPOSITORY) {
    console.log('::warning title=SCOPE::Cannot comment: the github-token input is empty.');
    return null;
  }
  const marker = `<!-- scope-action:${env.SCOPE_ACTION_COMMENT_KEY || '.'} -->`;
  const run =
    env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
      ? `[workflow run](${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID})`
      : null;
  let text = report.trim() || 'SCOPE produced no report.';
  if (text.length > MAX_COMMENT)
    text = `${text.slice(0, MAX_COMMENT)}\n\n… The report was truncated; the job summary has all of it.`;
  const body = `${marker}\n${text}\n\n<sub>Posted by the SCOPE action${run ? ` · ${run}` : ''}</sub>\n`;

  const base = `/repos/${env.GITHUB_REPOSITORY}/issues`;
  try {
    let existing = null;
    for (let page = 1; page <= 10 && !existing; page++) {
      const comments = await github('GET', `${base}/${number}/comments?per_page=100&page=${page}`);
      existing = comments.find((c) => c.user?.type === 'Bot' && c.body?.startsWith(marker));
      if (comments.length < 100) break;
    }
    const comment = existing
      ? await github('PATCH', `${base}/comments/${existing.id}`, { body })
      : await github('POST', `${base}/${number}/comments`, { body });
    console.log(`SCOPE: ${existing ? 'updated' : 'posted'} ${comment.html_url}`);
    return comment.html_url;
  } catch (error) {
    const hint =
      error.status === 403 || error.status === 404
        ? ' Give the job `permissions: pull-requests: write`. Pull requests from forks get a read-only token.'
        : '';
    console.log(
      `::warning title=SCOPE::Could not comment on the pull request: ${error.message}.${hint}`,
    );
    return null;
  }
}
