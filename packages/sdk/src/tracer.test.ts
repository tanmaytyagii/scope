import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { TraceBundle } from '@scope-ai/core';
import { describe, expect, it } from 'vitest';
import { HttpExporter, MemoryExporter } from './exporters.ts';
import { Tracer } from './tracer.ts';

function setup(options: Partial<ConstructorParameters<typeof Tracer>[0]> = {}) {
  const exporter = new MemoryExporter();
  const tracer = new Tracer({ exporter, ...options });
  return { exporter, tracer };
}

const tick = () => new Promise((r) => setTimeout(r, 2));

describe('Tracer', () => {
  it('nests spans across async boundaries and exports one bundle per trace', async () => {
    const { exporter, tracer } = setup();
    const result = await tracer.trace(
      'answer',
      { input: { question: 'q' }, runId: 'run_1', caseId: 'c1' },
      async () => {
        const docs = await tracer.span('retrieve', { kind: 'retrieval' }, async () => {
          await tick();
          return ['doc'];
        });
        await Promise.all([
          tracer.span('tool-a', { kind: 'tool' }, async () => tick()),
          tracer.span('tool-b', { kind: 'tool' }, async () => tick()),
        ]);
        return tracer.span('generate', { kind: 'llm' }, async (span) => {
          await tracer.span('inner', {}, () => 'x');
          span.setOutput({ text: 'final' });
          return `${docs.length} doc`;
        });
      },
    );
    expect(result).toBe('1 doc');
    expect(exporter.bundles).toHaveLength(1);
    const { trace, spans } = exporter.bundles[0] as TraceBundle;
    expect(trace).toMatchObject({
      name: 'answer',
      runId: 'run_1',
      caseId: 'c1',
      status: 'ok',
      spanCount: 6,
      input: { question: 'q' },
      output: '1 doc',
    });
    const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
    const root = byName.answer;
    expect(root?.parentId).toBeNull();
    expect(byName.retrieve?.parentId).toBe(root?.id);
    expect(byName['tool-a']?.parentId).toBe(root?.id);
    expect(byName['tool-b']?.parentId).toBe(root?.id);
    expect(byName.inner?.parentId).toBe(byName.generate?.id);
    expect(byName.generate?.output).toEqual({ text: 'final' });
    expect(byName.retrieve?.output).toEqual(['doc']);
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([trace.id]));
  });

  it('records errors, rethrows them, and still exports', async () => {
    const { exporter, tracer } = setup();
    await expect(
      tracer.trace('failing', {}, async () => {
        await tracer.span('step', {}, () => {
          throw new Error('provider exploded with key sk-proj-abcdefghijklmnopqrstuvwxyz');
        });
      }),
    ).rejects.toThrow('provider exploded');
    const { trace, spans } = exporter.bundles[0] as TraceBundle;
    expect(trace.status).toBe('error');
    expect(trace.error?.message).toBe('provider exploded with key [redacted:openai_key]');
    const step = spans.find((s) => s.name === 'step');
    expect(step?.status).toBe('error');
    expect(step?.events[0]).toMatchObject({
      name: 'exception',
      attributes: { 'exception.type': 'Error' },
    });
    expect(step?.error?.stack).toBeUndefined();
  });

  it('runs finalize after the root span, creating separate root spans and evaluations', async () => {
    const { exporter, tracer } = setup();
    await tracer.trace(
      'wf',
      {
        finalize: async (trace) => {
          await tracer.span('evaluate', { kind: 'evaluation' }, async () => tick());
          trace.addEvaluation({
            evaluator: 'grounded',
            type: 'groundedness',
            kind: 'heuristic',
            status: 'passed',
            score: 0.9,
            threshold: 0.7,
            reason: 'ok',
            metadata: {},
            durationMs: 1,
            spanId: null,
          });
        },
      },
      async () => tick(),
    );
    const { trace, spans, evaluations } = exporter.bundles[0] as TraceBundle;
    const evaluate = spans.find((s) => s.name === 'evaluate');
    const root = spans.find((s) => s.name === 'wf');
    expect(evaluate?.parentId).toBeNull();
    expect(evaluate?.startTime).toBeGreaterThanOrEqual(root?.endTime ?? Number.POSITIVE_INFINITY);
    expect(trace.durationMs).toBe(root?.durationMs);
    expect(evaluations[0]).toMatchObject({
      traceId: trace.id,
      evaluator: 'grounded',
      id: expect.stringMatching(/^ev_/),
    });
  });

  it('records model calls with GenAI attributes and estimated cost', async () => {
    const { exporter, tracer } = setup({
      pricing: { 'acme:m1': { input: 1, output: 2, asOf: '2026-01-01', source: 'test' } },
    });
    await tracer.trace('wf', {}, async () => {
      await tracer.span('call', { kind: 'llm' }, (span) => {
        span.recordModelCall({
          provider: 'acme',
          model: 'm1',
          responseModel: 'm1-2026-01-01',
          usage: { inputTokens: 1000, outputTokens: 500 },
          finishReason: 'stop',
          temperature: 0,
          ignoredParams: ['temperature'],
        });
      });
      await tracer.span('unpriced', { kind: 'llm' }, (span) => {
        span.recordModelCall({
          provider: 'mystery',
          model: 'x',
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      });
    });
    const { trace, spans } = exporter.bundles[0] as TraceBundle;
    const call = spans.find((s) => s.name === 'call');
    expect(call).toMatchObject({
      provider: 'acme',
      model: 'm1',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(call?.costUsd).toBeCloseTo(0.002);
    expect(call?.attributes).toMatchObject({
      'gen_ai.provider.name': 'acme',
      'gen_ai.request.model': 'm1',
      'gen_ai.response.model': 'm1-2026-01-01',
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.response.finish_reasons': ['stop'],
      'scope.request.ignored_params': ['temperature'],
      'scope.cost.price_key': 'acme:m1',
    });
    expect(trace.usage).toMatchObject({ inputTokens: 1001, outputTokens: 501 });
    expect(trace.costUsd).toBeNull();
    expect(trace.llmCallCount).toBe(2);
  });

  it('honours content capture and span limits', async () => {
    const { exporter, tracer } = setup({ privacy: { captureContent: false }, maxSpansPerTrace: 3 });
    let ran = 0;
    await tracer.trace('wf', { input: 'secret prompt' }, async () => {
      for (let i = 0; i < 5; i++) {
        await tracer.span(`s${i}`, { input: 'private' }, () => {
          ran++;
        });
      }
    });
    const { trace, spans } = exporter.bundles[0] as TraceBundle;
    expect(ran).toBe(5);
    expect(spans).toHaveLength(3);
    expect(trace.metadata['scope.dropped_spans']).toBe(3);
    expect(trace.input).toBeNull();
    expect(spans[1]?.attributes['scope.content.omitted']).toBe(true);
  });

  it('runs spans outside a trace without recording them', async () => {
    const { exporter, tracer } = setup();
    expect(await tracer.span('lonely', {}, () => 42)).toBe(42);
    expect(exporter.bundles).toHaveLength(0);
  });

  it('never lets exporter failures reach application code', async () => {
    const tracer = new Tracer({
      exporter: {
        export() {
          throw new Error('disk full');
        },
      },
    });
    await expect(tracer.trace('wf', {}, () => 'fine')).resolves.toBe('fine');
  });
});

describe('HttpExporter shutdown', () => {
  it('keeps the process alive until an awaited shutdown finishes, even when retries fail', async () => {
    // Background exports must never hold a process open, but `await tracer.shutdown()` must
    // complete (and count dropped traces) rather than the process exiting mid-retry.
    const sdk = fileURLToPath(new URL('./index.ts', import.meta.url));
    const script = `
      import { HttpExporter, Tracer } from ${JSON.stringify(sdk)};
      const exporter = new HttpExporter({ url: 'http://127.0.0.1:9', maxRetries: 2, timeoutMs: 500 });
      const tracer = new Tracer({ exporter });
      await tracer.trace('job', {}, () => 'done');
      await tracer.shutdown();
      process.stdout.write(JSON.stringify(exporter.stats));
    `;
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      execFile(
        process.execPath,
        ['--conditions=source', '--input-type=module', '-e', script],
        { timeout: 20_000 },
        (error, stdout, stderr) =>
          done({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });
    expect(result.stderr).not.toContain('unsettled top-level await');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ exportedTraces: 0, droppedTraces: 1 });
  });
});

describe('HttpExporter', () => {
  async function withServer(
    statuses: number[],
    run: (url: string, bodies: unknown[]) => Promise<void>,
  ) {
    const bodies: unknown[] = [];
    let call = 0;
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
      });
      req.on('end', () => {
        bodies.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(data) });
        res.writeHead(statuses[Math.min(call++, statuses.length - 1)] ?? 200).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies);
    } finally {
      server.close();
    }
  }

  it('batches traces into one ingest request on flush', async () => {
    await withServer([200], async (url, bodies) => {
      const exporter = new HttpExporter({
        url,
        apiKey: 'scope_test',
        project: 'demo',
        flushIntervalMs: 60_000,
      });
      const tracer = new Tracer({ exporter });
      await tracer.trace('a', {}, () => 1);
      await tracer.trace('b', {}, () => 2);
      expect(bodies).toHaveLength(0);
      await tracer.flush();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        url: '/api/v1/ingest',
        auth: 'Bearer scope_test',
        body: { project: 'demo' },
      });
      expect(
        (bodies[0] as { body: { traces: unknown[]; spans: unknown[] } }).body.traces,
      ).toHaveLength(2);
      expect(exporter.stats.exportedTraces).toBe(2);
    });
  });

  it('retries server errors and gives up on client errors', async () => {
    await withServer([503, 200], async (url, bodies) => {
      const exporter = new HttpExporter({ url, maxRetries: 2 });
      exporter.export(fakeBundle(1));
      await exporter.flush();
      expect(bodies).toHaveLength(2);
      expect(exporter.stats).toMatchObject({ exportedTraces: 1, droppedTraces: 0 });
    });
    await withServer([400], async (url, bodies) => {
      const exporter = new HttpExporter({ url, maxRetries: 2 });
      exporter.export(fakeBundle(1));
      await exporter.flush();
      expect(bodies).toHaveLength(1);
      expect(exporter.stats).toMatchObject({
        exportedTraces: 0,
        droppedTraces: 1,
        failedRequests: 1,
      });
    });
  });

  it('drops traces when the queue is full instead of growing without bound', () => {
    const exporter = new HttpExporter({
      url: 'http://127.0.0.1:9',
      maxQueueSpans: 5,
      flushIntervalMs: 60_000,
    });
    exporter.export(fakeBundle(3));
    exporter.export(fakeBundle(3));
    expect(exporter.stats.droppedTraces).toBe(1);
  });
});

function fakeBundle(spanCount: number): TraceBundle {
  return {
    trace: {
      id: 'a'.repeat(32),
      runId: null,
      caseId: null,
      name: 't',
      status: 'ok',
      startTime: 0,
      endTime: 1,
      durationMs: 1,
      input: null,
      output: null,
      metadata: {},
      error: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      spanCount,
      llmCallCount: 0,
    },
    spans: Array.from({ length: spanCount }, () => ({}) as TraceBundle['spans'][number]),
    evaluations: [],
  };
}
