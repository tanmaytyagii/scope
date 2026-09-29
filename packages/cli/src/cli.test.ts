import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPE_VERSION } from '@scope-ai/core';
import { Store } from '@scope-ai/storage';
import { beforeAll, describe, expect, it } from 'vitest';
import { __test as exportTest } from './commands/export.ts';

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
      ['--conditions=scope-source', BIN, ...args],
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
      'Dashboard and server:',
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
    expect(JSON.parse(r.stdout)).toMatchObject({ scope: SCOPE_VERSION });
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

  it('shows where the project is, and the next commands', async () => {
    const elsewhere = join(mkdtempSync(join(tmpdir(), 'scope-cli-elsewhere-')), 'bot');
    const r = await scope(['init', elsewhere], root);
    expect(r.code).toBe(0);
    // Outside the current directory, the path is absolute (not ./../../…).
    expect(r.stdout).toContain(`Created SCOPE project bot in ${elsewhere}`);
    expect(r.stdout).toContain(`cd ${elsewhere}`);
    expect(r.stdout).toMatch(/^ {2}scope run {2,}# run and evaluate the workflow/m);
    expect(r.stdout).toMatch(/^ {2}scope ui --open /m);
  });
});

describe('scope run without a path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-cli-all-'));
  const multi = join(dir, 'multi');

  beforeAll(async () => {
    expect((await scope(['init', 'multi'], dir)).code).toBe(0);
    const source = readFileSync(join(multi, 'workflows', 'support.yaml'), 'utf8');
    writeFileSync(
      join(multi, 'workflows', 'triage.yaml'),
      source.replace(/^name: support$/m, 'name: triage'),
    );
  });

  it('runs every workflow of the project and summarizes them', async () => {
    const r = await scope(['run'], multi);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('SCOPE · support');
    expect(r.stdout).toContain('SCOPE · triage');
    expect(r.stdout).toMatch(/Workflows\n.*Workflow.*Run.*Cases.*Pass rate.*Result/);
    expect(r.stdout).toMatch(/support\s+#1\s+12\s+83\.3%\s+passed/);
    expect(r.stdout).toMatch(/triage\s+#2\s+12\s+83\.3%\s+passed/);
  });

  it('reports every run in one JSON document', async () => {
    const r = await scope(['run', '--json'], multi);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.runs.map((x: { run: { workflow: string } }) => x.run.workflow)).toEqual([
      'support',
      'triage',
    ]);
  });

  it('refuses options that name something inside one workflow', async () => {
    const r = await scope(['run', '--case', 'refund-timing'], multi);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--case applies to one workflow, but 2 would run');
    expect(r.stderr).toContain('scope run workflows/support.yaml --case');
  });

  it('explains when the project has no workflows', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'scope-cli-empty-'));
    const r = await scope(['run'], empty);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('No workflow files found');
    expect(r.stderr).toContain('scope init');
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
      config: { params: { sentences: 2 }, workflowHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
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

    // The comparison the gates used is stored with the run, for the dashboard.
    const store = await Store.open(`sqlite:${join(project, '.scope', 'scope.db')}`);
    try {
      const row = await store.ensureProject('demo');
      const run = await store.latestRun(row.id, { workflow: 'support' });
      expect(run?.baseline).toMatchObject({ file: 'baselines/support.json', runNumber: 1 });
      expect(run?.baseline?.runId).toMatch(/^run_/);
      const stored = await store.getBaselineComparison(row.id, run?.id as string);
      expect(stored?.counts.regressed).toBeGreaterThan(0);
      expect(stored?.cases[0]?.kind).toBe('regressed');
    } finally {
      await store.close();
    }

    const allowed = await scope(['run', 'workflows/support.yaml', '--no-fail'], project);
    expect(allowed.code).toBe(0);
  });

  it('annotates failed gates on GitHub Actions and writes a JSON report file', async () => {
    const r = await scope(
      ['run', 'workflows/support.yaml', '--report-file', 'scope-report.json', '--no-fail'],
      project,
      { GITHUB_ACTIONS: 'true', GITHUB_SHA: 'abc1234def', GITHUB_REF: 'refs/pull/7/merge' },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /^::error title=SCOPE · support · run #\d+::Pass rate: .*dropped more than/m,
    );
    const report = JSON.parse(readFileSync(join(project, 'scope-report.json'), 'utf8'));
    expect(report).toMatchObject({
      schema: 'scope.report/v1',
      run: { workflow: 'support', git: { commit: 'abc1234def', pullRequest: 7 } },
    });
    expect(report.gates.some((g: { status: string }) => g.status === 'failed')).toBe(true);
  });

  it('compares runs and renders a markdown report', async () => {
    const compare = await scope(['compare', 'baselines/support.json', '4', '--json'], project);
    expect(compare.code).toBe(0);
    const data = JSON.parse(compare.stdout);
    expect(data.counts.regressed).toBeGreaterThan(0);

    // Up to four side by side, baselines included.
    const many = await scope(['compare', 'baselines/support.json', '1', '4'], project);
    expect(many.code).toBe(0);
    expect(many.stdout).toMatch(
      /Metric\s+baseline baselines\/support\.json \(run #1\)\s+run #1\s+run #4/,
    );
    expect(many.stdout).toMatch(/Pass rate\s+83\.3% ✓\s+83\.3% ✓\s+75\.0%/);
    expect(many.stdout).toContain('Cases that differ');
    const manyJson = JSON.parse(
      (await scope(['compare', '1', '2', '4', '--json'], project)).stdout,
    );
    expect(manyJson.runs).toEqual(['run #1', 'run #2', 'run #4']);
    expect(manyJson.metrics.find((m: { id: string }) => m.id === 'pass_rate').values).toHaveLength(
      3,
    );
    const tooMany = await scope(['compare', '1', '2', '3', '4', '5'], project);
    expect(tooMany.code).toBe(2);
    expect(tooMany.stderr).toContain('Compare 2 to 4 runs (got 5)');
    const md = await scope(['report', '4', '--format', 'markdown'], project);
    expect(md.stdout).toContain('### ❌ SCOPE · support — failed');
    expect(md.stdout).toContain('| Metric | Baseline | Current | Change | Gate |');
    // The baseline records its configuration, so the report says what changed: the workflow
    // file was edited so that answers keep one sentence.
    expect(md.stdout).toContain(
      '**Changed since the baseline:** sentences 2 → 1 · the workflow file',
    );
    const text = await scope(['compare', '1', '4'], project);
    expect(text.stdout).toMatch(/Changed\s+sentences 2 → 1 · the workflow file/);

    // Replacing the baseline file later does not rewrite history: the report shows what the
    // run's gates compared against.
    const file = join(project, 'baselines', 'support.json');
    const original = readFileSync(file, 'utf8');
    try {
      expect((await scope(['baseline', 'save', '4', '--force'], project)).code).toBe(0);
      const later = await scope(['report', '4', '--format', 'json'], project);
      const report = JSON.parse(later.stdout);
      expect(report.baseline).toMatchObject({ runNumber: 1 });
      expect(report.comparison.counts.regressed).toBeGreaterThan(0);
      // An explicit --baseline still compares with that file.
      const explicit = await scope(
        ['report', '4', '--format', 'json', '--baseline', 'baselines/support.json'],
        project,
      );
      expect(JSON.parse(explicit.stdout).baseline).toMatchObject({ runNumber: 4 });
    } finally {
      writeFileSync(file, original);
    }
    const out = join(project, 'summary.md');
    await scope(
      ['run', 'workflows/support.yaml', '--no-fail', '--summary-file', out, '-q'],
      project,
    );
    expect(readFileSync(out, 'utf8')).toContain('SCOPE · support');
  });

  it('writes JUnit reports for CI systems other than GitHub', async () => {
    const file = join(project, 'junit.xml');
    const r = await scope(['run', 'workflows/support.yaml', '--junit-file', file, '-q'], project);
    expect(r.code).toBe(1);
    const xml = readFileSync(file, 'utf8');
    expect(xml).toMatch(
      /^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites name="SCOPE" tests="\d+" failures="[1-9]\d*" errors="0"/,
    );
    expect(xml).toMatch(/<testsuite name="support \(run #\d+\)" tests="12" failures="3"/);
    expect(xml).toContain(
      '<failure type="evaluation" message="key_facts: Missing: &quot;5 to 7 business days&quot;.">',
    );
    expect(xml).toContain('<testcase classname="support" name="store-hours"');
    expect(xml).toMatch(
      /<testcase classname="support.gates" name="pass_rate drop ≤ 5.0 pp vs baseline" time="0.000">\s*<failure type="gate"/,
    );
    // Well-formed: every element closes, in order.
    const stack: string[] = [];
    for (const [tag, closing, name, selfClosing] of xml.matchAll(/<(\/?)([a-z-]+)[^>]*?(\/?)>/g)) {
      if (tag.startsWith('<?')) continue;
      if (selfClosing) continue;
      if (closing) expect(stack.pop()).toBe(name);
      else stack.push(name as string);
    }
    expect(stack).toEqual([]);

    const stored = await scope(['report', '1', '--format', 'junit'], project);
    expect(stored.code).toBe(0);
    expect(stored.stdout).toMatch(/<testsuite name="support \(run #1\)" tests="12" failures="2"/);
    expect(stored.stdout).toContain('<property name="scope.run" value="1"/>');
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

describe('scope export', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-cli-export-'));
  const proj = join(dir, 'exp');

  beforeAll(async () => {
    expect((await scope(['init', 'exp'], dir)).code).toBe(0);
    expect((await scope(['run', '-q'], proj)).code).toBe(0);
  });

  it('turns a run’s traces into dataset cases that run again', async () => {
    const file = join(proj, 'from-traces.jsonl');
    const r = await scope(
      ['export', 'traces', '--run', '1', '--format', 'dataset', '-o', file],
      proj,
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Wrote 12 cases');
    const cases = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(cases).toHaveLength(12);
    expect(cases.find((c) => c.id === 'refund-timing')).toMatchObject({
      inputs: { question: 'How long does it take to get a refund?' },
      expected: ['5 to 7 business days'],
      metadata: { source_trace: expect.stringMatching(/^[0-9a-f]{32}$/) },
    });
    const rerun = await scope(
      ['run', 'workflows/support.yaml', '--dataset', file, '--no-baseline', '-q'],
      proj,
    );
    expect(rerun.code).toBe(0);
    expect(rerun.stdout).toMatch(/run #2 · 12 cases/);
  });

  it('exports whole traces and run results', async () => {
    const jsonl = await scope(['export', 'traces', '--run', '1', '--limit', '3'], proj);
    const traces = jsonl.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(traces).toHaveLength(3);
    expect(traces[0]).toMatchObject({
      trace: { runId: expect.any(String) },
      spans: expect.any(Array),
    });

    const csv = await scope(['export', 'run', '1'], proj);
    expect(csv.code).toBe(0);
    const [header, ...rows] = csv.stdout.trim().split('\n');
    expect(header).toBe(
      'case_id,outcome,duration_ms,total_tokens,cost_usd,grounded.status,grounded.score,no_invented_facts.status,no_invented_facts.score,key_facts.status,key_facts.score,fast.status,fast.score,error,input_preview,output_preview,trace_id',
    );
    expect(rows).toHaveLength(12);
    expect(rows.find((r) => r.startsWith('refund-method,failed,'))).toContain(',failed,0,');
  });

  it('writes CSV that spreadsheets cannot run, and reads --since', () => {
    const { cell, parseSince } = exportTest;
    expect(cell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(cell('-1')).toBe("'-1");
    expect(cell(-1)).toBe('-1');
    expect(cell('a,b')).toBe('"a,b"');
    expect(parseSince('7d', 1_000_000_000)).toBe(1_000_000_000 - 7 * 86_400_000);
    expect(() => parseSince('last week')).toThrow(/not a duration or date/);
  });
});

describe('scope doctor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-cli-doctor-'));
  const proj = join(dir, 'doc');
  interface CheckRow {
    area: string;
    status: string;
    message: string;
    hint?: string;
  }
  async function doctor(cwd = proj, args: string[] = [], env: Record<string, string> = {}) {
    const r = await scope(['doctor', '--json', ...args], cwd, env);
    return { code: r.code, stdout: r.stdout, checks: JSON.parse(r.stdout).checks as CheckRow[] };
  }
  const check = (area: string, status: string, message: string | RegExp) =>
    expect.objectContaining({
      area,
      status,
      message: typeof message === 'string' ? message : expect.stringMatching(message),
    });

  beforeAll(async () => {
    expect((await scope(['init', 'doc'], dir)).code).toBe(0);
  });

  it('checks the datasets and baselines the workflows use', async () => {
    let { checks } = await doctor();
    expect(checks).toContainEqual(
      check('Datasets', 'pass', 'support: datasets/support.jsonl · 12 cases'),
    );
    expect(checks).toContainEqual(
      check('Baselines', 'warn', 'support: no baseline, so its regression gates are skipped'),
    );

    expect((await scope(['run'], proj)).code).toBe(0);
    expect((await scope(['baseline', 'save'], proj)).code).toBe(0);
    ({ checks } = await doctor());
    expect(checks).toContainEqual(
      check('Baselines', 'pass', /^baselines\/support\.json — run #1, saved /),
    );

    copyFileSync(join(proj, 'baselines', 'support.json'), join(proj, 'baselines', 'retired.json'));
    const data = join(proj, 'datasets', 'support.jsonl');
    writeFileSync(data, readFileSync(data, 'utf8').split('\n').slice(1).join('\n'));
    ({ checks } = await doctor());
    expect(checks).toContainEqual(
      check(
        'Baselines',
        'warn',
        'baselines/support.json: the dataset changed since it was saved (12 → 11 cases)',
      ),
    );
    expect(checks).toContainEqual(
      check('Baselines', 'warn', 'baselines/retired.json belongs to no workflow or variant'),
    );

    writeFileSync(data, `${readFileSync(data, 'utf8')}{"id":"broken"\n`);
    const broken = await doctor();
    expect(broken.code).toBe(1);
    expect(broken.checks).toContainEqual(
      check('Datasets', 'fail', /^support: datasets\/support\.jsonl: invalid JSON on line 12/),
    );
  });

  it('warns when git would commit the local database', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
        cwd: proj,
        stdio: 'ignore',
      });
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const ignored = await doctor();
    expect(ignored.checks.filter((c) => c.area === 'Git')).toHaveLength(1);
    writeFileSync(join(proj, '.gitignore'), 'node_modules/\n');
    const exposed = await doctor();
    expect(exposed.checks).toContainEqual(
      check('Git', 'warn', 'the local database .scope/scope.db is not ignored by git'),
    );
  });

  it('asks the providers in use for their models with --network', async () => {
    const hits: string[] = [];
    const api = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const ok = req.headers.authorization === 'Bearer sk-good';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          ok
            ? {
                object: 'list',
                data: [{ id: 'gpt-5', object: 'model', created: 1, owned_by: 'x' }],
              }
            : { error: { message: 'Incorrect API key provided' } },
        ),
      );
    });
    await new Promise<void>((done) => api.listen(0, '127.0.0.1', done));
    try {
      const remote = mkdtempSync(join(tmpdir(), 'scope-cli-remote-'));
      const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}/v1`;
      writeFileSync(
        join(remote, 'scope.yaml'),
        `version: 1\nproject: remote\nproviders:\n  openai:\n    base_url: ${url}\n    max_retries: 0\n`,
      );
      mkdirSync(join(remote, 'workflows'));
      writeFileSync(
        join(remote, 'workflows', 'remote.yaml'),
        [
          'version: 1',
          'name: remote',
          'steps:',
          '  - id: draft',
          '    type: llm',
          '    with: { model: openai:gpt-5, prompt: hi }',
          '  - id: polish',
          '    type: llm',
          '    with: { model: openai:gpt-9, prompt: hi }',
        ].join('\n'),
      );

      const offline = await doctor(remote, [], { OPENAI_API_KEY: 'sk-good' });
      expect(hits).toEqual([]);
      expect(offline.checks).toContainEqual(
        check('Providers', 'info', /^credentials were not tried; scope doctor --network/),
      );

      const good = await doctor(remote, ['--network'], { OPENAI_API_KEY: 'sk-good' });
      expect(hits).toEqual(['GET /v1/models']);
      expect(good.checks).toContainEqual(
        check('Providers', 'pass', /^openai: reachable, credentials accepted \(1 model, \d+ ms\)$/),
      );
      expect(good.checks).toContainEqual(
        check(
          'Providers',
          'warn',
          'openai: gpt-9 is not among the models these credentials can use',
        ),
      );
      expect(good.stdout).not.toContain('sk-good');

      const bad = await doctor(remote, ['--network'], { OPENAI_API_KEY: 'sk-bad' });
      expect(bad.code).toBe(1);
      expect(bad.checks).toContainEqual(
        check(
          'Providers',
          'fail',
          'openai rejected the credentials (401): Incorrect API key provided',
        ),
      );
    } finally {
      api.close();
    }
  });
});

interface Served {
  info: { url: string } & Record<string, unknown>;
  stop(): Promise<{ code: number | null; stderr: string }>;
}

/** Starts a long-running command and waits for the JSON document it prints once listening. */
function serve(args: string[], cwd: string, env: Record<string, string> = {}): Promise<Served> {
  return new Promise((ready, fail) => {
    const child = spawn(process.execPath, ['--conditions=scope-source', BIN, ...args, '--json'], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', SCOPE_DATABASE_URL: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.stdout.on('data', (d) => {
      stdout += d;
      try {
        const info = JSON.parse(stdout);
        ready({
          info,
          stop: async () => {
            child.kill('SIGINT');
            return { code: await exited, stderr };
          },
        });
      } catch {
        // wait for the complete document
      }
    });
    void exited.then((code) => fail(new Error(`exited with ${code} before listening:\n${stderr}`)));
  });
}

describe('scope ui, server and keys', () => {
  it('serves the project’s runs to the dashboard API and stops cleanly', async () => {
    const ui = await serve(['ui', '--port', '0'], project);
    try {
      expect(ui.info).toMatchObject({ project: 'demo', auth: 'none' });
      expect(ui.info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${ui.info.url}/api/v1/runs?limit=1`);
      const runs = (await res.json()) as { items: unknown[] };
      expect(runs.items[0]).toMatchObject({ workflow: 'support' });
    } finally {
      const { code } = await ui.stop();
      expect(code).toBe(0);
    }
  });

  it('refuses to expose the unauthenticated dashboard beyond this machine', async () => {
    const r = await scope(['ui', '--host', '0.0.0.0'], project);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('only listens on this machine');
    expect(r.stderr).toContain('scope server');
  });

  it('creates, lists and revokes API keys that a server accepts', async () => {
    const created = JSON.parse(
      (await scope(['keys', 'create', '--name', 'ci', '--scope', 'read', '--json'], project))
        .stdout,
    );
    expect(created).toMatchObject({ name: 'ci', project: 'demo', scopes: ['read'] });
    expect(created.secret).toMatch(/^scope_[A-Za-z0-9]{32}$/);

    const listed = await scope(['keys', 'list', '--json'], project);
    expect(listed.stdout).not.toContain(created.secret);
    expect(JSON.parse(listed.stdout).keys[0]).toMatchObject({ id: created.id, revokedAt: null });

    const server = await serve(['server', '--host', '127.0.0.1', '--port', '0'], project);
    try {
      const url = `${server.info.url}/api/v1/runs`;
      expect((await fetch(url)).status).toBe(401);
      const ok = await fetch(url, { headers: { authorization: `Bearer ${created.secret}` } });
      expect(ok.status).toBe(200);
      const revoked = await scope(['keys', 'revoke', created.id], project);
      expect(revoked.code).toBe(0);
      const after = await fetch(url, { headers: { authorization: `Bearer ${created.secret}` } });
      expect(after.status).toBe(401);
    } finally {
      const { code, stderr } = await server.stop();
      expect(code).toBe(0);
      // Server logs are JSON lines; the key never appears in them.
      expect(stderr).toContain('"msg":"SCOPE server listening"');
      expect(stderr).not.toContain(created.secret);
    }
  });

  it('rejects unknown key scopes', async () => {
    const r = await scope(['keys', 'create', '--scope', 'admin'], project);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown scope "admin"');
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
