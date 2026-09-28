# 0002 — SQLite locally, PostgreSQL for teams, one Kysely implementation

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

SCOPE is local-first: `scope run` on a laptop or CI runner must work with no services
running. A team deployment needs concurrent writers, network access and operational tooling
that SQLite files do not offer.

## Decision

- A single storage implementation built on **Kysely** (a typed SQL query builder with no
  runtime dependencies) targets both **SQLite** and **PostgreSQL**.
- SQLite uses Node's built-in **`node:sqlite`** module through a small adapter to Kysely's
  SQLite dialect. No native addon is compiled or downloaded at install time.
- PostgreSQL uses `pg`.
- One ordered set of migrations, written with Kysely's schema builder, with dialect branches
  only where types differ (`jsonb` vs `text`). Migrations run automatically on startup
  (disable with `SCOPE_AUTO_MIGRATE=false`).
- Storage is selected by URL: `sqlite:.scope/scope.db` (default) or `postgres://…`, from
  `SCOPE_DATABASE_URL` or `storage.url` in `scope.yaml`.
- SQLite runs in WAL mode with a busy timeout so `scope ui` and `scope run` can share a file.

## Consequences

- `npm install` never fails on a missing compiler toolchain, which is the most common install
  failure for CLIs that bundle SQLite natively.
- `node:sqlite` still prints an `ExperimentalWarning` on current Node versions. The adapter
  suppresses exactly that warning (and nothing else) while loading the module. If the API
  changes, the adapter is the only code affected; `better-sqlite3` is the fallback.
- `node:sqlite` is synchronous. That is fine for a single-user local server; shared
  deployments should use PostgreSQL, and the docs say so.
- Every query must be portable. Aggregations use standard SQL; JSON is read and written by
  the application, never queried with dialect-specific JSON operators.
- Both dialects run in CI (PostgreSQL as a service container).

## Alternatives considered

- **PostgreSQL only.** Simplest code, but `scope run` would require Docker or a database
  server — incompatible with local-first and with running in any CI job.
- **SQLite only.** Simplest code, but no path to multi-user deployments.
- **Drizzle ORM.** Good tooling, but schemas and migrations are defined separately per
  dialect, doubling the maintenance for two targets.
- **`better-sqlite3`.** Mature and fast, but a native addon; install failures on new Node
  releases and unusual platforms are common.
- **ClickHouse for traces.** Right for very high volume; unnecessary for the first release. The
  storage interface leaves room for a trace store split later.
