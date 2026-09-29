# 0001 — TypeScript monorepo on npm workspaces

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

SCOPE has a CLI, an SDK, an evaluation engine, a storage layer, an HTTP server and a web
dashboard. They share a domain model (traces, spans, evaluations, run summaries) and an API
contract. Most of SCOPE's users write Python; a large and growing share write TypeScript.

## Decision

- One repository, one language: **TypeScript** for every package, with strict compiler
  settings (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
  `erasableSyntaxOnly`). Only erasable syntax is allowed, so Node can run the sources directly.
- **npm workspaces** for package management. No additional package manager or task runner.
- Packages compile with `tsc -b` (TypeScript 7, project references) to `dist/`. During
  development, packages resolve to their TypeScript sources through a `scope-source` export
  condition, so tests and the CLI run without a build step. (It was named `source` until v0.3;
  some third-party packages publish a `source` condition pointing at TypeScript files in
  `node_modules`, which Node refuses to run, so the name is SCOPE's own.)
- **Biome** for formatting and linting (one tool, one config).
- **Vitest** for unit and integration tests; **Playwright** for end-to-end tests.
- Node.js `>= 22.16` (active LTS lines at the time of writing) — required for `node:sqlite`
  (see ADR 0002).

## Consequences

- The domain model, run summaries, gates and comparisons are written once and used by the CLI,
  the server and (through the API contract) the dashboard.
- The CLI ships through npm (`npx @scope-ai/cli`), which every JavaScript developer already has.
- Python users are served by the language-neutral ingestion API first; a Python SDK is the
  first roadmap item. The ingestion format is the contract that SDK will target.
- npm workspaces hoist dependencies, which can hide undeclared dependencies. CI packs the CLI
  and runs it from a clean directory to catch this.

## Alternatives considered

- **Python for engine and CLI, TypeScript for web.** Closer to most users, but splits the
  domain model across two languages and requires shipping a Python runtime for the dashboard
  server. Revisit if a Python-first contributor base emerges.
- **pnpm or Bun.** Stricter/faster, but an extra tool for every contributor to install. The
  repository is small enough that npm workspaces are sufficient.
- **ESLint + Prettier.** More rules available, two tools and considerably more configuration.
  Biome covers the rules we rely on.
