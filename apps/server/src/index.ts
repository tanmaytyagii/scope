/**
 * @scope-ai/server — SCOPE's HTTP API, trace ingestion and dashboard hosting.
 *
 *   const { url, close } = await startServer({
 *     store, auth: { mode: 'api-key' }, host: '0.0.0.0', port: 4700, webRoot: findWebRoot(),
 *   });
 */
export { createApp, type ScopeApp } from './app.ts';
export { ServerMetrics } from './metrics.ts';
export {
  isLoopbackHost,
  type RunningServer,
  type StartServerOptions,
  startServer,
} from './server.ts';
export { findWebRoot } from './static.ts';
export type { AppOptions, AuthConfig } from './types.ts';
