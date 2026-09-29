/**
 * OpenLLMetry (Traceloop) instrumentations, the real packages, sending OTLP to a running SCOPE
 * server: the OpenAI SDK, and LangChain (a prompt → chat model → parser chain). What SCOPE shows
 * is read back through the API the dashboard uses. The model is a local server that answers in
 * OpenAI's wire format. (One instrumentation project per test file: they patch the same SDK.)
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as CallbackManagerModule from '@langchain/core/callbacks/manager';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Span, TraceDetail, TracePage } from '@scope-ai/protocol';
import { type Project, Store } from '@scope-ai/storage';
import { LangChainInstrumentation } from '@traceloop/instrumentation-langchain';
import { OpenAIInstrumentation } from '@traceloop/instrumentation-openai';
import OpenAI from 'openai';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type RunningServer, startServer } from './server.ts';

let store: Store;
let project: Project;
let scope: RunningServer;
let model: Server;
let modelUrl: string;
let provider: BasicTracerProvider;

beforeAll(async () => {
  store = await Store.open(`sqlite:${join(mkdtempSync(join(tmpdir(), 'scope-tl-')), 'db')}`);
  project = await store.ensureProject('demo');
  scope = await startServer({
    store,
    auth: { mode: 'none', defaultProject: project },
    host: '127.0.0.1',
    port: 0,
  });
  model = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const request = JSON.parse(body) as { model: string };
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: `${request.model}-2026-08-07`,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Five to seven days.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 42, completion_tokens: 6, total_tokens: 48 },
        }),
      );
    });
  });
  await new Promise<void>((done) => model.listen(0, '127.0.0.1', done));
  modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;

  // As a Node application sets up OpenTelemetry (NodeTracerProvider and NodeSDK register it):
  // without a context manager, spans started in callbacks have no parent.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  provider = new BasicTracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${scope.url}/v1/traces` })),
    ],
  });
  const openai = new OpenAIInstrumentation({ traceContent: true });
  openai.setTracerProvider(provider);
  openai.manuallyInstrument(OpenAI);
  const langchain = new LangChainInstrumentation({ traceContent: true });
  langchain.setTracerProvider(provider);
  langchain.manuallyInstrument({ callbackManagerModule: CallbackManagerModule });
});

afterAll(async () => {
  await provider?.shutdown();
  model?.close();
  await scope?.close();
  await store?.close();
});

async function traces(): Promise<TraceDetail[]> {
  await provider.forceFlush();
  const page = (await (await fetch(`${scope.url}/api/v1/traces?limit=20`)).json()) as TracePage;
  return Promise.all(
    page.items.map(
      async (t) =>
        (await (await fetch(`${scope.url}/api/v1/traces/${t.id}`)).json()) as TraceDetail,
    ),
  );
}

const llm = (t: TraceDetail | undefined): Span | undefined =>
  t?.spans.find((s) => s.kind === 'llm');

it('records an OpenAI SDK call as a model span with messages, response and tokens', async () => {
  const client = new OpenAI({ apiKey: 'sk-test', baseURL: modelUrl });
  const reply = await client.chat.completions.create({
    model: 'gpt-5-mini',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'How long do refunds take?' },
    ],
  });
  expect(reply.choices[0]?.message.content).toBe('Five to seven days.');
  const trace = (await traces()).find((t) => t.spans.length === 1);
  expect(llm(trace)).toMatchObject({
    provider: 'openai',
    // The model asked for; the dated model the provider answered with is kept beside it.
    model: 'gpt-5-mini',
    attributes: expect.objectContaining({ 'gen_ai.response.model': 'gpt-5-mini-2026-08-07' }),
    inputTokens: 42,
    outputTokens: 6,
    output: { text: 'Five to seven days.' },
    input: {
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'How long do refunds take?' },
      ],
    },
  });
  // Priced from SCOPE's table: gpt-5-mini is a known model.
  expect(llm(trace)?.costUsd).toBeGreaterThan(0);
});

it('records a LangChain chain inside an active span, with its model call and step contents', async () => {
  const chain = ChatPromptTemplate.fromMessages([
    ['system', 'Answer in one sentence.'],
    ['user', '{question}'],
  ])
    .pipe(
      new ChatOpenAI({
        model: 'gpt-5-mini',
        apiKey: 'sk-test',
        configuration: { baseURL: modelUrl },
      }),
    )
    .pipe(new StringOutputParser());
  // OpenLLMetry parents LangChain's spans on the active span (its withWorkflow, or the
  // application's own); without one, every runnable becomes a trace of its own.
  const answer = await provider
    .getTracer('support-bot')
    .startActiveSpan('answer-question', async (span) => {
      try {
        return await chain.invoke({ question: 'Refund time?' });
      } finally {
        span.end();
      }
    });
  expect(answer).toBe('Five to seven days.');

  const trace = (await traces()).find((t) => t.trace.name === 'answer-question');
  expect(trace?.spans.length).toBeGreaterThan(3);
  expect(trace?.spans.find((s) => s.parentId === null)?.kind).toBe('workflow');
  const call = llm(trace);
  expect(call).toMatchObject({ model: 'gpt-5-mini', inputTokens: 42, outputTokens: 6 });
  // The chain's own span carries its input and output (traceloop.entity.*).
  const sequence = trace?.spans.find((s) => s.name.includes('RunnableSequence'));
  expect(sequence).toMatchObject({
    kind: 'step',
    input: { question: 'Refund time?' },
    output: 'Five to seven days.',
  });
});
