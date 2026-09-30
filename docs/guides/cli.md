# CLI reference

`scope --help` and `scope <command> --help` describe every option; this page is the overview.

## Global options

| Option | Effect |
| --- | --- |
| `--json` | Print one JSON document on stdout (diagnostics stay on stderr). `scope export` is the exception: without `-o` its stdout is the export itself, in its `--format`; with `-o`, `--json` prints what was written |
| `-q, --quiet` | Print only results and errors |
| `--verbose` | Print debug information, including stack traces for unexpected errors |
| `--no-color` | Disable colors (also `NO_COLOR`) |
| `--cwd <dir>` | Run as if started in `<dir>` |
| `-c, --config <file>` | Use this `scope.yaml` instead of discovering one |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Gates failed (the run completed; quality thresholds were not met) — or `scope doctor` found a problem |
| 2 | Usage or configuration error — nothing was executed |
| 3 | Execution, provider or storage error |
| 130 | Interrupted |

## Commands

### Get started

| Command | Does |
| --- | --- |
| `scope init [dir]` | Create a project with a workflow that runs offline. `--name`, `--force` |
| `scope validate [workflows…]` | Check workflows and their datasets without running anything (default: the project's workflows) |
| `scope run [workflows…]` | Run workflows over their datasets, evaluate every case, apply gates, store everything (default: the project's workflows) |

`scope run` options:

| Option | Effect |
| --- | --- |
| `--variant <name>` | Run a variant (repeatable; `base` for the defaults) |
| `--all-variants` | Run the defaults and every variant, then compare them |
| `--dataset <file>` | Use another dataset |
| `-i, --input <key=value>`, `--input-json <json>` | Run one ad-hoc case |
| `--case <id>`, `--tag <tag>`, `--limit <n>` | Run a subset |
| `--concurrency <n>` | Cases in parallel (default 4) |
| `--bail` | Stop at the first case that does not pass |
| `--baseline <file>`, `--no-baseline` | Choose or ignore the baseline for regression gates |
| `--no-fail` | Exit 0 even when gates fail |
| `--summary-file <file>` | Append the Markdown report (e.g. `$GITHUB_STEP_SUMMARY`; also `SCOPE_SUMMARY_FILE`) |
| `--report-file <file>` | Write the JSON report |
| `--junit-file <file>` | Write a JUnit XML report: a test case per case, a suite of gates ([CI](./ci.md#other-ci-systems)) |

With several workflows, every workflow is loaded and checked before any of them runs, a table
at the end shows each run's result, and `--json` / `--report-file` produce `{ "runs": [...] }`.
`--variant`, `--dataset`, `--input`, `--input-json`, `--case` and `--baseline <file>` name things
inside one workflow, so they need exactly one. The exit code is the worst of all runs.

On GitHub Actions (`GITHUB_ACTIONS=true`), failed gates are also printed as error annotations.

### Inspect results

| Command | Does |
| --- | --- |
| `scope runs [run]` | List recent runs (`--workflow`, `--limit`), or show one: summary, gates, evaluators |
| `scope traces [trace]` | List traces (`--run`, `--workflow`, `--status`, `--eval`, `--search`, `--model`, `--limit`), or show one as a span tree with evaluations (`--full` for complete inputs and outputs) |
| `scope compare <base> <head>` | Compare two runs (numbers or ids) or baseline files, metric by metric and case by case |
| `scope compare <a> <b> <c> [d]` | Up to four side by side: each headline metric per run with the best marked (ties within noise share it), and the cases whose outcome differs |
| `scope report [run]` | Render a run as `text`, `markdown`, `json` or `junit` (`--format`, `--baseline`, `-o`, `--dashboard-url`) |
| `scope export traces` | Write traces as JSONL, or as dataset cases with `--format dataset` (`--run`, `--workflow`, `--status`, `--eval`, `--since 7d`, `--limit`, `-o`) |
| `scope export run [run]` | Write a run's per-case results as `csv` (one row per case, a status and score column per evaluator) or `jsonl` (`--format`, `-o`) |

Runs are referenced by number (`12` or `#12`) or id; traces by id or a unique prefix of at least
4 characters.

### CI and regressions

| Command | Does |
| --- | --- |
| `scope baseline save [run]` | Write the run (default: latest) as `baselines/<workflow>[.<variant>].json`. Refuses failed or partial runs unless `--force`. `-o` for another path |
| `scope evaluate <run>` | Re-score a stored run with the workflow's current evaluators, without re-running it (`--workflow`, `--no-fail`) |

### Dashboard and server

| Command | Does |
| --- | --- |
| `scope ui` | Serve the dashboard and API for this project on 127.0.0.1 (`--port`, `--open`; `--host` other than loopback requires `--insecure-no-auth`) |
| `scope server` | Serve every project with API-key authentication (`--host`, `--port`, `--retention 30d`; JSON logs) |
| `scope keys create` | Create a key (`--project`, `--name`, `--scope ingest|read`, repeatable); printed once |
| `scope keys list` | List a project's keys, never their secrets |
| `scope keys revoke <key>` | Revoke a key by id (or unique id prefix) |

### Data

| Command | Does |
| --- | --- |
| `scope prune --older-than <age>` | Delete runs and application traces that started before `30d`, `2w`, `72h` or a date (`--only traces` or `--only runs`; `--project`, `--all-projects`). Shows what it would delete; deletes with `--yes`; `--vacuum` shrinks a SQLite file afterwards |
| `scope prune --run <run>` / `--trace <id>` | Delete one run with its traces, or one application trace (a run's own traces go with their run) |

### Diagnostics

| Command | Does |
| --- | --- |
| `scope doctor` | Check Node.js, configuration, workflows, datasets, baselines (missing, stale, unused), storage and migrations, provider credentials, whether git ignores the local database, and the dashboard port |
| `scope doctor --network` | Also ask each provider the workflows use for its model list — a read-only request that costs no tokens — to confirm it is reachable, accepts the credentials and offers the models |
| `scope version` | Print versions (`--json` for machine-readable) |

## Automation

`--json` output is an interface: scripts and CI can rely on it. The contract:

- **Stable:** exit codes, and the fields below — fields are added over time, never renamed or
  removed within a major version, and never change meaning. Ignore fields you do not know.
- **Not stable:** human-readable output (text, tables, colors) and messages on stderr. Parse
  `--json`, not text.
- Errors in `--json` mode are one object on stdout: `{ "error": { "code", "message", "hint"? } }`,
  with the exit code of the failure.

| Command | Top-level fields |
| --- | --- |
| `init` | `root`, `project`, `files` |
| `validate` | `valid`, `errors`, `warnings`, `workflows` |
| `run`, `report` | the JSON report (`schema: "scope.report/v1"`): `schema`, `run`, `summary`, `gates`, `baseline`, `comparison`, `failures` |
| `runs` | `runs`, `nextCursor` |
| `runs <run>` | `run` (including `manifest`), `failingCases` |
| `traces` | `items`, `nextCursor` |
| `traces <trace>` | `trace`, `spans`, `evaluations`, … (the trace detail) |
| `compare <a> <b>` | `base`, `head`, `metrics`, `cases`, `counts`, `config` |
| `baseline save` | `path`, `baseline` |
| `evaluate` | `run`, `previousSummary` |
| `export … -o <file>` | `file`, `format`, `count` (without `-o`, stdout is the export itself) |
| `keys create` | `id`, `name`, `project`, `scopes`, `prefix`, `secret` |
| `keys list` | `project`, `keys` |
| `prune` | `runs`, `runTraces`, `traces`, `spans`, `evaluations`, `oldest`, `newest`, `project`, `deleted` (and `vacuumed`, `bytesBefore`, `bytesAfter` when deleting) |
| `db status` | `scope`, `storage`, `schema` (`applied`, `pending`, `newer`), `bytes`, `projects` |
| `db migrate` | `applied`, `schema` |
| `db backup` | `file`, `bytes`, `durationMs` |
| `doctor` | `version`, `checks` (`area`, `status`, `message`, `hint`) |
| `version` | `scope`, `node`, `platform` |
| `ui` | `url`, `project`, `storage`, `dashboard`, `auth` (printed once the server listens) |

A test runs every command with `--json` and parses its output; the report's full shape is
`scope.report/v1`, the API's shapes are in `/api/v1/openapi.json`.

## Environment

| Variable | Used by |
| --- | --- |
| `SCOPE_DATABASE_URL` | Every command that reads or writes runs (overrides `storage.url`) |
| `SCOPE_CAPTURE_CONTENT` | `false` to store no inputs or outputs |
| `SCOPE_PORT`, `SCOPE_HOST` | `scope ui`, `scope server` |
| `SCOPE_SUMMARY_FILE` | `scope run --summary-file` |
| `SCOPE_DASHBOARD_URL` | `scope report --dashboard-url`, and trace links in `--junit-file` reports |
| `SCOPE_AUTO_MIGRATE` | `false` to never migrate the database automatically |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Hosted model providers |
