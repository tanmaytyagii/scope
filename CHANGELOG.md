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
