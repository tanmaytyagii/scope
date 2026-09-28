# 0006 — CI regression gates compare against committed baseline files

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

A regression gate needs a reference point. Options are "the last run on the default branch"
(stored somewhere) or an explicit file in the repository.

## Decision

- `scope baseline save` writes a JSON file (default `scope-baseline.json`, one per workflow
  and variant) containing the run summary and per-case results (status and scores).
- `scope run --baseline <file>` evaluates regression gates against it and reports per-case
  regressions and fixes.
- Updating the baseline is a deliberate, reviewed change in a pull request.

## Consequences

- CI needs no SCOPE server, database or network access to detect regressions.
- Quality changes are visible in code review as a baseline diff, next to the change that
  caused them.
- Baselines can go stale if nobody updates them; `scope report` shows the baseline's age and
  source commit.
- When a team server exists, "compare to the latest default-branch run on the server" can be
  added as a second baseline source without changing the gate logic.

## Alternatives considered

- **Baseline fetched from a server.** Requires infrastructure for the first CI integration.
- **Baseline from a cached CI artifact.** Implicit, expires, and invisible in review.
