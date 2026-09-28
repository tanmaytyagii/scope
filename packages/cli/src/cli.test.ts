import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const BIN = resolve(fileURLToPath(new URL('.', import.meta.url)), 'bin.ts');

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function scope(args: string[], cwd: string, env: Record<string, string> = {}): Promise<Result> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      ['--conditions=source', BIN, ...args],
      {
        cwd,
        env: {
          ...process.env,
          NO_COLOR: '1',
          CI: 'true',
          SCOPE_DATABASE_URL: '',
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
          GITHUB_ACTIONS: '',
          ...env,
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code as number)
            : 1
          : 0;
        done({ code, stdout, stderr });
      },
    );
  });
}

const root = mkdtempSync(join(tmpdir(), 'scope-cli-'));
const project = join(root, 'demo');

beforeAll(async () => {
  const init = await scope(['init', 'demo'], root);
  expect(init.code).toBe(0);
});

describe('scope (no project needed)', () => {
  it('prints grouped help', async () => {
    const r = await scope(['--help'], root);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('SCOPE — see what your AI actually does.');
    for (const heading of [
      'Get started:',
      'Inspect results:',
      'CI and regressions:',
      'Diagnostics:',
    ])
      expect(r.stdout).toContain(heading);
    expect(r.stdout).toContain('Exit codes:');
  });

  it('suggests commands on typos and exits 2', async () => {
    const r = await scope(['rn'], root);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown command 'rn'/);
    expect(r.stderr).toMatch(/Did you mean run\?/);
  });

  it('prints the version', async () => {
    const r = await scope(['version', '--json'], root);
    expect(JSON.parse(r.stdout)).toMatchObject({ scope: '0.1.0' });
  });
});

describe('scope init', () => {
  it('creates a runnable project and refuses to overwrite it', async () => {
    for (const file of [
      'scope.yaml',
      'workflows/support.yaml',
      'datasets/support.jsonl',
      'docs/returns.md',
      '.gitignore',
      '.scope/schemas/workflow.schema.json',
    ]) {
      expect(existsSync(join(project, file)), file).toBe(true);
    }
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toContain('.scope/');
    const again = await scope(['init'], project);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('scope init would overwrite');
    expect(again.stderr).toContain('--force');
  });
});

describe('scope run → inspect → baseline → regression', () => {
  it('validates the starter project', async () => {
    const r = await scope(['validate'], project);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('✓ workflows/support.yaml');
    expect(r.stderr).toContain('1 workflow · 0 errors · 0 warnings');
  });

  it('runs the workflow offline and stores the run', async () => {
    const r = await scope(['run', 'workflows/support.yaml'], project);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('SCOPE · support');
    expect(r.stdout).toMatch(/PASSED\s+run #1 · 12 cases/);
    expect(r.stdout).toContain('Evaluators');
    expect(r.stderr).toMatch(/12\/12/);
    expect(existsSync(join(project, '.scope', 'scope.db'))).toBe(true);
  });

  it('emits a single JSON document with --json', async () => {
    const r = await scope(
      ['run', 'workflows/support.yaml', '--json', '--case', 'refund-timing'],
      project,
    );
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({
      schema: 'scope.report/v1',
      run: { number: 2, workflow: 'support', status: 'completed' },
      summary: { cases: { total: 1 } },
    });
  });

  it('runs one ad-hoc input', async () => {
    const r = await scope(
      [
        'run',
        'workflows/support.yaml',
        '--input',
        'question=Do you ship to Canada?',
        '--json',
        '--no-fail',
      ],
      project,
    );
    const report = JSON.parse(r.stdout);
    expect(report.summary.cases.total).toBe(1);
    expect(report.run.dataset.name).toBe('support-adhoc');
  });

  it('lists runs and traces, and shows a trace tree', async () => {
    const runs = JSON.parse((await scope(['runs', '--json'], project)).stdout);
    expect(runs.runs.map((r: { number: number }) => r.number)).toEqual([3, 2, 1]);
    const traces = JSON.parse(
      (await scope(['traces', '--run', '1', '--json', '--limit', '50'], project)).stdout,
    );
    expect(traces.items).toHaveLength(12);
    const id = traces.items[0].id as string;
    const tree = await scope(['traces', id.slice(0, 8)], project);
    expect(tree.code).toBe(0);
    expect(tree.stdout).toContain('retrieval');
    expect(tree.stdout).toContain('local:extractive');
    expect(tree.stdout).toContain('Evaluations');
    const detail = await scope(['runs', '1'], project);
    expect(detail.stdout).toContain('Run #1');
    expect(detail.stdout).toContain('Gates');
  });

  it('saves a baseline and fails the next run on a regression', async () => {
    const saved = await scope(['baseline', 'save', '1'], project);
    expect(saved.code).toBe(0);
    const baseline = JSON.parse(readFileSync(join(project, 'baselines', 'support.json'), 'utf8'));
    expect(baseline).toMatchObject({
      schema: 'scope.baseline/v1',
      workflow: 'support',
      source: { runNumber: 1 },
    });
    expect(Object.keys(baseline.cases)).toHaveLength(12);

    const workflow = join(project, 'workflows', 'support.yaml');
    writeFileSync(
      workflow,
      readFileSync(workflow, 'utf8').replace(/^ {2}sentences: 2$/m, '  sentences: 1'),
    );
    const regressed = await scope(['run', 'workflows/support.yaml'], project);
    expect(regressed.code).toBe(1);
    expect(regressed.stdout).toContain('FAILED');
    expect(regressed.stdout).toContain('Compared with baseline');
    expect(regressed.stdout).toMatch(/regressed/);
    expect(regressed.stdout).toMatch(/dropped more than the allowed 5\.0 pp/);

    const allowed = await scope(['run', 'workflows/support.yaml', '--no-fail'], project);
    expect(allowed.code).toBe(0);
  });

  it('compares runs and renders a markdown report', async () => {
    const compare = await scope(['compare', 'baselines/support.json', '4', '--json'], project);
    expect(compare.code).toBe(0);
    const data = JSON.parse(compare.stdout);
    expect(data.counts.regressed).toBeGreaterThan(0);
    const md = await scope(['report', '4', '--format', 'markdown'], project);
    expect(md.stdout).toContain('### ❌ SCOPE · support — failed');
    expect(md.stdout).toContain('| Metric | Baseline | Current | Change | Gate |');
    const out = join(project, 'summary.md');
    await scope(
      ['run', 'workflows/support.yaml', '--no-fail', '--summary-file', out, '-q'],
      project,
    );
    expect(readFileSync(out, 'utf8')).toContain('SCOPE · support');
  });

  it('re-scores a stored run with the current evaluators', async () => {
    const r = await scope(['evaluate', '1'], project);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Re-evaluated run #1');
  });

  it('diagnoses the project', async () => {
    const r = await scope(['doctor', '--json'], project);
    expect(r.code).toBe(0);
    const { checks } = JSON.parse(r.stdout);
    expect(checks.find((c: { area: string }) => c.area === 'Storage')).toMatchObject({
      status: 'pass',
    });
  });
});

describe('errors', () => {
  it('shows configuration errors with a code frame and does not run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scope-cli-bad-'));
    writeFileSync(
      join(dir, 'bad.yaml'),
      [
        'version: 1',
        'name: bad',
        'steps:',
        '  - id: answer',
        '    type: llm',
        '    with:',
        '      model: local:echo',
        '      prompt: hi',
        '      temprature: 0',
      ].join('\n'),
    );
    const r = await scope(['run', 'bad.yaml'], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('bad.yaml:9:7');
    expect(r.stderr).toContain('the llm step has no argument "temprature"');
    expect(r.stderr).toContain('hint: Did you mean "temperature"?');
    expect(r.stderr).toContain('> 9 │       temprature: 0');
    expect(r.stderr).toContain('nothing was executed');
  });

  it('explains missing files and unknown cases', async () => {
    const missing = await scope(['run', 'nope.yaml'], project);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('Workflow file not found: nope.yaml');
    const unknownCase = await scope(['run', 'workflows/support.yaml', '--case', 'nope'], project);
    expect(unknownCase.code).toBe(2);
    expect(unknownCase.stderr).toContain('No case with id "nope"');
  });

  it('reports unreachable storage with exit code 3 and a pointer to doctor', async () => {
    const r = await scope(['runs'], project, {
      SCOPE_DATABASE_URL: 'postgres://scope:secret@127.0.0.1:9/scope',
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(
      'Unable to connect to PostgreSQL at postgres://scope:***@127.0.0.1:9/scope',
    );
    expect(r.stderr).not.toContain('secret');
    expect(r.stderr).toContain('scope doctor');
  });

  it('prints JSON errors in --json mode', async () => {
    const r = await scope(['runs', '999', '--json'], project);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({
      error: { code: 'not_found', message: 'No run matches "999"' },
    });
  });
});
