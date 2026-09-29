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

Packages resolve to their TypeScript sources through the `source` export condition, so edits
are picked up immediately by the CLI, the server and the tests.

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
| `npm run bench` | Ingestion and API timings on generated data (`-- --traces 100000`); see [docs/performance.md](docs/performance.md) |
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
apps/server          HTTP API and dashboard hosting
apps/web             dashboard
```

Read [docs/architecture.md](docs/architecture.md) before larger changes. Decisions with real
alternatives are recorded in [docs/decisions](docs/decisions/); propose a new ADR when you want
to change one.

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
