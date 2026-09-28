/**
 * Building blocks shared by every schema in the contract.
 *
 * Every schema that should appear under `components.schemas` in the OpenAPI document is
 * registered in `components` with a stable id.
 */
import { z } from 'zod';

export interface ComponentMeta {
  id: string;
  description?: string;
}

/** Registry of named schemas, rendered as OpenAPI `components.schemas`. */
export const components = z.registry<ComponentMeta>();

/** An ISO-8601 UTC timestamp, e.g. "2026-09-28T14:03:12.345Z". */
export const Timestamp = z.iso.datetime().describe('ISO-8601 timestamp in UTC');

export const JsonValue = z.json().register(components, {
  id: 'JsonValue',
  description: 'Any JSON value.',
});

export const JsonObject = z.record(z.string(), JsonValue);

export const ErrorBody = z
  .strictObject({
    error: z.strictObject({
      code: z.string().describe('Stable machine-readable error code, e.g. "not_found".'),
      message: z.string().describe('What went wrong.'),
      hint: z.string().optional().describe('How to fix it, when known.'),
      details: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Structured details, e.g. the failing fields of a validation error.'),
      requestId: z.string().describe('Also sent as the x-request-id response header.'),
    }),
  })
  .register(components, {
    id: 'Error',
    description: 'The error envelope for every non-2xx response.',
  });

export type ErrorBody = z.output<typeof ErrorBody>;

/** A page of results from a list endpoint with keyset pagination. */
export function pageOf<T extends z.ZodType>(item: T, id: string) {
  return z
    .strictObject({
      items: z.array(item),
      nextCursor: z
        .string()
        .nullable()
        .describe('Pass as `cursor` to fetch the next page; null on the last page.'),
    })
    .register(components, { id });
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Query parameters shared by list endpoints. */
export const PageQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .describe(`Items per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`),
  cursor: z.string().max(512).optional().describe('The `nextCursor` of the previous page.'),
});

/** Time windows accepted by aggregate endpoints. */
export const TIME_WINDOWS = ['24h', '7d', '30d', '90d'] as const;
export type TimeWindowName = (typeof TIME_WINDOWS)[number];

export const WindowQuery = z.object({
  window: z.enum(TIME_WINDOWS).optional().describe('How far back to aggregate (default 7d).'),
});

export type WindowQuery = z.output<typeof WindowQuery>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Length and time-series bucket width of each window. */
export const WINDOW_SPANS: Readonly<Record<TimeWindowName, { ms: number; bucketMs: number }>> = {
  '24h': { ms: DAY, bucketMs: HOUR },
  '7d': { ms: 7 * DAY, bucketMs: 6 * HOUR },
  '30d': { ms: 30 * DAY, bucketMs: DAY },
  '90d': { ms: 90 * DAY, bucketMs: 3 * DAY },
};
