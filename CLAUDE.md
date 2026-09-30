# CLAUDE.md — engineering memory for SCOPE

SCOPE — "See what your AI actually does." Open-source, local-first tracing, evaluation and
regression testing for AI workflows. This file is the persistent memory for coding sessions.
**The repository is the source of truth**: read `docs/DEVELOPMENT_STATUS.md` first, then the
code. Update both files when architecture or milestone state changes.

## Read before changing things

| Document | What it holds |
| --- | --- |
| `docs/DEVELOPMENT_STATUS.md` | What is done, in progress, broken; the current and next milestone |
| `docs/product.md` | Vocabulary (project, workflow, run, trace, span, evaluator, gate, baseline), scope of v0.1 |
| `docs/architecture.md` | Package boundaries, data model, API, dashboard routes, CLI, limits |
| `docs/decisions/` | ADRs. Do not silently contradict one; write a superseding ADR instead |
| `docs/roadmap.md` | Milestones M1–M7 and post-v0.1 work. Planned work lives here, never in the UI |
| `docs/integrations.md` | How traces get in from each stack, and how each path is tested. Claim nothing untested |
| `docs/extensibility.md` | Extension points (evaluators, steps, providers, exporters, APIs) and their stability |
| `docs/v0.4-roadmap.md` | The latest audit, scope and outcome (v0.2 and v0.3 have their own) |
| `docs/guides/operations.md` | Deployment, monitoring, migrations between versions, backups, retention, keys |
| `docs/performance.md` | Measured timings and how to reproduce them (`npm run bench`) |
| `RELEASING.md` | Versioning, the release workflow, what only the maintainer can do |

## Repository map

```text
packages/core        domain model + pure logic (no deps, no I/O)
packages/config      YAML schemas, diagnostics, templating, datasets, baselines
packages/providers   OpenAI, Anthropic, OpenAI-compatible, offline local:* models
packages/sdk         Tracer (AsyncLocalStorage), exporters, OpenAI/Anthropic client instrumentation
packages/evaluators  evaluator framework + built-ins (deterministic / heuristic / model)
packages/engine      workflow execution (llm, retrieve, transform, function steps)
packages/storage     Kysely store: SQLite (node:sqlite) + PostgreSQL, migrations, analytics
packages/protocol    HTTP API contract: Zod schemas, DTO types, OpenAPI document
packages/cli         the `scope` binary (commander)
packages/scope-ai    `npm install -g scope-ai`: re-exports the CLI's bin
apps/server          Hono HTTP API, OTLP ingestion (`src/otlp/`), dashboard hosting
apps/web             dashboard SPA (React 19, Vite, Tailwind v4, Radix, TanStack Query)
integrations/        GitHub Action (composite; self-tested in CI)
examples/            runnable examples; examples/examples.test.ts runs each as its README says
deploy/              production-style Docker Compose (scope server, PostgreSQL, optional Caddy)
```

Dependency direction: `cli → server → storage, protocol → core`; `cli → engine → {evaluators,
providers, sdk, config} → core`; `web → protocol` (types only). `core` depends on nothing.

## Commands

```bash
npm ci                         # install
npm run check                  # lint + typecheck + tests (what CI runs first)
npm run lint | npm run format  # Biome check / fix
npm run typecheck              # tsc -b tsconfig.json (source condition, no emit)
npm test                       # vitest run (unit + integration + CLI)
npm run build                  # tsc -b tsconfig.build.json + dashboard build
npm run scope -- <args>        # run the CLI from TypeScript sources (no build needed)
npm run smoke                  # pack every package, npm install scope-ai from them: init, run, ui
npm run release:verify         # package manifests + tarball contents (after a build)
npm run release:version -- X.Y.Z   # lockstep version bump (see RELEASING.md; never ad hoc)
npm run test:e2e               # Playwright + axe against CLI-seeded data (build web first)
npm run bench -- --traces N    # ingestion and API timings on a temporary database (docs/performance.md)
npm run bench:check            # CI's performance check: timings at 2,000 vs 50,000 traces
npm run dev:web                # dashboard dev server, proxies /api to a running scope ui
SCOPE_TEST_DATABASE_URL=postgres://… npm test   # also run storage/server tests on PostgreSQL
```

To look at the dashboard: `npm run build -w @scope-ai/web`, then `npm run scope -- ui` in a
project (e.g. one made with `scope init`). Screenshot pages with Playwright to review design.

Sources run directly on Node (`--conditions=scope-source`, erasable TS only; the condition is not
`source` because third-party packages publish that one). Tests live next to code as `*.test.ts`
under `packages/*/src` and `apps/server/src`, plus `examples/` and `integrations/`.
`npm run bench` measures ingestion (SDK and OTLP) and API timings (`--database postgres://…`
for PostgreSQL); record results in `docs/performance.md`. `deploy/compose.yaml` is the
production-style deployment; CI brings it up.

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess`, only erasable syntax (no enums, namespaces,
  parameter properties). Imports use `.ts` extensions; `import type` for types.
- Biome: 2-space indent, single quotes, semicolons, trailing commas, 100 columns.
- Errors users can hit are `ScopeError(code, message, { hint })` from `@scope-ai/core`.
  Messages say what failed; hints say how to fix it. CLI exit codes: 0 ok, 1 gates failed,
  2 usage/config, 3 execution/storage, 130 interrupted.
- Never log prompt/output content — ids, sizes, counts and timings only.
- Only `storage` knows SQL; only `server` knows HTTP; only `cli` knows terminals.
- Migrations are append-only (`packages/storage/src/migrations.ts`), tested for upgrades from the
  previous schema; update the version table in `docs/guides/operations.md` with each one. Large
  per-run JSON goes in its own table (`run_comparisons`), because run queries `selectAll()` and
  run lists must stay small; the run manifest (a few KB) lives on the run.
- API: `/api/v1`, camelCase JSON, ISO-8601 timestamps in responses, keyset pagination
  (`limit` ≤ 200, opaque `cursor`, `nextCursor`), one error envelope
  `{ error: { code, message, hint?, details?, requestId } }`. DTOs are explicit mappings.
- Ingestion (`POST /api/v1/ingest`, header `scope-protocol: 1`) accepts the SDK wire format:
  `{ project?, traces: TraceRecord[], spans: SpanRecord[], evaluations: EvaluationRecord[] }`
  with epoch-millisecond numbers. `POST /v1/traces` accepts OTLP/HTTP (protobuf or JSON, gzip);
  spans of one trace may arrive over many requests, so storage recomputes touched traces from
  all their stored spans (`ingestSpans`). Both paths redact with the server's policy.
- Spans and evaluations are selected by trace id (or run id), without `project_id` conditions next
  to them: with one, SQLite may pick a project index and walk the whole project. The query-plan
  test (`packages/storage/src/query-plans.test.ts`) fails on such plans — run it after changing
  a query or an index. Dashboard time-window aggregates read covering indexes (migration 0004).
- Runs record a manifest (`runManifest` in the engine): versions, fingerprints of the files the
  workflow names, evaluator identities, models called. Baselines keep the fingerprints, so
  comparisons name changed files. Deleting data goes through `store.prune` (batched, indexed
  cascades); nothing else deletes.
- Treat model output, provider responses and ingested attributes as untrusted: validate numbers
  (token counts are non-negative integers), bound sizes, and render text in Markdown reports
  with `mdText`/`mdCode` (no mentions, links or images in pull requests).
- Dashboard (`apps/web`): tokens in `src/styles.css` (light-dark(), no raw hex in components),
  primitives in `src/ui/`, charts in `src/charts/` (every chart has a table twin), filters in
  the URL (`useUrlState`), types only from `@scope-ai/protocol`, formatting from
  `@scope-ai/core`. Rules: `docs/design-system.md`.
- Conventional commits with package scopes (`feat(server): …`). No AI co-author trailers.
- Versions: every package has the same version and pins internal dependencies exactly; only
  `npm run release:version` changes them. Tests use `SCOPE_VERSION`, never a literal version.
  Publishing happens only in `.github/workflows/release.yml` from a tag (RELEASING.md).

## Product rules (non-negotiable)

- No fake features, data, metrics or "coming soon" UI. Planned work goes in `docs/roadmap.md`.
- Every evaluator declares its kind; heuristic scores are signals, model scores are opinions.
- Costs are "estimated" and unknown prices show as unknown, never `$0`.
- `local:*` models are deterministic stand-ins, labelled as such wherever they appear.
- Privacy: redaction before storage (SDK/engine and again on server ingest), bounded payloads,
  `capture_content: false` supported everywhere.
- Every chart answers an engineering question and has a text/table equivalent.
- Accessibility: keyboard operable, visible focus, semantic HTML, contrast in both themes.

## Security notes

- Secrets only from env vars / `${env:NAME}`; never stored, logged or written to reports.
- API keys: `scope_…`, SHA-256 hashed, shown once, scoped to one project (`ingest`, `read`).
- `scope ui` binds 127.0.0.1 with no auth and refuses non-loopback hosts unless
  `--insecure-no-auth`. `scope server` requires API keys.
- `function` steps and custom evaluators run project code with CLI privileges (test-runner
  trust model). Never load code from datasets or remote sources.
