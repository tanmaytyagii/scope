/**
 * Instrumentation under the conditions real applications meet: streams read after their trace
 * returns, cancelled or never read; failures midway; timeouts, retries and network errors;
 * concurrent calls; huge and malformed responses. The real OpenAI and Anthropic SDKs talk to a
 * local server scripted per test. In every case the application must see exactly what it would
 * without SCOPE, and nothing SCOPE records may throw, hang or grow without bound.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import type { SpanRecord, TraceBundle } from '@scope-ai/core';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryExporter } from './exporters.ts';
import { instrumentAnthropic, instrumentOpenAI } from './instrument.ts';
import { Tracer } from './tracer.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;
let handler: Handler = (_req, res) => res.writeHead(500).end();
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
    });
    req.on('end', () => handler(req, res, data ? JSON.parse(data) : {}));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

function setup(options: { openSpanGraceMs?: number; maxPayloadBytes?: number } = {}) {
  const exporter = new MemoryExporter();
  const tracer = new Tracer({
    exporter,
    ...(options.openSpanGraceMs !== undefined ? { openSpanGraceMs: options.openSpanGraceMs } : {}),
    ...(options.maxPayloadBytes ? { privacy: { maxPayloadBytes: options.maxPayloadBytes } } : {}),
  });
  const settled = async (count: number, ms = 2000): Promise<TraceBundle[]> => {
    for (let waited = 0; waited < ms && exporter.bundles.length < count; waited += 5)
      await new Promise((r) => setTimeout(r, 5));
    return exporter.bundles;
  };
  return { exporter, tracer, settled };
}

const openai = (tracer: Tracer, options: ConstructorParameters<typeof OpenAI>[0] = {}) =>
  instrumentOpenAI(
    new OpenAI({ apiKey: 'sk-test', baseURL: `${url}/v1`, maxRetries: 0, ...options }),
    {
      tracer,
    },
  );

const llmSpan = (bundle: TraceBundle | undefined): SpanRecord | undefined =>
  bundle?.spans.find((s) => s.kind === 'llm');

const completion = (content: string) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-5-mini',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** Writes an OpenAI chat stream: one chunk per word, then usage, then [DONE]. */
function sendChatStream(res: ServerResponse, words: string[], options: { end?: boolean } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [i, word] of words.entries())
    res.write(
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-5-mini', choices: [{ index: 0, delta: { content: i ? ` ${word}` : word }, finish_reason: null }] })}\n\n`,
    );
  if (options.end === false) return;
  res.write(
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-5-mini', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: words.length, total_tokens: 12 + words.length } })}\n\n`,
  );
  res.end('data: [DONE]\n\n');
}

const chat = {
  model: 'gpt-5-mini',
  messages: [{ role: 'user' as const, content: 'Refund time?' }],
};

describe('streams', () => {
  it('records a stream returned from a traced function and read after it returns', async () => {
    // The common web pattern: a handler returns the model's stream to the framework, which
    // reads it once the handler has returned.
    handler = (_req, res) => sendChatStream(res, ['Five', 'to', 'seven', 'days.']);
    const { tracer, exporter, settled } = setup();
    const client = openai(tracer);
    const stream = await tracer.trace('handle-request', {}, () =>
      client.chat.completions.create({
        ...chat,
        stream: true,
        stream_options: { include_usage: true },
      }),
    );
    expect(exporter.bundles).toHaveLength(0); // the trace waits for its open model span
    let text = '';
    for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? '';
    expect(text).toBe('Five to seven days.');
    const [bundle] = await settled(1);
    expect(bundle?.trace.name).toBe('handle-request');
    expect(llmSpan(bundle)).toMatchObject({
      status: 'ok',
      output: { text: 'Five to seven days.' },
      inputTokens: 12,
      outputTokens: 4,
    });
    expect(bundle?.trace.usage.totalTokens).toBe(16);
  });

  it('marks a stream the application stops reading as cancelled', async () => {
    handler = (_req, res) => sendChatStream(res, ['one', 'two', 'three', 'four']);
    const { tracer, settled } = setup();
    const stream = await openai(tracer).chat.completions.create({ ...chat, stream: true });
    let chunks = 0;
    for await (const _ of stream) if (++chunks === 2) break;
    const span = llmSpan((await settled(1))[0]);
    expect(span).toMatchObject({
      status: 'ok',
      output: { text: 'one two' },
      attributes: expect.objectContaining({ 'scope.stream.incomplete': 'cancelled' }),
    });
  });

  it('closes the span of a stream nobody reads, after the grace period', async () => {
    handler = (_req, res) => sendChatStream(res, ['never', 'read']);
    const { tracer, settled } = setup({ openSpanGraceMs: 100 });
    await tracer.trace('handler', {}, () =>
      openai(tracer).chat.completions.create({ ...chat, stream: true }),
    );
    const [bundle] = await settled(1);
    expect(bundle?.trace.name).toBe('handler');
    expect(llmSpan(bundle)).toMatchObject({
      status: 'error',
      statusMessage: 'the stream was not read to the end within 0 s',
      attributes: expect.objectContaining({ 'scope.stream.incomplete': 'abandoned' }),
    });
  });

  it('records a stream that fails midway, and the application gets the SDK’s error', async () => {
    handler = (req, res) => {
      sendChatStream(res, ['partial', 'answer'], { end: false });
      setTimeout(() => req.socket.destroy(), 20);
    };
    const { tracer, settled } = setup();
    const stream = await openai(tracer).chat.completions.create({ ...chat, stream: true });
    const error = await (async () => {
      for await (const _ of stream) {
        // reading until the connection drops
      }
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const span = llmSpan((await settled(1))[0]);
    expect(span?.status).toBe('error');
    expect(span?.error?.message).toBeTruthy();
  });

  it('ignores malformed stream events and keeps the valid text', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const data of [
        { choices: null },
        { choices: [{ delta: { content: 123 } }] },
        { choices: [{ delta: { content: 'Valid', tool_calls: 'nope' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1e12, function: { name: 7 } }] } }] },
        { choices: [{ delta: { content: ' text.' } }], usage: { prompt_tokens: -4 } },
      ])
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    const { tracer, settled } = setup();
    const stream = await openai(tracer).chat.completions.create({ ...chat, stream: true });
    for await (const _ of stream) {
      // the application reads every event, malformed or not
    }
    const span = llmSpan((await settled(1))[0]);
    expect(span?.status).toBe('ok');
    expect(span?.output).toEqual({ text: 'Valid text.' });
    expect(span?.inputTokens ?? null).toBeNull();
  });

  it('bounds the Anthropic stream accumulator whatever indexes the events carry', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events: Array<[string, unknown]> = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: 'm',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-5',
              content: [],
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          },
        ],
        [
          'content_block_start',
          { type: 'content_block_start', index: -1, content_block: { type: 'text', text: '' } },
        ],
        [
          'content_block_delta',
          {
            type: 'content_block_delta',
            index: 2 ** 53,
            delta: { type: 'text_delta', text: 'Hi' },
          },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0.5, delta: { type: 'text_delta', text: '!' } },
        ],
        ['message_stop', { type: 'message_stop' }],
      ];
      for (const [event, data] of events)
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    };
    const { tracer, settled } = setup();
    const client = instrumentAnthropic(
      new Anthropic({ apiKey: 'k', baseURL: url, maxRetries: 0 }),
      {
        tracer,
      },
    );
    const started = performance.now();
    const stream = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    for await (const _ of stream) {
      // read to the end
    }
    const span = llmSpan((await settled(1))[0]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(span?.status).toBe('ok');
  });
});

describe('failures', () => {
  it('records timeouts and rethrows the SDK’s own error', async () => {
    handler = (_req, res) => {
      setTimeout(() => sendJson(res, 200, completion('late')), 500);
    };
    const { tracer, settled } = setup();
    const error = await openai(tracer, { timeout: 50 })
      .chat.completions.create(chat)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
    const span = llmSpan((await settled(1))[0]);
    expect(span).toMatchObject({
      status: 'error',
      error: expect.objectContaining({ type: 'APIConnectionTimeoutError' }),
    });
  });

  it('records a call the SDK retried as one span with the final outcome', async () => {
    let requests = 0;
    handler = (_req, res) =>
      ++requests === 1
        ? sendJson(res, 503, { error: { message: 'busy' } })
        : sendJson(res, 200, completion('ok'));
    const { tracer, settled } = setup();
    const result = await openai(tracer, { maxRetries: 1 }).chat.completions.create(chat);
    expect(result.choices[0]?.message.content).toBe('ok');
    expect(requests).toBe(2);
    const bundles = await settled(1);
    expect(bundles).toHaveLength(1);
    expect(llmSpan(bundles[0])).toMatchObject({ status: 'ok', output: { text: 'ok' } });
  });

  it('records network failures and rethrows them', async () => {
    const { tracer, settled } = setup();
    const client = instrumentOpenAI(
      new OpenAI({ apiKey: 'sk-test', baseURL: 'http://127.0.0.1:9/v1', maxRetries: 0 }),
      { tracer },
    );
    const error = await client.chat.completions.create(chat).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAI.APIConnectionError);
    expect(llmSpan((await settled(1))[0])?.status).toBe('error');
  });

  it('survives malformed non-streaming responses and returns them unchanged', async () => {
    const nonsense = {
      choices: 'nonsense',
      usage: { prompt_tokens: '7', completion_tokens: null },
      model: 42,
    };
    handler = (_req, res) => sendJson(res, 200, nonsense);
    const { tracer, settled } = setup();
    const result = await openai(tracer).chat.completions.create(chat);
    expect(result).toMatchObject(nonsense);
    const span = llmSpan((await settled(1))[0]);
    expect(span).toMatchObject({ status: 'ok', inputTokens: null, outputTokens: null });
  });
});

describe('load', () => {
  it('keeps concurrent calls in one trace apart', async () => {
    handler = (_req, res, body) => {
      const messages = body.messages as Array<{ content: string }>;
      const question = messages.at(-1)?.content ?? '';
      // Answers arrive out of order.
      setTimeout(() => sendJson(res, 200, completion(`answer to ${question}`)), Math.random() * 30);
    };
    const { tracer, settled } = setup();
    const client = openai(tracer);
    const answers = await tracer.trace('fan-out', {}, () =>
      Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          client.chat.completions.create({
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: `q${i}` }],
          }),
        ),
      ),
    );
    expect(answers.map((a) => a.choices[0]?.message.content)).toEqual(
      Array.from({ length: 20 }, (_, i) => `answer to q${i}`),
    );
    const [bundle] = await settled(1);
    const spans = bundle?.spans.filter((s) => s.kind === 'llm') ?? [];
    expect(spans).toHaveLength(20);
    for (const span of spans) {
      const question = (span.input as { messages: Array<{ content: string }> }).messages[0]
        ?.content;
      expect(span.output).toEqual({ text: `answer to ${question}` });
    }
  });

  it('bounds a huge response in the span, never in what the application receives', async () => {
    const huge = 'x'.repeat(2_000_000);
    handler = (_req, res) => sendJson(res, 200, completion(huge));
    const { tracer, settled } = setup({ maxPayloadBytes: 4096 });
    const result = await openai(tracer).chat.completions.create(chat);
    expect(result.choices[0]?.message.content).toHaveLength(2_000_000);
    const span = llmSpan((await settled(1))[0]);
    const recorded = JSON.stringify(span?.output);
    expect(recorded.length).toBeLessThan(5000);
    expect(recorded).toContain('truncated');
  });
});
