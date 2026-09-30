# Operating SCOPE

Running `scope server` for a team: deploying it, watching it, upgrading it, backing it up and
keeping its database in bounds. For the server's configuration and API keys, see
[self-hosting](./self-hosting.md); for measured capacity, [performance](../performance.md).

## Deploy with Docker Compose

[`deploy/compose.yaml`](../../deploy/compose.yaml) runs `scope server` on PostgreSQL:

```bash
cd deploy
cp .env.example .env            # set POSTGRES_PASSWORD (openssl rand -hex 24)
docker compose up -d            # builds the image from this repository, starts both services
docker compose exec scope scope keys create --project my-app --name production --scope ingest
docker compose exec scope scope keys create --project my-app --name dashboard --scope read
```

What it sets up:

| Service | What it does |
| --- | --- |
| `postgres` | PostgreSQL 17 with its data in the `postgres` volume; health-checked with `pg_isready` |
| `scope` | `scope server`: API keys required, JSON logs, migrations applied on start. Health-checked on `/readyz` (database reachable and migrated). Published on `127.0.0.1:4700` only |
| `caddy` (profile `https`) | HTTPS for `SCOPE_DOMAIN` with a certificate Caddy obtains and renews; forwards to `scope` |

Both services restart unless stopped. Applications send traces to `https://<SCOPE_DOMAIN>` with an
`ingest` key (`SCOPE_URL`, `SCOPE_API_KEY`); people open the same address and paste a `read` key.

To serve HTTPS, point `SCOPE_DOMAIN`'s DNS at the machine and run
`docker compose --profile https up -d`. Behind another proxy or load balancer instead, forward
to `127.0.0.1:4700` (or put the proxy on the compose network) and keep these in mind:

- SCOPE speaks plain HTTP; terminate TLS in the proxy.
- Allow request bodies of at least `SCOPE_MAX_INGEST_BYTES` (5 MiB) on `/api/v1/ingest` and
  `/v1/traces`.
- Only forward what SCOPE serves: the dashboard (`/`), `/api/v1`, `/v1/traces` and the health
  endpoints. `/metrics` is better kept on the internal network.

## Health and monitoring

| Endpoint | Meaning |
| --- | --- |
| `GET /healthz` | The process is up (liveness) |
| `GET /readyz` | The database is reachable and migrated (readiness); 503 otherwise |
| `GET /metrics` | Prometheus metrics: requests by route and status, request durations, ingested traces and spans, rejected and dropped data by reason, retention deletions, unexpected errors |

Logs are one JSON object per line on stderr. Every request is logged with its route, status,
duration, request id, project and the id of the API key that made it — never the key itself, and
never prompt or output content. Database queries slower than `SCOPE_SLOW_QUERY_MS` (1 s) are
logged with their SQL and without their values.

Worth alerting on: `/readyz` failing, a rising `scope_unexpected_errors_total`, a rising
`scope_ingest_rejected_total` (clients sending what the server refuses), and
`scope_ingest_dropped_spans_total` (traces over the span limit).

## The database

`scope db status` shows where the database is, whether its schema is current, its size and what
each project holds. Run it inside the container with `docker compose exec scope scope db status`.

### Migrations and upgrades

**Upgrading is automatic.** A newer SCOPE applies every migration the database is missing, in
order, when the server (or any `scope` command) opens it — from any earlier version, with no
intermediate versions needed. With `SCOPE_AUTO_MIGRATE=false` nothing is migrated automatically:
`/readyz` reports pending migrations until you run `scope db migrate`.

**Downgrading is not possible.** Migrations only go forward. SCOPE 0.4 and later refuse to open a
database that a newer SCOPE has migrated — with or without auto-migration — with the message
"This database was migrated by a newer SCOPE (…)", and never read or write it; `scope db status`
names the newer migrations. **SCOPE 0.3 and earlier** refuse only when they try to migrate (the
default), with "corrupted migrations: previously executed migration … is missing"; with
`SCOPE_AUTO_MIGRATE=false` they would open the newer database. Do not run an older version
against an upgraded database: to go back, restore the backup taken before the upgrade.

**Back up before every upgrade** (below) — it is the only way back.

| SCOPE | Adds | Can the previous version open the database afterwards? |
| --- | --- | --- |
| 0.1 | `0001_initial` | — |
| 0.2 | `0002_run_comparisons` | No (0.1 fails to migrate it) |
| 0.3 | nothing | Yes: 0.2 opens a 0.3 database |
| 0.4 | `0003_run_manifest`, `0004_window_indexes` | No: 0.3 refuses it (verified with the 0.3.0 image) |

To upgrade a Compose deployment:

```bash
docker compose exec -T postgres pg_dump -U scope --format=custom scope > scope-before-upgrade.dump
git pull                           # or set SCOPE_IMAGE to the new version
docker compose up -d --build       # the new server applies migrations on start
docker compose exec scope scope db status
```

## Backups

Everything SCOPE stores is in its database: runs, traces, evaluations, workflow versions,
stored comparisons and API key hashes. Baseline files live in your repositories, not in SCOPE.
SCOPE does not back itself up; use the database's own tools.

**PostgreSQL:** back up with `pg_dump` and restore with `pg_restore`, or use your provider's
snapshots and point-in-time recovery.

```bash
pg_dump --format=custom --file=scope.dump "$SCOPE_DATABASE_URL"
pg_restore --clean --if-exists --dbname="$SCOPE_DATABASE_URL" scope.dump

# with deploy/compose.yaml (-T: no terminal, so the binary dump is not altered)
docker compose exec -T postgres pg_dump -U scope --format=custom scope > scope.dump
docker compose exec -T postgres pg_restore -U scope --clean --if-exists --dbname=scope < scope.dump
```

**SQLite:** `scope db backup <file>` writes a consistent copy while SCOPE keeps running (SQLite's
`VACUUM INTO`). Do not copy the `.db` file of a running server by hand: recent writes may still be
in its `-wal` file, and a copy of the two taken at different moments can be inconsistent. To
restore, stop SCOPE and put the backup in the database's place.

## Keeping the database in bounds

Traces accumulate. Delete what you no longer need:

```bash
scope prune --older-than 30d               # shows what would be deleted
scope prune --older-than 30d --yes         # deletes it
scope prune --older-than 7d --only traces --yes   # application traces only; keep runs
```

Or let the server do it: `SCOPE_RETENTION=30d` deletes runs and application traces older than 30
days in every project, when the server starts and every hour. Each pass is logged and counted in
`scope_retention_deleted_total`.

Deleted space is reused for new data. SQLite files do not shrink by themselves
(`scope prune … --yes --vacuum` rewrites the file, needing as much free disk as the database);
PostgreSQL's autovacuum makes the space reusable, and `VACUUM FULL` returns it to the file system
(it locks the tables while it runs).

## API keys

- **Least privilege:** applications get `ingest` keys, people and scripts `read` keys; a key
  belongs to one project.
- **Rotation:** create the new key, deploy it, check that `scope keys list` shows it in use and
  the old one no longer used, then `scope keys revoke <old id>`. Revocation is immediate.
- **Audit:** `scope keys list` shows when each key was created and last used (to the minute); the
  request log names the key id behind every request.
- Keys are stored as SHA-256 hashes and shown once. A lost key cannot be recovered: revoke it and
  create another.

## Capacity

See [performance](../performance.md) for measured ingestion rates and query times at 100,000 to
1,000,000 traces on SQLite and PostgreSQL, and the deployment boundaries they suggest.
