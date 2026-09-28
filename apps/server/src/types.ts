import type { Logger, PriceTable, PrivacyPolicy } from '@scope-ai/core';
import type { ApiKey, Project, Store } from '@scope-ai/storage';
import type { Context } from 'hono';
import type { ServerMetrics } from './metrics.ts';

/**
 * How the server authenticates requests.
 *
 * - `none`: a local server (`scope ui`). Requests act on `defaultProject`, or on the project
 *   named by the `x-scope-project` header (or the ingest body's `project`).
 * - `api-key`: a shared server (`scope server`). Every request under /api/v1 except /info
 *   needs `Authorization: Bearer scope_…`; the key's project bounds every query.
 */
export type AuthConfig = { mode: 'none'; defaultProject: Project } | { mode: 'api-key' };

export interface AppOptions {
  store: Store;
  auth: AuthConfig;
  /** Applied again to ingested payloads before storage (the SDK applies its own first). */
  privacy?: PrivacyPolicy;
  /** Project pricing overrides, shown with the built-in table. */
  pricing?: PriceTable;
  logger?: Logger;
  /** Directory with the built dashboard (index.html + assets). null disables the dashboard. */
  webRoot?: string | null;
  /** Ingest request body limit in bytes (default 5 MiB). */
  maxIngestBytes?: number;
  /** Spans stored per ingested trace (default 1,000); excess spans are dropped and counted. */
  maxSpansPerTrace?: number;
  /** Called with unexpected errors, e.g. to report them to an error tracker. */
  onError?: (error: unknown, context: { requestId: string; route: string }) => void;
  /** Clock, for tests. */
  now?: () => number;
}

export interface AppVariables {
  requestId: string;
  /** Set by the access middleware on every authenticated /api/v1 route. */
  project: Project;
  apiKey: ApiKey | null;
}

export type AppEnv = { Variables: AppVariables };

export type AppContext = Context<AppEnv>;

/** Everything route handlers need, resolved once when the app is created. */
export interface Deps {
  store: Store;
  auth: AuthConfig;
  privacy: PrivacyPolicy;
  pricing: PriceTable;
  logger: Logger;
  metrics: ServerMetrics;
  maxIngestBytes: number;
  maxSpansPerTrace: number;
  now: () => number;
}
