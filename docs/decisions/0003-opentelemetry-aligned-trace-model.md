# 0003 — OpenTelemetry-aligned trace model

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

OpenTelemetry is the industry standard for traces, and its GenAI semantic conventions define
attribute names for model calls. Teams will want to send existing OTel data to SCOPE and export
SCOPE data to their observability stack.

## Decision

- Trace IDs are 32 lowercase hex characters and span IDs are 16, as in W3C Trace Context.
- A span has a parent ID, name, kind, start/end time, status (`ok` / `error` with message),
  attributes (flat, dotted keys, primitive or primitive-array values) and events.
- Model-call spans use the GenAI semantic-convention attribute names
  (`gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`,
  `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.request.temperature`,
  `gen_ai.request.max_tokens`, `gen_ai.response.finish_reasons`).
- SCOPE-specific concepts use the `scope.` attribute namespace (`scope.step.type`,
  `scope.cost.usd`, `scope.cost.estimated`).
- Prompt and completion content is stored as span `input` / `output` payloads rather than as
  attributes, so it can be redacted, truncated or omitted independently.
- Hot fields used for aggregation (provider, model, token counts, cost) are denormalized into
  columns in addition to the attributes.

## Consequences

- An OTLP/HTTP ingestion endpoint can be added by mapping OTLP spans onto this model with no
  schema change. It is on the roadmap, not in v0.1.
- SCOPE's `kind` (workflow, step, llm, retrieval, tool, function, evaluation, custom) is richer
  than OTel's span kind; it is exported as the `scope.span.kind` attribute.

## Alternatives considered

- **Adopt the OpenTelemetry JS SDK directly.** Heavier, designed for services rather than
  batch evaluation runs, and its exporters cannot express evaluation results. We keep the data
  model compatible instead of taking the dependency.
- **A bespoke model with free-form IDs.** Simpler at first, and a costly migration later.
