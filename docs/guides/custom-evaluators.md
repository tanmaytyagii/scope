# Custom evaluators

When no built-in evaluator measures what matters to you — a house style, a domain rule, a
structured-output invariant — write one. An evaluator is an ES module in your project; SCOPE
loads it, runs it on every case, stores its verdict, reason and evidence, and gates on it like
any built-in. No SCOPE code changes and no dependency are needed.

A runnable example with two evaluators: [examples/custom-evaluator](../../examples/custom-evaluator).

## The module

```js
// evaluators/word-limit.mjs
export default {
  kind: 'deterministic',                       // required: deterministic | heuristic | model
  description: 'The answer has at most `max` words.',
  evaluate({ output, args }) {
    const words = String(output ?? '').split(/\s+/).filter(Boolean).length;
    return {
      score: words <= args.max ? 1 : 0,
      passed: words <= args.max,
      reason: `${words} words (limit ${args.max}).`,
      metadata: { words, max: args.max },
    };
  },
};
```

```yaml
# workflows/answers.yaml
evaluators:
  - name: short_enough
    type: ../evaluators/word-limit.mjs          # a path, relative to the workflow file
    with: { max: 45 }                            # becomes `args`
    threshold: 0.8                               # optional, for score-based verdicts
```

| Export field | Required | Meaning |
| --- | --- | --- |
| `kind` | yes | How it judges. `deterministic`: a rule anyone can re-check. `heuristic`: an approximation of a fuzzy property. `model`: a model's opinion. Shown next to every result; declare it honestly. |
| `evaluate(input, ctx)` | yes | Returns a result (or a promise of one). |
| `description` | no | One sentence: what it measures and how. |
| `defaultThreshold` | no | Pass threshold (0–1) for score-based verdicts when the workflow sets none. Default 1. |
| `argsSchema` | no | A Zod schema for `args`; invalid arguments fail the evaluation with the schema's message. Without one, `args` is passed as given. |

The module is the default export. TypeScript modules (`.ts`) work on Node.js 22.18+; in TypeScript,
`defineEvaluator` from `@scope-ai/evaluators` types everything.

## Input

`evaluate` receives one object:

| Field | Value |
| --- | --- |
| `input` | The case's inputs (`{ question: … }`), or what `with.input` selects |
| `output` | What is judged: the workflow output (the single declared output, when there is one), or what `with.output` selects, e.g. `"{{ steps.answer.output.text }}"` |
| `expected` | The case's `expected` value, or `with.expected`; `null` when absent |
| `context` | Reference text: the trace's retrieved documents by default, or `with.context` |
| `trace` | `{ durationMs, usage: { inputTokens, outputTokens, totalTokens }, costUsd }` of the case |
| `args` | The other `with` values (templates are rendered first) |

`ctx.signal` aborts when the evaluator times out (30 s; 180 s for `model`). For model-based
evaluators, `ctx.models.complete(modelRef, { messages })` and `ctx.models.embed(modelRef, texts)`
call models through SCOPE's providers; the calls are traced, and their tokens and cost are counted
as evaluator cost, not workflow cost.

## Result

| Field | Required | Meaning |
| --- | --- | --- |
| `reason` | yes | Why: a sentence a person can check. A result without a reason is an error. |
| `score` | yes (or `null`) | 0–1, clamped. `null` when a number does not apply. |
| `passed` | no | An explicit verdict. Without it, the case passes when `score >= threshold`. |
| `metadata` | no | Evidence, stored with the result and shown in the dashboard (e.g. the missing terms). It follows the content policy: dropped when content capture is off. |
| `skipped` | no | `true` when the evaluator does not apply to this case (e.g. nothing to measure); skipped results do not count for or against the case. |

## When it fails

- A thrown error (or a returned value without a `reason`) is recorded as an evaluation with
  status `error` and reason `The evaluator failed: <message>`; its `metadata` gets the error. The
  case counts as **errored**, which is not the same as failed — gates on pass rate see it.
- An error thrown with a `metadata` object property keeps that evidence.
- A module that cannot be loaded, or exports no `kind` or `evaluate`, stops the run before any
  case executes, with the file and the fix.

## Versions and reproducibility

A run records the SHA-256 of each custom evaluator module (SCOPE 0.4+; not of what the module
imports), so a comparison with a baseline says when an evaluator's code changed: *the evaluator
module ./evaluators/readability.mjs*. When you change **what** an evaluator measures, also give it
a new `name` (`readable_v2`): results under the old name stay comparable, and a comparison shows
the old evaluator as removed and the new one as added rather than mixing the two. See
[reproducibility](./workflows.md#reproducibility). `scope evaluate <run>` re-scores a stored run with the current
evaluators, without re-running the workflow.

## Trust

Evaluator modules run with the same privileges as `scope run`, like tests in a test runner. SCOPE
loads only modules that the project's own workflow files name — never from datasets or from the
network.
