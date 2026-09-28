# SCOPE Development Status

Last updated: 2026-09-28. Keep this file current: it is how the next session knows where to
start. Milestones are defined in [roadmap.md](./roadmap.md).

## Product Vision

SCOPE shows what an AI workflow actually did — every step, model call, token and cost — scores
it with evaluators that state how they judge, and fails CI when quality regresses against a
committed baseline. Local-first (SQLite, offline models), self-hostable (PostgreSQL), open
source (Apache-2.0).

## Completed

- **M1 Foundation** — npm workspaces monorepo, TypeScript 7, Biome, Vitest, CI (lint,
  typecheck, tests on Node 22/24 with PostgreSQL, package smoke test, dependency audit),
  contributor docs, issue/PR templates, ADRs 0001–0011.
- **M2 Core loop** — `core`, `config`, `providers`, `sdk`, `evaluators`, `engine`, `storage`;
  CLI `init`, `validate`, `run`, `runs`, `traces`, `report`, `doctor`, `version`.
- **M3 Comparison & CI (CLI side)** — variants, `compare`, `baseline save`, regression gates,
  markdown reports (`--summary-file` for `$GITHUB_STEP_SUMMARY`), `evaluate` (re-score).
- **M4 Server & API** — `@scope-ai/protocol` (Zod contract, route table, generated OpenAPI
  3.1), `@scope-ai/server` (Hono: read API, ingestion with server-side privacy, API-key auth,
  health/readiness/metrics, security headers, dashboard hosting), CLI `scope ui`,
  `scope server`, `scope keys`. Contract test validates every route's response.

## In Progress

- **M5 Dashboard** (`apps/web`).

## Not Started

- **M3 remainder** — composite GitHub Action (`integrations/github-action`).
- **M6 Distribution** — Dockerfile, `docker compose up` demo, `examples/`, user guides.
- **M7 Review & polish**.
- README.md (missing).

## Current Architecture

See [architecture.md](./architecture.md). Everything under `packages/` and `apps/server` is
implemented and tested.

## Current Milestone

M5 Dashboard.

## Working Commands

```bash
npm ci && npm run check          # lint, typecheck, 228 tests
npm run build && npm run smoke   # build + install packed packages into a temp dir and run
npm run scope -- ui              # local API (+ dashboard once built) on 127.0.0.1:4700
```

## Known Issues

- Server tests run on SQLite only; PostgreSQL coverage of the queries comes from the storage
  tests (`SCOPE_TEST_DATABASE_URL`).
- Links to `docs/guides/*.md`, `docs/design-system.md` and `examples/rag` point to files that
  do not exist yet (M5/M6).
- `npm run clean` references a missing `scripts/clean.mjs`.
- CONTRIBUTING says Node 22.18+, `package.json` engines say >=22.16.0.

## Technical Debt

- API-key authentication does one database lookup per request (no cache). Fine for SQLite and
  small teams; add a short-lived cache if it shows up in latency.

## Next Milestone

M5 Dashboard, then the GitHub Action (M3 remainder), then M6 Distribution.
