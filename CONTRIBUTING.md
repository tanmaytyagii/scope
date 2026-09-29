# Contributing to SCOPE

Thank you for helping. SCOPE is built to be dependable developer infrastructure, so we care
about correctness, clear errors and honest measurements as much as about features. This guide
covers everything you need to make a change and get it merged.

## Ground rules

- **Open an issue first for anything non-trivial.** A short discussion saves rework. Bug fixes
  and documentation improvements can go straight to a pull request.
- **Tests are part of the change.** New behaviour comes with tests; bug fixes come with a test
  that fails without the fix.
- **No fake features.** Nothing in the product may imply functionality that does not exist.
  Planned work goes on the [roadmap](docs/roadmap.md), not into the UI.
- **Be honest about evaluators.** Every evaluator declares whether it is deterministic,
  heuristic or model-based, and documents how it can be wrong.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Requirements: **Node.js 22.18+** (24 recommended; see `.nvmrc`) and npm. Contributors need 22.18
because the CLI and tests run TypeScript sources directly (Node's type stripping); installed
packages run compiled JavaScript and work from 22.16. Docker is optional (for PostgreSQL tests
and the demo).

```bash
git clone https://github.com/tanmaytyagii/scope.git
cd scope
npm ci
npm run check        # lint + typecheck + all tests
```

Run the CLI from source — no build step needed:

```bash
npm run scope -- --help
npm run scope -- run workflows/support.yaml --cwd examples/rag
```

Packages resolve to their TypeScript sources through the `scope-source` export condition, so
edits are picked up immediately by the CLI, the server and the tests.

### Useful commands

| Command | What it does |
| --- | --- |
| `npm run check` | Biome lint + TypeScript + Vitest (what CI runs first) |
| `npm run lint` / `npm run format` | Check / fix formatting and lint rules |
| `npm run typecheck` | Type-check every package from source |
| `npm test` | Unit, integration and CLI tests |
| `npm run build` | Emit `dist/` for every package and build the dashboard |
| `npm run dev:web` | Dashboard dev server with hot reload (proxies `/api` to a running `scope ui`) |
| `npm run test:e2e` | Playwright tests for the dashboard (build it first: `npm run build -w @scope-ai/web`; one-time: `npx playwright install chromium`) |
| `npm run bench` | Ingestion and API timings on generated data (`-- --traces 100000`, `-- --database postgres://…`); see [docs/performance.md](docs/performance.md) |
| `npm run bench:check` | The CI performance check: timings at 2,000 and 50,000 traces must not grow with the database |
| `npm run smoke` | Pack every package and install them into an empty project, as users will |
| `npm run clean` | Remove build output |

### Testing against PostgreSQL

Storage tests always run against SQLite. To run them against PostgreSQL too:

```bash
docker run -d --name scope-pg -e POSTGRES_PASSWORD=scope -e POSTGRES_USER=scope \
  -e POSTGRES_DB=scope_test -p 127.0.0.1:55432:5432 postgres:17-alpine
SCOPE_TEST_DATABASE_URL=postgres://scope:scope@127.0.0.1:55432/scope_test npm test
```

## Repository map

```text
packages/core        domain model and pure logic (no dependencies)
packages/config      YAML schemas, diagnostics, templates, datasets
packages/providers   model providers (OpenAI, Anthropic, compatible, local)
packages/sdk         tracer and exporters
packages/evaluators  evaluator framework and built-ins
packages/engine      workflow execution
packages/storage     SQLite/PostgreSQL store
packages/protocol    API contract
packages/cli         the scope command
packages/scope-ai    the package users install (`npm install -g scope-ai`)
apps/server          HTTP API, OTLP ingestion and dashboard hosting
apps/web             dashboard
integrations/        the GitHub Action
examples/            runnable examples (each one run by examples/examples.test.ts)
deploy/              production-style Docker Compose deployment
tests/e2e/           Playwright tests of the dashboard
```

Read [docs/architecture.md](docs/architecture.md) before larger changes. Decisions with real
alternatives are recorded in [docs/decisions](docs/decisions/); propose a new ADR when you want
to change one.

## Good first contributions

Self-contained gaps that exist today, each with a clear place in the code and tests to copy from.
Open an issue before starting so two people don't build the same thing.

- **CSV datasets.** `parseFile` in `packages/config/src/dataset.ts` reads JSONL, JSON and YAML;
  CSV (a header row, one column per input, an optional `expected` column) is on the
  [roadmap](docs/roadmap.md). Tests go next to the dataset tests in
  `packages/config/src/workflow.test.ts`; diagnostics should name the row and column.
- **Current prices.** `packages/core/src/pricing.ts` records every model's price with the date
  and the page it came from. Adding a model or correcting a changed price — with the source — is a
  one-file change covered by `packages/core/src/runs.test.ts`.
- **Provider recipes.** `docs/guides/configuration.md` shows an Ollama endpoint. Configurations
  for vLLM, LM Studio or OpenRouter, verified against a running server with `scope doctor
  --network`, help the next person.
- **A refusal evaluator.** "Refusal detection" is on the roadmap's evaluator list: a heuristic
  evaluator that flags answers declining the question. See [Adding an evaluator](#adding-an-evaluator);
  its documentation must say how it can be wrong.

## Working on each part

Each part has a guard that catches the mistakes that are easy to make there.

**CLI** (`packages/cli`). One file per command in `src/commands/`, registered in `src/main.ts`.
Every command supports `--json` (JSON on stdout, diagnostics on stderr) and the documented exit
codes; errors are `ScopeError`s with a hint. `src/cli.test.ts` runs the real binary in temporary
projects — add a case there, and a row to [docs/guides/cli.md](docs/guides/cli.md).

**SDK** (`packages/sdk`). Runs inside other people's applications: it must never throw into them,
block them or grow without bound. Anything read from a provider response or an ingested payload is
validated before use (see `count()` in `instrument.ts`). Test instrumentation with the real
`openai` and `@anthropic-ai/sdk` packages against a local server, as `instrument.test.ts` and
`instrument-robustness.test.ts` do.

**Server** (`apps/server`, `packages/protocol`). Every route is declared once in
`packages/protocol/src/routes.ts` with Zod schemas; the OpenAPI document is generated from it. The
contract test calls every route and validates its response, and `isolation.test.ts` checks that
no route shows one project's data through another project's key — both pick up a new route
automatically. `/api/v1` only changes additively (see the stability policy in
[docs/guides/api.md](docs/guides/api.md)).

**Storage** (`packages/storage`). The only package that knows SQL; every query is scoped to a
project. Migrations are append-only and tested on SQLite and PostgreSQL
(`SCOPE_TEST_DATABASE_URL`). `query-plans.test.ts` fails when a query scans a whole table or
project: select spans and evaluations by trace id, not by project and trace id together.

**Dashboard** (`apps/web`). Tokens, primitives and rules are in
[docs/design-system.md](docs/design-system.md). Types come only from `@scope-ai/protocol`. Every
chart has a table twin. The Playwright suite (`tests/e2e`) checks journeys, keyboard use and axe
accessibility in both themes against data the CLI produced.

**Evaluators** (`packages/evaluators`). See [Adding an evaluator](#adding-an-evaluator) and the
[custom evaluator contract](docs/guides/custom-evaluators.md).

**Integrations** (OTLP in `apps/server/src/otlp/`, instrumentation in `packages/sdk`). Claim only
what is tested, and say how: [docs/integrations.md](docs/integrations.md) lists each path with its
evidence. Mapping tests use each convention's documented attributes; end-to-end tests use the real
exporter or instrumentation packages.

## Common contributions

### Adding an evaluator

1. Implement it in `packages/evaluators/src/` with `defineEvaluator`: a strict `argsSchema`,
   an honest `kind`, a one-sentence `description` that states the method, and a `reason` on
   every result. Put evidence in `metadata`.
2. Register it in `BUILTIN_EVALUATORS` (`registry.ts`).
3. Add tests covering passing, failing, skipped and edge cases.
4. Document it in [docs/guides/evaluators.md](docs/guides/evaluators.md), including its failure
   modes.

### Adding a model provider

Implement `ModelProvider` in `packages/providers/src/`, map vendor errors with
`toProviderError`, add a pricing entry with its source and date if prices are public, and test
request shaping against a local HTTP server (see `providers.test.ts`).

### Adding a step type

Implement `StepType` in `packages/engine/src/steps.ts` with a strict `argsSchema` and register
it in `BUILTIN_STEPS`. Validation, templating and tracing work automatically.

## Style

- TypeScript strict mode; only erasable syntax (no enums, namespaces or parameter properties).
- Biome formats and lints; run `npm run format` before committing.
- Errors users can hit are `ScopeError`s with a stable `code`, a message that says what went
  wrong, and a `hint` that says how to fix it.
- Never log prompt or output content; log ids, sizes and timings.

## Commits and pull requests

We use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(eval): add citation evaluator
fix(storage): keep span order within a millisecond
docs: explain regression gates
```

Scopes: `core`, `config`, `providers`, `sdk`, `eval`, `engine`, `storage`, `protocol`, `cli`,
`server`, `web`, `action`, `docs`, `ci`, `examples`.

A pull request should:

- explain the problem and the approach,
- include tests and documentation updates,
- pass `npm run check`,
- update [CHANGELOG.md](CHANGELOG.md) under **Unreleased** for user-visible changes.

Maintainers publish releases from tags; see [RELEASING.md](RELEASING.md). Pull requests never
change package versions.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the project's license.
