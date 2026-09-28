import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isScopeError, ScopeError } from '@scope-ai/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnthropicProvider } from './anthropic.ts';
import { createLocalProvider, extractiveAnswer, findQuestion, NO_ANSWER } from './local.ts';
import { createOpenAIProvider } from './openai.ts';
import { isModelListed, ProviderRegistry, parseModelRef } from './registry.ts';

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

let server: Server;
let baseUrl: string;
const requests: Recorded[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: data ? JSON.parse(data) : {},
      });
      res.writeHead(nextResponse.status, {
        'content-type': 'application/json',
        'request-id': 'req_123',
        'x-request-id': 'req_123',
      });
      res.end(JSON.stringify(nextResponse.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe('local provider', () => {
  const context = [
    'Refunds are issued to the original payment method.',
    'Refunds take 5 to 7 business days to appear on a card statement.',
    'Standard shipping takes 3 days.',
    'Gift cards cannot be refunded.',
  ].join(' ');

  it('finds the question on the last content line', () => {
    expect(
      findQuestion([
        {
          role: 'user',
          content: `Context:\n${context}\n\nQuestion: How long do refunds take?\nAnswer:`,
        },
      ]),
    ).toBe('How long do refunds take?');
  });

  it('extracts the best-matching sentences in document order', () => {
    const answer = extractiveAnswer(
      [
        { role: 'system', content: 'You are a support agent. Answer from the context.' },
        {
          role: 'user',
          content: `Context:\n${context}\n\nQuestion: How many days do refunds take?`,
        },
      ],
      2,
    );
    expect(answer).toBe('Refunds take 5 to 7 business days to appear on a card statement.');
  });

  it('says so when nothing matches', () => {
    expect(
      extractiveAnswer(
        [{ role: 'user', content: `${context}\nWhat is the warranty on laptops?` }],
        2,
      ),
    ).toBe(NO_ANSWER);
  });

  it('is deterministic and reports estimated usage', async () => {
    const local = createLocalProvider();
    const request = {
      model: 'extractive',
      messages: [{ role: 'user' as const, content: `${context}\nAre gift cards refundable?` }],
      temperature: 0,
    };
    const a = await local.complete(request);
    const b = await local.complete(request);
    expect(a).toEqual(b);
    expect(a.text).toBe('Gift cards cannot be refunded.');
    expect(a.usage.estimated).toBe(true);
    expect(a.ignoredParams).toEqual(['temperature']);
  });

  it('supports json output, echo, and rejects unknown models', async () => {
    const local = createLocalProvider();
    const json = await local.complete({
      model: 'echo',
      messages: [{ role: 'user', content: 'hello' }],
      responseFormat: 'json',
    });
    expect(JSON.parse(json.text)).toEqual({ answer: 'hello' });
    await expect(local.complete({ model: 'gpt', messages: [] })).rejects.toThrow(/no model "gpt"/);
  });

  it('honours abort signals during simulated delays', async () => {
    const local = createLocalProvider();
    const controller = new AbortController();
    const pending = local.complete(
      { model: 'echo', messages: [], providerOptions: { delay_ms: 5000 } },
      { signal: controller.signal },
    );
    controller.abort(new Error('timed out'));
    await expect(pending).rejects.toThrow('timed out');
  });
});

describe('openai provider', () => {
  it('sends a chat completion and normalizes the response', async () => {
    nextResponse = {
      status: 200,
      body: {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-5-2026-01-01',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Five days.', refusal: null },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 4,
          total_tokens: 124,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      },
    };
    const provider = createOpenAIProvider({
      name: 'openai',
      type: 'openai',
      apiKey: 'sk-test',
      baseUrl: `${baseUrl}/v1`,
      maxRetries: 0,
    });
    const res = await provider.complete({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Refund time?' },
      ],
      temperature: 0,
      maxTokens: 200,
      responseFormat: 'json',
      providerOptions: { seed: 7 },
    });
    const sent = requests.at(-1) as Recorded;
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.headers.authorization).toBe('Bearer sk-test');
    expect(sent.body).toEqual({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Refund time?' },
      ],
      max_completion_tokens: 200,
      response_format: { type: 'json_object' },
      seed: 7,
    });
    expect(res).toMatchObject({
      text: 'Five days.',
      model: 'gpt-5-2026-01-01',
      finishReason: 'stop',
      ignoredParams: ['temperature'],
      usage: { inputTokens: 20, cacheReadTokens: 100, outputTokens: 4, totalTokens: 124 },
    });
  });

  it('uses max_tokens and keeps temperature for compatible endpoints', async () => {
    nextResponse = {
      status: 200,
      body: {
        id: 'x',
        object: 'chat.completion',
        created: 0,
        model: 'llama3.1:8b',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'length' },
        ],
      },
    };
    const provider = createOpenAIProvider({
      name: 'ollama',
      type: 'openai-compatible',
      baseUrl: `${baseUrl}/v1`,
      maxRetries: 0,
    });
    const res = await provider.complete({
      model: 'llama3.1:8b',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      maxTokens: 10,
    });
    expect((requests.at(-1) as Recorded).body).toMatchObject({ temperature: 0.2, max_tokens: 10 });
    expect(res.finishReason).toBe('length');
    expect(res.usage.totalTokens).toBe(0);
  });

  it('maps authentication and rate-limit errors', async () => {
    const provider = createOpenAIProvider({
      name: 'openai',
      type: 'openai',
      apiKey: 'sk-bad',
      baseUrl: `${baseUrl}/v1`,
      maxRetries: 0,
    });
    nextResponse = {
      status: 401,
      body: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } },
    };
    const auth = await provider
      .complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e);
    expect(isScopeError(auth, 'provider_auth')).toBe(true);
    expect((auth as ScopeError).message).toBe(
      'openai rejected the credentials (401): Incorrect API key provided',
    );
    expect((auth as ScopeError).hint).toContain('OPENAI_API_KEY');

    nextResponse = { status: 429, body: { error: { message: 'Rate limit reached' } } };
    const limited = await provider
      .complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e);
    expect(isScopeError(limited, 'provider_rate_limited')).toBe(true);
    expect((limited as ScopeError).retryable).toBe(true);
  });

  it('reports unreachable servers', async () => {
    const provider = createOpenAIProvider({
      name: 'ollama',
      type: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      maxRetries: 0,
    });
    const error = await provider
      .complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e);
    expect(isScopeError(error, 'provider_unavailable')).toBe(true);
    expect((error as ScopeError).message).toMatch(
      /^Could not connect to ollama at http:\/\/127.0.0.1:9\/v1/,
    );
  });
});

describe('anthropic provider', () => {
  const message = (overrides: Record<string, unknown> = {}) => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text: 'Refunds take ' },
      { type: 'text', text: '5 days.' },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 50,
      output_tokens: 8,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0,
    },
    ...overrides,
  });

  it('sends system separately, omits unsupported sampling params and joins text blocks', async () => {
    nextResponse = { status: 200, body: message() };
    const provider = createAnthropicProvider({
      name: 'anthropic',
      apiKey: 'sk-ant-test',
      baseUrl,
      maxRetries: 0,
    });
    const res = await provider.complete({
      model: 'claude-opus-5',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Refund time?' },
      ],
      temperature: 0,
      responseFormat: 'json',
      jsonSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      providerOptions: { output_config: { effort: 'low' } },
    });
    const sent = requests.at(-1) as Recorded;
    expect(sent.url).toBe('/v1/messages');
    expect(sent.headers['x-api-key']).toBe('sk-ant-test');
    expect(sent.body).toEqual({
      model: 'claude-opus-5',
      max_tokens: 16000,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Refund time?' }],
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(res).toMatchObject({
      text: 'Refunds take 5 days.',
      finishReason: 'stop',
      ignoredParams: ['temperature'],
      usage: { inputTokens: 50, outputTokens: 8, cacheReadTokens: 1000, totalTokens: 1058 },
    });
  });

  it('keeps temperature for models that accept it and surfaces refusals', async () => {
    nextResponse = {
      status: 200,
      body: message({
        model: 'claude-haiku-4-5',
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      }),
    };
    const provider = createAnthropicProvider({
      name: 'anthropic',
      apiKey: 'k',
      baseUrl,
      maxRetries: 0,
    });
    const res = await provider.complete({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.3,
    });
    expect((requests.at(-1) as Recorded).body.temperature).toBe(0.3);
    expect(res.finishReason).toBe('refusal');
    expect(res.attributes).toEqual({ 'scope.refusal.category': 'cyber' });
  });

  it('maps unknown models to a clear error', async () => {
    nextResponse = {
      status: 404,
      body: { type: 'error', error: { type: 'not_found_error', message: 'model: claude-opus-9' } },
    };
    const provider = createAnthropicProvider({
      name: 'anthropic',
      apiKey: 'k',
      baseUrl,
      maxRetries: 0,
    });
    const error = await provider
      .complete({ model: 'claude-opus-9', messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e);
    expect(isScopeError(error, 'provider_model_not_found')).toBe(true);
    expect((error as ScopeError).message).toBe(
      'anthropic could not find model "claude-opus-9": model: claude-opus-9',
    );
  });

  it('requires the conversation to start with a user message', async () => {
    const provider = createAnthropicProvider({ name: 'anthropic', apiKey: 'k', baseUrl });
    await expect(
      provider.complete({
        model: 'claude-opus-5',
        messages: [{ role: 'assistant', content: 'hi' }],
      }),
    ).rejects.toThrow(/first non-system message/);
  });
});

describe('model lists (scope doctor --network)', () => {
  it('lists OpenAI models with the key', async () => {
    const provider = createOpenAIProvider({
      name: 'openai',
      type: 'openai',
      apiKey: 'sk-test',
      baseUrl: `${baseUrl}/v1`,
      maxRetries: 0,
    });
    nextResponse = {
      status: 200,
      body: {
        object: 'list',
        data: [
          { id: 'gpt-5', object: 'model', created: 1, owned_by: 'openai' },
          { id: 'gpt-5-mini-2026-08-07', object: 'model', created: 1, owned_by: 'openai' },
        ],
      },
    };
    requests.length = 0;
    expect(await provider.listModels?.()).toEqual(['gpt-5', 'gpt-5-mini-2026-08-07']);
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/v1/models' });
    expect(requests[0]?.headers.authorization).toBe('Bearer sk-test');
  });

  it('lists Anthropic models across pages', async () => {
    const provider = createAnthropicProvider({ name: 'anthropic', apiKey: 'k', baseUrl });
    nextResponse = {
      status: 200,
      body: {
        data: [{ id: 'claude-sonnet-5', type: 'model', display_name: 'x', created_at: '2026' }],
        has_more: false,
        first_id: 'claude-sonnet-5',
        last_id: 'claude-sonnet-5',
      },
    };
    requests.length = 0;
    expect(await provider.listModels?.()).toEqual(['claude-sonnet-5']);
    expect(requests[0]?.url).toMatch(/^\/v1\/models\?/);
    expect(requests[0]?.headers['x-api-key']).toBe('k');
  });

  it('explains rejected keys and endpoints without a model list', async () => {
    const provider = createOpenAIProvider({
      name: 'openai',
      type: 'openai',
      apiKey: 'sk-bad',
      baseUrl: `${baseUrl}/v1`,
      maxRetries: 0,
    });
    nextResponse = { status: 401, body: { error: { message: 'Incorrect API key provided' } } };
    const auth = await provider.listModels?.().catch((e) => e);
    expect((auth as ScopeError).message).toBe(
      'openai rejected the credentials (401): Incorrect API key provided',
    );
    nextResponse = { status: 404, body: { error: { message: 'Not found' } } };
    const missing = await provider.listModels?.().catch((e) => e);
    expect((missing as ScopeError).message).toBe(
      'openai could not list its models (404): Not found',
    );
    expect((missing as ScopeError).hint).toContain('may not implement GET /models');
  });

  it('matches aliases to dated snapshots and Ollama tags', () => {
    const listed = ['claude-haiku-4-5-20251001', 'gpt-4o-2024-08-06', 'llama3.1:latest', 'gpt-5'];
    expect(isModelListed('gpt-5', listed)).toBe(true);
    expect(isModelListed('claude-haiku-4-5', listed)).toBe(true);
    expect(isModelListed('gpt-4o', listed)).toBe(true);
    expect(isModelListed('llama3.1', listed)).toBe(true);
    expect(isModelListed('gpt-5-mini', listed)).toBe(false);
    expect(isModelListed('gpt-4', listed)).toBe(false);
    expect(isModelListed('claude-opus-5', listed)).toBe(false);
  });
});

describe('registry', () => {
  it('parses model references, keeping colons in model names', () => {
    expect(parseModelRef('ollama:llama3.1:8b')).toEqual({
      provider: 'ollama',
      model: 'llama3.1:8b',
    });
    expect(() => parseModelRef('gpt-5')).toThrow(/not a model reference/);
  });

  it('resolves built-ins and configured endpoints', () => {
    const registry = new ProviderRegistry({
      env: { OPENAI_API_KEY: 'sk-x' },
      providers: { ollama: { type: 'openai-compatible', base_url: 'http://localhost:11434/v1' } },
    });
    expect(registry.resolve('local:extractive').provider.type).toBe('local');
    expect(registry.resolve('ollama:llama3').provider.type).toBe('openai-compatible');
    expect(registry.get('openai').type).toBe('openai');
    expect(registry.describe('openai').credential).toEqual({
      status: 'env',
      variable: 'OPENAI_API_KEY',
    });
    expect(registry.describe('anthropic').credential).toMatchObject({
      status: 'missing',
      variable: 'ANTHROPIC_API_KEY',
    });
  });

  it('explains unknown providers and missing credentials', () => {
    const registry = new ProviderRegistry({
      env: {},
      providers: {
        ollama: { type: 'openai-compatible', base_url: 'http://x', missingEnv: ['OLLAMA_KEY'] },
      },
    });
    expect(() => registry.get('opneai')).toThrow(ScopeError);
    try {
      registry.get('opneai');
    } catch (error) {
      expect((error as ScopeError).hint).toBe('Did you mean "openai"?');
    }
    expect(() => registry.get('openai')).toThrow('OPENAI_API_KEY is not set');
    expect(() => registry.get('ollama')).toThrow(
      'Provider "ollama" needs OLLAMA_KEY, which is not set',
    );
  });
});
