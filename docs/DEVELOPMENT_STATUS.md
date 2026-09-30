# SCOPE Development Status

Last updated: 2026-09-30. Keep this file current: it is how the next session knows where to
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

- **v0.3 Ecosystem and adoption** — see [v0.3-roadmap.md](./v0.3-roadmap.md) for the audit, each
  item's outcome and how it was verified. In short: OpenTelemetry ingestion (`POST /v1/traces`,
  protobuf and JSON, GenAI/OpenLLMetry/OpenInference/Vercel AI SDK mapping, traces assembled
  across requests); one-line OpenAI and Anthropic client instrumentation (`@scope-ai/sdk`);
  redaction of everything a trace stores; JUnit reports for other CI systems; comparisons that
  say what changed in configuration (baseline `config`); `scope export` (traces as JSONL or
  dataset cases, run results as CSV or JSONL); the custom evaluator contract; every example run
  in CI; actions pinned to SHAs on Node.js 24 with Dependabot; an OTLP benchmark that found and
  fixed a whole-project span scan; a security review of the new inputs (Markdown escaping in PR
  comments, untrusted response numbers); guides organized by task;
  [integrations](./integrations.md) and [extensibility](./extensibility.md).

- **v0.4 Production adoption** — see [v0.4-roadmap.md](./v0.4-roadmap.md) for the audit, what
  each item delivered and how it was verified. In short: the SDK no longer loses whole batches
  and records streams returned to web frameworks; large traces load with a content budget;
  retention (`scope prune`, `SCOPE_RETENTION`); `scope db status | migrate | backup`; a
  production Compose deployment with HTTPS, verified by hand (including an upgrade from 0.3.0)
  and in CI; run manifests (versions, file fingerprints, models called) and comparisons that name
  changed files; covering indexes for the dashboard's window queries; query-plan tests on SQLite
  and PostgreSQL, a size-independence benchmark in CI and an isolation test over every route;
  benchmarks at up to 1,000,000 traces (SQLite) and 500,000 (PostgreSQL); OpenInference and
  OpenLLMetry tested with their real packages; the trace contract; price freshness; the CLI's
  `--json` contract; refusal of databases migrated by a newer SCOPE; operations and security
  documentation.

## In Progress

- Nothing half-done.

## Not Started

- A release on npm: `v0.3.0` was tagged and its release workflow verified the packages, but
  publishing to npm failed (most likely the one-time npm setup in
  [RELEASING.md](../RELEASING.md)), so no GitHub release was created either. The packages are at
  0.3.0; v0.4's changes are under "Unreleased" in the CHANGELOG. The maintainer fixes the npm
  setup, then runs `npm run release:version -- 0.4.0` and pushes the tag.
- Roadmap items, in order: Python SDK, server-side baselines, dataset tooling in the dashboard,
  more evaluators, accounts, online evaluation, rollups at scale.

## Current Architecture

See [architecture.md](./architecture.md). All packages and apps are implemented and tested;
`packages/scope-ai` is the installable wrapper around the CLI.

## Current Milestone

v0.4 is complete (see [v0.4-roadmap.md](./v0.4-roadmap.md) for each item's outcome, the scale
measurements and the security review). Validated on 2026-09-30: clean `npm ci` (0
vulnerabilities), lint, typecheck, 399 tests on SQLite and 422 with PostgreSQL, build, 12
packages verified, the install smoke test, 35 end-to-end tests with accessibility checks,
`bench:check`, actionlint, the Docker image and the compose deployment with HTTPS, and the scale
benchmarks in [performance.md](./performance.md). Next: the maintainer fixes the npm setup
(RELEASING.md), releases 0.4.0 with `npm run release:version -- 0.4.0` and its tag, and enables
the repository's dependency graph for the *Dependency audit* check.

## Working Commands

```bash
npm ci && npm run check          # lint, typecheck (incl. dashboard + e2e), 399 tests (422 with PostgreSQL)
npm run build                    # packages (tsc -b) + dashboard (vite)
npm run release:verify           # package manifests and tarball contents (after a build)
npm run smoke                    # pack all packages, npm install scope-ai from them: init, run, ui
npx playwright install chromium  # once
npm run test:e2e                 # dashboard E2E, 35 tests (needs the dashboard built)
npm run bench -- --traces 100000 # ingestion, API, OTLP, retention, size (docs/performance.md)
npm run bench:check              # CI's check: timings at 2,000 vs 50,000 traces
node scripts/screenshots.mjs     # regenerate docs/images from real runs
npm run scope -- ui              # local dashboard on 127.0.0.1:4700 (from sources)
npm run dev:web                  # dashboard dev server, proxies /api to scope ui
docker compose up                # demo: PostgreSQL + seeded runs + dashboard on 127.0.0.1:4700
cd deploy && docker compose up -d   # production-style: scope server + PostgreSQL (+ Caddy)
SCOPE_TEST_DATABASE_URL=postgres://scope:scope@127.0.0.1:55432/scope_test npm test  # + PostgreSQL (422 tests)
```

## Known Issues

- E2E tests run on SQLite only; storage and server API tests also run on PostgreSQL when
  `SCOPE_TEST_DATABASE_URL` is set (CI sets it).
- Migrations only go forward. 0.4 refuses a database a newer SCOPE migrated; 0.3 and earlier
  refuse only when they migrate, so with `SCOPE_AUTO_MIGRATE=false` they would open one
  (docs/guides/operations.md). Restoring the backup taken before an upgrade is the way back.
- On SQLite, dashboard aggregates over a window holding around a million traces take 3–4 s when
  their indexes do not fit in memory; the first `scope prune` on a large database takes seconds
  ([performance.md](./performance.md)).
- OpenInference's and OpenLLMetry's OpenAI instrumentations send no token counts for streamed
  calls and no span for failed calls (openai 7.25); tests pin this down and the trace contract
  documents it.
- On GitHub, Dependabot pull requests fail the *Dependency audit* job until the maintainer enables
  the repository's dependency graph (a repository setting).
- Overview time buckets are aligned to UTC, so in non-whole-hour time zones (e.g. UTC+5:30)
  bucket boundaries fall at :30 local time. Correct, but slightly odd-looking.

## Technical Debt

- API-key authentication does one database lookup per request (no cache).
- The dashboard initial bundle is ~160 KB gzipped (React, React Router, TanStack Query);
  pages load on demand.
- Time-window aggregates (overview, evaluators, models) read every trace in their window from a
  covering index: 0.3 s at 500,000 traces, seconds at 1,000,000 on SQLite
  ([performance.md](./performance.md)); rollups are on the roadmap.
- OTLP ingestion updates each trace's totals with its own statement (100 per 100-trace request),
  which makes it round-trip bound on PostgreSQL (404–878 traces/s from one sender).
- OTLP: gzip bodies are decompressed synchronously (bounded at 20 MiB), and a trace arriving in
  many pieces is recomputed from all its stored spans for each piece (a few ms per piece at the
  1,000-span limit).
- The span tree is not virtualized; fine at the 1,000-span limit.

## Next Milestone

The first published release (maintainer action), then the Python SDK. Python applications can
already send traces through OpenTelemetry (`/v1/traces`); a native SDK would add SCOPE's own
evaluations and `scope run` parity.
