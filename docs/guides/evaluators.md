# Evaluators

An evaluator scores one output and explains the score. Every evaluator declares its **kind**,
because the three kinds deserve different trust:

| Kind | What it is | Trust it as |
| --- | --- | --- |
| **deterministic** | A rule: the same output always gets the same result | A fact about the output |
| **heuristic** | A deterministic approximation of a fuzzy property (word overlap, pattern matching) | A signal worth investigating, not a verdict |
| **model** | A model's judgment, recorded with the judge model and its reasoning | An opinion, not ground truth |

Each result has a **status** — `passed`, `failed`, `error` (the evaluator could not decide, e.g. the
judge model timed out; never silently turned into a pass or fail) or `skipped` (not applicable,
e.g. no expected value) — a score from 0 to 1 when one applies, a **reason**, and **evidence** in
`metadata` (missing strings, unsupported sentences, the judge's reasoning).

## Configuring evaluators

```yaml
evaluators:
  - name: key_facts            # how it appears in reports and gates (default: the type)
    type: contains
    threshold: 1               # optional: pass when score >= threshold
    with:                      # the evaluator's arguments
      all: true
```

A score-based result passes when `score >= threshold`. The threshold comes from the workflow,
else the evaluator's default (listed below), else 1. Some evaluators decide pass/fail themselves
(`contains` with `all: false`, `regex`, budgets).

### Choosing what is judged

By default an evaluator judges the workflow's output against the case's `expected` value, with
the input and the retrieved context available. Four reserved arguments, rendered as
[templates](./workflows.md#templates), change that:

```yaml
- name: intent
  type: exact_match
  with:
    output: "{{ outputs.ticket.intent }}"     # a field of the declared output
    expected: "{{ expected.intent }}"         # a field of the case's expected value
- name: grounded_reply
  type: groundedness
  with:
    output: "{{ outputs.ticket.reply }}"
    context: "{{ steps.policy.output.text }}" # instead of all retrieved text
```

`input` can be overridden the same way. Templates here also see `trace.duration_ms`,
`trace.total_tokens` and `trace.cost_usd`.

## Built-in evaluators

### Deterministic

| Type | Passes when | Arguments |
| --- | --- | --- |
| `exact_match` | The output equals `expected`. Text is compared after normalization; objects and lists by deep equality | `case_sensitive` (true), `trim` (true), `collapse_whitespace` (true) |
| `contains` | The output contains the required strings: `value`, or the case's `expected` (a string or list). Score = share found | `value`, `all` (true: every string; false: any), `case_sensitive` (false) |
| `not_contains` | The output contains none of the forbidden strings | `value` (required), `case_sensitive` (false) |
| `regex` | The output matches the pattern (or, with `should_match: false`, does not) | `pattern`, `flags`, `should_match` (true) |
| `json` | The output is valid JSON (objects as-is; text may be fenced in Markdown) and satisfies the JSON Schema when given | `schema` |
| `latency` | The workflow's duration (excluding evaluation) is within budget | `max_ms` |
| `tokens` | Token use is within budget | `max_total`, `max_input`, `max_output` (at least one) |
| `cost` | Estimated cost is within budget | `max_usd` |

### Heuristic

| Type | Measures | Default threshold | How it can be wrong |
| --- | --- | --- | --- |
| `similarity` | Word overlap with `expected` (token F1, or ROUGE-L with `method: rouge_l`); with several references, the closest | 0.5 | Measures shared wording, not meaning: a correct paraphrase scores low, a wrong answer reusing the words scores high |
| `groundedness` | Share of answer sentences whose content words appear in one passage of the context | 0.8 | Misses support that is paraphrased; cannot see a contradiction that reuses the context's words. Skips answers that decline to answer. Arguments: `support_threshold` (0.6), `min_terms` (3) |
| `unsupported_claims` | Numbers and names in the answer that never appear in the context — a hallucination signal | 1 | Cannot see unsupported claims made in ordinary words; number words ("five") do not match digits |
| `relevance` | Share of the question's key terms the answer addresses | 0.5 | An answer can repeat the question's words without answering it. Argument: `question` (default: the only text input, else the `question` or `query` input, else all inputs as text) |

Heuristics are cheap, fast and reproducible, which makes them useful as regression signals: a
drop in groundedness between two runs is worth a look even though the absolute score is only
approximate.

### Model-based

| Type | Measures | Default threshold | Arguments |
| --- | --- | --- | --- |
| `llm_judge` | A judge model grades the output against your rubric on a 1–5 scale, normalized to 0–1 | 0.75 | `model` (required), `rubric` (required), `include_context` (true), `max_tokens` (1024) |
| `embedding_similarity` | Cosine similarity of embeddings of the output and `expected` | 0.8 | `model` (required, e.g. `openai:text-embedding-3-small`) |

```yaml
- name: helpful
  type: llm_judge
  with:
    model: anthropic:claude-sonnet-5
    rubric: >
      A good answer resolves the customer's question using only the provided context, states
      concrete facts (days, amounts, steps), and says so when the context lacks the answer.
```

Judge calls are traced as child spans of the evaluation, with the judge's prompt and reasoning,
and their tokens and cost are reported separately from the workflow's own (they appear under
"Evaluator calls" on the Models page, not in trace cost). A judge is itself a model: calibrate it
against labelled examples before gating on it, and prefer deterministic checks where one exists.

## Custom evaluators

Point `type` at a module in the project whose default export declares a `kind`, a `description`
and an `evaluate(input, ctx)` function returning `{ score, reason, passed?, metadata?, skipped? }`:

```yaml
evaluators:
  - name: short_enough
    type: ../evaluators/word-limit.mjs
    with: { max: 45 }
```

The full contract — inputs, results, thresholds, failures, versioning — is in
[custom evaluators](./custom-evaluators.md), with a runnable example in
[examples/custom-evaluator](../../examples/custom-evaluator).

## Re-scoring a run

`scope evaluate <run>` runs the workflow's current evaluators over a stored run's outputs without
re-running the workflow — useful after adding an evaluator or changing a threshold. Stored
outputs are subject to the project's privacy settings, so a re-score sees truncated or omitted
content if capture was limited when the run was recorded.

## Adding a built-in evaluator

See [CONTRIBUTING](../../CONTRIBUTING.md#adding-an-evaluator): a strict argument schema, an honest
kind, a one-sentence description of the method, tests for passing, failing, skipped and edge
cases, and an entry here with its failure modes.
