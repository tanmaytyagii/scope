# SCOPE Development Status

Last updated: 2026-09-29. Keep this file current: it is how the next session knows where to
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

- **M7 Review & polish** — security (DNS-rebinding defense for `scope ui`, CSRF analysis of
  ingestion), correctness (double URL-decoding of run references), performance (20k traces:
  ingestion ~10k traces/s, slowest endpoint ~60 ms on SQLite), accessibility (axe clean in both
  themes), docs/examples verified against the running product, DX (`scope doctor` reports the
  dashboard build).

- **v0.2 Product upgrade** — see [v0.2-roadmap.md](./v0.2-roadmap.md) for the audit and every
  item's outcome. In short: CI and Action reliability (actionlint, runner tests, API tests on
  PostgreSQL, three real bugs fixed); distribution (`scope-ai`, lockstep versions, package
  verification, tag-driven release workflow with npm provenance and a GHCR image, `RELEASING.md`);
  `scope run` without a path; dataset validation and a deeper `scope doctor` (`--network`);
  failing-case navigation and span filters in the trace explorer; the baseline comparison on the
  run page (stored per run, migration 0002); up to four runs side by side; pull-request comments
  from the Action; measured performance ([performance.md](./performance.md)); refreshed README,
  screenshots and guides.

## In Progress

- Nothing half-done.

## Not Started

- The first published release: 0.2.0 is prepared, but publishing needs the maintainer's npm
  organization and token (one-time setup in [RELEASING.md](../RELEASING.md)), then a `v0.2.0` tag.
- Roadmap items, in order: Python SDK, OpenAI/Anthropic client auto-instrumentation, OTLP
  ingestion, server-side baselines, retention (`scope prune`), dataset tooling, more evaluators,
  accounts, online evaluation, rollups at scale.

## Current Architecture

See [architecture.md](./architecture.md). All packages and apps are implemented and tested;
`packages/scope-ai` is the installable wrapper around the CLI.

## Current Milestone

v0.2 is complete and 0.2.0 is prepared (CHANGELOG section, versions). Next: the maintainer sets
up npm (RELEASING.md) and pushes the `v0.2.0` tag, which publishes.

## Working Commands

```bash
npm ci && npm run check          # lint, typecheck (incl. dashboard + e2e), 277 tests (+4 on PostgreSQL)
npm run build                    # packages (tsc -b) + dashboard (vite)
npm run release:verify           # package manifests and tarball contents (after a build)
npm run smoke                    # pack all packages, npm install scope-ai from them: init, run, ui
npx playwright install chromium  # once
npm run test:e2e                 # dashboard E2E, 34 tests (needs the dashboard built)
npm run bench -- --traces 100000 # ingestion and API timings (docs/performance.md)
node scripts/screenshots.mjs     # regenerate docs/images from real runs
npm run scope -- ui              # local dashboard on 127.0.0.1:4700 (from sources)
npm run dev:web                  # dashboard dev server, proxies /api to scope ui
docker compose up                # demo: PostgreSQL + seeded runs + dashboard on 127.0.0.1:4700
SCOPE_TEST_DATABASE_URL=postgres://scope:scope@127.0.0.1:55432/scope_test npm test  # + PostgreSQL suite
```

## Known Issues

- E2E tests run on SQLite only; storage and server API tests also run on PostgreSQL when
  `SCOPE_TEST_DATABASE_URL` is set (CI sets it).
- A database migrated by 0.2 (migration 0002) cannot be opened by 0.1 with auto-migration.
- Overview time buckets are aligned to UTC, so in non-whole-hour time zones (e.g. UTC+5:30)
  bucket boundaries fall at :30 local time. Correct, but slightly odd-looking.

## Technical Debt

- API-key authentication does one database lookup per request (no cache).
- The dashboard initial bundle is ~160 KB gzipped (React, React Router, TanStack Query);
  pages load on demand.
- Time-window aggregates (overview, evaluators, models) scan their window: ~260 ms at 100,000
  traces on SQLite ([performance.md](./performance.md)); rollups are on the roadmap.
- The span tree is not virtualized; fine at the 1,000-span limit.

## Next Milestone

The first published release (maintainer action), then the Python SDK speaking the ingestion
protocol (docs/guides/api.md#ingestion).
