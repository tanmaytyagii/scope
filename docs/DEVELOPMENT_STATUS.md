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
- **M3 Comparison & CI** — variants, `compare`, `baseline save`, regression gates, markdown
  reports (`--summary-file`), JSON reports (`--report-file`), gate annotations on GitHub,
  `evaluate` (re-score), and the composite GitHub Action (`integrations/github-action`,
  self-tested by `.github/workflows/action.yml`).
- **M4 Server & API** — `@scope-ai/protocol` (Zod contract, route table, generated OpenAPI
  3.1), `@scope-ai/server` (Hono: read API, ingestion with server-side privacy, API-key auth,
  health/readiness/metrics, CSP, dashboard hosting), CLI `scope ui`, `scope server`,
  `scope keys`. A contract test validates every route's response against its schema.
- **M5 Dashboard** — `@scope-ai/web` (React 19, Vite 8, Tailwind v4, Radix, cmdk, TanStack
  Query, react-router 8): all pages in architecture.md §11, command palette, shortcuts, themes,
  API-key sign-in, hand-written charts with table twins. Design system in
  [design-system.md](./design-system.md). Playwright E2E (journeys, keyboard, axe WCAG A/AA in
  both themes) against CLI-seeded data; CI job `e2e`.
- **M6 Distribution** — README with real screenshots, `docs/guides/` (quickstart, workflows,
  evaluators, configuration, tracing, CI, self-hosting, CLI, API — every example validated or
  run), runnable `examples/` (rag, triage, sdk-tracing), Dockerfile (installs packed packages)
  and `compose.yaml` demo on PostgreSQL; CI job `docker`.

## In Progress

- Nothing half-done.

## Not Started

- **M7 Review & polish** — product, security, accessibility and performance review.
- Post-v0.1 roadmap items (npm publishing first).

## Current Architecture

See [architecture.md](./architecture.md). All packages and apps are implemented and tested.

## Current Milestone

M7 Review & polish.

## Working Commands

```bash
npm ci && npm run check          # lint, typecheck (incl. dashboard + e2e), 244 tests
npm run build                    # packages (tsc -b) + dashboard (vite)
npm run smoke                    # pack all packages, install in a temp dir: init, run, ui
npx playwright install chromium  # once
npm run test:e2e                 # dashboard E2E (needs the dashboard built)
npm run scope -- ui              # local dashboard on 127.0.0.1:4700 (from sources)
npm run dev:web                  # dashboard dev server, proxies /api to scope ui
docker compose up                # demo: PostgreSQL + seeded runs + dashboard on 127.0.0.1:4700
SCOPE_TEST_DATABASE_URL=postgres://scope:scope@127.0.0.1:55432/scope_test npm test  # + PostgreSQL suite
```

## Known Issues

- Server and E2E tests run on SQLite only; PostgreSQL coverage of queries comes from the
  storage tests (`SCOPE_TEST_DATABASE_URL`).
- Overview time buckets are aligned to UTC, so in non-whole-hour time zones (e.g. UTC+5:30)
  bucket boundaries fall at :30 local time. Correct, but slightly odd-looking.

## Technical Debt

- API-key authentication does one database lookup per request (no cache).
- The dashboard initial bundle is ~160 KB gzipped (React, React Router, TanStack Query);
  pages load on demand.

## Next Milestone

After M7: publish `@scope-ai/*` to npm and tag action releases (roadmap item 1 after v0.1).
