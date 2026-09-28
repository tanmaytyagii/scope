# 0008 — HTTP API: Hono, `/api/v1`, Zod contract, keyset pagination

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

The API serves the dashboard today and third-party clients (SDKs in other languages,
scripts, integrations) later. It must be predictable and documented from the start.

## Decision

- **Hono** on Node (`@hono/node-server`): small, dependency-free, typed, standards-based
  (`Request`/`Response`), testable in-process with `app.request()`.
- Contract in `@scope-ai/protocol` as Zod schemas; OpenAPI 3.1 generated from them and served
  at `/api/v1/openapi.json`.
- URL versioning (`/api/v1`) with an additive-only change policy.
- Plural resource nouns, `snake_case`-free JSON (`camelCase` fields), ISO-8601 timestamps.
- Keyset pagination with opaque cursors; `limit` default 50, max 200.
- One error envelope: `{ error: { code, message, hint?, details?, requestId } }`.
- Response DTOs are explicit mappings; no database row is serialized directly.

## Consequences

- Handlers stay thin: parse → call storage → map to DTO.
- The web client and future SDKs get types and docs from the same schemas.

## Alternatives considered

- **Fastify.** Excellent, but heavier and Node-specific; Hono's in-process testing and web
  standard types fit our needs.
- **GraphQL / tRPC.** tRPC couples clients to TypeScript; GraphQL adds a layer that a small,
  read-heavy API does not need.
- **Offset pagination.** Unstable under concurrent inserts and slow on deep pages.
