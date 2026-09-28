# SCOPE GitHub Action

Runs your SCOPE workflows on every pull request, compares them with the baselines committed
in the repository, and fails the check when quality regresses beyond your gates.

What you get on each run:

- a Markdown report per workflow in the job summary — metrics against the baseline, gate
  results, and the cases that regressed;
- an error annotation for every failed gate (a warning for `severity: warn` gates);
- the SQLite database and a JSON report as a workflow artifact, so you can open the exact
  traces locally with `scope ui`;
- a failed job when a gate fails, and the step outputs `result` and `report`.

## Usage

```yaml
# .github/workflows/scope.yml
name: SCOPE
on: pull_request

permissions:
  contents: read

jobs:
  evaluate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: tanmaytyagii/scope/integrations/github-action@main
        env:
          # Only needed for workflows that call hosted models.
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Pin the action to a commit SHA (or a release tag, once releases are published) — SCOPE itself
runs from the same commit as the action: the action builds the CLI from its own checkout, which
adds about half a minute to the job. Installing from npm will replace the build step once the
`@scope-ai/*` packages are published (see the [roadmap](../../docs/roadmap.md)).

### Baselines

Regression gates (`max_decrease`, `max_increase`, `*_pct`) compare a run with a baseline file.
Create one from a run you trust and commit it:

```bash
scope run workflows/support.yaml
scope baseline save            # writes baselines/support.json
git add baselines/support.json
```

With `baseline: auto` (the default), each workflow is compared with
`baselines/<workflow>.json` (or `baselines/<workflow>.<variant>.json` for a variant) when it
exists. Absolute gates (`min`, `max`) apply with or without a baseline. Because the baseline
is a file, a pull request that intentionally changes quality updates it in the same diff, where
reviewers can see the new numbers.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `workflows` | the workflows in `scope.yaml` | Workflow files, separated by spaces or newlines; globs allowed |
| `working-directory` | `.` | Directory of the SCOPE project (where `scope.yaml` is) |
| `variants` | `default` | `default`, `all`, or a comma-separated list of variant names |
| `baseline` | `auto` | `auto`, `none`, or a baseline file path |
| `fail-on-gates` | `true` | `false` reports gate failures without failing the job |
| `node-version` | `24` | Node.js used to run SCOPE (22.16 or newer) |
| `upload-artifact` | `true` | Upload `.scope/scope.db` and the JSON reports |
| `artifact-name` | `scope-results` | Name of the uploaded artifact |

## Outputs

| Output | Description |
| --- | --- |
| `result` | `passed`, `failed` (a gate failed) or `error` (a workflow could not run) |
| `report` | Path of the combined JSON report (`.scope/action/report.json`) |

## Exit behaviour

The step fails when a `fail`-severity gate fails (exit 1), or when a workflow cannot run —
invalid configuration (exit 2) or an execution or storage error (exit 3). Every workflow runs
even if an earlier one fails, so one report shows everything.

## Not yet supported

Pull-request comments (updated in place) are planned; today the report is in the job summary.
