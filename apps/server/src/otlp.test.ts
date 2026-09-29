/**
 * OTLP ingestion end to end: the official OpenTelemetry JS exporters (JSON and protobuf) and the
 * Vercel AI SDK's OpenTelemetry integration send to a running SCOPE server, and the result is
 * read back through the API the dashboard uses. No hand-built payloads on the happy path.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { OpenTelemetry } from '@ai-sdk/otel';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPTraceExporter as JsonExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as ProtobufExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import type { Span, TraceDetail, TracePage } from '@scope-ai/protocol';
import { type Project, Store } from '@scope-ai/storage';
import { generateText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type RunningServer, startServer } from './server.ts';

let store: Store;
let project: Project;
let server: RunningServer;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-otlp-'));
  store = await Store.open(`sqlite:${join(dir, 'scope.db')}`);
  project = await store.ensureProject('demo');
  server = await startServer({
    store,
    auth: { mode: 'none', defaultProject: project },
    host: '127.0.0.1',
    port: 0,
  });
});

afterAll(async () => {
  await server?.close();
  await store?.close();
});

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${server.url}/api/v1${path}`);
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
}

function provider(exporter: SpanExporter, batch: boolean) {
  return new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'support-bot', 'service.version': '1.4.2' }),
    spanProcessors: [batch ? new BatchSpanProcessor(exporter) : new SimpleSpanProcessor(exporter)],
  });
}

/** A request handled by a model call and a tool call, one of which fails, as an app records it. */
async function recordAnswer(p: BasicTracerProvider, question: string): Promise<string> {
  const tracer = p.getTracer('support-bot');
  const root = tracer.startSpan('answer-question', { attributes: { 'input.value': question } });
  const inRoot = trace.setSpan(context.active(), root);

  const llm = tracer.startSpan(
    'chat gpt-5',
    {
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'openai',
        'gen_ai.request.model': 'gpt-5',
        'gen_ai.response.model': 'gpt-5-2025-08-07',
        'gen_ai.usage.input_tokens': 1200,
        'gen_ai.usage.output_tokens': 150,
        'gen_ai.usage.cache_read.input_tokens': 200,
        'gen_ai.system_instructions': JSON.stringify([{ type: 'text', content: 'Be brief.' }]),
        'gen_ai.input.messages': JSON.stringify([
          { role: 'user', parts: [{ type: 'text', content: question }] },
        ]),
        'gen_ai.output.messages': JSON.stringify([
          {
            role: 'assistant',
            parts: [{ type: 'text', content: 'Refunds take 5 to 7 business days.' }],
            finish_reason: 'stop',
          },
        ]),
        'http.request.header.authorization': 'Bearer sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      },
    },
    inRoot,
  );
  llm.end();

  const tool = tracer.startSpan(
    'execute_tool lookup_order',
    {
      attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': 'lookup_order',
        'gen_ai.tool.call.arguments': JSON.stringify({ order: 'A-1' }),
      },
    },
    inRoot,
  );
  tool.recordException(new Error('order service timed out'));
  tool.setStatus({ code: SpanStatusCode.ERROR, message: 'order service timed out' });
  tool.end();

  root.setAttribute('output.value', 'Refunds take 5 to 7 business days.');
  root.end();
  await p.forceFlush();
  return root.spanContext().traceId;
}

function expectAnswerTrace(detail: TraceDetail) {
  expect(detail.trace).toMatchObject({
    name: 'answer-question',
    status: 'ok',
    spanCount: 3,
    llmCallCount: 1,
    // 1,200 reported input tokens include 200 read from cache, which SCOPE counts (and prices)
    // separately; the total includes them once.
    usage: { inputTokens: 1000, outputTokens: 150, totalTokens: 1350 },
    input: expect.stringContaining('How long do refunds take?'),
    metadata: { 'service.name': 'support-bot', 'service.version': '1.4.2' },
  });
  expect(detail.trace.costUsd).toBeGreaterThan(0);
  const byName = (name: string) => detail.spans.find((s) => s.name === name) as Span;
  const root = byName('answer-question');
  const llm = byName('chat gpt-5');
  const tool = byName('execute_tool lookup_order');
  expect(root).toMatchObject({ kind: 'workflow', parentId: null });
  expect(llm).toMatchObject({
    kind: 'llm',
    parentId: root.id,
    provider: 'openai',
    model: 'gpt-5',
    inputTokens: 1000,
    outputTokens: 150,
    input: {
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'How long do refunds take?' },
      ],
    },
    output: { text: 'Refunds take 5 to 7 business days.' },
  });
  expect(llm.costUsd).toBeGreaterThan(0);
  expect(llm.attributes).toMatchObject({
    'gen_ai.response.model': 'gpt-5-2025-08-07',
    'http.request.header.authorization': '[redacted:sensitive_field]',
    'otel.scope.name': 'support-bot',
  });
  // Content moved to input/output is not duplicated in attributes.
  expect(llm.attributes['gen_ai.input.messages']).toBeUndefined();
  expect(tool).toMatchObject({
    kind: 'tool',
    status: 'error',
    input: { order: 'A-1' },
    error: { type: 'Error', message: 'order service timed out' },
  });
  expect(root.offsetMs).toBe(0);
}

describe('OTLP/HTTP ingestion', () => {
  it('assembles a trace sent span by span over OTLP/JSON', async () => {
    const p = provider(new JsonExporter({ url: `${server.url}/v1/traces` }), false);
    const traceId = await recordAnswer(p, 'How long do refunds take?');
    await p.shutdown();
    expectAnswerTrace(await api<TraceDetail>(`/traces/${traceId}`));
    const page = await api<TracePage>('/traces?q=refunds');
    expect(page.items.map((t) => t.id)).toContain(traceId);
  });

  it('accepts OTLP/protobuf, compressed', async () => {
    const p = provider(
      new ProtobufExporter({ url: `${server.url}/v1/traces`, compression: 'gzip' as never }),
      true,
    );
    const traceId = await recordAnswer(p, 'How long do refunds take?');
    await p.shutdown();
    expectAnswerTrace(await api<TraceDetail>(`/traces/${traceId}`));
  });

  it('records Vercel AI SDK calls through its OpenTelemetry integration', async () => {
    const p = provider(new JsonExporter({ url: `${server.url}/v1/traces` }), false);
    const model = new MockLanguageModelV4({
      provider: 'openai.chat',
      modelId: 'gpt-5',
      doGenerate: {
        content: [{ type: 'text', text: 'Refunds take 5 to 7 business days.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 40, noCache: 40, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 9, text: 9, reasoning: undefined },
        },
        warnings: [],
      } as never,
    });
    const result = await generateText({
      model,
      prompt: 'How long do refunds take?',
      experimental_telemetry: {
        isEnabled: true,
        integrations: [new OpenTelemetry({ tracer: p.getTracer('ai') })],
      },
    });
    expect(result.text).toBe('Refunds take 5 to 7 business days.');
    await p.forceFlush();
    await p.shutdown();

    const page = await api<TracePage>('/traces?q=refunds&sort=newest&limit=1');
    const detail = await api<TraceDetail>(`/traces/${page.items[0]?.id}`);
    const calls = detail.spans.filter((s) => s.kind === 'llm');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 40,
      outputTokens: 9,
    });
    expect(JSON.stringify(calls[0]?.input)).toContain('How long do refunds take?');
    expect(calls[0]?.output).toEqual({ text: 'Refunds take 5 to 7 business days.' });
    expect(detail.trace).toMatchObject({
      llmCallCount: 1,
      usage: { inputTokens: 40, outputTokens: 9 },
    });
    expect(detail.trace.costUsd).toBeGreaterThan(0);
  });
});

describe('OTLP with the AI SDK: an agent that calls a tool', () => {
  it('shows each step, model call and tool call, and counts tokens once', async () => {
    const p = provider(new JsonExporter({ url: `${server.url}/v1/traces` }), false);
    const usage = {
      inputTokens: { total: 40, noCache: 40, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 9, text: 9, reasoning: undefined },
    };
    const model = new MockLanguageModelV4({
      provider: 'openai.chat',
      modelId: 'gpt-5',
      doGenerate: [
        {
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"order":"A-1"}' },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage,
          warnings: [],
        },
        {
          content: [{ type: 'text', text: 'Order A-1 has shipped.' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        },
      ] as never,
    });
    await generateText({
      model,
      prompt: 'Where is order A-1?',
      stopWhen: stepCountIs(3),
      tools: {
        lookup: tool({
          inputSchema: z.object({ order: z.string() }),
          execute: async ({ order }) => ({ order, status: 'shipped' }),
        }),
      },
      experimental_telemetry: {
        isEnabled: true,
        integrations: [new OpenTelemetry({ tracer: p.getTracer('ai') })],
      },
    });
    await p.forceFlush();
    await p.shutdown();

    const page = await api<TracePage>('/traces?q=order%20a-1&limit=1');
    const detail = await api<TraceDetail>(`/traces/${page.items[0]?.id}`);
    expect(detail.trace).toMatchObject({
      llmCallCount: 2,
      usage: { inputTokens: 80, outputTokens: 18 },
      output: { text: 'Order A-1 has shipped.' },
    });
    const kinds = detail.spans.map((s) => s.kind).sort();
    expect(kinds).toEqual(['llm', 'llm', 'step', 'step', 'tool', 'workflow']);
    expect(detail.spans.find((s) => s.kind === 'tool')).toMatchObject({
      input: { order: 'A-1' },
      output: { order: 'A-1', status: 'shipped' },
    });
  });
});

describe('OTLP requests', () => {
  const post = (body: string | Uint8Array, headers: Record<string, string>, url = server.url) =>
    fetch(`${url}/v1/traces`, { method: 'POST', body, headers });

  const span = (traceId: string, spanId: string, extra: Record<string, unknown> = {}) => ({
    traceId,
    spanId,
    name: 'work',
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000000250000000',
    ...extra,
  });
  const request = (spans: unknown[], resource: Record<string, string> = {}) => ({
    resourceSpans: [
      {
        resource: {
          attributes: Object.entries(resource).map(([key, v]) => ({
            key,
            value: { stringValue: v },
          })),
        },
        scopeSpans: [{ scope: { name: 'test' }, spans }],
      },
    ],
  });

  it('accepts gzip-compressed JSON and reports rejected spans as a partial success', async () => {
    const body = JSON.stringify(
      request([span('a'.repeat(32), 'b'.repeat(16)), span('0'.repeat(32), '1'.repeat(16))]),
    );
    const res = await post(new Uint8Array(gzipSync(body)), {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      partialSuccess: {
        rejectedSpans: '1',
        errorMessage: expect.stringContaining('1 span(s) rejected'),
      },
    });
    const detail = await api<TraceDetail>(`/traces/${'a'.repeat(32)}`);
    expect(detail.trace).toMatchObject({ name: 'work', durationMs: 250, spanCount: 1 });
  });

  it('explains what it cannot read', async () => {
    const text = await post('{}', { 'content-type': 'text/plain' });
    expect(text.status).toBe(415);
    expect(((await text.json()) as { error: { hint: string } }).error.hint).toContain(
      'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
    );
    const garbage = await post(new Uint8Array([0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f]), {
      'content-type': 'application/x-protobuf',
    });
    expect(garbage.status).toBe(400);
    expect(((await garbage.json()) as { error: { message: string } }).error.message).toMatch(
      /^The OTLP protobuf request could not be decoded: /,
    );
    const brotli = await post('{}', {
      'content-type': 'application/json',
      'content-encoding': 'br',
    });
    expect(brotli.status).toBe(415);
  });

  it('refuses a compressed body that expands beyond the limit', async () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    const res = await post(new Uint8Array(bomb), {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    });
    expect(res.status).toBe(413);
  });

  it('keeps a trace within the span limit across requests', async () => {
    const limited = await startServer({
      store,
      auth: { mode: 'none', defaultProject: project },
      host: '127.0.0.1',
      port: 0,
      maxSpansPerTrace: 3,
    });
    try {
      const id = 'c'.repeat(32);
      for (const ids of [
        ['1', '2'],
        ['3', '4'],
      ]) {
        const res = await post(
          JSON.stringify(request(ids.map((i) => span(id, i.repeat(16))))),
          { 'content-type': 'application/json' },
          limited.url,
        );
        expect(res.status).toBe(200);
      }
      expect((await api<TraceDetail>(`/traces/${id}`)).trace.spanCount).toBe(3);
    } finally {
      await limited.close();
    }
  });

  it('routes traces to the project their resource names, and checks API keys', async () => {
    const res = await post(
      JSON.stringify(
        request([span('d'.repeat(32), '1'.repeat(16))], { 'scope.project': 'billing' }),
      ),
      {
        'content-type': 'application/json',
      },
    );
    expect(res.status).toBe(200);
    const billing = await store.ensureProject('billing');
    expect((await store.getTrace(billing.id, 'd'.repeat(32)))?.trace.name).toBe('work');

    const { secret } = await store.createApiKey(project.id, 'otel', ['ingest']);
    const keyed = await startServer({
      store,
      auth: { mode: 'api-key' },
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const body = JSON.stringify(request([span('e'.repeat(32), '1'.repeat(16))]));
      const anonymous = await post(body, { 'content-type': 'application/json' }, keyed.url);
      expect(anonymous.status).toBe(401);
      const authorized = await post(
        body,
        { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        keyed.url,
      );
      expect(authorized.status).toBe(200);
      expect((await store.getTrace(project.id, 'e'.repeat(32)))?.trace.spanCount).toBe(1);
      const elsewhere = await post(
        JSON.stringify(
          request([span('f'.repeat(32), '1'.repeat(16))], { 'scope.project': 'billing' }),
        ),
        { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        keyed.url,
      );
      expect(elsewhere.status).toBe(403);
    } finally {
      await keyed.close();
    }
  });
});
