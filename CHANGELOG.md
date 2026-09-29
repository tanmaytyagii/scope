# Changelog

All notable changes to SCOPE are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may contain breaking changes,
which are always called out).

## [Unreleased]

### Added

- Runs record what produced them (a *manifest*, stored by migration `0003_run_manifest`): the
  SCOPE and Node.js versions and platform; SHA-256 fingerprints of every file the workflow names
  (`function` step modules, custom evaluator modules, retrieval corpora — each matched file's path
  and content); each evaluator's type and kind, with the judge model and prompt version of
  model-graded ones; and the models called, with the exact models the providers reported. The run
  page shows it under *What produced this run*, `scope runs <run>` summarizes it, and the API,
  `--json` and the JSON report include it (`manifest`, null for older runs). Baseline files keep
  the file fingerprints and SCOPE version (new optional `config.files` and `config.scope`), so
  comparisons name changed files — *the retrieval corpus ../docs/\*.md* — and a change of SCOPE
  version; `ConfigDiff` gains `files` and `scope`.

- `scope db status` shows where the database is, whether its schema is current (or was migrated
  by a newer SCOPE), its size and what each project holds; `scope db migrate` applies pending
  migrations (for `SCOPE_AUTO_MIGRATE=false`); `scope db backup <file>` writes a consistent copy
  of a SQLite database while it is in use. None of them migrates on open.
- A production-style deployment: [`deploy/compose.yaml`](deploy/compose.yaml) runs `scope server`
  on PostgreSQL with secrets from `deploy/.env`, health checks on `/readyz`, restart policies, and
  optional HTTPS through Caddy. The new [operations guide](docs/guides/operations.md) covers
  deploying, monitoring, upgrades, backups, retention and key rotation; the
  [API guide](docs/guides/api.md#stability-and-deprecation) states which interfaces are stable and
  how they are deprecated.
- Request logs name the project and the API key id behind each request.
- Retention. `scope prune --older-than 30d` deletes runs (with their traces) and application
  traces that started before a date or age; `--run` and `--trace` delete one; `--only`,
  `--project` and `--all-projects` narrow or widen it. Without `--yes` it only says what it would
  delete. Deletion runs in batches and can be interrupted and resumed; `--vacuum` shrinks a SQLite
  file afterwards. `scope server --retention 30d` (`SCOPE_RETENTION`) prunes every project at
  start and hourly, logs what it deleted and counts it in `scope_retention_deleted_total`. Runs
  still running are only deleted once they have been running for a day.
- `scope server` refuses `SCOPE_MAX_INGEST_BYTES` and `SCOPE_MAX_SPANS_PER_TRACE` values that are
  not positive whole numbers, instead of starting with a broken limit.
- `scope server` logs database queries slower than `SCOPE_SLOW_QUERY_MS` (1000 ms by default)
  with their SQL — never their values. `Store.open` takes an `onQuery` hook.
- Performance is guarded in CI. A query-plan test runs the store's hot paths on SQLite and fails
  when a statement scans a whole table, or every span or evaluation of a project, to find a few
  (the shape of the v0.3 OTLP slowdown, which it catches). `npm run bench:check` compares
  ingestion and reads at 2,000 and 50,000 traces on the same machine and fails when one slows
  down with the database's size; a new CI job runs it.

- Large traces open quickly in the dashboard. `GET /api/v1/traces/{trace}` takes
  `contentBudget=<bytes>`: every span's structure is returned, but inputs and outputs only up to
  the budget; the rest are marked `contentOmitted: true` (left out, not empty) and served one at a
  time by the new `GET /api/v1/traces/{trace}/spans/{span}`. Storage reads content only for spans
  within the budget, so memory is bounded too. The trace explorer asks for 2 MiB and loads a
  span's content when it is selected: a 1,000-span trace with ~120 KB per span went from a
  118.7 MiB response (server at 1.1 GiB) to a 2.3 MiB one, open in under a second. Without the
  parameter the API returns everything, as before. Spans carry the new `contentOmitted` field
  (always `false` then).

### Fixed

- The SDK's HTTP exporter no longer loses whole batches. Requests are bounded by size as well as
  by trace count (`maxBatchBytes`, 4 MiB by default, below the server's 5 MiB limit), a trace too
  large for any request is dropped on its own with a warning, and when the server refuses a batch
  as too large (413) or names an invalid trace (400 with `details.issues`), the exporter resends
  the rest without it. Before, 50 traces of about 120 KB each made one 6 MB request, and all 50
  were dropped. The queue is bounded by bytes too (`maxQueueBytes`, 32 MiB).
- A run's case list (`GET /runs/{run}/cases`, the run page) read every evaluation of the project
  to find those of one page of cases, on SQLite; found by the new query-plan test.
- The dashboard's time-window pages stay fast as data grows. Migration `0004_window_indexes`
  adds covering indexes for the overview, models and evaluator pages and the failed-evaluations
  list, so they read an index in time order instead of every row in the window: at 300,000 traces
  the overview's trace totals went from 617 ms to 22 ms on first load, the models page's queries
  from 1.2 s to 20 ms and 300 ms to 140 ms, and the failed-evaluations list from 31 ms to 1 ms, for
  6% more disk. A trace's and a run's evaluations are read by trace or run id alone, which the new
  indexes would otherwise have turned into project-wide walks (caught by the query-plan test).
- SQLite keeps up to 64 MiB of pages in memory (was 2 MiB): at 200,000 traces ingestion is 40%
  faster because index pages stay cached.
- Ingestion errors caused by one record (a duplicate trace id, a span or evaluation without its
  trace, an unknown run id) name the record in `details.issues`, as schema errors already did.
- A streamed model response that a traced handler returns for its web framework to send (the
  usual way to stream a chat answer) is now recorded completely: the trace waits for its open
  model span and is exported when the stream ends. Before, the span was closed as an error with
  no output or tokens the moment the handler returned. Spans still open after `openSpanGraceMs`
  (10 minutes by default, a new tracer option) or at `shutdown()` are closed as errors; at most
  1,000 traces wait at once. `scope run` keeps closing open spans when a case ends.
- Instrumented streams mark partial output: `scope.stream.incomplete` is `cancelled` when the
  application stops reading early, and `abandoned` (an error) when a stream is not read to the
  end within the grace period — before, an unread stream held its trace in memory forever.
- Errors recorded on spans name the error's class when its `name` is the generic `Error`, as with
  the OpenAI and Anthropic SDKs: `APIConnectionTimeoutError`, `RateLimitError`, not `Error`.
- Streamed tool-call deltas without a name or arguments are no longer recorded as empty tool
  calls, and at most 128 tool calls are kept from one response.

## [0.3.0] - 2026-09-29

### Changed

- The export condition SCOPE's packages use for their TypeScript sources during development is
  now `scope-source` (was `source`). Third-party packages that publish a `source` condition broke
  tests and `npm run scope`. Only affects working on SCOPE itself.

### Security

- Third-party GitHub Actions are pinned to commit SHAs in every workflow and in the composite
  action, and Dependabot keeps the pins and npm dependencies current. They are the first
  releases that run on Node.js 24 (Node.js 20, which the previous majors used, is past end of
  life): `actions/checkout` v5, `setup-node` v5, `upload-artifact` v6, `download-artifact` v7,
  `github-script` v8, `dependency-review-action` v5, and the Docker actions' current majors. The
  composite action disables `setup-node`'s new automatic dependency caching, which would otherwise
  cache the calling repository's packages.
- Redaction now covers everything a trace stores, in the process that records it: span
  attributes, event attributes, status messages, error stacks, trace metadata, and evaluation
  reasons and evidence. Before, the SDK and `scope run` redacted only inputs, outputs and error
  messages, so a secret set as an attribute in a `function` step (or quoted by an evaluator) was
  stored as-is; with content capture off, error messages were not redacted at all.
- Sensitive keys also match by their last segments: `openai_api_key`, `db.password` and
  `http.request.header.authorization` are masked, not only exact names like `api_key`.
- Evaluation evidence follows the content policy in `scope run` as it already did on the server:
  with `capture_content: false` it is no longer stored.
- The Markdown report (pull request comment, job summary) renders case ids, evaluation reasons,
  gate messages and workflow names as plain text. Reasons can quote model output or dataset
  text; before, an `@mention` in one pinged that person or team, and Markdown images and links
  rendered in the pull request. Case ids are code spans that backticks cannot end.
- Client instrumentation (unreleased until now) does not trust response numbers: token counts
  must be whole and non-negative (a negative count would have made the server reject the whole
  batch), and an Anthropic stream event with a huge block index no longer blocks the application
  (it made the accumulator walk a sparse array for about a minute).
- OTLP ingestion (unreleased until now) ignores token counts that are not whole, non-negative
  numbers (which gave negative costs), and bounds span status messages, error fields, provider
  and model names as the SDK ingestion schema does. Trace rollups count cache tokens from span
  attributes only when they are such counts.

### Added

- OpenTelemetry ingestion: `POST /v1/traces` accepts OTLP/HTTP (protobuf or JSON, optionally
  gzip), so any OpenTelemetry SDK — and through it the Vercel AI SDK, OpenLLMetry and OpenInference
  instrumentations for LangChain, LlamaIndex and vendor SDKs — can send traces with
  `OTEL_EXPORTER_OTLP_ENDPOINT`. GenAI semantic conventions become model calls with provider,
  model, tokens, estimated cost, prompt and response; spans of one trace may arrive over several
  requests. Tested with the OpenTelemetry JS exporters and the AI SDK's `@ai-sdk/otel`.
- `instrumentOpenAI(client, { tracer })` and `instrumentAnthropic(client, { tracer })` in
  `@scope-ai/sdk`: every chat, Responses, embeddings and messages call — streamed or not, and
  through the SDKs' stream helpers — becomes a model span with request, response, model, tokens,
  estimated cost and finish reason, inside the current trace or as its own. The client's behavior
  is unchanged (`withResponse()`, stream helpers, errors). OpenAI-compatible servers are recorded
  under the provider name you give. Tested against the real `openai` and `@anthropic-ai/sdk`
  packages.
- JUnit XML reports for CI systems other than GitHub: `scope run --junit-file <file>` and
  `scope report --format junit`. Every case is a test case (failed or errored, with reasons and
  the trace), each run's gates a second suite; GitLab, Jenkins, CircleCI and Azure Pipelines show
  them as test results. The CI guide has GitLab, Jenkins, CircleCI and Azure setups.
- Comparisons say what changed in configuration, not only in results: which parameters differ,
  and whether the workflow file or the dataset changed. Baseline files record the parameters and
  workflow hash they came from (a new optional `config` field; older SCOPE versions ignore it),
  so `scope run`, reports, the job summary and pull request comment ("Changed since the baseline:
  sentences 2 → 1 · the workflow file"), the run page and `scope compare` show it; the Compare
  page and `GET /api/v1/comparisons` compare two runs' configuration too.
- `scope export traces` writes traces as JSONL, or as dataset cases (`--format dataset`) —
  from observed traces back to regression tests; `scope export run` writes a run's per-case
  results as CSV (a status and score column per evaluator; cells a spreadsheet would run as
  formulas are escaped) or JSONL.
- [Custom evaluators](docs/guides/custom-evaluators.md): the contract written down — the module,
  its inputs and result, thresholds, failures and versioning — with a runnable example
  ([examples/custom-evaluator](examples/custom-evaluator)).
- [Integrations](docs/integrations.md) and [extensibility](docs/extensibility.md): how traces get
  in from each stack and how well each path is tested, and every extension point with its
  stability.
- Every example runs in CI (`examples/examples.test.ts`) with the commands its README documents.
  New: [instrument-openai](examples/instrument-openai), an OpenAI SDK application traced with one
  line, against OpenAI or a local model through Ollama. The committed example baselines record
  their configuration.
- [Privacy and data](docs/guides/privacy.md): what is stored, what leaves the machine, what is
  redacted where, and how to keep content out.

### Fixed

- On SQLite, OTLP ingestion scanned every span of the project for each request, because span
  queries combining a project condition with a list of trace ids used the wrong index: it fell to
  667 traces/s at 100,000 stored traces. It now stays at about 7,200 traces/s regardless of
  database size. The trace list's model filter and a run's case list had the same query shape
  and are fixed too. `npm run bench` measures OTLP ingestion ([performance](docs/performance.md)).

## [0.2.0] - 2026-09-29

The first published release. Version 0.1.0 was developed in the open but never published, so
these notes cover everything in SCOPE; the Fixed section lists defects found and fixed before
this release.

### Added

- Workflow engine with `llm`, `retrieve`, `transform` and `function` steps, variants, datasets,
  per-step timeouts, cancellation and bounded concurrency.
- Versioned, strict YAML configuration with line/column diagnostics, suggestions and JSON Schema
  for editors.
- Model providers: OpenAI, Anthropic, OpenAI-compatible endpoints, and deterministic offline
  `local:extractive` / `local:echo` models.
- OpenTelemetry-aligned tracing SDK with context propagation and a batching HTTP exporter.
- Evaluators — deterministic: `exact_match`, `contains`, `not_contains`, `regex`, `json`,
  `latency`, `tokens`, `cost`; heuristic: `similarity`, `groundedness`, `unsupported_claims`,
  `relevance`; model-based: `llm_judge`, `embedding_similarity`; custom evaluators from files.
- Run summaries, gates, per-case comparison and committed baselines for regression testing.
- SQLite (default) and PostgreSQL storage with shared migrations.
- `scope` CLI: `init`, `validate`, `run`, `runs`, `traces`, `compare`, `report`,
  `baseline save`, `evaluate`, `doctor`, `version`.
- HTTP API `/api/v1` (`@scope-ai/server`): runs, per-case results, comparisons, traces with
  span offsets, evaluator health, evaluation results, workflows, model usage with the price
  used, project settings and API key metadata; keyset pagination, one error envelope with
  request ids, and an OpenAPI 3.1 document generated from the contract (`@scope-ai/protocol`).
- Trace ingestion (`POST /api/v1/ingest`) for SDKs, with server-side redaction, per-trace span
  limits, rollups recomputed from spans, and idempotent writes.
- `scope ui` (local dashboard server, loopback only, no authentication), `scope server`
  (API-key authentication, JSON logs) and `scope keys create|list|revoke`.
- `/healthz`, `/readyz` and Prometheus `/metrics`; security headers and a strict
  Content-Security-Policy.
- Dashboard (`@scope-ai/web`, served by `scope ui` and `scope server`): Overview (KPIs, traces
  and errors, latency, pass rate by run, recent failures, failing evaluators), Runs with
  two-run selection, Run detail (gates, evaluator breakdown, filterable cases), Compare
  (direction-aware metric deltas and per-case changes), Traces (search, filters, sorting),
  Trace explorer (keyboard-navigable span tree with timing, model calls shown as prompt and
  response, retrievals as ranked documents, evaluations with evidence), Evaluations (evaluator
  health, per-run trends, failing results), Workflows (history, variants, versions, source),
  Models (calls, latency, errors, estimated cost and the price used) and Settings (storage,
  privacy policy, pricing table, API keys, theme).
- Command palette (⌘K), keyboard shortcuts, light and dark themes, API-key sign-in for shared
  servers, and a table view for every chart.
- Playwright end-to-end tests with axe accessibility scans, run in CI against real runs.
- GitHub Action (`integrations/github-action`): runs workflows against committed baselines,
  writes the job summary, annotates failed gates, uploads results, and fails the job on
  regressions; self-tested in CI.
- `scope run --report-file <file>` writes the JSON report while keeping human output; on
  GitHub Actions, failed gates are emitted as error/warning annotations.

- Docker image (`scope server` by default) and a `docker compose up` demo: PostgreSQL, real runs
  of the RAG example, and the dashboard.
- Runnable examples: `examples/rag`, `examples/triage` (function steps, tool calls, structured
  output) and `examples/sdk-tracing`.
- `scope doctor` reports whether the dashboard assets are built.
- User guides (`docs/guides`): quickstart, workflows, evaluators, configuration, tracing, CI,
  self-hosting, CLI and HTTP API; a README with real screenshots and output.

- CI lints GitHub workflow files with actionlint; the GitHub Action's runner has its own test
  suite; the API contract tests also run on PostgreSQL.
- `scope-ai` package: `npm install -g scope-ai` installs the `scope` command (once published).
- Release pipeline ([RELEASING.md](RELEASING.md)): `npm run release:version` sets one version on
  every package; a `v*` tag publishes the npm packages with provenance, a multi-arch image to
  GHCR and a GitHub release with the CHANGELOG section; a manual run is a dry run. Package
  manifests and tarball contents are verified in CI, and the install test now installs
  `scope-ai` and `@scope-ai/sdk` the way users will.
- `scope run` without a path runs every workflow of the project (checked before any runs), with
  a summary table; options that name something inside one workflow require a single workflow.
- `scope validate` checks datasets too (JSON errors with a code frame, missing and mistyped
  inputs, with a "did you mean" for misspelled input names).
- `scope doctor` checks datasets, baselines (missing — noting when regression gates are skipped —
  stale after dataset changes, or belonging to no workflow) and whether git ignores the local
  database. `scope doctor --network` asks each provider in use for its model list (read-only, no
  tokens) to confirm reachability, credentials and model names.
- Trace explorer: step through a run's failing and errored cases with `[` / `]` (or the
  header's arrows, "Failing case 2 of 5"), and filter the span tree by name, kind or model and to
  errors or model calls — matches keep their parent spans for context; filters live in the URL.
  The trace API returns `failingCases` (position, total, previous, next) for run cases.
- Run page: "Compared with baseline" — the metric deltas and changed cases the run's regression
  gates saw, with links to the traces. Stored with the run (`run_comparisons`, migration `0002`,
  applied automatically) because the baseline may come from another machine; served at
  `GET /api/v1/runs/{run}/baseline-comparison`. Runs record their baseline's source run id.
- Compare up to four runs side by side — select them on the Runs page (`/compare?runs=…`) or
  `scope compare 12 13 14`: the parameters that differ, every metric per run with the best
  marked (values within noise tolerance share it), and the cases where the runs disagree, linked
  to their traces. API: `GET /api/v1/comparisons/matrix?runs=`.
- Every titled dashboard panel is a named landmark region for screen readers.
- `npm run bench` and [docs/performance.md](docs/performance.md): measured ingestion, API and
  dashboard timings up to 100,000 traces and 1,000-span traces.
- The GitHub Action's `comment: true` posts the report on the pull request as one comment,
  updated in place on later pushes; without permission (e.g. fork pull requests) it warns instead
  of failing. The token never reaches `scope run`.
- The GitHub Action's `install` input: `auto` installs `scope-ai` from npm at the action's version
  when it is published and builds from source otherwise.

### Security

- `scope ui` rejects requests whose Host is not `localhost`, `127.0.0.1` or `::1`, so a web page
  cannot read local traces by rebinding its domain to the loopback address.

### Fixed

- The GitHub Action reported `result: passed` when a gate failed with `fail-on-gates: false`; the
  result now comes from the run's gate status, not the exit code.
- The Action's self-test workflow was invalid YAML and never ran.
- PostgreSQL installs using a dedicated schema (`search_path`) failed to migrate when another
  schema in the database already had SCOPE's migration tables.
- `scope init <dir>` outside the current directory printed paths like `./../x`; it now prints the
  absolute path.
- Package tarballs included TypeScript's `dist/.tsbuildinfo`.
- `scope report <run>` recomputed the baseline comparison from the file on disk, so a baseline
  saved after the run changed the report; it now shows what the run was compared with.
- The run page labelled a run "(baseline)" by run number, which is wrong when the baseline was
  saved in another database (e.g. CI); it now matches the baseline's run id.

- Run references containing `%` returned 500 (they were URL-decoded twice); they are now 404.
- Derived cache prices in the built-in pricing table are rounded (no `0.30000000000000004`).
- Evaluator templates referring to a declared output by name (`{{ outputs.ticket.intent }}`) failed
  at evaluation time for workflows with a single output, although validation required that form.
- `await tracer.shutdown()` could let the process exit mid-retry when the server was unreachable
  (unsettled top-level await); an awaited flush now keeps the process alive until it finishes.
