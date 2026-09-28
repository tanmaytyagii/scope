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

## Repository map

```text
packages/core        domain model + pure logic (no deps, no I/O)
packages/config      YAML schemas, diagnostics, templating, datasets, baselines
packages/providers   OpenAI, Anthropic, OpenAI-compatible, offline local:* models
packages/sdk         Tracer (AsyncLocalStorage), Memory/Console/Http exporters
packages/evaluators  evaluator framework + built-ins (deterministic / heuristic / model)
packages/engine      workflow execution (llm, retrieve, transform, function steps)
packages/storage     Kysely store: SQLite (node:sqlite) + PostgreSQL, migrations, analytics
packages/protocol    HTTP API contract: Zod schemas, DTO types, OpenAPI document
packages/cli         the `scope` binary (commander)
apps/server          Hono HTTP API + dashboard hosting (`scope ui`, `scope server`)
apps/web             dashboard SPA (React 19, Vite, Tailwind v4, Radix, TanStack Query)
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
npm run smoke                  # pack every package, install into a temp dir, run the CLI
SCOPE_TEST_DATABASE_URL=postgres://… npm test   # also run storage/server tests on PostgreSQL
```

Sources run directly on Node (`--conditions=source`, erasable TS only). Tests live next to
code as `*.test.ts` under `packages/*/src` and `apps/server/src`.

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess`, only erasable syntax (no enums, namespaces,
  parameter properties). Imports use `.ts` extensions; `import type` for types.
- Biome: 2-space indent, single quotes, semicolons, trailing commas, 100 columns.
- Errors users can hit are `ScopeError(code, message, { hint })` from `@scope-ai/core`.
  Messages say what failed; hints say how to fix it. CLI exit codes: 0 ok, 1 gates failed,
  2 usage/config, 3 execution/storage, 130 interrupted.
- Never log prompt/output content — ids, sizes, counts and timings only.
- Only `storage` knows SQL; only `server` knows HTTP; only `cli` knows terminals.
- API: `/api/v1`, camelCase JSON, ISO-8601 timestamps in responses, keyset pagination
  (`limit` ≤ 200, opaque `cursor`, `nextCursor`), one error envelope
  `{ error: { code, message, hint?, details?, requestId } }`. DTOs are explicit mappings.
- Ingestion (`POST /api/v1/ingest`, header `scope-protocol: 1`) accepts the SDK wire format:
  `{ project?, traces: TraceRecord[], spans: SpanRecord[], evaluations: EvaluationRecord[] }`
  with epoch-millisecond numbers.
- Conventional commits with package scopes (`feat(server): …`). No AI co-author trailers.

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
