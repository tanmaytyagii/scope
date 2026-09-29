# Workflows

A workflow is a YAML file that says what to run, on which cases, and how to judge the result:

```yaml
# yaml-language-server: $schema=../.scope/schemas/workflow.schema.json
version: 1
name: support                      # lowercase letters, digits, ".", "_", "-"
description: Answers customer questions from the help center.

inputs:
  question: { type: string, description: The customer's question. }

params:
  model: local:extractive
  top_k: 3

variants:
  narrow:
    top_k: 1

steps:
  - id: retrieve
    type: retrieve
    with:
      query: "{{ inputs.question }}"
      corpus: ../docs/*.md
      top_k: "{{ params.top_k }}"
  - id: answer
    type: llm
    with:
      model: "{{ params.model }}"
      system: Answer using only the context.
      prompt: |
        Context:
        {{ steps.retrieve.output.text }}

        Question: {{ inputs.question }}

outputs:
  answer: "{{ steps.answer.output.text }}"

dataset: ../datasets/support.jsonl

evaluators:
  - name: grounded
    type: groundedness
  - name: key_facts
    type: contains

gates:
  - metric: pass_rate
    min: 0.9
  - metric: evaluator.grounded.mean_score
    max_decrease: 0.05
```

Run it with `scope run workflows/support.yaml`. Everything is validated before anything runs:
YAML syntax, unknown keys (with suggestions), step and evaluator arguments, template
references to inputs, params, steps and outputs, provider names, and referenced files. Errors
point to the file, line and column. `scope validate` runs the same checks without executing.

Paths in a workflow are relative to the workflow file.

## Inputs, params and variants

- **`inputs`** describe what each case provides: `type` (`string`, `number`, `integer`,
  `boolean`, `object`, `array`, `any`), `description`, `required` (default true) and `default`.
  Cases are checked against them before the run starts.
- **`params`** are the knobs of the workflow: model, prompt fragments, retrieval depth — any JSON
  value.
- **`variants`** are named overrides of params. `--variant narrow` runs one;
  `--variant base --variant narrow` runs several; `--all-variants` runs the defaults and every
  variant, then prints a side-by-side table. Each variant is its own run, so `scope compare`
  and the dashboard compare them case by case — two as base and head, or up to four side by side
  (`scope compare 12 13 14`, or select them on the dashboard's Runs page), with the parameters
  that differ and the cases where the runs disagree.

```yaml
params:
  model: anthropic:claude-sonnet-5
variants:
  opus:
    model: anthropic:claude-opus-5
  gpt:
    model: openai:gpt-5
```

Variants that switch providers are why provider-specific options are keyed by provider name
(see `provider_options` below): each call only sends the options for the provider serving it.

## Steps

Each step has an `id` (lowercase, letters, digits and `_`), a `type`, arguments under `with`,
and optionally `name`, `description`, `timeout_ms` and `continue_on_error`. Steps run in order;
each becomes a span in the trace. A step that throws fails the case — unless it sets
`continue_on_error: true`, in which case its output is `null`, its state is `error`, and the
workflow continues.

### `llm` — call a model

| Argument | Description |
| --- | --- |
| `model` | `provider:model`, e.g. `openai:gpt-5`, `anthropic:claude-sonnet-5`, `local:extractive` |
| `prompt` | The user message |
| `system` | System message |
| `messages` | A list of `{ role: system | user | assistant, content }`, before `prompt` |
| `temperature`, `max_tokens`, `stop` | Sampling parameters |
| `response_format` | `text` (default) or `json` |
| `json_schema` | A JSON Schema for structured output (implies `json`) |
| `provider_options` | Extra request fields per provider: `{ openai: { seed: 7 } }` |

Output: `{ text, json, model, finish_reason, usage }` — `json` is the parsed response when
`response_format` is `json` (a Markdown code fence around the JSON is tolerated), otherwise
`null`. The span records the prompt, the response, the serving model, token counts and the
estimated cost. Default timeout: 300 s.

### `retrieve` — search local documents

| Argument | Default | Description |
| --- | --- | --- |
| `query` | — | Search text |
| `corpus` | — | A glob or list of globs: Markdown, text or JSONL files |
| `top_k` | 4 | Documents to return (1–100) |
| `min_score` | 0 | Minimum BM25 score |
| `chunk_size` | 800 | Characters per chunk; Markdown is split by heading first |

Output: `{ query, documents: [{ id, source, title, text, score }], text }`, where `text` joins the
documents for use in prompts. The retrieved text becomes the default `context` for evaluators
such as `groundedness`. Default timeout: 30 s.

### `transform` — compute a value

```yaml
- id: parse
  type: transform
  with:
    value: "{{ steps.answer.output.text }}"
    parse: json            # optional: parse a JSON string
```

Output: the value. Default timeout: 10 s.

### `function` — run your code

```yaml
- id: triage
  type: function
  with:
    module: ../triage.mjs    # a JavaScript or TypeScript module in the project
    export: triage           # default: the default export
    args: { strict: true }   # passed as the first argument
```

The function receives `(args, ctx)`. Everything done through `ctx` is traced:

| `ctx` member | Purpose |
| --- | --- |
| `inputs`, `params`, `steps`, `case`, `variant` | The same values templates see |
| `llm(options)` | A model call (same options as the `llm` step), recorded as a model-call span |
| `retrieve(options)` | A retrieval (same options as `retrieve`); its text becomes evaluator context |
| `tool(name, input, fn)` | Runs `fn` as a `tool` span recording the input and result |
| `span(name, { kind, input }, fn)` | Any other traced unit of work |
| `signal` | An `AbortSignal` for timeouts and cancellation |

The return value is the step's output. Function steps run with the CLI's privileges, like a test
runner; SCOPE never loads code from datasets or remote sources. TypeScript modules need Node's
type stripping (on by default from Node 22.18). Default timeout: 300 s. See
[examples/triage](../../examples/triage).

## Templates

Strings in `with`, `outputs` and evaluator arguments are templates:

```text
{{ inputs.question }}
{{ steps.retrieve.output.documents[0].source }}
{{ params.style | default("concise") | upper }}
{{ steps.answer.output.json | json(2) }}
```

Expressions are dotted paths — with `[0]` or `["key"]` indexing — or literals, followed by
filters. The roots are `inputs`, `params`, `steps.<id>.output`, `case` (`id`, `metadata`,
`tags`) and `variant`; evaluator arguments also see `outputs`, `expected` and `trace`
(`duration_ms`, `total_tokens`, `cost_usd`).

A string that is exactly one expression keeps the value's type (`top_k: "{{ params.top_k }}"`
yields a number); anything else is interpolated as text.

| Filter | Result |
| --- | --- |
| `json`, `json(2)` | JSON text (optionally indented) |
| `text` | Plain text of any value |
| `default(value)` | The value, or the fallback when missing, null or empty |
| `join(", ")` | A list joined as text |
| `lower`, `upper`, `trim` | Text case and whitespace |
| `truncate(200)` | Text cut to a length, with "…" |
| `length` | Length of a string, list or object |
| `first`, `last` | First or last list element |
| `number` | A number (errors if the value is not numeric) |

There is no code execution in templates; logic belongs in a `function` step. A reference to a
missing value is an error that lists the available names — unless the expression's first filter
is `default(…)`.

## Outputs

`outputs` maps names to templates rendered after the last step. Without `outputs`, the last
step's output is the workflow's output.

Evaluators judge the output: with **one** declared output, they judge its value directly; with
several, the whole object. Evaluator arguments can select part of it by name:
`output: "{{ outputs.ticket.intent }}"`.

## Datasets

`dataset` points to the cases a workflow runs on:

```yaml
dataset: ../datasets/support.jsonl              # JSONL, JSON or YAML file
dataset: { path: ../data/cases.yaml, name: smoke }
dataset:                                        # inline
  cases:
    - id: refund
      inputs: { question: How long do refunds take? }
      expected: 5 to 7 business days
```

A case has `inputs`, and optionally `id` (derived from a hash of the inputs when missing), `expected`
(any JSON — what evaluators such as `exact_match` and `contains` compare with), `metadata` and
`tags`. In flat form, every key other than `id`, `expected`, `metadata` and `tags` is an input:

```jsonl
{"id": "refund", "question": "How long do refunds take?", "expected": ["5 to 7 business days"]}
```

JSON and YAML files hold a list of cases or `{ cases: [...] }`. Datasets are hashed; baselines
record the hash so SCOPE warns when a comparison spans a changed dataset.

Run a subset with `--case <id>` (repeatable), `--tag <tag>` or `--limit <n>`; run one ad-hoc
input with `--input question="…"` or `--input-json '{…}'`; use another file with
`--dataset <file>`. Runs over a subset are never compared with the full baseline.

## Gates

Gates decide whether a run passes, and therefore the exit code in CI.

```yaml
gates:
  - metric: pass_rate
    min: 0.9                         # absolute
  - metric: latency.p95_ms
    max: 3000
  - metric: evaluator.grounded.mean_score
    max_decrease: 0.05               # regression vs the baseline
  - metric: cost.total_usd
    max_increase_pct: 20
    severity: warn                   # report, don't fail
```

| Condition | Meaning |
| --- | --- |
| `min`, `max` | Absolute bounds |
| `max_decrease`, `max_increase` | Largest allowed absolute change from the baseline (ratios in fractions: 0.05 = 5 points) |
| `max_decrease_pct`, `max_increase_pct` | Largest allowed relative change from the baseline, in percent |
| `severity` | `fail` (default) or `warn` |

Regression conditions are skipped (and reported as skipped) when there is no baseline. See
[CI and regressions](./ci.md) for baselines.

**Metrics:**

| Metric | Meaning |
| --- | --- |
| `pass_rate` | Share of cases whose evaluations all passed (errored cases count as not passing) |
| `error_rate` | Share of cases whose execution failed |
| `latency.p50_ms`, `latency.p95_ms`, `latency.mean_ms`, `latency.max_ms` | Case duration (workflow only, excluding evaluation) |
| `tokens.total`, `tokens.mean_per_case` | Tokens used by the workflow's model calls |
| `cost.total_usd`, `cost.mean_per_case_usd` | Estimated cost |
| `evaluator.<name>.pass_rate`, `evaluator.<name>.mean_score` | Per evaluator |

A case **passes** when it ran without error and none of its evaluations failed or errored.
Skipped evaluations (for example `exact_match` on a case without `expected`) do not count.

## Execution

- Cases run concurrently (default 4; `--concurrency` or `defaults.concurrency`).
- `--bail` stops scheduling new cases after the first that does not pass.
- Ctrl-C finishes in-flight cases, stores them, and marks the run cancelled; a second Ctrl-C
  exits immediately.
- Model calls retry on rate limits and transient errors (honouring `Retry-After`).
- Exit codes: `0` passed, `1` gates failed, `2` usage or configuration error, `3` execution or
  storage error, `130` interrupted. `--no-fail` exits 0 when gates fail.
