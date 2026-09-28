# 0004 — Versioned, strict YAML workflow format

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

Workflows and their evaluation criteria must be reviewable in pull requests, runnable in CI,
and understandable by people who did not write them. Configuration formats are hard to change
once published.

## Decision

- Workflows are YAML files with a required top-level `version: 1`.
- Objects are **strict**: unknown keys are errors with a "did you mean" suggestion.
- Framework keys and plugin arguments are separated: steps and evaluators carry `id`/`name`,
  `type` and framework options at the top level, and type-specific arguments under `with:`.
  Plugins can add arguments without colliding with future framework keys.
- Keys are `snake_case`, matching the model APIs users already know (`max_tokens`, `top_k`).
- Runtime values use `{{ … }}` templates with dotted paths and a closed set of filters. No
  code execution in templates; logic goes in `function` steps.
- Environment variables are referenced with `${env:NAME}` and resolved at load time; stored
  snapshots keep the reference.
- Evaluators and gates are declared next to the steps, not as steps, because they run after
  the workflow, see every case, and are not part of the application's behaviour.
- The Zod schemas are the source of truth and are exported as JSON Schema for editors.

## Consequences

- Typos are caught before any tokens are spent.
- Evolving the format: additive fields within version 1; breaking changes introduce
  `version: 2` with an in-memory upgrader and a deprecation notice for version 1 files.
- YAML is less expressive than code. Complex control flow (agent loops, branching) lives in
  `function` steps, which are fully traced via their context object.

## Alternatives considered

- **Workflows as TypeScript code only.** Maximally flexible, but not reviewable by non-authors,
  harder to validate statically, and excludes non-TypeScript users.
- **JSON.** No comments, noisier diffs.
- **Evaluation as a step type.** Mixes application logic with judging it and makes per-run
  aggregation awkward.
