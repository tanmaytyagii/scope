# 0010 — Privacy defaults: redaction, bounded payloads, optional content capture

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

Prompts and model outputs routinely contain personal data, credentials pasted by users, and
proprietary documents. An observability tool concentrates all of it in one database.

## Decision

- Content capture is on by default for local use (the point of the tool is to see it) and is
  controlled by `privacy.capture_content` / `SCOPE_CAPTURE_CONTENT`. When off, SCOPE keeps
  structure, timing, token counts, costs and evaluation results, and drops inputs/outputs.
- Redaction runs before storage in the SDK/engine and again on server ingest. Built-in
  patterns: OpenAI/Anthropic/GitHub/Slack/Stripe-style API keys, AWS access keys, bearer
  tokens, private key blocks, JWTs, and values under sensitive field names (`password`,
  `api_key`, `authorization`, `secret`, `token`). Users add patterns and field names.
- Every captured payload is bounded (`privacy.max_payload_bytes`, default 64 KiB) and marked
  when truncated.
- SCOPE's own logs never contain payload content — only IDs, sizes, counts and timings.
- Evaluator evidence that quotes the output is subject to the same capture policy.

## Consequences

- Redaction is pattern-based and therefore best-effort; documentation says so and recommends
  `capture_content: false` for regulated data.
- Truncation means an evaluator re-run from stored data (`scope evaluate`) may see truncated
  text; the engine evaluates live outputs before truncation during `scope run`.

## Alternatives considered

- **Capture off by default.** Safer, but the first-run experience would show empty traces.
  Local-only default storage keeps the data on the developer's machine.
