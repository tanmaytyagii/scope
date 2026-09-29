# Changelog

All notable changes to SCOPE are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may contain breaking changes,
which are always called out).

## [Unreleased]

### Changed

- The export condition SCOPE's packages use for their TypeScript sources during development is
  now `scope-source` (was `source`). Third-party packages that publish a `source` condition broke
  tests and `npm run scope`. Only affects working on SCOPE itself.

### Security

- Redaction now covers everything a trace stores, in the process that records it: span
  attributes, event attributes, status messages, error stacks, trace metadata, and evaluation
  reasons and evidence. Before, the SDK and `scope run` redacted only inputs, outputs and error
  messages, so a secret set as an attribute in a `function` step (or quoted by an evaluator) was
  stored as-is; with content capture off, error messages were not redacted at all.
- Sensitive keys also match by their last segments: `openai_api_key`, `db.password` and
  `http.request.header.authorization` are masked, not only exact names like `api_key`.
- Evaluation evidence follows the content policy in `scope run` as it already did on the server:
  with `capture_content: false` it is no longer stored.

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
- [Privacy and data](docs/guides/privacy.md): what is stored, what leaves the machine, what is
  redacted where, and how to keep content out.

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
