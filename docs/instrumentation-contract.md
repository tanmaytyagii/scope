# The trace contract

What SCOPE records, whatever sends it. Every path into SCOPE — `scope run`, the SDK, the OpenAI
and Anthropic wrappers, OpenTelemetry from any framework — produces the same records, so the
dashboard, the API, comparisons and exports treat them alike. This page defines those records
and says how each integration maps onto them, and where the result differs. It is part of the
stable interface ([stability policy](./guides/api.md#stability-and-deprecation)).

## Concepts

**Trace.** One execution of your application's work: a request answered, a job run, a dataset
case in `scope run`. It has an id (32 hex characters, the W3C/OpenTelemetry trace id), a name,
a status (`ok` or `error`), start and end times, its input and output, metadata, and rollups
computed from its spans: token totals, estimated cost, span and model-call counts. A trace
belongs to one project; a trace made by `scope run` also belongs to a run and a case.

**Span.** One timed piece of a trace, nested under a parent span. Every span has an id (16 hex
characters), a parent (or none, for the root), a name, a *kind*, a status and optional error,
start and end times, an input and an output (content, subject to the privacy policy), attributes
(structure: always kept, always redacted) and events.

**Workflow.** The root span of a trace, kind `workflow`: the unit of work as a whole. There is
exactly one root per trace; spans nested under it are never `workflow`.

The kinds of span:

| Kind | Is | Records |
| --- | --- | --- |
| `workflow` | The root of a trace | The trace's input and output |
| `step` | A named part of the work (a chain in a framework, a workflow step) | Its input and output |
| `llm` | A model call | See [model calls](#model-calls) |
| `tool` | A tool or function the model called | Input: the arguments; output: the result |
| `retrieval` | A search for context | Input: the query (`{ query, … }`); output: `{ documents: [{ id?, source?, title?, text, score? }] }`, ranked |
| `function` | Your own code, run as a `function` step by `scope run` | Its input and return value |
| `evaluation` | The work of judging an output (an evaluator's model calls live under it) | Excluded from the trace's token and cost rollups |
| `custom` | Anything else | As recorded |

### Model calls

A span of kind `llm` has:

| Field | Meaning |
| --- | --- |
| `provider`, `model` | The provider and the model **requested** (`openai`, `gpt-5-mini`) — one model is one row on the Models page |
| attribute `gen_ai.response.model` | The model the provider **reported**, when it differs (a dated snapshot) |
| `inputTokens`, `outputTokens` | Token counts **reported** by the provider; `null` when not reported (never 0 for unknown) |
| attributes `gen_ai.usage.cache_read_input_tokens`, `…cache_creation_input_tokens` | Cached input tokens, counted separately (not included in `inputTokens`) |
| `costUsd` | An **estimate**: reported tokens × SCOPE's dated price table; `null` when the model has no price |
| input | `{ messages: [{ role, content }] }` — system instructions first |
| output | `{ text }`, plus `toolCalls: [{ name, arguments }]` when the model called tools |
| attribute `gen_ai.response.finish_reasons` | Why the model stopped |
| attribute `scope.stream.incomplete` | For streams: `cancelled` or `abandoned` when the output is partial |
| status, error | `error` with the error's type and message when the call failed |

### Evaluations

Evaluation results are records attached to a trace (and optionally a span): evaluator name,
type, kind (`deterministic`, `heuristic`, `model`), status (`passed`, `failed`, `error`,
`skipped`), score, threshold, reason and evidence. `scope run` produces them; applications add
them with `trace.addEvaluation(…)` in the SDK. OpenTelemetry has no evaluation records, so
traces that arrive over OTLP have none (an OpenInference `EVALUATOR` span becomes a span of kind
`evaluation`, not a result).

## How each integration maps

| | SCOPE SDK | `instrumentOpenAI` / `instrumentAnthropic` | OTLP, GenAI conventions | OpenInference | OpenLLMetry |
| --- | --- | --- | --- | --- | --- |
| Trace and workflow | `tracer.trace(name, …)` | The surrounding trace; a call outside one is its own trace, rooted at the model call | The root span; `invoke_agent` at the root is the workflow | Root `CHAIN` / `AGENT` span is the workflow | Root `workflow` / `task` span is the workflow |
| Steps | `tracer.span(…)` (kind as given) | — | Other spans (`custom`), `agent_step` → `step` | Nested `CHAIN`, `AGENT`, `GUARDRAIL` → `step` | Nested `workflow`, `task`, `agent` → `step` |
| Model calls | `span.recordModelCall(…)` | Automatic (chat, responses, embeddings; messages) | `gen_ai.operation.name` `chat`, `generate_content`, `text_completion`, `embeddings` | `LLM`, `EMBEDDING` | `gen_ai.*` attributes |
| Model name | As given | Requested | `gen_ai.request.model` | From `llm.invocation_parameters` (`llm.model_name` is the reported one) | `gen_ai.request.model` |
| Tokens | As given | Reported (streams: with `include_usage`) | `gen_ai.usage.*` | `llm.token_count.*` | `gen_ai.usage.*` |
| Prompt and response | Span input and output | Automatic | `gen_ai.input.messages`, `gen_ai.output.messages` | `llm.input_messages.*`, `llm.output_messages.*` | `gen_ai.prompt.*`, `gen_ai.completion.*`, `traceloop.entity.*` |
| Tools | `kind: 'tool'` | Tool calls in the output | `execute_tool` | `TOOL` | `tool` |
| Retrieval | `kind: 'retrieval'` | — | — | `RETRIEVER`, `retrieval.documents.*` | — |
| Errors | Thrown errors | Thrown errors, with the SDK's error class | Status `ERROR`, `exception` events | The same | The same |
| Evaluations | `trace.addEvaluation` | — | — | — | — |

The Vercel AI SDK's spans (`ai.*`) follow the GenAI column, with `ai.prompt*` and `ai.response.*`
for content and `ai.toolCall` spans for tools. LangChain arrives through OpenInference or
OpenLLMetry. How each path is tested: [integrations](./integrations.md).

## Where the same behavior differs

Measured with the real packages in SCOPE's tests (versions in `apps/server/package.json`):

- **A model call outside any trace.** `instrumentOpenAI` makes the call its own trace (root kind
  `llm`, named `chat <model>`); OpenInference and OpenLLMetry do the same (a root `LLM` span).
  Inside a trace or an active span, all nest the call under it.
- **Framework steps.** LangChain through OpenInference adds a span for the prompt template
  (`custom`) and the output parser (`step`); through OpenLLMetry, each runnable is a `step`, and
  they nest only under an *active* span (OpenLLMetry's `withWorkflow`, or your own) — without one,
  each runnable arrives as its own trace.
- **Streamed calls.** `instrumentOpenAI` records token counts when the request sets
  `stream_options.include_usage`; OpenInference's and OpenLLMetry's OpenAI instrumentations send
  none for streams, so their streamed calls show unknown tokens and cost.
- **Failed calls.** `instrumentOpenAI` and `instrumentAnthropic` record a failed call as an
  `error` span with the SDK's error class. With openai 7.25, OpenInference's and OpenLLMetry's
  OpenAI instrumentations export no span for a call that fails, so it does not appear in SCOPE.
- **Evaluations** exist only for traces made by `scope run` or given results through the SDK.
- **Cost** is always SCOPE's estimate from reported tokens: computed by the SDK for SDK traces
  and by the server for OTLP traces, from the same table and project overrides.
