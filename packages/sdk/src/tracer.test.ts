import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { silentLogger, type TraceBundle } from '@scope-ai/core';
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

  it('redacts attributes, events, status messages, errors, evaluations and metadata', async () => {
    const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
    for (const captureContent of [true, false]) {
      const { exporter, tracer } = setup({ privacy: { captureContent }, includeStacks: true });
      await tracer
        .trace(
          'call',
          {
            finalize: (trace) =>
              trace.addEvaluation({
                evaluator: 'echo',
                type: 'regex',
                kind: 'deterministic',
                status: 'failed',
                score: 0,
                threshold: null,
                reason: `Output contained ${key}`,
                metadata: { match: key },
                durationMs: 1,
                spanId: null,
              }),
          },
          async (trace) => {
            trace.setMetadata('password', 'hunter2');
            trace.setMetadata('note', `uses ${key}`);
            await tracer.span('fetch', { kind: 'tool' }, (span) => {
              span.setAttribute('openai_api_key', 'plain-value');
              span.setAttribute('http.request.header.authorization', 'Basic dXNlcjpwYXNz');
              span.setAttribute('url', `https://api.example.com/?key=${key}`);
              span.setAttribute('http.response.status_code', 401);
              span.addEvent('retry', { 'http.request.header.cookie': 'session=abc' });
              span.setStatus('ok', `sent ${key}`);
            });
            throw new Error(`401 Incorrect API key provided: ${key}`);
          },
        )
        .catch(() => {});
      const bundle = exporter.bundles[0];
      const text = JSON.stringify(bundle);
      expect(text, `captureContent: ${captureContent}`).not.toContain(key);
      expect(text).not.toContain('plain-value');
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('dXNlcjpwYXNz');
      expect(text).not.toContain('session=abc');
      const fetch = bundle?.spans.find((s) => s.name === 'fetch');
      expect(fetch?.attributes).toMatchObject({
        openai_api_key: '[redacted:sensitive_field]',
        'http.response.status_code': 401,
        url: 'https://api.example.com/?key=[redacted:openai_key]',
      });
      expect(bundle?.trace.error?.message).toBe(
        '401 Incorrect API key provided: [redacted:openai_key]',
      );
      expect(bundle?.evaluations[0]?.reason).toBe('Output contained [redacted:openai_key]');
      // Evidence is content: kept (redacted) with capture on, dropped with capture off.
      expect(bundle?.evaluations[0]?.metadata).toEqual(
        captureContent ? { match: '[redacted:openai_key]' } : {},
      );
      expect(bundle?.trace.metadata).toMatchObject({ password: '[redacted:sensitive_field]' });
    }
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

describe('spans that outlive their trace function', () => {
  it('waits for them before exporting, without keeping the caller waiting', async () => {
    const { exporter, tracer } = setup();
    let release!: () => void;
    const late = new Promise<void>((r) => {
      release = r;
    });
    // The function returns while its span is still open (a stream handed to the caller).
    await tracer.trace('handler', {}, () => {
      void tracer.span('stream', { kind: 'llm' }, async (span) => {
        await late;
        span.setOutput({ text: 'done' });
      });
      return 'returned';
    });
    expect(exporter.bundles).toHaveLength(0);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(exporter.bundles).toHaveLength(1);
    expect(exporter.bundles[0]?.spans.find((s) => s.name === 'stream')).toMatchObject({
      status: 'ok',
      output: { text: 'done' },
    });
  });

  it('closes them as errors after the grace period, or at shutdown', async () => {
    const graced = setup({ openSpanGraceMs: 30 });
    await graced.tracer.trace('handler', {}, () => {
      void graced.tracer.span('never', {}, () => new Promise(() => {}));
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(graced.exporter.bundles[0]?.spans.find((s) => s.name === 'never')).toMatchObject({
      status: 'error',
      statusMessage: 'span did not end within 0 s of its trace',
    });

    const { exporter, tracer } = setup();
    await tracer.trace('handler', {}, () => {
      void tracer.span('never', {}, () => new Promise(() => {}));
    });
    await tracer.shutdown();
    expect(exporter.bundles[0]?.spans.find((s) => s.name === 'never')).toMatchObject({
      status: 'error',
      statusMessage: 'span was still open when the tracer shut down',
    });
  });

  it('holds at most 1,000 traces, releasing the oldest first', async () => {
    const { exporter, tracer } = setup();
    for (let i = 0; i < 1001; i++)
      await tracer.trace(`t${i}`, {}, () => {
        void tracer.span('never', {}, () => new Promise(() => {}));
      });
    await new Promise((r) => setTimeout(r, 5));
    expect(exporter.bundles.map((b) => b.trace.name)).toEqual(['t0']);
  });

  it('closes them at once when the grace period is 0, as a workflow run needs', async () => {
    const { exporter, tracer } = setup({ openSpanGraceMs: 0 });
    await tracer.trace('case', {}, () => {
      void tracer.span('never', {}, () => new Promise(() => {}));
    });
    expect(exporter.bundles[0]?.spans.find((s) => s.name === 'never')).toMatchObject({
      status: 'error',
      statusMessage: 'span did not end before its trace',
    });
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
        ['--conditions=scope-source', '--input-type=module', '-e', script],
        { timeout: 20_000 },
        (error, stdout, stderr) =>
          done({
            code: error ? Number((error as { code?: number }).code ?? 1) : 0,
            stdout,
            stderr,
          }),
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

    const bytes = new HttpExporter({
      url: 'http://127.0.0.1:9',
      maxQueueBytes: 12_000,
      flushIntervalMs: 60_000,
    });
    bytes.export(sizedBundle(1, 5000));
    bytes.export(sizedBundle(2, 5000));
    bytes.export(sizedBundle(3, 5000));
    expect(bytes.stats.droppedTraces).toBe(1);
  });

  /** A server that answers each ingest request with `respond(body)`; records what arrived. */
  async function withHandler(
    respond: (body: { traces: Array<{ id: string }> }, raw: string) => [number, string],
    run: (url: string, received: Array<{ ids: string[]; bytes: number }>) => Promise<void>,
  ) {
    const received: Array<{ ids: string[]; bytes: number }> = [];
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
      });
      req.on('end', () => {
        const body = JSON.parse(data) as { traces: Array<{ id: string }> };
        const [status, text] = respond(body, data);
        if (status === 200)
          received.push({ ids: body.traces.map((t) => t.id), bytes: Buffer.byteLength(data) });
        res.writeHead(status, { 'content-type': 'application/json' }).end(text);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, received);
    } finally {
      server.close();
    }
  }

  it('bounds each request by bytes as well as by traces', async () => {
    await withHandler(
      () => [200, '{}'],
      async (url, received) => {
        const exporter = new HttpExporter({ url, maxBatchBytes: 12_000, flushIntervalMs: 60_000 });
        for (let i = 1; i <= 5; i++) exporter.export(sizedBundle(i, 5000));
        await exporter.flush();
        expect(received.map((r) => r.ids.length)).toEqual([2, 2, 1]);
        expect(received.every((r) => r.bytes <= 12_000)).toBe(true);
        expect(exporter.stats).toMatchObject({ exportedTraces: 5, droppedTraces: 0 });
      },
    );
  });

  it('drops a trace larger than a request without sending it, and says so once', async () => {
    await withHandler(
      () => [200, '{}'],
      async (url, received) => {
        const warnings: unknown[] = [];
        const exporter = new HttpExporter({
          url,
          maxBatchBytes: 8000,
          flushIntervalMs: 60_000,
          logger: {
            ...silentLogger,
            warn: (message, fields) => warnings.push({ message, fields }),
          },
        });
        exporter.export(sizedBundle(1, 20_000));
        exporter.export(sizedBundle(2, 20_000));
        exporter.export(sizedBundle(3, 1000));
        await exporter.flush();
        expect(received).toEqual([{ ids: [traceId(3)], bytes: expect.any(Number) }]);
        expect(exporter.stats).toMatchObject({ exportedTraces: 1, droppedTraces: 2 });
        expect(warnings).toEqual([
          {
            message: 'SCOPE dropped a trace too large to send',
            fields: expect.objectContaining({ traceId: traceId(1), maxBatchBytes: 8000 }),
          },
        ]);
      },
    );
  });

  it('splits a batch the server refuses as too large, so only oversized traces are lost', async () => {
    // A server whose limit is smaller than the exporter's batch size.
    await withHandler(
      (_, raw) => (Buffer.byteLength(raw) > 16_000 ? [413, '{}'] : [200, '{}']),
      async (url, received) => {
        const exporter = new HttpExporter({ url, flushIntervalMs: 60_000 });
        for (let i = 1; i <= 8; i++) exporter.export(sizedBundle(i, i === 5 ? 20_000 : 3000));
        await exporter.flush();
        expect(received.flatMap((r) => r.ids).sort()).toEqual(
          [1, 2, 3, 4, 6, 7, 8].map(traceId).sort(),
        );
        expect(exporter.stats).toMatchObject({ exportedTraces: 7, droppedTraces: 1 });
      },
    );
  });

  it('isolates a trace the server names as invalid, and does not split other rejections', async () => {
    const invalid = traceId(3);
    const issues = JSON.stringify({
      error: {
        code: 'bad_request',
        message: 'x',
        details: { issues: [{ path: 'traces[2].runId' }] },
      },
    });
    await withHandler(
      (body) => (body.traces.some((t) => t.id === invalid) ? [400, issues] : [200, '{}']),
      async (url, received) => {
        const exporter = new HttpExporter({ url, flushIntervalMs: 60_000 });
        for (let i = 1; i <= 6; i++) exporter.export(sizedBundle(i, 500));
        await exporter.flush();
        expect(received.flatMap((r) => r.ids).sort()).toEqual([1, 2, 4, 5, 6].map(traceId).sort());
        expect(exporter.stats).toMatchObject({ exportedTraces: 5, droppedTraces: 1 });
      },
    );
    let requests = 0;
    await withHandler(
      () => {
        requests++;
        return [400, '{"error":{"code":"bad_request","message":"Unsupported scope-protocol"}}'];
      },
      async (url) => {
        const exporter = new HttpExporter({ url, flushIntervalMs: 60_000 });
        for (let i = 1; i <= 6; i++) exporter.export(sizedBundle(i, 500));
        await exporter.flush();
        expect(requests).toBe(1);
        expect(exporter.stats).toMatchObject({ exportedTraces: 0, droppedTraces: 6 });
      },
    );
  });
});

const traceId = (n: number) => n.toString(16).padStart(32, '0');

/** A trace with distinct id `n` whose serialized form is about `bytes` long. */
function sizedBundle(n: number, bytes: number): TraceBundle {
  const bundle = fakeBundle(0);
  bundle.trace = { ...bundle.trace, id: traceId(n), input: { text: 'x'.repeat(bytes) } };
  return bundle;
}

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
