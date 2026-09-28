# Ticket triage

A support-ticket triage step written as ordinary JavaScript (`triage.mjs`) and run as a
`function` step. Everything it does through `ctx` is traced:

- `ctx.tool('orders.lookup', …)` — a tool span with the lookup's input and result,
- `ctx.retrieve(…)` — a retrieval span over `policies/`, which also becomes the evaluators'
  context,
- `ctx.llm(…)` — a model-call span with the prompt, response and token counts.

The step returns structured output (`intent`, `priority`, `order_status`, `reply`). Evaluators
check its shape with JSON Schema, compare `intent` and `priority` with the labelled answers in
`datasets/tickets.jsonl`, and check that the reply is supported by the retrieved policy.

```bash
# from the repository root
npm run scope -- run workflows/triage.yaml --cwd examples/triage
```

The `narrow_urgency` variant treats only the word "urgent" as urgent. Against the committed
baseline, it fails the priority regression gate on the two tickets it misses:

```bash
npm run scope -- run workflows/triage.yaml --variant narrow_urgency --baseline baselines/triage.json --cwd examples/triage
```

Evaluator templates select fields of the declared output — `{{ outputs.ticket.intent }}` — and
of the case's expected value — `{{ expected.intent }}`.
