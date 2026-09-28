/**
 * Generates the OpenAPI 3.1 document for `/api/v1` from the route table and the registered
 * schemas, so the documentation cannot drift from the contract.
 */
import { SCOPE_VERSION } from '@scope-ai/core';
import { z } from 'zod';
import { components } from './common.ts';
import { API_BASE, ROUTES, type RouteDefinition } from './routes.ts';

type JsonSchema = Record<string, unknown>;

const STATUS_TEXT: Record<number, string> = {
  400: 'The request is invalid; `error.details` names the failing fields.',
  401: 'Authentication is required and the API key is missing or invalid.',
  403: 'The API key lacks the scope this operation needs, or belongs to another project.',
  404: 'The resource does not exist in this project.',
  413: 'The request body exceeds the server’s limit.',
  415: 'The request body must be application/json.',
  500: 'An unexpected server error. The response carries a requestId for the logs.',
};

/**
 * Cleans generated JSON Schema for publication: drops per-component `$schema`/`$id`, the long
 * date-time regex (the `format` says it), and `additionalProperties: false` — clients must
 * tolerate new fields (the API changes additively) and the server ignores unknown input fields.
 */
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  const out: JsonSchema = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === '$schema' || key === '$id') continue;
    if (key === 'additionalProperties' && v === false) continue;
    if (key === 'pattern' && (value as JsonSchema).format === 'date-time') continue;
    out[key] = clean(v);
  }
  return out;
}

function refFor(schema: z.ZodType): JsonSchema {
  const meta = components.get(schema);
  if (meta) return { $ref: `#/components/schemas/${meta.id}` };
  return clean(
    z.toJSONSchema(schema, { metadata: components, unrepresentable: 'any' }),
  ) as JsonSchema;
}

function queryParameters(query: z.ZodObject): JsonSchema[] {
  const json = z.toJSONSchema(query, { io: 'input', unrepresentable: 'any' }) as {
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, schema]) => {
    const { description, ...rest } = clean(schema) as JsonSchema;
    return {
      name,
      in: 'query',
      required: json.required?.includes(name) ?? false,
      ...(description ? { description } : {}),
      schema: rest,
    };
  });
}

function operation(route: RouteDefinition): JsonSchema {
  const responses: JsonSchema = {
    200: {
      description: 'OK',
      content: { 'application/json': { schema: refFor(route.response) } },
    },
  };
  const statuses = new Set(route.errors ?? []);
  if (route.access !== 'public') {
    statuses.add(401);
    statuses.add(403);
  }
  statuses.add(500);
  for (const status of [...statuses].sort()) {
    responses[status] = {
      description: STATUS_TEXT[status] ?? 'Error',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  const parameters = [
    ...(route.params ?? []).map((p) => ({
      name: p.name,
      in: 'path',
      required: true,
      description: p.description,
      schema: { type: 'string' },
    })),
    ...(route.query ? queryParameters(route.query) : []),
  ];
  return {
    operationId: route.operationId,
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    tags: [route.tag],
    // Public operations need no key; others need a key with this scope when the server uses keys.
    ...(route.access === 'public' ? { security: [] } : { 'x-scope-key-scope': route.access }),
    ...(parameters.length ? { parameters } : {}),
    ...(route.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: refFor(route.body) } },
          },
        }
      : {}),
    responses,
  };
}

export function buildOpenApiDocument(options: { serverUrl?: string } = {}): JsonSchema {
  const paths: Record<string, JsonSchema> = {};
  for (const route of ROUTES) {
    const path = `${API_BASE}${route.path}`;
    paths[path] = { ...paths[path], [route.method]: operation(route) };
  }
  const generated = z.toJSONSchema(components, {
    uri: (id) => `#/components/schemas/${id}`,
    unrepresentable: 'any',
  }) as { schemas: Record<string, unknown> };
  const schemas: Record<string, unknown> = {};
  for (const [id, schema] of Object.entries(generated.schemas)) schemas[id] = clean(schema);
  return {
    openapi: '3.1.0',
    info: {
      title: 'SCOPE API',
      version: SCOPE_VERSION,
      description:
        'Read runs, traces, evaluations and analytics, and ingest traces from SDKs. The /v1 contract changes only additively. Errors use one envelope: { error: { code, message, hint?, details?, requestId } }.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    ...(options.serverUrl ? { servers: [{ url: options.serverUrl }] } : {}),
    security: [{ apiKey: [] }],
    tags: [
      { name: 'Server' },
      { name: 'Analytics' },
      { name: 'Runs' },
      { name: 'Traces' },
      { name: 'Evaluations' },
      { name: 'Workflows' },
      { name: 'Ingestion' },
    ],
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A project API key (scope_…). Not needed for a local `scope ui` server, which has no authentication.',
        },
      },
      schemas,
    },
  };
}
