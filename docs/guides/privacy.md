# Privacy and data

What SCOPE stores, what leaves your machine, what is redacted, and how to keep sensitive content
out entirely. This describes what the code does — nothing stronger.

## What is stored

Everything lives in one database: `.scope/scope.db` (SQLite) by default, or the PostgreSQL
database in `SCOPE_DATABASE_URL`.

| Data | Contains | Content? |
| --- | --- | --- |
| Workflow versions | The workflow file as committed (`${env:NAME}` references unresolved, never their values) | — |
| Runs | Parameters, dataset name, file, size and hash, git commit, branch and pull request, summary, gates, the baseline compared with | — |
| Traces and spans | Timings, status, model, provider, token counts, estimated cost, attributes, events, errors | **Inputs and outputs** |
| Evaluations | Status, score, threshold, reason | **Evidence** (often quotes the output) |
| API keys (`scope server`) | A SHA-256 hash and a short prefix, never the key | — |

Payloads are bounded: each input or output is cut to 64 KiB (`privacy.max_payload_bytes`), and a
trace keeps at most 1,000 spans. SCOPE's own logs contain ids, sizes, counts and timings — never
prompts or outputs.

## What leaves your machine

SCOPE sends nothing anywhere on its own: no account, no telemetry, no update checks. Data leaves
only through what you configure:

| When | What is sent | To |
| --- | --- | --- |
| A workflow calls a hosted model | The prompt | The provider in the model reference (`openai:`, `anthropic:`, or your endpoint's `base_url`) |
| A model-based evaluator runs (`llm_judge`, `embedding_similarity`) | The output (and rubric, expected value, context) | The judge model's provider |
| An application uses `@scope-ai/sdk` | Traces | `SCOPE_URL` — your `scope ui` or `scope server` |
| `scope doctor --network` | A model-list request (no prompts) | Each provider the workflows use |
| The GitHub Action | The database and reports as a workflow artifact; the report in the job summary and, with `comment: true`, on the pull request | GitHub |

`local:*` models make no network calls, so a project on `local:extractive` works fully offline.
To keep prompts on your machine with a real model, point a provider at a local server, such as
Ollama or vLLM (see [configuration](./configuration.md#providers)). The dashboard loads nothing
from other origins; a Content-Security-Policy enforces it.

## Redaction

Redaction runs **before storage, in the process that records the trace** — the SDK in your
application, or the engine in `scope run` — and **again on the server** when traces are ingested
over HTTP. It covers inputs and outputs, span attributes, event attributes, status messages, error
messages and stack traces, trace metadata, and evaluation reasons and evidence (evaluators see
the unredacted output, so what they say about it is redacted too).

**Always on — credentials by pattern:** OpenAI, Anthropic, Stripe, GitHub, Slack, AWS, Google and
SCOPE keys, JWTs, bearer tokens and private keys become `[redacted:<rule>]`. A bearer token keeps
its `Bearer ` prefix, so you can still see that a header was sent.

**Always on — sensitive keys:** a value stored under a key named like a secret becomes
`[redacted:sensitive_field]`, whatever it looks like: `password`, `secret`, `token`, `api_key`,
`authorization`, `cookie`, `set-cookie`, `x-api-key`, `access_token`, `client_secret`,
`private_key` and similar. Keys match when their last segments form one of these names, so
`openai_api_key`, `db.password` and `http.request.header.authorization` match, while
`max_tokens` and `token_count` do not. Headers are just keys: `authorization` and `cookie`
headers are masked wherever they appear. Numbers under suffix-matched keys (`input_token: 12`)
are kept.

**Opt in — personal data:** `email`, `phone`, `credit_card` (Luhn-checked) and `us_ssn`.

**Your own:** patterns and keys for your domain.

```yaml
# scope.yaml
privacy:
  redact: [email, phone]
  patterns:
    - name: ticket_id
      pattern: "TCK-[0-9]{6}"
  sensitive_keys: [customer_note]
```

For the SDK, pass the same options to `createTracer({ privacy: { redact: ['email'] } })`.

Redaction is pattern-based, and therefore best effort: it catches the formats above, not a name,
an address or a secret in an unknown format.

## Turning content capture off

```yaml
privacy:
  capture_content: false        # or SCOPE_CAPTURE_CONTENT=false (also for the SDK and server)
```

Without content capture, inputs, outputs and evaluation evidence are not stored. What remains is
structure: names, timings, status, models, tokens, cost, attributes, metadata, errors and
evaluation reasons — all still redacted. Two things to know:

- An evaluation reason can quote text, e.g. `Missing: "30 days"` quotes the expected answer.
- Evaluations still run on the real output in memory; only what is stored changes.

For regulated data, turn content capture off on both sides: in the application (SDK) and on the
server (`SCOPE_CAPTURE_CONTENT=false`), so neither stores content even if the other is
misconfigured.

## Deleting data

Everything is in the database: delete `.scope/scope.db` to start over locally, or delete rows in
PostgreSQL (runs cascade to their traces, spans, evaluations and comparisons). There is no
automatic retention yet.
