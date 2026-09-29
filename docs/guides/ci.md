# CI and regressions

SCOPE turns "did this change make the AI worse?" into a check on every pull request: run the
workflows, compare with a committed baseline, fail when a gate is violated.

## 1. Gates

Gates live in the workflow ([reference](./workflows.md#gates)). Absolute gates hold on every
run; regression gates compare with a baseline:

```yaml
gates:
  - metric: pass_rate
    min: 0.85                             # never below 85%
  - metric: pass_rate
    max_decrease: 0.02                    # never more than 2 points below the baseline
  - metric: evaluator.grounded.mean_score
    max_decrease: 0.05
  - metric: latency.p95_ms
    max_increase_pct: 30
    severity: warn                        # reported, not failing
```

## 2. A committed baseline

A baseline is a JSON snapshot of a run you trust — its summary and every case's outcome and
scores — saved in the repository:

```bash
scope run workflows/support.yaml
scope baseline save                      # latest run → baselines/support.json
git add baselines/support.json && git commit -m "chore: baseline for support workflow"
```

`scope baseline save` refuses runs that failed their gates or covered part of the dataset
(`--force` overrides). Variants get their own file: `baselines/support.<variant>.json`.

From then on, `scope run workflows/support.yaml` compares with it automatically
(`--baseline <file>` picks another, `--no-baseline` ignores it), reports which cases regressed
and which were fixed, and applies the regression gates.

When a change *intentionally* moves quality — a new model, a stricter prompt — update the
baseline in the same pull request. Reviewers then see the new numbers in the diff of
`baselines/*.json`, next to the change that caused them.

## 3. GitHub Actions

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
      - uses: tanmaytyagii/scope/integrations/github-action@main   # pin to a commit SHA
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}      # if workflows call hosted models
```

The action runs every workflow listed in `scope.yaml`, writes a Markdown report per workflow to
the job summary, annotates each failed gate, uploads the database and JSON reports as an
artifact, and fails the job when a gate fails. With `comment: true` (and
`permissions: pull-requests: write`) it also posts the report on the pull request, updating the
same comment on every push. Inputs and outputs are documented in
[the action's README](../../integrations/github-action/README.md).

A report (an excerpt of a real one) looks like this:

```markdown
### ❌ SCOPE · support — failed

<sub>Run #3 · 12 cases · baseline: run #1, 4h ago</sub>

**Reason:**
- ❌ Pass rate 83.3% → 75.0% (−8.3 pp); dropped more than the allowed 5.0 pp

| Metric | Baseline | Current | Change | Gate |
| --- | ---: | ---: | ---: | :---: |
| Pass rate | 83.3% | 75.0% | −8.3 pp ↓ | ❌ |
| grounded score | 1.000 | 1.000 | ±0.000 | ✅ |
| key_facts pass rate | 83.3% | 75.0% | −8.3 pp ↓ |  |
| Latency p95 | 4 ms | 4 ms | −0.7% | ✅ |

<details><summary>1 regressed, 0 fixed case</summary>

| Case | Change |
| --- | --- |
| `refund-timing` | ❌ passed → failed (key_facts passed → failed 1.000 → 0.000) |

</details>
```

It continues with the full gate table, the failing cases and why they failed, and a note that
heuristic scores are signals and costs are estimates.

To open the exact traces behind a failed check, download the `scope-results` artifact and, from
your project directory, point the dashboard at the downloaded database:

```bash
SCOPE_DATABASE_URL=sqlite:/path/to/scope-results/scope.db scope ui --open
```

## Other CI systems

Everything the action does is a `scope` command, so any CI system that runs Node.js 22.16+ can
run it:

```bash
scope run --junit-file scope-junit.xml --summary-file scope-report.md --report-file scope-report.json
```

- **The exit code decides the job:** 0 passed · 1 a gate failed · 2 configuration error ·
  3 execution or storage error.
- **`--junit-file`** writes a JUnit XML report, which GitLab, Jenkins, CircleCI and Azure
  Pipelines display as test results. Every case is a test case (failed when an evaluator failed,
  errored when execution failed, with the reasons and the trace id); each run's gates are a
  second suite. GitLab's merge request widget then lists the cases that started failing.
- **`--summary-file`** appends the Markdown report (the same one the GitHub Action posts);
  **`--report-file`** writes the JSON report.
- `scope report <run> --format markdown|json|junit` renders a stored run later;
  `scope compare <base> <head>` compares runs or baseline files.
- Set `SCOPE_DASHBOARD_URL` to a shared dashboard (`scope server`) to turn trace ids in reports
  into links.

Runs record the commit and branch from git, and the pull request number on GitHub. These examples
install SCOPE from npm, available from the first release; until then, install it from source as in
the [quickstart](./quickstart.md).

### GitLab CI

```yaml
# .gitlab-ci.yml
scope:
  image: node:24
  script:
    - npm install -g scope-ai
    - scope run --junit-file scope-junit.xml --summary-file scope-report.md
  artifacts:
    when: always
    reports:
      junit: scope-junit.xml
    paths:
      - scope-report.md
      - .scope/scope.db
```

### Jenkins

```groovy
stage('SCOPE') {
  steps {
    sh 'npm install -g scope-ai'
    sh 'scope run --junit-file scope-junit.xml'
  }
  post {
    always { junit 'scope-junit.xml' }
  }
}
```

### CircleCI and Azure Pipelines

Run the same two commands, then publish the file: `store_test_results` with the directory holding
`scope-junit.xml` (CircleCI), or `PublishTestResults@2` with `testResultsFormat: JUnit` (Azure).

## Keeping CI costs predictable

- Use a small, representative dataset for pull requests (`--tag smoke` or `--limit`), and the full
  dataset on a schedule. Runs over a subset skip regression gates, because they are not
  comparable with a full baseline.
- Prefer deterministic and heuristic evaluators in gates; model-based judges add cost and
  variance.
- Budget gates (`cost.total_usd`, `tokens.total`) catch accidental prompt growth.
