# Self-hosting

`scope ui` is a local dashboard for one developer. For a team — shared runs, production traces
from applications, a dashboard everyone can open — run `scope server` with PostgreSQL.

| | `scope ui` | `scope server` |
| --- | --- | --- |
| Listens on | 127.0.0.1 (refuses other hosts without `--insecure-no-auth`) | 0.0.0.0 by default |
| Authentication | none | API keys (`scope keys`) |
| Projects | the current project | every project; each key belongs to one |
| Logs | warnings on stderr | JSON lines on stderr |
| Typical storage | SQLite in the project | PostgreSQL |

## Try it: the Docker demo

```bash
git clone https://github.com/tanmaytyagii/scope.git && cd scope
docker compose up
```

This builds the image, starts PostgreSQL, seeds it with real runs of
[examples/rag](../../examples/rag) — including a variant that fails its regression gate — and
serves the dashboard at <http://127.0.0.1:4700>. The demo dashboard runs `scope ui` without
authentication and is published on the loopback interface only. `docker compose down -v` removes
it and its data.

## Run a server

### With Docker

The image runs `scope server` by default (port 4700, JSON logs, a health check on `/healthz`):

```bash
docker build -t scope .
docker run -d --name scope -p 4700:4700 \
  -e SCOPE_DATABASE_URL=postgres://scope:secret@db.internal:5432/scope \
  scope
```

It builds every package and installs the packed packages into a slim Node 24 image, so the
container runs exactly what an npm install would.

### Without Docker

```bash
export SCOPE_DATABASE_URL=postgres://scope:secret@db.internal:5432/scope
scope server --port 4700          # --host defaults to 0.0.0.0
```

Database migrations run automatically when the server (or any `scope` command) opens the
database. With `SCOPE_AUTO_MIGRATE=false` nothing is migrated, and `/readyz` reports pending
migrations until a process with auto-migration has applied them. `scope doctor` checks
connectivity and reports the schema state.

## API keys

Every `/api/v1` request except `/api/v1/info` needs `Authorization: Bearer scope_…`. Keys belong to
one project, which bounds everything they can read or write, and carry scopes:

| Scope | Allows |
| --- | --- |
| `ingest` | `POST /api/v1/ingest` — for applications sending traces |
| `read` | Every read endpoint — for the dashboard and scripts |

```bash
# with Docker
docker exec scope scope keys create --project support-bot --name production-app --scope ingest
docker exec scope scope keys create --project support-bot --name dashboard --scope read

# without Docker (same database)
scope keys create --project support-bot --name ci --scope read --scope ingest
scope keys list --project support-bot
scope keys revoke <key id> --project support-bot
```

A key is printed once and stored only as a SHA-256 hash. The dashboard asks for a `read` key on
first visit and keeps it for the browser tab (or on the device, if chosen). Revoked keys stop
working immediately.

Applications send traces with `SCOPE_URL=https://scope.example.com` and `SCOPE_API_KEY=<ingest
key>` ([tracing guide](./tracing.md)). CI runs of `scope run` write directly to the database
through `SCOPE_DATABASE_URL`, so their runs appear on the server's dashboard too.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `SCOPE_DATABASE_URL` | `sqlite:.scope/scope.db` | Database (PostgreSQL for servers) |
| `SCOPE_HOST`, `SCOPE_PORT` | `0.0.0.0`, `4700` | Listen address (`--host`, `--port`) |
| `SCOPE_LOG_FORMAT` | `json` | `pretty` for human-readable logs |
| `SCOPE_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `SCOPE_MAX_INGEST_BYTES` | 5 MiB | Largest ingest request |
| `SCOPE_MAX_SPANS_PER_TRACE` | 1000 | Spans stored per trace; the rest are dropped and counted |
| `SCOPE_CAPTURE_CONTENT` | `true` | `false`: the server drops inputs and outputs on ingestion |
| `SCOPE_AUTO_MIGRATE` | `true` | Apply migrations on start |

A `scope.yaml` in the server's working directory, if present, supplies the privacy policy and
pricing overrides applied on ingestion ([configuration](./configuration.md)).

## Operations

- **Health:** `GET /healthz` (process up), `GET /readyz` (database reachable and migrated; 503
  otherwise).
- **Metrics:** `GET /metrics` in Prometheus format — requests by route and status, request
  duration histograms, ingested traces/spans/evaluations, rejected ingests by reason, dropped
  spans, unexpected errors.
- **Logs:** one JSON object per line with a request id; every response carries the same id in
  `x-request-id` and in error bodies. Logs never contain prompt or output content.
- **Backups:** everything is in the database; back up PostgreSQL as usual.

## Security

- Put the server behind TLS (a reverse proxy or load balancer); it speaks plain HTTP.
- Responses carry a strict Content-Security-Policy and standard security headers; the dashboard
  loads nothing from other origins.
- Traces are redacted by the SDK and again by the server before storage; see
  [privacy](./configuration.md#privacy). For regulated data, set `SCOPE_CAPTURE_CONTENT=false`.
- There are no user accounts yet: access is per project, through keys. Treat `read` keys like
  read access to every prompt and response in the project.
- Report vulnerabilities privately — see [SECURITY.md](../../SECURITY.md).
