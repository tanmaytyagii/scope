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

## Trace a request

```ts
import { createTracer } from '@scope-ai/sdk';

const tracer = createTracer();   // exports to SCOPE_URL (default http://127.0.0.1:4700)

export async function answer(question: string) {
  return tracer.trace('answer-question', { input: { question } }, async () => {
    const docs = await tracer.span('search', { kind: 'retrieval', input: { question } }, () =>
      search(question),
    );
    return tracer.span('generate', { kind: 'llm' }, async (span) => {
      const res = await openai.chat.completions.create({
        model: 'gpt-5-mini',
        messages: [{ role: 'user', content: prompt(question, docs) }],
      });
      span.recordModelCall({
        provider: 'openai',
        model: 'gpt-5-mini',
        responseModel: res.model,
        finishReason: res.choices[0]?.finish_reason,
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
        },
      });
      return res.choices[0]?.message.content ?? '';
    });
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

### Model calls

`span.recordModelCall` records a call with OpenTelemetry GenAI attribute names and estimates
its cost from SCOPE's pricing table. Pass usage in SCOPE's field names:

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

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `SCOPE_URL` | `http://127.0.0.1:4700` | Server to send traces to |
| `SCOPE_API_KEY` | — | API key with the `ingest` scope (for `scope server`) |
| `SCOPE_PROJECT` | the server's project | Project name, for servers without authentication |
| `SCOPE_EXPORTER` | `http` | `console` prints one line per trace to stderr instead |
| `SCOPE_CAPTURE_CONTENT` | `true` | `false` records structure, timing and tokens but no inputs or outputs |
| `SCOPE_LOG_LEVEL` | `warn` | The SDK's own log level |

`createTracer({ exporter, privacy, pricing, logger })` accepts the same settings in code. Use
`MemoryExporter` in tests.

## Delivery guarantees

The HTTP exporter is built to never hurt the host application:

- traces are batched (up to 50 per request) and sent in the background, without keeping the
  process alive;
- the queue is bounded (2,048 spans); when full, new traces are dropped and one warning is
  logged;
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
