# Architecture Decision Records

Each record captures one decision that had credible alternatives: the context, what was
decided, and the consequences we accepted. Records are immutable once accepted; a changed
decision gets a new record that supersedes the old one.

| # | Decision | Status |
| --- | --- | --- |
| [0001](./0001-typescript-monorepo.md) | TypeScript monorepo on npm workspaces | Accepted |
| [0002](./0002-storage-sqlite-and-postgres.md) | SQLite locally, PostgreSQL for teams, one Kysely implementation | Accepted |
| [0003](./0003-opentelemetry-aligned-trace-model.md) | OpenTelemetry-aligned trace model | Accepted |
| [0004](./0004-workflow-configuration-format.md) | Versioned, strict YAML workflow format | Accepted |
| [0005](./0005-evaluator-taxonomy.md) | Evaluators declare deterministic, heuristic or model kind | Accepted |
| [0006](./0006-committed-baselines.md) | CI regression gates compare against committed baseline files | Accepted |
| [0007](./0007-offline-local-models.md) | Deterministic offline `local:*` models for demos and tests | Accepted |
| [0008](./0008-http-api-conventions.md) | HTTP API: Hono, `/api/v1`, Zod contract, keyset pagination | Accepted |
| [0009](./0009-dashboard-stack.md) | Dashboard: React, Vite, Tailwind, Radix, hand-written charts | Accepted |
| [0010](./0010-privacy-defaults.md) | Privacy defaults: redaction, bounded payloads, optional content capture | Accepted |
| [0011](./0011-license.md) | Apache-2.0 license | Accepted |

Template: copy [0000-template.md](./0000-template.md).
