# Roadmap

SCOPE is built in milestones. Each milestone ends with something a developer can use, tested
and documented. This file is the single place where planned work is listed; nothing on it is
shown in the product until it exists.

## v0.1 — Foundation (current)

Status: M1–M7 are done, and so are the [v0.2](./v0.2-roadmap.md), [v0.3](./v0.3-roadmap.md)
and [v0.4](./v0.4-roadmap.md) upgrades. Next are the post-v0.1 items below that remain open.
Details in [DEVELOPMENT_STATUS.md](./DEVELOPMENT_STATUS.md).

| Milestone | Delivers | Exit criteria |
| --- | --- | --- |
| **M1 Foundation** | Monorepo, tooling (TypeScript 7, Biome, Vitest), CI, contributor docs | `npm ci && npm run check` passes locally and in CI |
| **M2 Core loop** | `core`, `config`, `providers`, `sdk`, `evaluators`, `engine`, `storage`; CLI `init`, `validate`, `run`, `runs`, `traces`, `report`, `doctor`, `version` | `scope init && scope run` executes an offline workflow, stores traces and evaluations in SQLite, prints a summary, and exits with the gate result; unit + integration + CLI tests |
| **M3 Comparison & CI** | Variants, `compare`, `baseline save`, regression gates, markdown reports, `evaluate` (re-score), GitHub Action | A pull request that lowers groundedness fails CI with a readable job summary |
| **M4 Server & API** | `scope ui` / `scope server`, `/api/v1`, ingestion, API keys, health/metrics, OpenAPI, PostgreSQL | API integration tests on SQLite and PostgreSQL; SDK traces from an instrumented app appear via HTTP |
| **M5 Dashboard** | Design system, Overview, Runs, Compare, Traces + explorer, Evaluations, Workflows, Models, Settings, command palette | Playwright flows pass; keyboard-only operation; light and dark themes |
| **M6 Distribution** | Dockerfile, `docker compose up` demo with PostgreSQL, examples, full documentation | A new user goes from clone to populated dashboard with one command |
| **M7 Review & polish** | Product, security, accessibility and performance review; fixes | Review findings addressed or recorded as issues |

## After v0.1

Ordered by expected value to users. Items move up when users ask for them.

1. **Python SDK** — tracer and HTTP exporter speaking the same ingestion protocol.
2. ~~**Client auto-instrumentation** — wrappers for the OpenAI and Anthropic SDKs that record
   model spans with no manual code~~ — done in 0.3 for TypeScript (`instrumentOpenAI`,
   `instrumentAnthropic`); Python comes with the Python SDK.
3. **Published packages and action release** — the release workflow is in place (0.2:
   `scope-ai` and `@scope-ai/*` on npm with provenance, the image on GHCR, tagged action
   releases); what remains is the first published release.
4. ~~**OTLP/HTTP ingestion** — accept OpenTelemetry GenAI spans directly~~ — done in 0.3
   (`POST /v1/traces`, protobuf and JSON; see [integrations](./integrations.md)).
5. **Server-side baselines** — "compare with the latest run on `main`" as an alternative to
   committed baseline files.
6. ~~**Pull-request comments** from the GitHub Action, updated in place~~ — done in 0.2
   (`comment: true`).
7. ~~**Retention** — `scope prune` and server-side retention policies~~ — done in 0.4
   (`scope prune`, `scope server --retention`).
8. **Dataset tooling** — promote traces to dataset cases from the dashboard; CSV datasets. (0.3
   added the command-line half: `scope export traces --format dataset`.)
9. **More evaluators** — tool-call correctness, citation verification, NLI-based
   groundedness (model), refusal detection.
10. **Accounts** — users, organizations, SSO and role-based access for shared servers.
11. **Online evaluation** — sampled evaluation of production traffic with alerting.
12. **Rollups at scale** — pre-aggregated time buckets for the dashboard's overview, evaluator
    and model views, once deployments outgrow window scans. 0.4's covering indexes made these
    scans index-only, but they still read every trace in the window: 0.3 s for 500,000 traces,
    3–4 s for 1,000,000 on SQLite when the indexes do not fit in memory
    ([performance](./performance.md)). Also batching the per-trace updates of OTLP ingestion,
    which make it round-trip bound on PostgreSQL.

## How to influence the roadmap

Open a feature request or evaluator request issue describing the problem you have, not only
the feature you want. Upvote existing issues with a 👍 reaction.
