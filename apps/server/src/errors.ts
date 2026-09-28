/**
 * The error envelope. Every non-2xx response under /api/v1 has the shape
 * `{ error: { code, message, hint?, details?, requestId } }` and an accurate status.
 */
import { type ErrorCode, ErrorCodes, isScopeError, ScopeError } from '@scope-ai/core';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { AppEnv } from './types.ts';

const STATUS_BY_CODE: Partial<Record<ErrorCode, ContentfulStatusCode>> = {
  [ErrorCodes.badRequest]: 400,
  [ErrorCodes.usage]: 400,
  [ErrorCodes.unauthorized]: 401,
  [ErrorCodes.forbidden]: 403,
  [ErrorCodes.notFound]: 404,
  [ErrorCodes.payloadTooLarge]: 413,
  [ErrorCodes.unsupportedMediaType]: 415,
  [ErrorCodes.storageUnavailable]: 503,
};

export function statusFor(error: ScopeError): ContentfulStatusCode {
  return STATUS_BY_CODE[error.code] ?? 500;
}

export function errorBody(
  requestId: string,
  code: string,
  message: string,
  extra: { hint?: string | undefined; details?: Record<string, unknown> | undefined } = {},
) {
  return {
    error: {
      code,
      message,
      ...(extra.hint ? { hint: extra.hint } : {}),
      ...(extra.details ? { details: extra.details } : {}),
      requestId,
    },
  };
}

export function sendError(c: Context<AppEnv>, error: ScopeError): Response {
  return c.json(
    errorBody(c.get('requestId'), error.code, error.message, {
      hint: error.hint,
      details: error.details,
    }),
    statusFor(error),
  );
}

/** Converts Zod issues into a ScopeError whose details name each failing field. */
export function validationError(where: 'query' | 'body', issues: z.core.$ZodIssue[]): ScopeError {
  const fields = issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
  const first = fields[0];
  const message =
    where === 'query'
      ? `Invalid query parameter ${first?.path ?? ''}: ${first?.message ?? 'invalid value'}`
      : `Invalid request body at ${first?.path ?? '(root)'}: ${first?.message ?? 'invalid value'}`;
  return new ScopeError(ErrorCodes.badRequest, message, {
    hint:
      where === 'body'
        ? 'Check the request against the IngestRequest schema at /api/v1/openapi.json.'
        : 'See /api/v1/openapi.json for the accepted parameters.',
    details: { issues: fields, ...(issues.length > 20 ? { truncated: issues.length } : {}) },
  });
}

export function notFound(what: string, hint?: string): ScopeError {
  return new ScopeError(ErrorCodes.notFound, `${what} not found`, { hint });
}

/** Maps any thrown value to a ScopeError, or null when it is unexpected (a bug). */
export function toScopeError(error: unknown): ScopeError | null {
  if (isScopeError(error)) return error;
  if (error instanceof HTTPException) {
    if (error.status === 413) {
      return new ScopeError(ErrorCodes.payloadTooLarge, 'Request body is too large', {
        hint: 'Send fewer traces per request. The server limit is set by SCOPE_MAX_INGEST_BYTES.',
      });
    }
    if (error.status === 401) return new ScopeError(ErrorCodes.unauthorized, error.message);
    if (error.status >= 400 && error.status < 500)
      return new ScopeError(ErrorCodes.badRequest, error.message || 'Bad request');
  }
  return null;
}
