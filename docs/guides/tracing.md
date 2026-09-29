# Tracing applications

Workflows run by `scope run` are traced automatically. To see what an existing application does
— in development or production — instrument it with `@scope-ai/sdk` and send its traces to a
SCOPE server. The dashboard shows them exactly like workflow traces.

## Install

From the first release on, `npm install @scope-ai/sdk`. The packages are not published to npm
yet, so for now build them from a SCOPE checkout and install the tarballs into your application:

```bash
# in the scope repository
npm ci && npm run build
npm pack -w @scope-ai/core -w @scope-ai/sdk --pack-destination /tmp/scope-packs

# in your application
npm install /tmp/scope-packs/scope-ai-core-*.tgz /tmp/scope-packs/scope-ai-sdk-*.tgz
```

## Instrument a model client

One line records every call your application makes through the OpenAI or Anthropic SDK:

```ts
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createTracer, instrumentAnthropic, instrumentOpenAI } from '@scope-ai/sdk';

const tracer = createTracer();   // exports to SCOPE_URL (default http://127.0.0.1:4700)
const openai = instrumentOpenAI(new OpenAI(), { tracer });
const anthropic = instrumentAnthropic(new Anthropic(), { tracer });
```

Each call to `openai.chat.completions.create`, `openai.responses.create`,
`openai.embeddings.create` or `anthropic.messages.create` — streaming or not, and through the
stream helpers built on them (`chat.completions.stream()`, `messages.stream()`) — becomes a model
span: the request and its messages, the response text and tool calls, the model that answered,
tokens (cached input counted separately), estimated cost, finish reason and request id. Inside a
trace it is a child of the current span; outside one it is a trace of its own.

The client keeps its exact behavior: same return values (`.withResponse()` and stream helpers
work), same errors, no changes to requests. Recording failures never reach your code.

- **Streams** are recorded as your code reads them, including a stream your traced handler
  returns for a web framework to send later: the trace waits for its open model span and is
  exported when the stream ends. If your code stops reading early, the span keeps what arrived
  and is marked `scope.stream.incomplete: cancelled`. A stream nobody reads to the end is closed
  after `openSpanGraceMs` (10 minutes by default) as an error, marked `abandoned`. OpenAI reports
  token usage for streams only with `stream_options: { include_usage: true }`; without it,
  streamed calls have no token counts.
- **Failures** — timeouts, network errors, API errors, a stream that breaks midway — are recorded
  on the span with the SDK's error class (`APIConnectionTimeoutError`, `RateLimitError`, …) and
  rethrown unchanged. Calls the SDK retries are one span with the final outcome. Malformed
  responses are passed to your code as they are; SCOPE records what it can read from them.
- **OpenAI-compatible servers** (Ollama, vLLM, OpenRouter, Gemini's OpenAI endpoint): point the
  OpenAI client at them and name the provider — `instrumentOpenAI(new OpenAI({ baseURL }),
  { tracer, provider: 'ollama' })`. Their cost is unknown unless you pass prices with
  `createTracer({ pricing })`.
- Other endpoints (batches, assistants, realtime, files) are not recorded.

## Trace a request

Group the calls of one request into a trace, with spans for your own steps:

```ts
export async function answer(question: string) {
  return tracer.trace('answer-question', { input: { question } }, async () => {
    const docs = await tracer.span('search', { kind: 'retrieval', input: { question } }, () =>
      search(question),
    );
    const res = await openai.chat.completions.create({     // recorded as a child span
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: prompt(question, docs) }],
    });
    return res.choices[0]?.message.content ?? '';
  });
}
```

- `tracer.trace(name, options, fn)` starts a trace. `options.input` and `options.metadata` are
  recorded; the return value becomes the output (or call `trace.setOutput`).
- `tracer.span(name, options, fn)` records a unit of work inside the current trace. Nesting
  follows `await` automatically (AsyncLocalStorage); outside a trace, spans are no-ops, so
  instrumented code behaves the same when tracing is off.
- `kind` is one of `llm`, `retrieval`, `tool`, `function`, `step` or `custom` (the default).
- Errors thrown inside a span are recorded on it (status `error`, type, message) and re-thrown
  unchanged.

### Model calls from other clients

For a client without a wrapper, record the call on a span yourself. `span.recordModelCall`
records it with OpenTelemetry GenAI attribute names and estimates its cost from SCOPE's pricing
table:

```ts
await tracer.span('generate', { kind: 'llm', input: { messages } }, async (span) => {
  const res = await client.generate({ model: 'my-model', messages });
  span.recordModelCall({
    provider: 'acme',
    model: 'my-model',
    usage: { inputTokens: res.usage.input, outputTokens: res.usage.output },
  });
  return res.text;
});
```

Pass usage in SCOPE's field names:

| SCOPE | OpenAI Chat Completions | Anthropic Messages |
| --- | --- | --- |
| `inputTokens` | `usage.prompt_tokens` | `usage.input_tokens` |
| `outputTokens` | `usage.completion_tokens` | `usage.output_tokens` |
| `cacheReadTokens` | `usage.prompt_tokens_details.cached_tokens` | `usage.cache_read_input_tokens` |
| `cacheWriteTokens` | — | `usage.cache_creation_input_tokens` |

Also accepted: `responseModel`, `finishReason`, `temperature`, `maxTokens`, `requestId`, and
`costUsd` to record a known cost instead of an estimate. A model without a known price records an
unknown cost (pass prices with `createTracer({ pricing })`).

### Other span methods

`setInput`, `setOutput`, `setAttribute(s)`, `addEvent(name, attributes)`,
`setStatus('error', message)` and `recordError(error)`.

### Recording your own evaluations

Checks your application already makes can be recorded on the trace and show up in the
Evaluations page:

```ts
await tracer.trace('answer-question', { input: { question } }, async (trace) => {
  const reply = await generate(question);
  const cited = /\[\d+\]/.test(reply);
  trace.addEvaluation({
    evaluator: 'has_citation',
    type: 'regex',
    kind: 'deterministic',
    status: cited ? 'passed' : 'failed',
    score: cited ? 1 : 0,
    threshold: null,
    reason: cited ? 'The reply cites a source.' : 'No citation marker in the reply.',
    metadata: {},
    durationMs: 0,
    spanId: null,
  });
  return reply;
});
```

## Turn traces into test cases

Traces from your application are the best source of test cases: they are the questions users
actually ask. Export them as a dataset, review them, add the expected answers your evaluators
need, and run them:

```bash
scope export traces --workflow answer-question --since 7d --format dataset -o datasets/from-production.jsonl
scope run workflows/support.yaml --dataset datasets/from-production.jsonl
```

Each case's `inputs` is the trace's input (an object as is, anything else as `{ input }`), its id is
the trace's case id or `trace-<id>`, and `metadata.source_trace` points back to the trace. Traces
recorded without content capture have no input and are skipped.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `SCOPE_URL` | `http://127.0.0.1:4700` | Server to send traces to |
| `SCOPE_API_KEY` | — | API key with the `ingest` scope (for `scope server`) |
| `SCOPE_PROJECT` | the server's project | Project name, for servers without authentication |
| `SCOPE_EXPORTER` | `http` | `console` prints one line per trace to stderr instead |
| `SCOPE_CAPTURE_CONTENT` | `true` | `false` records structure, timing and tokens but no inputs or outputs |
| `SCOPE_LOG_LEVEL` | `warn` | The SDK's own log level |

`createTracer({ exporter, privacy, pricing, openSpanGraceMs, logger })` accepts the same
settings in code. Use `MemoryExporter` in tests.

A trace is exported when its function returns — or, if spans are still open then (a stream
returned to the caller), when they end, at most `openSpanGraceMs` later. Spans still open at that
point, or at `tracer.shutdown()`, are closed as errors. At most 1,000 traces wait at once.

## Delivery guarantees

The HTTP exporter is built to never hurt the host application:

- traces are batched (up to 50 per request, and at most 4 MiB, below the server's default 5 MiB
  limit) and sent in the background, without keeping the process alive;
- the queue is bounded (2,048 spans, 32 MiB); when full, new traces are dropped and one warning is
  logged;
- a trace too large for one request is dropped on its own, with one warning naming the limit;
  it cannot take other traces with it. If the server refuses a batch as too large, or names an
  invalid trace in it, the exporter sends the rest again without it;
- failed requests are retried with backoff (3 retries on network errors, 429 and 5xx), then
  dropped and counted in `exporter.stats`;
- `await tracer.shutdown()` (or `flush()`) sends what is queued before the process exits — call it
  in scripts, serverless handlers and shutdown hooks.

Privacy rules apply before anything leaves the process: secrets are redacted and payloads
bounded as described in [configuration](./configuration.md#privacy), and the server applies its
own policy again on arrival.

## Other languages and frameworks

Applications instrumented with OpenTelemetry — in any language, or through the Vercel AI SDK,
OpenLLMetry or OpenInference for LangChain, LlamaIndex and vendor SDKs — send traces to SCOPE
by pointing their OTLP exporter at the server:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4700
```

Model calls that follow the OpenTelemetry GenAI conventions show their model, tokens, estimated
cost, prompt and response like SCOPE's own. Setup per framework, and exactly what is mapped:
[integrations](../integrations.md).

Without OpenTelemetry, the ingestion endpoint is language-neutral: `POST /api/v1/ingest` with
`{ traces, spans, evaluations }` in the format of the [HTTP API](./api.md#ingestion).
