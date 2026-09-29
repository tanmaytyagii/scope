# Configuration: `scope.yaml`

A SCOPE project is a directory with a `scope.yaml`. Commands find it by walking up from the
current directory (or take `--config <file>`). Without one, the current directory is the
project and defaults apply.

```yaml
# yaml-language-server: $schema=.scope/schemas/project.schema.json
version: 1
project: support-bot            # lowercase letters, digits, ".", "_", "-"

storage:
  url: sqlite:.scope/scope.db   # default; or postgres://user:pass@host:5432/db

providers:                      # optional: named OpenAI-compatible endpoints and overrides
  ollama:
    type: openai-compatible
    base_url: http://localhost:11434/v1

pricing:                        # optional: USD per 1M tokens, overrides the built-in table
  ollama:llama3.1:
    input: 0
    output: 0
    source: self-hosted

privacy:
  capture_content: true
  max_payload_bytes: 65536
  redact: [email]

defaults:
  concurrency: 4
  timeout_ms: 60000

workflows:
  - workflows/*.yaml

baselines:
  dir: baselines
```

Unknown keys are errors with a "did you mean" suggestion — a misspelled `temprature` is caught,
not ignored. `scope init` writes JSON Schemas to `.scope/schemas/` so editors with the YAML
language server autocomplete and validate both file types.

## Environment references

Any string value can reference an environment variable as `${env:NAME}`:

```yaml
providers:
  openrouter:
    type: openai-compatible
    base_url: https://openrouter.ai/api/v1
    api_key: ${env:OPENROUTER_API_KEY}
```

References are resolved when the file is loaded. Stored workflow versions keep the reference,
never the value. A missing variable is a warning at load time and an error only if the provider
is used.

## Storage

| `storage.url` | Use |
| --- | --- |
| `sqlite:<path>` | Default (`sqlite:.scope/scope.db`, relative to the project). Uses Node's built-in `node:sqlite`; nothing to install |
| `postgres://…` | Teams and servers. Migrations run automatically on first use |

`SCOPE_DATABASE_URL` overrides `storage.url`. Set `SCOPE_AUTO_MIGRATE=false` to require
migrations to be applied explicitly. `scope doctor` checks connectivity and schema state.

## Providers

Models are referenced as `provider:model` — `openai:gpt-5`, `anthropic:claude-sonnet-5`,
`local:extractive`, or `<name>:<model>` for a provider you define.

| Provider | Credentials | Notes |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | Chat Completions and embeddings |
| `anthropic` | `ANTHROPIC_API_KEY` | Messages API |
| any name with `type: openai-compatible` | `api_key` (optional) | Ollama, vLLM, LM Studio, OpenRouter, … |
| `local` | none | `local:extractive` and `local:echo`: deterministic offline stand-ins for demos and tests, not language models |

Provider settings: `type`, `api_key`, `base_url`, `organization`, `timeout_ms`, `max_retries`
(0–10; retries honour `Retry-After`), `headers`. Declaring `openai` or `anthropic` here overrides
their defaults (for example a proxy `base_url`).

SCOPE sends exactly the model you configure and records the model that served each call. It
never falls back to another model on its own. Parameters a model does not accept (for example
`temperature` on some models) are omitted with a validation warning and recorded on the span.

## Pricing

Costs are **estimates**: token counts times prices per million tokens. The built-in table
(`packages/core/src/pricing.ts`) records when and where each price was taken; the dashboard's
Settings page lists it. Add or override entries under `pricing`, keyed by `provider:model`:

```yaml
pricing:
  openai:gpt-5:
    input: 1.25
    output: 10
    cache_read: 0.125
    as_of: "2026-09-01"
    source: https://openai.com/api/pricing
```

A model with no known price has an **unknown** cost, shown as "unknown" — never `$0`. Run totals
that include unpriced calls are marked incomplete. `local:*` models cost nothing.

**Measured and estimated.** Token counts are what the provider reported for each call (marked
*estimated* only where SCOPE had to count them itself, e.g. offline models). Costs are always
estimates: reported tokens times the price in the table, which may differ from your invoice
(discounts, batch or regional pricing, price changes). Prices are dated; one older than 180 days
is shown as possibly out of date on the Models and Settings pages, and `scope doctor` warns about
it for the models your workflows use. Set the current price in `pricing:` to replace it.

## Privacy

Prompts and outputs often contain personal data. Before anything is stored — in the engine and
SDK, and again by the server on ingestion — SCOPE:

1. redacts credentials: OpenAI, Anthropic, GitHub, Slack, Stripe and Google API keys, AWS access
   keys, bearer tokens, private keys, JWTs and SCOPE keys;
2. masks values of sensitive fields (`password`, `secret`, `api_key`, `authorization`, `token`,
   `cookie`, …, plus `sensitive_keys`);
3. applies opt-in rules from `redact`: `email`, `credit_card` (Luhn-checked), `us_ssn`, `phone`,
   and your own `patterns`;
4. truncates payloads over `max_payload_bytes` (default 64 KiB), marking them as truncated;
5. with `capture_content: false`, stores no inputs or outputs at all — structure, timing,
   tokens, costs and evaluation results remain.

```yaml
privacy:
  capture_content: true
  redact: [email, phone]
  patterns:
    - name: ticket_id
      pattern: "TCK-[0-9]{6}"
  sensitive_keys: [customer_note]
```

`SCOPE_CAPTURE_CONTENT=false` overrides `capture_content`. Redaction is pattern-based and
therefore best effort; for regulated data, turn content capture off. SCOPE's own logs never
contain prompt or output content. [Privacy and data](./privacy.md) lists what is stored, what
leaves the machine and exactly what is redacted where.

## Defaults

| Key | Default | Effect |
| --- | --- | --- |
| `defaults.concurrency` | 4 | Cases run in parallel (`--concurrency` overrides) |
| `defaults.timeout_ms` | per step type | Step timeout when a step sets none (llm and function 300 s, retrieve 30 s, transform 10 s) |

## Other settings

- `workflows`: globs listing the project's workflows (default `workflows/*.yaml`, `*.yml`),
  used by `scope validate`, `scope doctor` and the GitHub Action.
- `baselines.dir`: where `scope baseline save` writes and `scope run` looks (default `baselines`).
