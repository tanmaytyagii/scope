/**
 * The GitHub Action's runner, exercised against a real project with the environment GitHub
 * provides (job summary and output files), so the action's behavior is tested locally and in CI —
 * not only by the self-test workflow on GitHub.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const RUNNER = join(here, 'run.mjs');
const CLI = resolve(here, '../../packages/cli/src/bin.ts');

interface ActionResult {
  code: number;
  stdout: string;
  outputs: Record<string, string>;
  summary: string;
}

const root = mkdtempSync(join(tmpdir(), 'scope-action-'));
const project = join(root, 'demo');

function exec(file: string, args: string[], cwd: string, env: Record<string, string>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(
      file,
      args,
      {
        cwd,
        env: {
          ...process.env,
          NO_COLOR: '1',
          CI: 'true',
          SCOPE_DATABASE_URL: '',
          // The runner starts the CLI with this Node; run it from TypeScript sources.
          NODE_OPTIONS: '--conditions=scope-source',
          ...env,
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        const code = error ? Number((error as { code?: number }).code ?? 1) : 0;
        done({ code, stdout, stderr });
      },
    );
  });
}

async function runAction(
  inputs: Record<string, string> = {},
  extraEnv: Record<string, string> = {},
): Promise<ActionResult> {
  const dir = mkdtempSync(join(tmpdir(), 'scope-action-gh-'));
  const summary = join(dir, 'summary.md');
  const output = join(dir, 'output.txt');
  writeFileSync(summary, '');
  writeFileSync(output, '');
  const result = await exec(process.execPath, [RUNNER], project, {
    GITHUB_ACTIONS: 'true',
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_OUTPUT: output,
    SCOPE_CLI: CLI,
    SCOPE_ACTION_WORKFLOWS: inputs.workflows ?? '',
    SCOPE_ACTION_VARIANTS: inputs.variants ?? 'default',
    SCOPE_ACTION_BASELINE: inputs.baseline ?? 'auto',
    SCOPE_ACTION_FAIL_ON_GATES: inputs['fail-on-gates'] ?? 'true',
    SCOPE_ACTION_COMMENT: inputs.comment ?? 'false',
    ...extraEnv,
  });
  const outputs = Object.fromEntries(
    readFileSync(output, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  return {
    code: result.code,
    stdout: result.stdout,
    outputs,
    summary: readFileSync(summary, 'utf8'),
  };
}

const cli = (args: string[]) =>
  exec(process.execPath, ['--conditions=scope-source', CLI, ...args], project, {});

beforeAll(async () => {
  await exec(process.execPath, ['--conditions=scope-source', CLI, 'init', 'demo'], root, {});
  // These tests are about the action, not timing: on a busy CI runner the starter's latency
  // warning gate (p95 +50% over a millisecond-scale baseline) is noise, and flipped "passed" to
  // "passed with warnings" (CI on fc5398e).
  const workflow = join(project, 'workflows', 'support.yaml');
  const gate = '  - metric: latency.p95_ms\n    max_increase_pct: 50\n    severity: warn\n';
  const text = readFileSync(workflow, 'utf8');
  expect(text).toContain(gate);
  writeFileSync(workflow, text.replace(gate, ''));
  expect((await cli(['run', 'workflows/support.yaml', '--quiet'])).code).toBe(0);
  expect((await cli(['baseline', 'save', '1'])).code).toBe(0);
});

describe('GitHub Action runner', () => {
  it('runs the project’s workflows against the baseline and reports a pass', async () => {
    const r = await runAction();
    expect(r.code).toBe(0);
    expect(r.outputs).toMatchObject({ result: 'passed', report: '.scope/action/report.json' });
    expect(r.summary).toContain('### ✅ SCOPE · support — passed');
    expect(r.summary).toContain('baseline: run #1');
    const report = JSON.parse(readFileSync(join(project, r.outputs.report as string), 'utf8'));
    expect(report).toMatchObject({
      schema: 'scope.action-report/v1',
      result: 'passed',
      workflows: [{ workflow: 'workflows/support.yaml', exitCode: 0 }],
    });
  });

  it('fails a regression, annotates the gate and explains it in the summary', async () => {
    const workflow = join(project, 'workflows', 'support.yaml');
    const original = readFileSync(workflow, 'utf8');
    writeFileSync(workflow, original.replace(/^ {2}sentences: 2$/m, '  sentences: 1'));
    try {
      const r = await runAction({ workflows: 'workflows/*.yaml' });
      expect(r.code).toBe(1);
      expect(r.outputs.result).toBe('failed');
      expect(r.stdout).toMatch(/^::error title=SCOPE · support · run #\d+::Pass rate: /m);
      expect(r.summary).toContain('### ❌ SCOPE · support — failed');
      expect(r.summary).toContain('regressed');
      expect(r.summary).toContain(
        '**Changed since the baseline:** sentences 2 → 1 · the workflow file',
      );

      const reportOnly = await runAction({ 'fail-on-gates': 'false' });
      expect(reportOnly.code).toBe(0);
      expect(reportOnly.outputs.result).toBe('failed');
    } finally {
      writeFileSync(workflow, original);
    }
  });

  it('reports a workflow that cannot run as an error, and still runs the others', async () => {
    const r = await runAction({ workflows: 'workflows/missing.yaml workflows/support.yaml' });
    expect(r.code).toBe(2);
    expect(r.outputs.result).toBe('error');
    expect(r.summary).toContain('`workflows/missing.yaml` could not run (exit 2)');
    expect(r.summary).toContain('SCOPE · support — passed');
  });

  it('runs variants when asked', async () => {
    const r = await runAction({ variants: 'terse', baseline: 'none' });
    expect(r.code).toBe(0);
    expect(r.summary).toContain('terse');
  });
});

/** A fake GitHub REST API: records requests and keeps the pull request's comments. */
function fakeGitHub() {
  const requests: Array<{ method: string; url: string; auth: string | undefined; body: unknown }> =
    [];
  const comments: Array<{ id: number; body: string; user: { type: string }; html_url: string }> = [
    // Someone else's comment that mentions the marker is never edited.
    { id: 1, body: '<!-- scope-action:. --> quoted', user: { type: 'User' }, html_url: 'x' },
  ];
  let deny = false;
  const server = createServer((req: IncomingMessage, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : null;
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        body,
      });
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (deny && req.method !== 'GET')
        return send(403, { message: 'Resource not accessible by integration' });
      if (req.method === 'GET' && req.url?.startsWith('/repos/acme/app/issues/7/comments'))
        return send(200, comments);
      if (req.method === 'POST' && req.url === '/repos/acme/app/issues/7/comments') {
        const id = 100 + comments.length;
        const comment = {
          id,
          body: body.body,
          user: { type: 'Bot' },
          html_url: `https://github.test/acme/app/pull/7#issuecomment-${id}`,
        };
        comments.push(comment);
        return send(201, comment);
      }
      const patch = /^\/repos\/acme\/app\/issues\/comments\/(\d+)$/.exec(req.url ?? '');
      if (req.method === 'PATCH' && patch) {
        const comment = comments.find((c) => c.id === Number(patch[1]));
        if (!comment) return send(404, { message: 'Not Found' });
        comment.body = body.body;
        return send(200, comment);
      }
      send(404, { message: 'Not Found' });
    });
  });
  return {
    requests,
    comments,
    deny: (value: boolean) => {
      deny = value;
    },
    listen: () =>
      new Promise<string>((done) =>
        server.listen(0, '127.0.0.1', () =>
          done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
        ),
      ),
    close: () => server.close(),
  };
}

describe('pull request comments', () => {
  const api = fakeGitHub();
  let env: Record<string, string>;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scope-action-event-'));
    const event = join(dir, 'event.json');
    writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
    env = {
      GITHUB_API_URL: await api.listen(),
      GITHUB_EVENT_PATH: event,
      GITHUB_REPOSITORY: 'acme/app',
      GITHUB_SERVER_URL: 'https://github.test',
      GITHUB_RUN_ID: '42',
      SCOPE_ACTION_GITHUB_TOKEN: 'ghs_test_token',
    };
  });
  afterAll(() => api.close());

  it('posts the report once, then updates the same comment', async () => {
    const first = await runAction({ comment: 'true' }, env);
    expect(first.code).toBe(0);
    const posted = api.comments.filter((c) => c.user.type === 'Bot');
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toMatch(/^<!-- scope-action:\. -->\n### ✅ SCOPE · support — passed/);
    expect(posted[0]?.body).toContain(
      '[workflow run](https://github.test/acme/app/actions/runs/42)',
    );
    expect(first.outputs.comment).toBe(posted[0]?.html_url);
    expect(api.requests.every((r) => r.auth === 'Bearer ghs_test_token')).toBe(true);

    const second = await runAction({ comment: 'true' }, env);
    expect(second.code).toBe(0);
    expect(api.comments.filter((c) => c.user.type === 'Bot')).toHaveLength(1);
    expect(api.requests.at(-1)).toMatchObject({
      method: 'PATCH',
      url: `/repos/acme/app/issues/comments/${posted[0]?.id}`,
    });
    // The user's comment that quotes the marker is left alone.
    expect(api.comments[0]?.body).toBe('<!-- scope-action:. --> quoted');
  });

  it('warns instead of failing when it may not comment', async () => {
    api.deny(true);
    try {
      const r = await runAction({ comment: 'true' }, env);
      expect(r.code).toBe(0);
      expect(r.outputs.result).toBe('passed');
      expect(r.outputs.comment).toBeUndefined();
      expect(r.stdout).toMatch(
        /^::warning title=SCOPE::Could not comment on the pull request: .*403/m,
      );
      expect(r.stdout).toContain('pull-requests: write');
    } finally {
      api.deny(false);
    }
  });

  it('comments only when asked, and only on pull requests', async () => {
    const before = api.requests.length;
    await runAction({}, env);
    expect(api.requests.length).toBe(before);

    const dir = mkdtempSync(join(tmpdir(), 'scope-action-push-'));
    writeFileSync(join(dir, 'event.json'), JSON.stringify({ ref: 'refs/heads/main' }));
    const push = await runAction(
      { comment: 'true' },
      { ...env, GITHUB_EVENT_PATH: join(dir, 'event.json') },
    );
    expect(push.code).toBe(0);
    expect(push.stdout).toContain('not a pull request event');
    expect(api.requests.length).toBe(before);
  });
});
