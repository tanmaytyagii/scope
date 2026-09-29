# SCOPE GitHub Action

Runs your SCOPE workflows on every pull request, compares them with the baselines committed
in the repository, and fails the check when quality regresses beyond your gates.

What you get on each run:

- a Markdown report per workflow in the job summary — metrics against the baseline, gate
  results, and the cases that regressed;
- an error annotation for every failed gate (a warning for `severity: warn` gates);
- the SQLite database and a JSON report as a workflow artifact, so you can open the exact
  traces locally with `scope ui`;
- optionally, the same report as a pull request comment, updated in place on every push;
- a failed job when a gate fails, and the step outputs `result`, `report` and `comment`.

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
      - uses: actions/checkout@v5
      - uses: tanmaytyagii/scope/integrations/github-action@main
        env:
          # Only needed for workflows that call hosted models.
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Pin the action to a release tag or a commit SHA: SCOPE runs at the action's version. With
`install: auto` (the default) the action installs `scope-ai` at that version from npm when it
is published, and otherwise builds the CLI from the action's own checkout, which adds about half a
minute to the job. SCOPE is not on npm yet, so today the action builds from source.

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
| `install` | `auto` | `auto` (npm if this version is published, else source), `npm`, or `source` |
| `comment` | `false` | `true` posts the report on the pull request (one comment, updated in place) |
| `github-token` | `${{ github.token }}` | Token for the comment |
| `upload-artifact` | `true` | Upload `.scope/scope.db` and the JSON reports |
| `artifact-name` | `scope-results` | Name of the uploaded artifact |

## Outputs

| Output | Description |
| --- | --- |
| `result` | `passed`, `failed` (a gate failed) or `error` (a workflow could not run) |
| `report` | Path of the combined JSON report (`.scope/action/report.json`) |
| `comment` | URL of the pull request comment, when one was posted or updated |

## Exit behaviour

The step fails when a `fail`-severity gate fails (exit 1), or when a workflow cannot run —
invalid configuration (exit 2) or an execution or storage error (exit 3). Every workflow runs
even if an earlier one fails, so one report shows everything.

## Pull request comments

With `comment: true`, the report is posted on the pull request as one comment and updated in
place on every later push, instead of piling up. The job needs permission to comment:

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - uses: actions/checkout@v5
  - uses: tanmaytyagii/scope/integrations/github-action@main
    with:
      comment: true
```

Pull requests from forks get a read-only token, so there the action logs a warning and the
report stays in the job summary; the check itself still passes or fails on the gates. The token is
used for the comment only — it is not passed to `scope run` or the project code it runs.

The comment contains exactly the job summary's report: metrics, gate results, case ids and
evaluator reasons (which can quote parts of outputs, e.g. a missing expected phrase). Anyone who
can read the pull request can read it, so keep `comment: false` where reports must stay within
the Actions log.
