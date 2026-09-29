/**
 * Client instrumentation against the real OpenAI and Anthropic SDKs, talking to local HTTP
 * servers that answer in each API's wire format (JSON and server-sent events). The checks are
 * twofold: what SCOPE records, and that the application sees exactly what it would without it.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryExporter } from './exporters.ts';
import { instrumentAnthropic, instrumentOpenAI } from './instrument.ts';
import { Tracer } from './tracer.ts';

type Reply = { status?: number; json?: unknown; sse?: Array<{ event?: string; data: unknown }> };
const replies: Reply[] = [];
const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
    });
    req.on('end', () => {
      requests.push({ path: req.url ?? '', body: data ? JSON.parse(data) : {} });
      const reply = replies.shift() ?? {
        status: 500,
        json: { error: { message: 'no reply queued' } },
      };
      if (reply.sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const e of reply.sse)
          res.write(
            `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`,
          );
        res.end();
        return;
      }
      res.writeHead(reply.status ?? 200, {
        'content-type': 'application/json',
        'x-request-id': 'req_test',
      });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

function setup() {
  const exporter = new MemoryExporter();
  const tracer = new Tracer({ exporter });
  const settled = async (count: number) => {
    for (let i = 0; i < 200 && exporter.bundles.length < count; i++)
      await new Promise((r) => setTimeout(r, 5));
    return exporter.bundles;
  };
  return { exporter, tracer, settled };
}

const openaiClient = () => new OpenAI({ apiKey: 'sk-test', baseURL: `${url}/v1`, maxRetries: 0 });
const anthropicClient = () => new Anthropic({ apiKey: 'test', baseURL: url, maxRetries: 0 });

const completion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-5-2025-08-07',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Refunds take 5 to 7 days.' },
      finish_reason: 'stop',
    },
  ],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 12,
    total_tokens: 132,
    prompt_tokens_details: { cached_tokens: 20 },
  },
};

describe('instrumentOpenAI', () => {
  it('records a call as a trace of its own, and returns the SDK’s promise unchanged', async () => {
    const { tracer, settled } = setup();
    const openai = instrumentOpenAI(openaiClient(), { tracer });
    replies.push({ json: completion });
    const { data, response } = await openai.chat.completions
      .create({
        model: 'gpt-5',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: [{ type: 'text', text: 'How long do refunds take?' }] },
        ],
      })
      .withResponse();
    expect(data.choices[0]?.message.content).toBe('Refunds take 5 to 7 days.');
    expect(response.status).toBe(200);

    const [bundle] = await settled(1);
    const span = bundle?.spans[0];
    expect(bundle?.spans).toHaveLength(1);
    expect(span).toMatchObject({
      name: 'chat gpt-5',
      kind: 'llm',
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 100,
      outputTokens: 12,
      input: {
        model: 'gpt-5',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'How long do refunds take?' },
        ],
      },
      output: { text: 'Refunds take 5 to 7 days.' },
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.response.model': 'gpt-5-2025-08-07',
        'gen_ai.usage.cache_read_input_tokens': 20,
        'gen_ai.response.finish_reasons': ['stop'],
      },
    });
    expect(span?.costUsd).toBeGreaterThan(0);
  });

  it('nests calls in the current trace', async () => {
    const { tracer, settled } = setup();
    const openai = instrumentOpenAI(openaiClient(), { tracer });
    replies.push({ json: completion });
    await tracer.trace('answer', {}, () =>
      openai.chat.completions.create({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    );
    const [bundle] = await settled(1);
    const [root, call] = bundle?.spans ?? [];
    expect(call).toMatchObject({ kind: 'llm', parentId: root?.id });
    expect(bundle?.trace.llmCallCount).toBe(1);
  });

  it('records streams as they are consumed, passing every chunk through', async () => {
    const { tracer, settled } = setup();
    const openai = instrumentOpenAI(openaiClient(), { tracer });
    const chunk = (delta: object, finish: string | null = null) => ({
      id: 'chatcmpl-2',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-5-2025-08-07',
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    replies.push({
      sse: [
        { data: chunk({ role: 'assistant', content: 'Refunds ' }) },
        { data: chunk({ content: 'take 5 days.' }) },
        { data: chunk({}, 'stop') },
        {
          data: {
            ...chunk({}),
            choices: [],
            usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 },
          },
        },
        { data: '[DONE]' },
      ],
    });
    const stream = await openai.chat.completions.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const received: string[] = [];
    for await (const c of stream) received.push(c.choices[0]?.delta?.content ?? '');
    expect(received.join('')).toBe('Refunds take 5 days.');
    expect(typeof stream.toReadableStream).toBe('function');

    const [bundle] = await settled(1);
    expect(bundle?.spans[0]).toMatchObject({
      output: { text: 'Refunds take 5 days.' },
      inputTokens: 30,
      outputTokens: 4,
      attributes: { 'gen_ai.response.finish_reasons': ['stop'] },
    });
    expect(requests.at(-1)?.body).not.toHaveProperty('scope');
  });

  it('records the stream helper through create()', async () => {
    const { tracer, settled } = setup();
    const openai = instrumentOpenAI(openaiClient(), { tracer });
    replies.push({
      sse: [
        {
          data: {
            id: 'c',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'gpt-5',
            choices: [
              { index: 0, delta: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' },
            ],
          },
        },
        { data: '[DONE]' },
      ],
    });
    const helper = openai.chat.completions.stream({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect((await helper.finalChatCompletion()).choices[0]?.message.content).toBe('Hello.');
    const bundles = await settled(1);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.spans[0]?.output).toEqual({ text: 'Hello.' });
  });

  it('records the Responses API and embeddings', async () => {
    const { tracer, settled } = setup();
    const openai = instrumentOpenAI(openaiClient(), { tracer });
    replies.push({
      json: {
        id: 'resp_1',
        object: 'response',
        created_at: 1,
        model: 'gpt-5',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'm',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Five days.', annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 50,
          output_tokens: 3,
          total_tokens: 53,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    const response = await openai.responses.create({
      model: 'gpt-5',
      instructions: 'Be brief.',
      input: 'Refund time?',
    });
    expect(response.output_text).toBe('Five days.');
    replies.push({
      json: {
        object: 'list',
        model: 'text-embedding-3-small',
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      },
    });
    await openai.embeddings.create({ model: 'text-embedding-3-small', input: 'refunds' });

    const [chat, embed] = await settled(2);
    expect(chat?.spans[0]).toMatchObject({
      input: {
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Refund time?' },
        ],
      },
      output: { text: 'Five days.' },
      inputTokens: 50,
      outputTokens: 3,
    });
    expect(embed?.spans[0]).toMatchObject({
      name: 'embeddings text-embedding-3-small',
      output: { embeddings: 1, dimensions: 3 },
      inputTokens: 4,
    });
  });

  it('records failures and rethrows the SDK’s own error', async () => {
    const { tracer, settled } = setup();
    const openai = instrumentOpenAI(openaiClient(), { tracer });
    replies.push({
      status: 401,
      json: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } },
    });
    const error = await openai.chat.completions
      .create({ model: 'gpt-5', messages: [{ role: 'user', content: 'Hi' }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAI.AuthenticationError);
    const [bundle] = await settled(1);
    expect(bundle?.spans[0]).toMatchObject({
      status: 'error',
      error: { message: expect.stringContaining('Incorrect API key') },
    });
  });

  it('names OpenAI-compatible providers, and instruments a client once', async () => {
    const { tracer, settled } = setup();
    const ollama = instrumentOpenAI(
      instrumentOpenAI(openaiClient(), { tracer, provider: 'ollama' }),
      { tracer },
    );
    replies.push({ json: { ...completion, model: 'llama3.1' } });
    await ollama.chat.completions.create({
      model: 'llama3.1',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const bundles = await settled(1);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.spans[0]).toMatchObject({
      provider: 'ollama',
      model: 'llama3.1',
      costUsd: null,
      attributes: { 'scope.provider.type': 'openai-compatible' },
    });
  });
});

describe('instrumentAnthropic', () => {
  const message = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'Five to seven days.' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 80,
      output_tokens: 6,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 0,
    },
  };

  it('records messages.create', async () => {
    const { tracer, settled } = setup();
    const anthropic = instrumentAnthropic(anthropicClient(), { tracer });
    replies.push({ json: message });
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 200,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Refund time?' }],
    });
    expect(result.content[0]).toMatchObject({ text: 'Five to seven days.' });
    const [bundle] = await settled(1);
    expect(bundle?.spans[0]).toMatchObject({
      name: 'chat claude-sonnet-5',
      provider: 'anthropic',
      inputTokens: 80,
      outputTokens: 6,
      input: {
        max_tokens: 200,
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Refund time?' },
        ],
      },
      output: { text: 'Five to seven days.' },
      attributes: { 'gen_ai.usage.cache_read_input_tokens': 10, 'gen_ai.request.max_tokens': 200 },
    });
    expect(bundle?.spans[0]?.costUsd).toBeGreaterThan(0);
  });

  const events = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          ...message,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 80, output_tokens: 1 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Five to ' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'seven days.' },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 6 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];

  it('records streamed messages, and messages.stream() through create()', async () => {
    const { tracer, settled } = setup();
    const anthropic = instrumentAnthropic(anthropicClient(), { tracer });
    replies.push({ sse: events });
    const stream = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 200,
      messages: [{ role: 'user', content: 'Refund time?' }],
      stream: true,
    });
    let text = '';
    for await (const e of stream)
      if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') text += e.delta.text;
    expect(text).toBe('Five to seven days.');

    replies.push({ sse: events });
    const helper = anthropic.messages.stream({
      model: 'claude-sonnet-5',
      max_tokens: 200,
      messages: [{ role: 'user', content: 'Refund time?' }],
    });
    expect(await helper.finalText()).toBe('Five to seven days.');

    const bundles = await settled(2);
    expect(bundles).toHaveLength(2);
    for (const b of bundles)
      expect(b.spans[0]).toMatchObject({
        output: { text: 'Five to seven days.' },
        inputTokens: 80,
        outputTokens: 6,
        attributes: { 'gen_ai.response.finish_reasons': ['end_turn'] },
      });
  });
});
