/**
 * SCOPE's error model.
 *
 * Every error that reaches a user carries a stable machine-readable `code`, a message that says
 * what went wrong, and — whenever we can know it — a `hint` that says how to fix it.
 */

export const ErrorCodes = {
  // configuration & usage
  configNotFound: 'config_not_found',
  configInvalid: 'config_invalid',
  usage: 'usage',
  datasetInvalid: 'dataset_invalid',
  baselineInvalid: 'baseline_invalid',
  // providers
  providerUnknown: 'provider_unknown',
  providerAuth: 'provider_auth',
  providerRateLimited: 'provider_rate_limited',
  providerUnavailable: 'provider_unavailable',
  providerBadRequest: 'provider_bad_request',
  providerModelNotFound: 'provider_model_not_found',
  providerMissingDependency: 'provider_missing_dependency',
  // execution
  stepFailed: 'step_failed',
  stepTimeout: 'step_timeout',
  templateError: 'template_error',
  functionLoadFailed: 'function_load_failed',
  evaluatorFailed: 'evaluator_failed',
  cancelled: 'cancelled',
  // storage
  storageUnavailable: 'storage_unavailable',
  storageMigrationFailed: 'storage_migration_failed',
  storageUnsupported: 'storage_unsupported',
  // api
  notFound: 'not_found',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  badRequest: 'bad_request',
  payloadTooLarge: 'payload_too_large',
  internal: 'internal',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ScopeErrorOptions {
  hint?: string | undefined;
  details?: Record<string, unknown> | undefined;
  cause?: unknown;
  /** Whether retrying the same operation may succeed. */
  retryable?: boolean | undefined;
}

export class ScopeError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: ScopeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ScopeError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

export function isScopeError(error: unknown, code?: ErrorCode): error is ScopeError {
  return error instanceof ScopeError && (code === undefined || error.code === code);
}

/** Serializable description of an error, stored on traces and spans. */
export interface ErrorInfo {
  type: string;
  message: string;
  code?: string;
  hint?: string;
  stack?: string;
}

export function toErrorInfo(error: unknown, options: { includeStack?: boolean } = {}): ErrorInfo {
  if (error instanceof ScopeError) {
    const info: ErrorInfo = { type: error.name, message: error.message, code: error.code };
    if (error.hint) info.hint = error.hint;
    if (options.includeStack && error.stack) info.stack = error.stack;
    return info;
  }
  if (error instanceof Error) {
    const info: ErrorInfo = { type: error.name || 'Error', message: error.message };
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') info.code = code;
    if (options.includeStack && error.stack) info.stack = error.stack;
    return info;
  }
  return { type: 'Error', message: typeof error === 'string' ? error : String(error) };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}
