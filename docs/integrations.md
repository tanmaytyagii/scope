# Integrations

How traces get into SCOPE from the stack you already have, what each path records, and how well
it is tested. For the design behind these choices, see [extensibility](./extensibility.md).

## At a glance

| You use | Send traces with | Model calls recorded with | Verified |
| --- | --- | --- | --- |
| SCOPE workflows (`scope run`) | built in | provider, model, tokens, cost, prompt, response | CI |
| TypeScript, any code | [`@scope-ai/sdk`](./guides/tracing.md) | `span.recordModelCall(…)` | CI |
| The OpenAI or Anthropic TypeScript SDK | [`instrumentOpenAI` / `instrumentAnthropic`](./guides/tracing.md#instrument-a-model-client) | automatically, streams included | CI, against the real SDK packages |
| Any OpenTelemetry SDK (Node, Python, Go, Java, .NET, …) | OTLP/HTTP to `/v1/traces` | GenAI semantic conventions | CI with the OpenTelemetry JS exporters (JSON and protobuf); Python SDK checked manually |
| Vercel AI SDK 7 | [`@ai-sdk/otel`](#vercel-ai-sdk) → OTLP | automatically | CI, with the AI SDK's own test models |
| OpenAI and LangChain through OpenLLMetry (Traceloop) | OTLP | OpenLLMetry's attributes | CI, with `@traceloop/instrumentation-openai` and `-langchain` |
| OpenAI and LangChain through OpenInference (Arize Phoenix) | OTLP | OpenInference's attributes | CI, with `@arizeai/openinference-instrumentation-openai` and `-langchain` |
| LlamaIndex, Anthropic, Bedrock, … through OpenLLMetry or OpenInference, and their Python instrumentations | OTLP | the same attributes | Mapping unit-tested on their documented attributes |
| Another language, without OpenTelemetry | [`POST /api/v1/ingest`](./guides/api.md#ingestion) | fields of the ingest protocol | CI |

"CI, with …" means the real instrumentation package runs in SCOPE's tests: an application
calls a model (a local server answering in OpenAI's format), the package's spans go through the
OpenTelemetry exporter to a running SCOPE, and the test reads back what the dashboard would show.
"Unit-tested on documented attributes" means the conventions those projects publish are mapped
and tested with spans built to match them, but their packages are not run in CI. If a version of
theirs sends something SCOPE misreads, please open an issue with the span attributes.

**LangChain with OpenLLMetry:** its LangChain instrumentation nests LangChain's steps under the
span that is *active* when the chain runs — OpenLLMetry's `withWorkflow`, or a span of your own.
Without one, each step of a chain arrives as a trace of its own (in any backend).
OpenInference's LangChain instrumentation nests them by itself.

## OpenTelemetry (OTLP/HTTP)

Point any OpenTelemetry exporter at a SCOPE server:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4700      # scope ui, or your scope server
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf              # or http/json; gRPC is not supported
export OTEL_RESOURCE_ATTRIBUTES=service.name=support-bot
# scope server only (API key with the ingest scope):
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer scope_…"
```

Exporters append `/v1/traces` to the endpoint, which is where SCOPE listens. Protobuf and JSON
are accepted, gzip-compressed or not, within the server's request limit
(`SCOPE_MAX_INGEST_BYTES`, 5 MiB; a compressed body may expand to four times that).

**What is mapped**

| OpenTelemetry | SCOPE |
| --- | --- |
| Trace id, span id, parent span id, start and end time | The same: traces keep their OpenTelemetry ids, spans nest as sent |
| Spans of one trace sent in several requests | One trace, recomputed as spans arrive; its root span names it |
| `gen_ai.operation.name` `chat`, `text_completion`, `generate_content`, `embeddings` | Model call (`llm`) |
| `execute_tool` · `invoke_agent` · agent steps | Tool call · workflow (at the root) or step · step |
| `gen_ai.provider.name` (or `gen_ai.system`), `gen_ai.request.model` | Provider and model; the price from SCOPE's pricing table, as an estimate |
| `gen_ai.usage.input_tokens`, `output_tokens`, cache read/creation tokens | Tokens (cached input tokens are counted separately, once) |
| `gen_ai.input.messages`, `gen_ai.system_instructions`, `gen_ai.output.messages` | The call's prompt and response |
| `gen_ai.tool.call.arguments` / `result` | The tool call's input and output |
| Status `ERROR`, `exception` events | Span error with type, message and stack |
| Resource attributes (`service.name`, …) | Trace metadata |
| Instrumentation scope | Attribute `otel.scope.name` |
| Every other attribute | Kept as an attribute (nested values as JSON text) |
| Resource attribute `scope.project` | The project the trace goes to (servers without authentication; with an API key, it must match the key's project) |

OpenLLMetry (`traceloop.span.kind`, indexed `gen_ai.prompt.N.*` / `gen_ai.completion.N.*`,
`gen_ai.usage.prompt_tokens`, `traceloop.entity.input` / `output`) and OpenInference
(`openinference.span.kind`, `llm.*`, `input.value` / `output.value`,
`retrieval.documents.N.document.*` — shown as ranked documents) are recognized where they differ
from the GenAI conventions. A chain, agent or task that starts a trace becomes its workflow;
nested ones are steps. The model is the one requested (OpenInference reports the provider's
dated model as `llm.model_name`, kept as `gen_ai.response.model`), so one model is one row on the
Models page.

**Privacy.** Prompt and response attributes are moved into the span's input and output, so the
server's content policy applies to them: with `SCOPE_CAPTURE_CONTENT=false` they are not stored.
Every other attribute is redacted like SCOPE's own ([privacy](./guides/privacy.md)). Many
instrumentations record prompts by default; turn that off at the source too if you need to
(OpenLLMetry: `TRACELOOP_TRACE_CONTENT=false`; OpenInference: `OPENINFERENCE_HIDE_INPUTS` /
`OPENINFERENCE_HIDE_OUTPUTS`).

**Limitations**

- Traces only: OpenTelemetry metrics and logs are not accepted. Instrumentations that emit prompt
  content as log records (for example `opentelemetry-instrumentation-openai-v2` with
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`) produce model spans with tokens and
  timing, but without their content.
- OTLP/gRPC is not supported; use OTLP/HTTP.
- Span links, trace state and dropped-attribute counts are not stored.
- A trace keeps at most `SCOPE_MAX_SPANS_PER_TRACE` spans (1,000), counted across requests.
- Token counts and cost come from what the instrumentation reports; a span without usage has no
  cost. Prices are SCOPE's estimates, not your bill.

## Vercel AI SDK

AI SDK 7 sends telemetry through integrations; `@ai-sdk/otel` produces OpenTelemetry spans with
the GenAI conventions. Register it with a tracer provider that exports to SCOPE:

```ts
import { OpenTelemetry } from '@ai-sdk/otel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { generateText } from 'ai';

const provider = new BasicTracerProvider({
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())], // OTEL_EXPORTER_OTLP_*
});

const result = await generateText({
  model,
  prompt: 'Where is order A-1?',
  experimental_telemetry: {
    isEnabled: true,
    integrations: [new OpenTelemetry({ tracer: provider.getTracer('ai') })],
  },
});
await provider.forceFlush();
```

Each call becomes a trace: the agent invocation at the root, each step, each model call with its
tokens and cost, and each tool call with its arguments and result. Earlier AI SDK versions (3–5)
emit the same `ai.*` and `gen_ai.*` attributes through `experimental_telemetry` with a tracer;
SCOPE reads those too, but they are not in SCOPE's CI.

## Python applications

Use the OpenTelemetry Python SDK with an instrumentation for your framework, and export OTLP/HTTP:

```bash
pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
pip install opentelemetry-instrumentation-langchain    # OpenLLMetry; or openinference-instrumentation-langchain
```

```python
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.instrumentation.langchain import LangchainInstrumentor

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))  # OTEL_EXPORTER_OTLP_* variables
trace.set_tracer_provider(provider)
LangchainInstrumentor().instrument()
```

The Python OpenTelemetry SDK's protobuf exporter, with gzip, was checked against SCOPE by hand
(GenAI attributes, resource, tokens, estimated cost); it is not part of CI.

## OpenAI-compatible endpoints

Anything that speaks the OpenAI API — Ollama, vLLM, LM Studio, llama.cpp's server, OpenRouter,
Google Gemini's OpenAI-compatible endpoint — works in two places:

- **Workflows:** a named provider in `scope.yaml` ([configuration](./guides/configuration.md#providers)):

  ```yaml
  providers:
    ollama:
      type: openai-compatible
      base_url: http://localhost:11434/v1
    gemini:
      type: openai-compatible
      base_url: https://generativelanguage.googleapis.com/v1beta/openai
      api_key: ${env:GEMINI_API_KEY}
  ```

  then `model: ollama:llama3.1` or `model: gemini:gemini-2.5-flash` in a workflow.
  `scope doctor --network` checks the endpoint answers and offers the model.
- **Applications:** the OpenAI SDK with a `baseURL`, wrapped by `instrumentOpenAI` — calls are
  recorded under the provider name you give (`instrumentOpenAI(client, { provider: 'ollama' })`).

Prices: SCOPE's table covers OpenAI and Anthropic models. Other models show cost as unknown until
you add a price to `pricing:` in `scope.yaml` (for self-hosted models, `input: 0, output: 0`).

## CI systems

See [CI and regressions](./guides/ci.md): the GitHub Action, JUnit reports for GitLab, Jenkins,
CircleCI and Azure Pipelines, and plain exit codes for anything else.
