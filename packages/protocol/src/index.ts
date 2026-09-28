/**
 * @scope-ai/protocol — the contract of SCOPE's HTTP API.
 *
 * Zod schemas for every request and response of `/api/v1`, the ingestion format SDKs send,
 * the route table, and the generated OpenAPI document. The dashboard imports the types only.
 */
export * from './common.ts';
export * from './domain.ts';
export * from './ingest.ts';
export { buildOpenApiDocument } from './openapi.ts';
export * from './queries.ts';
export * from './resources.ts';
export * from './routes.ts';
