/**
 * Every example runs, with the commands and outcomes its README documents. Each workflow example
 * is copied to a temporary directory first, so runs never write into the repository.
 */
import { execFile, spawn } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const CLI = resolve(here, '../packages/cli/src/bin.ts');
const ENV = {
  ...process.env,
  NO_COLOR: '1',
  CI: 'true',
  SCOPE_DATABASE_URL: '',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  GITHUB_ACTIONS: '',
};

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(
      process.execPath,
      ['--conditions=scope-source', ...args],
      { cwd, env: { ...ENV, ...env }, timeout: 60_000 },
      (error, stdout, stderr) =>
        done({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

const scope = (args: string[], cwd: string) => run([CLI, ...args], cwd);

function copy(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), `scope-example-${name}-`)), name);
  cpSync(join(here, name), dir, {
    recursive: true,
    filter: (source) => !source.includes(`${name}/.scope`),
  });
  return dir;
}

describe('examples/rag', () => {
  it('passes, and its terse variant fails the regression gate against the committed baseline', async () => {
    const dir = copy('rag');
    expect((await scope(['validate'], dir)).code).toBe(0);
    const pass = await scope(['run', 'workflows/support.yaml'], dir);
    expect(pass.code).toBe(0);
    expect(pass.stdout).toContain('PASSED');
    const terse = await scope(
      [
        'run',
        'workflows/support.yaml',
        '--variant',
        'terse',
        '--baseline',
        'baselines/support.json',
      ],
      dir,
    );
    expect(terse.code).toBe(1);
    expect(terse.stdout).toContain(
      'Pass rate 83.3% → 75.0% (−8.3 pp); dropped more than the allowed 5.0 pp',
    );
    expect((await scope(['compare', '1', '2'], dir)).code).toBe(0);
  });
});

describe('examples/triage', () => {
  it('passes, and narrow_urgency fails the priority regression gate', async () => {
    const dir = copy('triage');
    expect((await scope(['validate'], dir)).code).toBe(0);
    expect((await scope(['run', 'workflows/triage.yaml'], dir)).code).toBe(0);
    const narrow = await scope(
      [
        'run',
        'workflows/triage.yaml',
        '--variant',
        'narrow_urgency',
        '--baseline',
        'baselines/triage.json',
      ],
      dir,
    );
    expect(narrow.code).toBe(1);
    expect(narrow.stdout).toMatch(/priority/);
  });
});

describe('examples/custom-evaluator', () => {
  it('gates on two custom evaluators, and fails when answers run long', async () => {
    const dir = copy('custom-evaluator');
    const pass = await scope(['run'], dir);
    expect(pass.code).toBe(0);
    expect(pass.stdout).toMatch(/short_enough\s+deterministic\s+100\.0%/);
    expect(pass.stdout).toMatch(/readable\s+heuristic\s+100\.0%/);
    const echo = await scope(['run', '--variant', 'echo'], dir);
    expect(echo.code).toBe(1);
    expect(echo.stdout).toMatch(/short_enough: \d+ words \(limit 45\)\./);
  });
});

/** Starts `scope ui` on a copy of an example project; resolves with its URL. */
async function serve(): Promise<{ url: string; stop: () => void }> {
  const ui = spawn(
    process.execPath,
    ['--conditions=scope-source', CLI, 'ui', '--port', '0', '--json'],
    {
      cwd: copy('rag'),
      env: ENV,
    },
  );
  const url = await new Promise<string>((ready, fail) => {
    let out = '';
    ui.stdout.on('data', (d) => {
      out += d;
      try {
        ready(JSON.parse(out).url);
      } catch {
        // wait for the whole document
      }
    });
    ui.on('exit', (code) => fail(new Error(`scope ui exited with ${code}`)));
  });
  return { url, stop: () => ui.kill('SIGINT') };
}

describe('examples/sdk-tracing', () => {
  it('sends its traces to a running scope ui', async () => {
    const { url, stop } = await serve();
    try {
      const app = await run([join(here, 'sdk-tracing', 'app.mjs')], here, { SCOPE_URL: url });
      expect(app.code).toBe(0);
      expect(app.stdout).toContain(`Sent 4 traces to ${url}`);
      const traces = (await (await fetch(`${url}/api/v1/traces?limit=10`)).json()) as {
        items: Array<{ name: string; evalCount: number }>;
      };
      expect(traces.items).toHaveLength(4);
      expect(traces.items.every((t) => t.evalCount > 0)).toBe(true);
    } finally {
      stop();
    }
  });
});

describe('examples/instrument-openai', () => {
  // A stand-in for an OpenAI-compatible server (the example was also run against Ollama).
  it('records the OpenAI SDK calls of an unmodified application', async () => {
    const model = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 1,
            model: 'llama3.1',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Within 5 to 7 business days.' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
          }),
        );
      });
    });
    await new Promise<void>((done) => model.listen(0, '127.0.0.1', done));
    const { url, stop } = await serve();
    try {
      const app = await run([join(here, 'instrument-openai', 'app.mjs')], here, {
        SCOPE_URL: url,
        OPENAI_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
        OPENAI_API_KEY: 'local',
        OPENAI_MODEL: 'llama3.1',
        SCOPE_PROVIDER: 'ollama',
      });
      expect(app.code).toBe(0);
      expect(app.stdout).toContain(`Sent 2 traces to ${url}.`);
      const page = (await (await fetch(`${url}/api/v1/traces?limit=5`)).json()) as {
        items: Array<{ id: string; llmCallCount: number }>;
      };
      expect(page.items).toHaveLength(2);
      const detail = (await (await fetch(`${url}/api/v1/traces/${page.items[0]?.id}`)).json()) as {
        spans: Array<{
          kind: string;
          provider: string | null;
          model: string | null;
          inputTokens: number | null;
        }>;
      };
      expect(detail.spans.find((s) => s.kind === 'llm')).toMatchObject({
        provider: 'ollama',
        model: 'llama3.1',
        inputTokens: 42,
      });
    } finally {
      stop();
      model.close();
    }
  });
});
