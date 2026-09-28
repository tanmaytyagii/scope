/**
 * Maps vendor SDK errors to SCOPE errors with actionable hints.
 */
import { ErrorCodes, ScopeError } from '@scope-ai/core';

export interface ErrorContext {
  provider: string;
  model: string;
  /** Environment variable that normally holds the credential, for hints. */
  credentialEnv?: string;
  baseUrl?: string;
}

function apiMessage(error: unknown): string {
  const e = error as {
    error?: { error?: { message?: unknown }; message?: unknown };
    message?: unknown;
  };
  const nested = e.error?.error?.message ?? e.error?.message;
  if (typeof nested === 'string' && nested) return nested;
  const message = typeof e.message === 'string' ? e.message : String(error);
  // SDK messages look like "400 {json}" or "401 Incorrect API key"; drop the status prefix.
  return message.replace(/^\d{3}\s+/, '').slice(0, 500);
}

export function isAbortError(error: unknown): boolean {
  const names = [
    (error as { name?: unknown })?.name,
    (error as { constructor?: { name?: unknown } })?.constructor?.name,
  ];
  return names.some((n) => n === 'AbortError' || n === 'APIUserAbortError' || n === 'TimeoutError');
}

export function toProviderError(error: unknown, ctx: ErrorContext): unknown {
  if (error instanceof ScopeError || isAbortError(error)) return error;
  const status = (error as { status?: unknown })?.status;
  // SDK errors keep name "Error"; the class name identifies them.
  const name = `${String((error as { name?: unknown })?.name ?? '')} ${String((error as { constructor?: { name?: unknown } })?.constructor?.name ?? '')}`;
  const target = `${ctx.provider}:${ctx.model}`;
  const details = {
    provider: ctx.provider,
    model: ctx.model,
    ...(typeof status === 'number' ? { status } : {}),
  };

  if (typeof status === 'number') {
    const message = apiMessage(error);
    if (status === 401) {
      return new ScopeError(
        ErrorCodes.providerAuth,
        `${ctx.provider} rejected the credentials (401): ${message}`,
        {
          hint: ctx.credentialEnv
            ? `Check that ${ctx.credentialEnv} holds a valid, active key.`
            : 'Check the API key configured for this provider.',
          details,
          cause: error,
        },
      );
    }
    if (status === 403) {
      return new ScopeError(
        ErrorCodes.providerAuth,
        `${ctx.provider} denied access to ${target} (403): ${message}`,
        {
          hint: 'The key is valid but not allowed to use this model or endpoint. Check its permissions and organization.',
          details,
          cause: error,
        },
      );
    }
    if (status === 404) {
      return new ScopeError(
        ErrorCodes.providerModelNotFound,
        `${ctx.provider} could not find model "${ctx.model}": ${message}`,
        {
          hint: `Check the model name in the workflow (${target}) and that your account can use it.`,
          details,
          cause: error,
        },
      );
    }
    if (status === 429) {
      return new ScopeError(
        ErrorCodes.providerRateLimited,
        `${ctx.provider} rate limit reached for ${target}: ${message}`,
        {
          hint: 'Lower --concurrency, raise the provider max_retries in scope.yaml, or wait and retry.',
          details,
          retryable: true,
          cause: error,
        },
      );
    }
    if (status === 408 || status >= 500) {
      return new ScopeError(
        ErrorCodes.providerUnavailable,
        `${ctx.provider} is unavailable (${status}): ${message}`,
        {
          hint: 'This is usually temporary. SCOPE already retried; run again later or raise max_retries.',
          details,
          retryable: true,
          cause: error,
        },
      );
    }
    return new ScopeError(
      ErrorCodes.providerBadRequest,
      `${ctx.provider} rejected the request for ${target} (${status}): ${message}`,
      {
        hint: 'Check the step arguments (max_tokens, response_format, provider_options) against the provider documentation.',
        details,
        cause: error,
      },
    );
  }

  if (
    name.includes('Connection') ||
    /ECONNREFUSED|ENOTFOUND|fetch failed/i.test(String((error as Error)?.message))
  ) {
    return new ScopeError(
      ErrorCodes.providerUnavailable,
      `Could not connect to ${ctx.provider}${ctx.baseUrl ? ` at ${ctx.baseUrl}` : ''}: ${apiMessage(error)}`,
      {
        hint: ctx.baseUrl
          ? 'Check base_url in scope.yaml and that the server is running and reachable.'
          : 'Check your network connection and any proxy settings.',
        details,
        retryable: true,
        cause: error,
      },
    );
  }
  if (/api key|apikey|credential|authentication/i.test(String((error as Error)?.message))) {
    return new ScopeError(ErrorCodes.providerAuth, `${ctx.provider}: ${apiMessage(error)}`, {
      hint: ctx.credentialEnv
        ? `Set ${ctx.credentialEnv}, or add api_key under providers.${ctx.provider} in scope.yaml.`
        : undefined,
      details,
      cause: error,
    });
  }
  return error;
}
