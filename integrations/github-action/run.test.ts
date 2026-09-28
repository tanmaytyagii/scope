/**
 * The GitHub Action's runner, exercised against a real project with the environment GitHub
 * provides (job summary and output files), so the action's behavior is tested locally and in CI —
 * not only by the self-test workflow on GitHub.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

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
          NODE_OPTIONS: '--conditions=source',
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

async function runAction(inputs: Record<string, string> = {}): Promise<ActionResult> {
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
  });
  const outputs = Object.fromEntries(
    readFileSync(output, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('=', 2) as [string, string]),
  );
  return {
    code: result.code,
    stdout: result.stdout,
    outputs,
    summary: readFileSync(summary, 'utf8'),
  };
}

const cli = (args: string[]) =>
  exec(process.execPath, ['--conditions=source', CLI, ...args], project, {});

beforeAll(async () => {
  await exec(process.execPath, ['--conditions=source', CLI, 'init', 'demo'], root, {});
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
