# HTTP API

`scope ui` and `scope server` serve a JSON API under `/api/v1` — the same API the dashboard uses.
The complete contract, generated from the server's own schemas, is at
**`/api/v1/openapi.json`** (OpenAPI 3.1); load it into any OpenAPI viewer or client generator.

## Conventions

- **Authentication:** none for `scope ui`; `Authorization: Bearer scope_…` for `scope server`
  (see [API keys](./self-hosting.md#api-keys)). `GET /api/v1/info` never needs a key.
- **JSON:** camelCase fields; timestamps are ISO-8601 strings; durations and span offsets are
  milliseconds.
- **Pagination:** lists take `limit` (default 50, max 200) and return `nextCursor`; pass it as
  `cursor` for the next page. Pages are stable while new data arrives.
- **Errors:** every error has the same body and an accurate status code:

  ```json
  {
    "error": {
      "code": "not_found",
      "message": "Run #99 not found",
      "hint": "No such run in project \"support-bot\". List runs with GET /api/v1/runs.",
      "requestId": "req_01M3…"
    }
  }
  ```

  Validation errors (400) list the failing fields in `error.details.issues`. The request id is
  also in the `x-request-id` header and in the server's logs.
- **Versioning:** `/v1` changes only additively — new fields and endpoints, never removals or
  changed meanings. Clients should ignore fields they do not know.

## Endpoints

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/v1/info` | Version, ingestion protocol version, auth mode |
| GET | `/api/v1/project` | Project, storage, privacy policy, pricing table, row counts |
| GET | `/api/v1/api-keys` | Key metadata (never secrets) |
| GET | `/api/v1/overview?window=7d` | Headline metrics, time series, run trend, recent failures (`24h`, `7d`, `30d`, `90d`) |
| GET | `/api/v1/runs` | Runs, newest first (`workflow`, `variant`, `status`, `gateStatus`) |
| GET | `/api/v1/runs/{run}` | A run — `{run}` is an id or a number |
| GET | `/api/v1/runs/{run}/cases` | Per-case results (`outcome`, `evaluator`, `q`) |
| GET | `/api/v1/comparisons?base=&head=` | Metric deltas and changed cases (`includeUnchanged=true` for all) |
| GET | `/api/v1/traces` | Traces (`run`, `name`, `status`, `eval`, `model`, `case`, `q`, `since`, `until`, `sort`) |
| GET | `/api/v1/traces/{trace}` | A trace with spans and evaluations, and for run cases where it stands among the run's failing cases (`failingCases`); id or unique prefix |
| GET | `/api/v1/evaluators?window=7d` | Pass rate, mean score and per-run trend of each evaluator |
| GET | `/api/v1/evaluations` | Evaluation results (`evaluator`, `status`, `kind`, `run`) |
| GET | `/api/v1/workflows`, `/api/v1/workflows/{name}` | Workflows; one workflow's source, versions and variants |
| GET | `/api/v1/models?window=7d` | Calls, tokens, latency, errors and estimated cost per model, with the price used |
| POST | `/api/v1/ingest` | Store traces from SDKs |

Outside `/api/v1`: `GET /healthz`, `GET /readyz`, `GET /metrics` (Prometheus).

```bash
# failing traces of run #12
curl -s "http://127.0.0.1:4700/api/v1/traces?run=12&eval=failed&limit=20"

# the same on a shared server
curl -s -H "Authorization: Bearer $SCOPE_API_KEY" \
  "https://scope.example.com/api/v1/comparisons?base=11&head=12"
```

## Ingestion

`POST /api/v1/ingest` stores finished traces. It is how `@scope-ai/sdk` exports, and the contract
for SDKs in other languages. Send `Content-Type: application/json` and, optionally,
`scope-protocol: 1`.

```json
{
  "project": "support-bot",
  "traces": [
    {
      "id": "4bf92f3577b34da6a3ce929d0e0e4736",
      "name": "answer-question",
      "status": "ok",
      "startTime": 1790000000000,
      "endTime": 1790000000850,
      "durationMs": 850,
      "input": { "question": "How long do refunds take?" },
      "output": "5 to 7 business days.",
      "metadata": { "release": "2026.09.1" }
    }
  ],
  "spans": [
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "id": "00f067aa0ba902b7",
      "parentId": null,
      "name": "answer-question",
      "kind": "workflow",
      "status": "ok",
      "startTime": 1790000000000,
      "endTime": 1790000000850,
      "durationMs": 850
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "id": "a3ce929d0e0e4736",
      "parentId": "00f067aa0ba902b7",
      "name": "generate",
      "kind": "llm",
      "status": "ok",
      "startTime": 1790000000120,
      "endTime": 1790000000840,
      "durationMs": 720,
      "provider": "openai",
      "model": "gpt-5-mini",
      "inputTokens": 412,
      "outputTokens": 38,
      "costUsd": 0.000179,
      "attributes": { "gen_ai.response.model": "gpt-5-mini-2026-08-07" }
    }
  ],
  "evaluations": []
}
```

- Times are epoch **milliseconds** (fractions allowed). Trace ids are 32 lowercase hex
  characters and span ids 16, as in W3C Trace Context / OpenTelemetry.
- Every span and evaluation must belong to a trace in the same request. The server recomputes a
  trace's token, cost and count totals from its spans (evaluation spans excluded).
- Fields not listed in the schema are ignored, so newer clients work with older servers.
- `project` routes traces on a server without authentication (created on first use); with a key,
  it must match the key's project if given.
- Idempotent: re-sending a trace id is a no-op. A trace id already owned by another project is
  never overwritten and is counted in `rejectedTraces`.
- The server redacts and bounds payloads with its privacy policy, and keeps at most 1,000 spans per
  trace (`droppedSpans` in the response).

Response:

```json
{
  "project": "support-bot",
  "accepted": { "traces": 1, "spans": 2, "evaluations": 0 },
  "rejectedTraces": 0,
  "droppedSpans": 0
}
```

Limits: 5 MiB per request (413 above it) and 1,000 traces per request. Retry on 429 and 5xx with
backoff; do not retry 4xx other than 429.
