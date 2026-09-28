/**
 * The only module that talks HTTP. Every request goes to this origin's /api/v1; errors carry the
 * server's envelope (code, message, hint, requestId) so the UI can show them verbatim.
 */
import type { ErrorBody } from '@scope-ai/protocol';

const KEY = 'scope.apiKey';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;
  readonly requestId: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: { hint?: string | undefined; requestId?: string | undefined } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = extra.hint;
    this.requestId = extra.requestId;
  }
}

function storage(kind: 'session' | 'local'): Storage | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

export function getApiKey(): string | null {
  return storage('session')?.getItem(KEY) ?? storage('local')?.getItem(KEY) ?? null;
}

/** Keeps the key for this tab only, or on this device when `remember` is set. */
export function setApiKey(key: string, remember: boolean): void {
  clearApiKey();
  storage(remember ? 'local' : 'session')?.setItem(KEY, key);
}

export function clearApiKey(): void {
  storage('session')?.removeItem(KEY);
  storage('local')?.removeItem(KEY);
}

/** Fired when the server rejects the key, so the app can ask for a new one. */
export const UNAUTHORIZED_EVENT = 'scope:unauthorized';

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export function apiUrl(path: string, params: QueryParams = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return `/api/v1${path}${query ? `?${query}` : ''}`;
}

export async function apiGet<T>(
  path: string,
  params: QueryParams = {},
  options: { signal?: AbortSignal | undefined; apiKey?: string | null } = {},
): Promise<T> {
  const key = options.apiKey === undefined ? getApiKey() : options.apiKey;
  let response: Response;
  try {
    response = await fetch(apiUrl(path, params), {
      headers: {
        accept: 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      signal: options.signal ?? null,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(0, 'network', 'Cannot reach the SCOPE server', {
      hint: 'Check that `scope ui` (or `scope server`) is still running, then retry.',
    });
  }
  if (response.ok) return (await response.json()) as T;

  let body: ErrorBody | null = null;
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // not an envelope (e.g. a proxy error page)
  }
  const error = body?.error
    ? new ApiError(response.status, body.error.code, body.error.message, {
        hint: body.error.hint,
        requestId: body.error.requestId,
      })
    : new ApiError(response.status, 'http_error', `The server answered ${response.status}`);
  if (response.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  throw error;
}
