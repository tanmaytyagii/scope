import { asText, ErrorCodes, type JsonValue, ScopeError } from '@scope-ai/core';

/** Parses a JSON column. Both dialects return JSON columns as text (see dialects.ts). */
export function readJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

export function readJsonOrNull<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return readJson<T>(value);
}

export function writeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function writeJsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function preview(value: JsonValue | null, max = 280): string {
  if (value === null) return '';
  const text = asText(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Escapes LIKE wildcards; use with `escape '\'`. */
export function likePattern(text: string): string {
  return `%${text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ─── keyset pagination ───────────────────────────────────────────────────────────────────────

export interface Cursor {
  /** Sort value of the last item. */
  v: number | string;
  /** Id of the last item (tie-breaker). */
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.v, cursor.id])).toString('base64url');
}

export function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(parsed) &&
      (typeof parsed[0] === 'number' || typeof parsed[0] === 'string') &&
      typeof parsed[1] === 'string'
    ) {
      return { v: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw new ScopeError(ErrorCodes.badRequest, 'Invalid pagination cursor', {
    hint: 'Pass the nextCursor value from a previous response unchanged.',
  });
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(limit)));
}

export function percentileOf(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (rank - lo);
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
