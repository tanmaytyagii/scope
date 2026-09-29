# SCOPE — Architecture

This document describes how SCOPE is built: its boundaries, data model, runtime flows and the
interfaces that extensions implement. Decisions with meaningful alternatives are recorded as
ADRs in [decisions/](./decisions/). Product scope and vocabulary are defined in
[product.md](./product.md).

---

## 1. System overview

```text
                ┌───────────────────────────── developer machine / CI runner ─────────────────────────────┐
                │                                                                                          │
  workflow.yaml │   ┌─────────┐    ┌──────────┐    ┌──────────────┐    ┌────────────┐                      │
  dataset.jsonl ├──▶│ config  │───▶│  engine  │───▶│  providers   │───▶│ OpenAI /   │  (or offline         │
  scope.yaml    │   │ (parse, │    │ (steps,  │    │ (model calls)│    │ Anthropic /│   `local:*` models)  │
                │   │ validate│    │  runs)   │    └──────────────┘    │ compatible │                      │
                │   └─────────┘    │          │───▶ evaluators         └────────────┘                      │
                │                  │          │───▶ sdk Tracer ──▶ exporter ──┐                             │
                │                  └──────────┘                              │                             │
                │   ┌─────────┐                                              ▼                             │
                │   │   cli   │──── run / report / compare / baseline ──▶ storage ◀── server (Hono) ◀── web │
                │   └─────────┘                                         (SQLite │                 dashboard│
                │                                                        or PG)  ├── /api/v1 ◀── SDK HTTP  │
                │                                                                └── /v1/traces ◀── OTLP   │
                └──────────────────────────────────────────────────────────────────────────────────────────┘
```

Three ways data enters SCOPE:

1. **Workflows run by SCOPE** (`scope run`). The engine executes steps, the SDK tracer records
   spans, evaluators score each case, and the CLI persists the run.
2. **Existing applications instrumented with the SDK.** The application creates traces with
   `@scope-ai/sdk` — by hand, or by wrapping its OpenAI or Anthropic client — and the HTTP
   exporter posts them to a SCOPE server (`scope ui` locally, or a self-hosted server).
3. **Applications instrumented with OpenTelemetry**, in any language. Their OTLP/HTTP exporter
   posts spans to `/v1/traces`; the server maps GenAI semantic conventions (and OpenLLMetry,
   OpenInference and Vercel AI SDK attributes) to SCOPE spans.

All paths produce the same trace records, so the dashboard and API do not distinguish them.
[Integrations](./integrations.md) lists each path and how it is tested.

## 2. Repository layout

```text
scope/
├── apps/
│   ├── server/           @scope-ai/server   HTTP API + dashboard hosting (Hono on Node)
│   └── web/              @scope-ai/web      Dashboard SPA (React, Vite, Tailwind)
├── packages/
│   ├── core/             @scope-ai/core     Domain model and pure logic. No runtime dependencies.
│   ├── config/           @scope-ai/config   YAML loading, schemas, diagnostics, templating, datasets
│   ├── providers/        @scope-ai/providers Model provider interface + OpenAI, Anthropic, compatible, local
│   ├── sdk/              @scope-ai/sdk      Tracer, span context propagation, exporters
│   ├── evaluators/       @scope-ai/evaluators Evaluator interface + built-in evaluators
│   ├── engine/           @scope-ai/engine   Workflow execution: steps, retrieval, orchestration
│   ├── storage/          @scope-ai/storage  Kysely schema, migrations, SQLite + PostgreSQL, queries
│   ├── protocol/         @scope-ai/protocol API contract: request/response schemas and types
│   └── cli/              @scope-ai/cli      The `scope` binary
├── integrations/
│   └── github-action/    Composite GitHub Action
├── examples/             Runnable example projects (all work offline): rag, triage, sdk-tracing
├── docs/                 Product, architecture, ADRs, design system, user guides (docs/guides)
├── tests/e2e/            Playwright tests for the dashboard
├── docker/               Demo seed script
├── Dockerfile            Server image (installs the packed packages)
└── compose.yaml          `docker compose up` demo: PostgreSQL + seeded runs + dashboard
```

### Dependency graph

Arrows point from dependent to dependency. There are no cycles; `core` depends on nothing.

```text
cli ──▶ engine ──▶ evaluators ──▶ core
 │        │  └───▶ providers ───▶ core
 │        ├──────▶ sdk ─────────▶ core
 │        └──────▶ config ──────▶ core
 ├──▶ storage ──▶ core
 └──▶ server ──▶ storage, protocol ──▶ core
web ──▶ protocol (types only), core (pure formatting and span-tree helpers)
```

`core` has no I/O and no Node-only APIs, so the dashboard uses its formatters
(`formatDuration`, `formatUsd`, …) and `buildSpanTree` directly: the CLI and the dashboard show
identical numbers.

Boundary rules, enforced by review and by package `exports`:

- `core` is pure: no I/O, no Node-only APIs, no dependencies. Everything in it is unit-testable.
- Only `storage` knows SQL. Only `server` knows HTTP routing. Only `cli` knows about terminals.
- `providers` and `evaluators` never import `engine`; the engine injects what they need.
- The dashboard talks to the server exclusively through `/api/v1`. It never sees database rows.

## 3. Domain model (`@scope-ai/core`)

### Identifiers

| Entity | Format | Example | Why |
| --- | --- | --- | --- |
| Trace | 32 lowercase hex (128-bit random) | `8f31c0…` | W3C Trace Context / OpenTelemetry compatible |
| Span | 16 lowercase hex (64-bit random) | `a1b2c3d4e5f60718` | OpenTelemetry compatible |
| Run | `run_` + 26-char ULID | `run_01J9…` | time-sortable; human-facing number `#42` is separate |
| Evaluation | `ev_` + ULID | | |
| Project, workflow, API key | prefixed ULIDs | `prj_…`, `wf_…`, `key_…` | |

Every run also has a per-project sequential `number` (`#42`) because humans reference runs in
conversation and in pull-request comments.

### Trace and span

```ts
interface TraceRecord {
  id: string;                    // 32 hex
  projectId: string;
  runId: string | null;          // null for SDK traces outside a run
  caseId: string | null;
  name: string;                  // workflow name or SDK trace name
  status: 'ok' | 'error';
  startTime: number;             // epoch ms
  endTime: number;
  durationMs: number;
  input: Payload | null;         // redacted, size-bounded JSON
  output: Payload | null;
  metadata: Record<string, JsonValue>;
  error: ErrorInfo | null;
  // rollups computed from spans on ingest (evaluation spans excluded):
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  costUsd: number | null;        // null when any model has unknown pricing
  spanCount: number;
  llmCallCount: number;
}

interface SpanRecord {
  traceId: string;
  id: string;                    // 16 hex
  parentId: string | null;
  name: string;
  kind: 'workflow' | 'step' | 'llm' | 'retrieval' | 'tool' | 'function' | 'evaluation' | 'custom';
  status: 'ok' | 'error';
  statusMessage: string | null;
  startTime: number; endTime: number; durationMs: number;
  input: Payload | null; output: Payload | null;
  attributes: Record<string, AttributeValue>;   // OpenTelemetry-style dotted keys
  events: SpanEvent[];                           // timestamped annotations, exceptions
  // denormalized for aggregation; also present in attributes:
  provider: string | null; model: string | null;
  inputTokens: number | null; outputTokens: number | null; costUsd: number | null;
}
```

Model-call spans use the OpenTelemetry GenAI semantic-convention attribute names
(`gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`,
`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.request.temperature`), so
the OTLP endpoint (section 10) maps OpenTelemetry spans without translating the model. See
[ADR 0003](./decisions/0003-opentelemetry-aligned-trace-model.md).

### Payloads and privacy

`Payload` is JSON produced by `capturePayload(value, policy)`, which:

1. serializes safely (cycles, `BigInt`, `Error`, `Map`/`Set`, binary → descriptive placeholders),
2. applies redaction rules — built-in patterns for API keys, bearer tokens, private keys, AWS
   keys and JWTs, plus user-defined patterns and field names,
3. truncates strings and the total payload to `privacy.max_payload_bytes` (default 64 KiB),
   recording `{ truncated: true, originalBytes }`,
4. returns `null` for content when `privacy.capture_content: false` (metadata such as token
   counts and latency is still recorded).

This runs in the SDK before data leaves the process, and again on the server for data arriving
over HTTP. See [ADR 0010](./decisions/0010-privacy-defaults.md).

### Evaluation

```ts
type EvaluatorKind = 'deterministic' | 'heuristic' | 'model';
type EvaluationStatus = 'passed' | 'failed' | 'error' | 'skipped';

interface EvaluationResult {
  evaluator: string;            // configured name, e.g. "grounded"
  type: string;                 // evaluator type, e.g. "groundedness"
  kind: EvaluatorKind;
  status: EvaluationStatus;
  score: number | null;         // normalized 0..1, null when not applicable
  threshold: number | null;
  reason: string;               // human-readable explanation, always present
  metadata: Record<string, JsonValue>;  // evidence: matched spans, unsupported claims, judge output
  durationMs: number;
}
```

`error` means the evaluator could not produce a verdict (for example the judge model timed
out). It is never silently converted into a pass or a fail.

### Run summary, gates and comparison

All pure functions in `core`, shared by the CLI, the server and the dashboard's API:

- `summarizeRun(cases) → RunSummary`: pass rate, error rate, latency p50/p95/mean/max,
  token totals, estimated cost, and per-evaluator pass rate and mean score.
- `evaluateGates(summary, gates, baseline?) → GateResult[]`: absolute thresholds (`min`,
  `max`) and regression thresholds against a baseline (`max_decrease`, `max_increase`,
  `max_increase_pct`). Each gate has severity `fail` or `warn`.
- `compareRuns(base, head) → Comparison`: metric deltas with direction-awareness (higher is
  better for scores, lower is better for latency and cost) and per-case changes
  (`regressed`, `fixed`, `unchanged`, `added`, `removed`).

The metric namespace used by gates, reports and the API:

```text
pass_rate                     error_rate
latency.p50_ms  latency.p95_ms  latency.mean_ms  latency.max_ms
tokens.total    tokens.mean_per_case
cost.total_usd  cost.mean_per_case_usd
evaluator.<name>.pass_rate    evaluator.<name>.mean_score
```

## 4. Configuration (`@scope-ai/config`)

Two file types, both YAML, both carrying `version: 1`:

- **`scope.yaml`** — project settings: project name, storage URL, provider settings, pricing
  overrides, privacy policy, defaults.
- **Workflow files** — `name`, `inputs`, `params`, `variants`, `steps`, `outputs`, `dataset`,
  `evaluators`, `gates`.

Validation happens in three passes, all before any step executes:

1. **Syntax** — YAML parse errors with line and column.
2. **Schema** — Zod schemas. Objects are strict: an unknown key is an error with a
   "did you mean" suggestion, because silently ignored typos (`temprature: 0`) are a common
   source of wrong results.
3. **Semantics** — step IDs are unique; template references (`steps.retrieve.output`) point to
   earlier steps; evaluator and step types exist; provider names resolve; referenced files
   exist; gate metrics name real evaluators.

Every diagnostic carries `file:line:column`, the offending path, a message, and a fix hint, and
is rendered with a source excerpt. The schemas are also exported as JSON Schema
(`schemas/workflow.schema.json`) for editor autocompletion.

Templates use `{{ expression }}` with dotted paths and a closed set of filters (`json`,
`join`, `default`, `truncate`, `lower`, `upper`, `trim`, `length`). There is no arbitrary code
execution in templates; logic belongs in `function` steps. A template that is exactly one
expression preserves the value's type (`top_k: "{{ params.top_k }}"` yields a number).

Environment variables are referenced as `${env:NAME}` and are resolved at load time. The
stored workflow snapshot keeps the reference, never the value.

Schema evolution policy: additive changes within `version: 1`; a breaking change introduces
`version: 2` and a loader that upgrades `version: 1` files in memory with a deprecation
notice. See [ADR 0004](./decisions/0004-workflow-configuration-format.md).

## 5. Engine (`@scope-ai/engine`)

### Execution of a run

```text
scope run workflows/support.yaml --variant small-context
  │
  ├─ load + validate project config, workflow, dataset          (config)
  ├─ open storage, migrate, register workflow version           (storage)
  ├─ create run #N (status: running, git commit/branch captured)
  ├─ for each case, with bounded concurrency (default 4):
  │     tracer.trace(workflow.name) ─┐
  │        for each step:            │ span per step; model calls, retrievals and
  │           resolve templates      │ tool calls become child spans
  │           execute step           │
  │        resolve outputs           │
  │        evaluation span ──────────┤ one child span per evaluator
  │     exporter → storage (trace, spans, evaluations in one transaction)
  ├─ summarizeRun → evaluateGates (with baseline if given) → complete run
  └─ exit code: 0 passed · 1 gate failed · 2 configuration error · 3 execution error
```

### Step types

| Type | Purpose | Output |
| --- | --- | --- |
| `llm` | Call a model through a provider (`openai:gpt-5`, `anthropic:claude-sonnet-5`, `local:extractive`) | `{ text, json?, usage, model, finish_reason }` |
| `retrieve` | BM25 search over local documents, chunked by heading/paragraph | `{ documents: [{ id, source, text, score }], text }` |
| `transform` | Compute a value from templates (build a string, pick fields, parse JSON) | the value |
| `function` | Call an exported function from a JS/TS module in the project | the return value |

A `function` step receives a context with `ctx.llm()`, `ctx.span()` and `ctx.retrieve()`, so
agent loops and tool calls written in code are traced exactly like declarative steps.

Step types are registered in a `StepRegistry`; adding a type means implementing:

```ts
interface StepType<Args> {
  type: string;
  argsSchema: ZodType<Args>;          // validated after template resolution
  spanKind: SpanKind;
  execute(args: Args, ctx: StepContext): Promise<unknown>;
}
```

### Reliability

- Per-step `timeout_ms` (defaults: `llm` and `function` 300 s, `retrieve` 30 s, `transform` 10 s;
  `defaults.timeout_ms` in scope.yaml overrides them), enforced with `AbortSignal`.
- Retries for retryable provider errors (HTTP 408, 409, 429, 5xx, connection errors), honouring
  `Retry-After`, delegated to the vendor SDK. Default 2 retries, configurable per project.
- A failing case never aborts the run; it becomes a trace with `status: error`. `--bail` stops
  the run at the first failure.
- Ctrl-C finishes in-flight cases' persistence and marks the run `cancelled`.

## 6. Providers (`@scope-ai/providers`)

```ts
interface ModelProvider {
  id: string;                                          // "openai"
  complete(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResponse>;
  embed?(req: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResponse>;
}
```

Vendor providers wrap the vendors' official SDKs (`openai`, `@anthropic-ai/sdk`), which track
API changes, implement retries with `Retry-After`, and expose typed errors that SCOPE maps to its
own error codes (`provider_auth`, `provider_rate_limited`, `provider_unavailable`, …). SDKs are
imported lazily, so a run that only uses `local:*` models never loads them. Model references are
`provider:model`. Provider-specific request fields are passed through `provider_options`, keyed by
provider name (`provider_options: { anthropic: { output_config: { effort: low } } }`) so that
variants which switch providers never send one provider's options to another.

SCOPE sends exactly what the workflow asks for and records the serving model
(`gen_ai.response.model`) on every span. It never enables vendor-side model fallbacks on its
own: in an evaluation harness the model is the variable under test, and silently answering with
a different model would invalidate the comparison. Request parameters a model does not accept
(for example `temperature` on current Claude models) are omitted with a validation warning and
recorded on the span as `scope.request.ignored_params`.

Built-in providers:

| Provider | Credentials | Notes |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | Chat Completions API; embeddings |
| `anthropic` | `ANTHROPIC_API_KEY` | Messages API |
| `compatible` / named endpoints | configured in `scope.yaml` | Any OpenAI-compatible server: Ollama, vLLM, LM Studio, OpenRouter |
| `local` | none | Deterministic offline models: `local:extractive` (extracts the context sentences that best match the question) and `local:echo`. For demos, tests and CI plumbing — not language models, and labelled as such everywhere |

Costs are computed from a versioned pricing table (`packages/core/src/pricing.ts`, with an
`as_of` date and source per entry) and project overrides in `scope.yaml`. A model without a
known price produces `costUsd: null` and the UI shows "unknown", never `$0`.

## 7. Evaluators (`@scope-ai/evaluators`)

```ts
interface EvaluatorDefinition<Args> {
  type: string;                  // "groundedness"
  kind: EvaluatorKind;
  description: string;
  argsSchema: ZodType<Args>;
  evaluate(input: EvaluatorInput<Args>, ctx: EvaluatorContext): Promise<EvaluatorOutcome>;
}

interface EvaluatorInput<Args> {
  input: JsonValue;              // case inputs
  output: JsonValue;             // workflow output (or a templated selection of it)
  expected: JsonValue | null;
  context: string | null;        // e.g. retrieved documents
  trace: { durationMs: number; usage: Usage; costUsd: number | null };
  args: Args;
}
```

`EvaluatorContext` provides a model provider (for model-based evaluators), an abort signal and
the tracer. Built-ins:

| Type | Kind | Measures |
| --- | --- | --- |
| `exact_match` | deterministic | output equals expected (with optional normalization) |
| `contains`, `not_contains`, `regex` | deterministic | presence/absence of required content |
| `json` | deterministic | output parses as JSON and optionally satisfies a JSON Schema |
| `latency`, `tokens`, `cost` | deterministic | budget thresholds on the trace |
| `similarity` | heuristic | lexical token-F1 / ROUGE-L against expected |
| `groundedness` | heuristic | share of answer sentences supported by the context |
| `unsupported_claims` | heuristic | numbers, quantities and named entities in the answer that do not appear in the context (a hallucination signal) |
| `relevance` | heuristic | coverage of the question's key terms in the answer |
| `llm_judge` | model | rubric-graded score from a judge model, with the judge's reasoning stored |
| `embedding_similarity` | model | cosine similarity of embeddings of output and expected |

Custom evaluators are modules: `type: ./evaluators/refund-policy.ts` exporting
`defineEvaluator({...})`. See [ADR 0005](./decisions/0005-evaluator-taxonomy.md).

## 8. Tracing SDK (`@scope-ai/sdk`)

```ts
const tracer = createTracer({ project: 'support-bot' });   // exporter chosen from env
const openai = instrumentOpenAI(new OpenAI(), { tracer });  // model calls become llm spans

await tracer.trace('answer-question', { input: { question } }, async () => {
  const docs = await tracer.span('retrieve', { kind: 'retrieval' }, () => search(question));
  const res = await openai.chat.completions.create({ ... });
  return res.choices[0].message.content;
});
```

- Context propagates through `AsyncLocalStorage`; nested `span()` calls parent automatically.
- `instrumentOpenAI` / `instrumentAnthropic` patch the client's `create()` methods in place
  (chat completions, responses, embeddings; messages), structurally — the SDKs are not
  dependencies. Non-streaming calls return the SDK's own promise, observed on the side; streams
  are wrapped so each chunk passes through unchanged while the span accumulates the output.
  Response fields are validated before use (token counts must be non-negative integers).
  Model calls from anything else are recorded with `span.recordModelCall(...)`.
- Exporters: `HttpExporter` (batched, bounded queue, retry with backoff, drops and counts on
  overflow — never blocks or crashes the host application), `ConsoleExporter`,
  `MemoryExporter` (tests). The engine uses a storage-backed exporter.
- Configuration via `SCOPE_URL`, `SCOPE_API_KEY`, `SCOPE_PROJECT`, `SCOPE_CAPTURE_CONTENT`.

## 9. Storage (`@scope-ai/storage`)

SQLite (Node's built-in `node:sqlite`, no native addon) for local use and PostgreSQL for
shared deployments, behind one Kysely-based implementation with shared, dialect-aware
migrations. See [ADR 0002](./decisions/0002-storage-sqlite-and-postgres.md).

```text
projects        id, slug (unique), name, created_at
api_keys        id, project_id → projects, name, prefix, hash (unique), scopes, created_at,
                last_used_at, revoked_at
workflows       id, project_id → projects, name, description, latest_version_id, timestamps
                unique (project_id, name)
workflow_versions id, workflow_id → workflows, hash, definition (json), source (text), created_at
                unique (workflow_id, hash)
runs            id, project_id, number, workflow_id, workflow_version_id, variant, params,
                dataset, status, gate_status, summary, gates, git, trigger, error,
                started_at, ended_at, duration_ms
                unique (project_id, number); index (project_id, started_at), (workflow_id, started_at)
traces          id, project_id, run_id → runs (cascade), case_id, name, status, start/end,
                duration_ms, input, output, metadata, error, token and cost rollups,
                span_count, llm_call_count, eval_status, search_text
                index (project_id, start_time), (run_id), (project_id, name, start_time),
                (project_id, status, start_time)
spans           (trace_id, id) primary key, trace_id → traces (cascade), parent_id, name, kind,
                status, timing, input, output, attributes, events, provider, model, tokens,
                cost_usd; index (project_id, model, start_time)
evaluations     id, project_id, trace_id → traces (cascade), run_id, span_id, evaluator, type,
                kind, status, score, threshold, reason, metadata, duration_ms, created_at
                index (run_id, evaluator), (project_id, evaluator, created_at), (trace_id)
run_comparisons run_id → runs (cascade, primary key), project_id, baseline (json),
                comparison (json: metric deltas, counts, up to 500 changed cases), created_at
```

`run_comparisons` (migration `0002`) keeps what a run's regression gates compared against when
it ran. The baseline file may have been saved on another machine, from a run that is not in this
database, so the comparison cannot be recomputed later; run lists never load it.

Conventions: timestamps are epoch milliseconds — `bigint` for records, `double precision` for
trace and span times so spans that start within the same millisecond keep their order. JSON is
`jsonb` on PostgreSQL and `text` on SQLite, and both drivers return it as text so one code path
parses it. Every tenant-owned row carries `project_id`, which every query filters on; ingestion
attaches spans and evaluations to their bundle's trace and refuses trace ids owned by another
project. Aggregations (overview, models, evaluator health) are computed in SQL over denormalized
columns, never by loading rows into memory. List endpoints use keyset pagination on
`(start_time, id)`.

## 10. HTTP API (`@scope-ai/server`, `@scope-ai/protocol`)

Hono on Node. Base path `/api/v1`. All request and response bodies are defined as Zod schemas
in `@scope-ai/protocol`, together with a route table (`ROUTES`) from which the OpenAPI 3.1
document served at `/api/v1/openapi.json` is generated. The server's contract test requests
every route in the table and validates the response against its schema, with strict objects, so
an unmapped field fails the test.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/info` | Version, protocol and auth mode (public: the dashboard reads it before signing in) |
| GET | `/api/v1/overview?window=7d` | KPIs and time series for the dashboard home (`24h`, `7d`, `30d`, `90d`) |
| GET | `/api/v1/runs` | List runs (filter: workflow, variant, status, gateStatus; keyset pagination) |
| GET | `/api/v1/runs/{run}` | Run detail with summary, gates and evaluator breakdown (`{run}`: id or number) |
| GET | `/api/v1/runs/{run}/cases` | Per-case results (filter: outcome, failing evaluator, `q`) |
| GET | `/api/v1/runs/{run}/baseline-comparison` | The run next to its baseline file as compared when it ran: metric deltas, changed cases |
| GET | `/api/v1/comparisons?base=&head=` | Compare two runs; unchanged cases only with `includeUnchanged=true` |
| GET | `/api/v1/comparisons/matrix?runs=` | Two to four runs side by side (`compareMany`) |
| GET | `/api/v1/traces` | List traces (filter: run, name, status, eval, model, case, `q`, time; sort; pagination) |
| GET | `/api/v1/traces/{trace}` | Trace with spans (with `offsetMs` from trace start) and evaluations |
| GET | `/api/v1/evaluators` | Per-evaluator health and per-run trend |
| GET | `/api/v1/evaluations` | Evaluation results (filter: evaluator, status, kind, run) |
| GET | `/api/v1/workflows`, `/api/v1/workflows/{name}` | Workflows, latest definition, versions and variants |
| GET | `/api/v1/models` | Calls, tokens, latency, errors and estimated cost per model, with the price used |
| GET | `/api/v1/project` | Project, storage, privacy policy, pricing table and row counts |
| GET | `/api/v1/api-keys` | Key metadata (name, prefix, scopes, last use); never secrets or hashes |
| GET | `/api/v1/traces/{trace}/spans/{span}` | One span in full, for traces read with a `contentBudget` |
| POST | `/api/v1/ingest` | Batched traces, spans and evaluations from SDKs |
| POST | `/v1/traces` | OpenTelemetry spans (OTLP/HTTP, protobuf or JSON, optionally gzip) |
| GET | `/healthz`, `/readyz`, `/metrics` | Liveness, readiness (database ping + migrations), Prometheus metrics |

Conventions:

- Errors: `{ "error": { "code": "not_found", "message": "…", "hint": "…", "requestId": "…" } }`
  with an accurate HTTP status. Validation errors list the failing fields in `details.issues`.
- Pagination: `?limit=` (default 50, max 200) and opaque `?cursor=`; responses include
  `nextCursor`.
- Timestamps in responses are ISO-8601 strings; durations and span offsets are milliseconds.
- Versioning: the `/v1` contract only changes additively. Removing or changing a field
  requires `/v2`. The published OpenAPI document omits `additionalProperties: false` so
  generated clients tolerate new fields.
- Response DTOs are explicit mappings from domain records; database rows are never serialized
  directly.

### Ingestion

`POST /api/v1/ingest` accepts the SDK's wire format (header `scope-protocol: 1`):
`{ project?, traces, spans, evaluations }` with epoch-millisecond times. The batch is validated
as a whole; every span and evaluation must belong to a trace in the same request, and `runId`s
must name runs of the project. Before storage the server applies its own privacy policy again
(redaction of content, attributes, messages and evidence; content dropped when
`capture_content` is off), keeps at most `SCOPE_MAX_SPANS_PER_TRACE` spans per trace (roots
first; the count of dropped spans is recorded in trace metadata), and recomputes token, cost and
count rollups from the spans. Re-sent traces are ignored (idempotent per id); trace ids owned by
another project are never overwritten and are reported as `rejectedTraces`.

`POST /v1/traces` accepts OTLP/HTTP (`application/x-protobuf` or `application/json`, optionally
`Content-Encoding: gzip`, decompressed size bounded at 4× the body limit) with the same
authentication (`ingest` scope) and privacy policy. A minimal protobuf reader (no generated code)
decodes requests; `otlp/map.ts` maps each span: the kind from GenAI operation names or
OpenInference/OpenLLMetry span kinds, messages and completions into span input and output,
tokens (cached input counted once), estimated cost from the pricing table, exceptions into span
errors, resource attributes into trace metadata. The resource attribute `scope.project` selects
the project where authentication allows it. Exporters send spans as they end, so a trace arrives
over several requests: storage inserts spans idempotently and recomputes every touched trace
from all its stored spans (root, timing, rollups, previews), within the per-trace span limit.
Invalid spans are counted in an OTLP partial-success response rather than failing the request.

### Metrics

`/metrics` exposes `scope_http_requests_total{method,route,status}`,
`scope_http_request_duration_seconds{method,route}`, `scope_ingested_{traces,spans,evaluations}_total`,
`scope_ingest_rejected_total{reason}`, `scope_ingest_dropped_spans_total`,
`scope_unexpected_errors_total`, `scope_build_info` and `scope_process_start_time_seconds`.
Route labels are route patterns (`/api/v1/runs/:run`), never raw paths.

### Authentication

| Mode | When | Behaviour |
| --- | --- | --- |
| `none` | `scope ui` (binds to 127.0.0.1) | No authentication. The server refuses to bind a non-loopback address in this mode unless `--insecure-no-auth` is passed explicitly. Requests act on the current project, or on the project named by the `x-scope-project` header (reads) or the ingest body's `project` (created on first use). |
| `api-key` | self-hosted server | `Authorization: Bearer scope_…`. Keys are stored as SHA-256 hashes, shown once at creation, carry scopes (`ingest`, `read`) and belong to exactly one project, which bounds every query. The dashboard asks for a read-scoped key. |

User accounts, SSO and RBAC are roadmap items; the project-scoped key is the authorization
boundary the later model builds on.

## 11. Dashboard (`@scope-ai/web`)

React 19 + Vite + TypeScript + Tailwind CSS v4, with Radix primitives for accessible
overlays (dialog, popover, dropdown, tooltip, tabs) and `cmdk` for the command palette.
Server state uses TanStack Query; URL search params are the source of truth for filters, so
every view is linkable. Charts are small hand-written SVG components on the design tokens
(no charting library) — see [ADR 0009](./decisions/0009-dashboard-stack.md).

Routes:

```text
/                       Overview — how is my AI system doing?
/runs                   Runs, filterable; select two to compare
/runs/:id               Run: summary, gates, evaluator breakdown, cases
/compare?base=&head=    Comparison: metric deltas, per-case regressions and fixes
/traces                 Traces with filters and search
/traces/:id?span=       Trace explorer: span tree + timeline, span detail, evaluations
/evaluations            Evaluator health and failing results
/workflows, /workflows/:name   Definitions and run history
/models                 Usage and cost per model
/settings               Project, storage, privacy, pricing, API keys, appearance
```

Every page except the Overview is loaded on first visit (route-level code splitting). The
dashboard is a static bundle: `@scope-ai/server` depends on `@scope-ai/web` and serves its
`dist/` (`findWebRoot()`), with hashed assets cached immutably and `index.html` for any other
path. Under `scope server` the dashboard first reads `/api/v1/info`; when the server uses API
keys it asks for a read-scoped key, kept in session storage (or local storage if the user asks
to be remembered) and sent as a bearer token.

The command palette (⌘K / Ctrl+K) jumps to pages, runs by number, traces by id prefix, and trace
search; `g` + a letter navigates, `/` focuses the page's search, `?` lists shortcuts.

Development: `npm run dev:web` starts Vite with `/api` proxied to a running `scope ui`
(`SCOPE_API_URL` to change it). Pure logic (span layout, axis math, payload shapes) is unit
tested with Vitest; journeys, keyboard use and axe accessibility scans run in Playwright
against a project seeded by the CLI (`tests/e2e`).

The design system (tokens, primitives, patterns) is documented in
[design-system.md](./design-system.md).

## 12. CLI (`@scope-ai/cli`)

```text
scope init [dir]                  Scaffold a project that runs offline immediately
scope validate [workflow...]      Validate configuration without executing
scope run <workflow>              Execute a workflow over its dataset and evaluate it
scope evaluate <run>              Re-score a stored run with the current evaluators (no model calls for the workflow)
scope runs [id]                   List runs or show one
scope traces [id]                 List traces or show one as a tree
scope compare <base> <head>       Compare two runs (IDs, #numbers or a baseline file)
scope report [run]                Render a report (text, markdown, json, junit)
scope export traces|run           Write traces (JSONL, or dataset cases) or a run's results (CSV, JSONL)
scope baseline save [run]         Write a baseline file for CI
scope ui [--port] [--open]        Start the local dashboard (127.0.0.1, no authentication)
scope server [--host] [--port]    Start a server for shared deployments (API keys required)
scope keys create|list|revoke     Manage project API keys for `scope server`
scope doctor                      Diagnose configuration, storage and providers
scope version
```

Global flags: `--json` (machine-readable output on stdout, diagnostics on stderr), `--cwd`,
`--config`, `--quiet`, `--verbose`, `--no-color` (and `NO_COLOR`). Exit codes are stable and
documented: `0` success, `1` gates failed, `2` usage or configuration error, `3` execution or
storage error, `130` interrupted. `scope run --junit-file` writes a JUnit XML report (each case a
test case, each run's gates a second suite) for CI systems other than GitHub.

## 13. GitHub integration

A composite action (`integrations/github-action`, documented in its README) that:

1. builds the SCOPE CLI from the action's own commit (until the packages are published to npm),
2. runs `scope run` for each workflow (from the `workflows` input, or the project's workflows
   via `scope validate --json`) — regression gates use `baselines/<workflow>[.<variant>].json`
   when it exists,
3. appends each run's Markdown report to the job summary and emits an error annotation per
   failed gate (warning for `severity: warn`) — `scope run` does both when `GITHUB_ACTIONS` is
   set,
4. uploads the SQLite database and JSON reports as an artifact, and sets the outputs `result`
   and `report`,
5. fails the job when a `fail`-severity gate fails (exit 1) or a workflow cannot run (2 or 3).

Every workflow runs even if an earlier one fails. With `comment: true` the reports also go to
one pull request comment, updated on every push. The repository's own CI runs the action against
a starter project twice — unchanged (must pass) and with an injected regression (must fail).

Reports say what changed in configuration since the baseline: baseline files record their
parameters and workflow hash (`config`), and comparisons list changed parameters and whether the
workflow file or the dataset changed. Text that can come from models or datasets (reasons, case
ids) is escaped so it renders as plain text in pull requests — no mentions, links or images.

Baselines are committed JSON files (`scope baseline save`), so a pull request that changes
quality shows the baseline diff for review. See
[ADR 0006](./decisions/0006-committed-baselines.md).

## 14. Observability of SCOPE itself

- Structured logger in `core` (JSON lines on the server, human-readable in the CLI), with
  redaction applied to every log record. Prompt and output content is never logged; log
  records carry IDs and sizes only.
- Every HTTP request gets an `x-request-id` (accepted if valid, otherwise generated) that
  appears in logs and error responses.
- `/metrics` exposes Prometheus counters and histograms: HTTP requests by route and status,
  ingested traces/spans, ingestion rejections, database query errors.
- `scope doctor` checks Node version, configuration validity, storage connectivity and
  migration state, provider credentials (presence, and optionally a live request with
  `--network`), and port availability.
- `onError` hook on the server for plugging in error trackers.

## 15. Security

- Secrets only from environment variables or `${env:…}` references; never written to the
  database, logs, workflow snapshots or reports.
- Redaction of known secret formats in all captured payloads (section 3).
- API keys hashed with SHA-256 (they are high-entropy random tokens, so a slow hash is not
  required), compared in constant time, scoped to one project.
- Input validation on every API boundary with explicit body-size limits (ingest and OTLP:
  5 MiB; gzip-compressed OTLP is bounded after decompression too). The OTLP decoder bounds
  nesting depth, and mapped spans get the same field limits as the SDK ingestion schema.
- Security headers and a strict Content-Security-Policy for the dashboard.
- `scope ui` (no authentication) answers only requests addressed to `localhost`, `127.0.0.1` or
  `::1` — a DNS-rebinding defense — and ingestion requires `application/json` (OTLP:
  `application/json` or `application/x-protobuf`), which a cross-site page cannot send without a
  CORS preflight (the server sends no CORS headers).
- `function` steps and custom evaluators execute user code from the project directory with
  the CLI's privileges — the same trust model as a test runner. This is documented, and
  SCOPE never loads code from datasets or remote sources.

## 16. Performance limits

| Limit | Default | Configurable |
| --- | --- | --- |
| Captured payload size per field | 64 KiB | `privacy.max_payload_bytes` |
| Spans per trace | 1,000 (excess dropped and counted) | `SCOPE_MAX_SPANS_PER_TRACE` |
| Ingest request body (SDK and OTLP) | 5 MiB (OTLP gzip: 20 MiB decompressed) | `SCOPE_MAX_INGEST_BYTES` |
| SDK export queue | 2,048 spans, dropped with a warning when full | exporter option |
| API page size | 50 (max 200) | per request |
| Run concurrency | 4 | `--concurrency` / `defaults.concurrency` |

## 17. Testing strategy

| Layer | Tool | What |
| --- | --- | --- |
| Unit | Vitest | core (stats, gates, comparison, cost, redaction, ids), config (schemas, diagnostics with positions, templates), evaluators, retrieval, providers (recorded HTTP fixtures via a fake `fetch`), sdk |
| Integration | Vitest | engine end-to-end with `local` models; storage against SQLite and PostgreSQL (`SCOPE_TEST_DATABASE_URL`); server via `app.request()` against a real store |
| CLI | Vitest + child processes | `init → validate → run → report → compare → baseline` in temporary directories, asserting output, JSON shape and exit codes |
| E2E | Playwright | Dashboard flows against a server seeded by executing the example workflows (real runs, not fixtures) |
| Package | CI | `npm pack` the CLI and run it from a clean directory to catch missing dependencies |

CI runs lint, typecheck, unit and integration tests (with a PostgreSQL service), build, E2E,
the package smoke test and dependency audit on every pull request.
