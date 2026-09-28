# Changelog

All notable changes to SCOPE are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may contain breaking changes,
which are always called out).

## [Unreleased]

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

### Fixed

- Derived cache prices in the built-in pricing table are rounded (no `0.30000000000000004`).
