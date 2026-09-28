# 0007 — Deterministic offline `local:*` models for demos and tests

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

A first-time user should see real traces, real evaluations and a real regression without an
API key. Tests and CI for SCOPE itself must be deterministic and free.

## Decision

The `local` provider ships two deterministic models:

- **`local:extractive`** answers by selecting the sentences in its prompt that best match the
  prompt's final line (the question), using BM25 scoring. Given retrieved context, it produces
  plausible, grounded — and sometimes wrong or incomplete — answers, which exercises every
  evaluator meaningfully.
- **`local:echo`** returns its prompt. Useful for testing templates and plumbing.

Token counts for local models are estimated (`scope.usage.estimated = true`) and their cost is
exactly zero.

## Consequences

- `scope init` produces a project that runs and evaluates offline immediately, and the Docker
  demo populates the dashboard by executing workflows rather than inserting fixtures.
- Local models are labelled as such in every surface. Documentation states plainly that they
  are not language models and that their scores say nothing about any real model.

## Alternatives considered

- **Seeded fixture data for the demo.** Faster to build, but it would be fake data presented as
  product output.
- **Bundling a small open-weights model.** Hundreds of megabytes, slow on CPU, and still
  non-deterministic across platforms.
