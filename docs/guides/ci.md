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
artifact, and fails the job when a gate fails. Inputs and outputs are documented in
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

Everything the action does is available from the CLI:

```bash
scope run workflows/support.yaml \
  --summary-file report.md \        # append the Markdown report
  --report-file report.json         # write the JSON report
echo "exit code: $?"                # 0 passed · 1 gates failed · 2 config error · 3 execution error
```

`scope report <run> --format markdown|json` renders a stored run; `scope compare <base> <head>`
compares runs or baseline files. Runs record the commit, branch and (on GitHub) the pull request
number from the CI environment.

## Keeping CI costs predictable

- Use a small, representative dataset for pull requests (`--tag smoke` or `--limit`), and the full
  dataset on a schedule. Runs over a subset skip regression gates, because they are not
  comparable with a full baseline.
- Prefer deterministic and heuristic evaluators in gates; model-based judges add cost and
  variance.
- Budget gates (`cost.total_usd`, `tokens.total`) catch accidental prompt growth.
