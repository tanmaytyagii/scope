# SCOPE Development Status

Last updated: 2026-09-28. Keep this file current: it is how the next session knows where to
start. Milestones are defined in [roadmap.md](./roadmap.md).

## Product Vision

SCOPE shows what an AI workflow actually did — every step, model call, token and cost — scores
it with evaluators that state how they judge, and fails CI when quality regresses against a
committed baseline. Local-first (SQLite, offline models), self-hostable (PostgreSQL), open
source (Apache-2.0).

## Completed

- **M1 Foundation** — npm workspaces monorepo, TypeScript 7, Biome, Vitest, CI, contributor
  docs, issue/PR templates, ADRs 0001–0011.
- **M2 Core loop** — `core`, `config`, `providers`, `sdk`, `evaluators`, `engine`, `storage`;
  CLI `init`, `validate`, `run`, `runs`, `traces`, `report`, `doctor`, `version`.
- **M3 Comparison & CI (CLI side)** — variants, `compare`, `baseline save`, regression gates,
  markdown reports (`--summary-file`), `evaluate` (re-score).
- **M4 Server & API** — `@scope-ai/protocol` (Zod contract, route table, generated OpenAPI
  3.1), `@scope-ai/server` (Hono: read API, ingestion with server-side privacy, API-key auth,
  health/readiness/metrics, CSP, dashboard hosting), CLI `scope ui`, `scope server`,
  `scope keys`. A contract test validates every route's response against its schema.
- **M5 Dashboard** — `@scope-ai/web` (React 19, Vite 8, Tailwind v4, Radix, cmdk, TanStack
  Query, react-router 8): all pages in architecture.md §11, command palette, shortcuts, themes,
  API-key sign-in, hand-written charts with table twins. Design system in
  [design-system.md](./design-system.md). Playwright E2E (journeys, keyboard, axe WCAG A/AA in
  both themes) against CLI-seeded data; CI job `e2e`.

## In Progress

- Nothing half-done. Next up is the GitHub Action.

## Not Started

- **M3 remainder** — composite GitHub Action (`integrations/github-action`).
- **M6 Distribution** — Dockerfile, `docker compose up` demo, `examples/`, user guides
  (`docs/guides/*.md` are linked from `scope init` output and CONTRIBUTING but do not exist).
- **M7 Review & polish**.
- README.md (missing).

## Current Architecture

See [architecture.md](./architecture.md). All packages and apps are implemented and tested.

## Current Milestone

M3 remainder (GitHub Action), then M6 (distribution, docs, examples, README).

## Working Commands

```bash
npm ci && npm run check          # lint, typecheck (incl. dashboard + e2e), 243 tests
npm run build                    # packages (tsc -b) + dashboard (vite)
npm run smoke                    # pack all packages, install in a temp dir: init, run, ui
npx playwright install chromium  # once
npm run test:e2e                 # dashboard E2E (needs the dashboard built)
npm run scope -- ui              # local dashboard on 127.0.0.1:4700 (from sources)
npm run dev:web                  # dashboard dev server, proxies /api to scope ui
```

## Known Issues

- Server and E2E tests run on SQLite only; PostgreSQL coverage of queries comes from the
  storage tests (`SCOPE_TEST_DATABASE_URL`).
- Overview time buckets are aligned to UTC, so in non-whole-hour time zones (e.g. UTC+5:30)
  bucket boundaries fall at :30 local time. Correct, but slightly odd-looking.
- `scope init` output links to `docs/guides/*.md` (M6).

## Technical Debt

- API-key authentication does one database lookup per request (no cache).
- The dashboard initial bundle is ~160 KB gzipped (React, React Router, TanStack Query);
  pages load on demand.

## Next Milestone

GitHub Action (composite, `integrations/github-action`), then M6 Distribution.
