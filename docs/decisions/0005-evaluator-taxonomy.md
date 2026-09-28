# 0005 — Evaluators declare deterministic, heuristic or model kind

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

Evaluation tools often present a lexical-overlap score as "semantic similarity" or a judge
model's opinion as "accuracy". Engineers then trust numbers that do not measure what their
names claim.

## Decision

Every evaluator declares one kind, shown next to every score in the CLI, reports and dashboard:

- **deterministic** — a verifiable rule. Same input, same result, and the result is a fact
  (the output is or is not valid JSON; latency is or is not under 2 s).
- **heuristic** — a deterministic approximation of a fuzzy property, such as groundedness via
  lexical support. Useful as a signal and for regression detection; not a verdict.
- **model** — a judgment by a model. Non-deterministic in general; the judge model, prompt and
  raw response are stored as evidence with the score.

Further rules:

- Scores are normalized to 0..1. Pass/fail comes from an explicit threshold.
- `error` is a distinct status from `failed`; an evaluator that cannot run never passes.
- Every result has a human-readable `reason` and machine-readable evidence in `metadata`
  (e.g. the unsupported sentences, the missing substrings).
- Evaluators that need a similarity signal have honest names: `similarity` is lexical;
  `embedding_similarity` is model-based.

## Consequences

- Users can decide how much weight to put on each score, and gates can be set strictly for
  deterministic evaluators and loosely for heuristic ones.
- Documentation must describe the method and failure modes of each heuristic evaluator.

## Alternatives considered

- **Unlabelled scores.** Simpler UI, misleading results.
- **Only deterministic evaluators.** Honest but insufficient for open-ended text.
