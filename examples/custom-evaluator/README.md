# Custom evaluators

A support workflow judged by one built-in evaluator and two written for this project:

| Evaluator | File | Kind | Shows |
| --- | --- | --- | --- |
| `short_enough` | [`evaluators/word-limit.mjs`](./evaluators/word-limit.mjs) | deterministic | Arguments (`with: { max: 45 }`), an explicit verdict, argument errors |
| `readable` | [`evaluators/readability.mjs`](./evaluators/readability.mjs) | heuristic | A 0–1 score with a threshold, evidence in `metadata`, skipping a case |

Both are plain ES modules: a default export with `kind`, `description` and `evaluate`. No
dependency on SCOPE is needed. The contract is in
[custom evaluators](../../docs/guides/custom-evaluators.md).

Run it from this directory (offline, no API key):

```bash
scope run                      # passes: short, readable answers
scope run --variant echo       # local:echo answers with its whole prompt: short_enough fails its gate
scope ui --open                # each evaluation's reason and evidence, per case
```

From the repository root without installing: `npm run scope -- run --cwd examples/custom-evaluator`.

`local:extractive` and `local:echo` are deterministic offline stand-ins, not language models.
