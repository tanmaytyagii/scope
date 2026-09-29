/**
 * The SCOPE HTTP application: /api/v1, health and metrics endpoints, and the dashboard.
 *
 * Created in-process by `scope ui` / `scope server`, and by tests through `app.request()`.
 */
import {
  DEFAULT_PRIVACY_POLICY,
  ErrorCodes,
  newId,
  ScopeError,
  silentLogger,
} from '@scope-ai/core';
import { buildOpenApiDocument, INGEST_LIMITS } from '@scope-ai/protocol';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { registerApi } from './api.ts';
import { requireAccess } from './auth.ts';
import { errorBody, sendError, toScopeError } from './errors.ts';
import { ServerMetrics } from './metrics.ts';
import { handleOtlpTraces } from './otlp/route.ts';
import { registerDashboard } from './static.ts';
import type { AppEnv, AppOptions, Deps } from './types.ts';

export interface ScopeApp {
  app: Hono<AppEnv>;
  metrics: ServerMetrics;
}

/** The dashboard is a static bundle served from this origin; nothing else may run or connect. */
const CONTENT_SECURITY_POLICY = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

/** Lowercase hostname without IPv6 brackets. */
function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

export function createApp(options: AppOptions): ScopeApp {
  const metrics = new ServerMetrics();
  const deps: Deps = {
    store: options.store,
    auth: options.auth,
    privacy: options.privacy ?? DEFAULT_PRIVACY_POLICY,
    pricing: options.pricing ?? {},
    logger: options.logger ?? silentLogger,
    metrics,
    maxIngestBytes: options.maxIngestBytes ?? INGEST_LIMITS.maxBodyBytes,
    maxSpansPerTrace: options.maxSpansPerTrace ?? INGEST_LIMITS.maxSpansPerTrace,
    now: options.now ?? Date.now,
  };
  const app = new Hono<AppEnv>();

  app.use(requestId({ generator: () => newId('req'), limitLength: 64 }));

  // Access log and metrics. Route patterns, not raw paths, keep label cardinality bounded.
  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    const durationMs = performance.now() - started;
    const matched = c.req.routePath;
    const route = matched === '*' || matched === '/*' ? 'dashboard' : matched;
    const status = String(c.res.status);
    metrics.httpRequests.inc({ method: c.req.method, route, status });
    metrics.httpDuration.observe({ method: c.req.method, route }, durationMs / 1000);
    if (route !== 'dashboard' || c.res.status >= 400) {
      // Which key acted on which project (the key's id, never the key): an audit trail.
      const key = c.get('apiKey');
      const project = c.get('project');
      deps.logger.info('request', {
        method: c.req.method,
        route,
        status: c.res.status,
        durationMs: Math.round(durationMs * 10) / 10,
        requestId: c.get('requestId'),
        ...(project ? { project: project.slug } : {}),
        ...(key ? { keyId: key.id } : {}),
      });
    }
  });

  app.use(
    secureHeaders({
      contentSecurityPolicy: CONTENT_SECURITY_POLICY,
      referrerPolicy: 'no-referrer',
      crossOriginResourcePolicy: 'same-origin',
      crossOriginEmbedderPolicy: false,
    }),
  );

  // DNS-rebinding protection for servers without authentication: a page on another site can
  // point its own hostname at 127.0.0.1, but it cannot make the browser send a loopback Host.
  if (options.allowedHosts) {
    const allowed = new Set(options.allowedHosts.map(normalizeHost));
    app.use(async (c, next) => {
      const host = normalizeHost(new URL(c.req.url).hostname);
      if (allowed.has(host)) return next();
      metrics.httpRequests.inc({ method: c.req.method, route: 'blocked-host', status: '403' });
      return c.json(
        errorBody(
          c.get('requestId'),
          ErrorCodes.forbidden,
          `Requests addressed to "${host}" are not accepted`,
          {
            hint: `This server has no authentication and only answers requests to ${[...allowed].join(', ')}. Open it at http://localhost:<port>.`,
          },
        ),
        403,
      );
    });
  }

  const ingestLimit = bodyLimit({
    maxSize: deps.maxIngestBytes,
    onError: () => {
      metrics.ingestRejected.inc({ reason: 'too_large' });
      throw new ScopeError(
        ErrorCodes.payloadTooLarge,
        `Request body exceeds ${deps.maxIngestBytes.toLocaleString('en-US')} bytes`,
        {
          hint: 'Send fewer traces per request. The server limit is set by SCOPE_MAX_INGEST_BYTES.',
        },
      );
    },
  });
  app.use('/api/v1/ingest', ingestLimit);
  app.use('/v1/traces', ingestLimit);

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.get('/readyz', async (c) => {
    try {
      await deps.store.ping();
      const { pending } = await deps.store.migrationState();
      if (pending.length > 0) {
        return c.json(
          { status: 'unavailable', reason: `pending migrations: ${pending.join(', ')}` },
          503,
        );
      }
      return c.json({ status: 'ready' });
    } catch (error) {
      deps.logger.warn('readiness check failed', { error });
      return c.json({ status: 'unavailable', reason: 'database unreachable' }, 503);
    }
  });

  app.get('/metrics', (c) =>
    c.body(metrics.render(), 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }),
  );

  let openapi: object | null = null;
  app.get('/api/v1/openapi.json', (c) => {
    openapi ??= buildOpenApiDocument();
    return c.json(openapi);
  });

  registerApi(app, deps);
  // OTLP/HTTP, at the path the OpenTelemetry specification defines for traces.
  app.post('/v1/traces', requireAccess(deps, 'ingest'), (c) => handleOtlpTraces(c, deps));

  app.all('/api/*', (c) =>
    c.json(
      errorBody(c.get('requestId'), ErrorCodes.notFound, `No route ${c.req.method} ${c.req.path}`, {
        hint: 'See /api/v1/openapi.json for the available operations.',
      }),
      404,
    ),
  );

  registerDashboard(app, options.webRoot ?? null);

  app.onError((error, c) => {
    const known = toScopeError(error);
    if (known) return sendError(c, known);
    const requestId = c.get('requestId') ?? 'unknown';
    metrics.unexpectedErrors.inc();
    deps.logger.error('unexpected error', { error, requestId, route: c.req.routePath });
    options.onError?.(error, { requestId, route: c.req.routePath });
    return c.json(
      errorBody(requestId, ErrorCodes.internal, 'Unexpected server error', {
        hint: 'The server logged the error with this requestId. Please report it if it persists.',
      }),
      500,
    );
  });

  return { app, metrics };
}
