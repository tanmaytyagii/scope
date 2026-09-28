/**
 * Exit codes and error presentation.
 *
 *   0  success
 *   1  gates failed (the run completed, quality thresholds were not met)
 *   2  usage or configuration error
 *   3  execution, provider or storage error
 *   130 interrupted
 */
import { readFileSync } from 'node:fs';
import { ConfigError, renderDiagnostic, type Styler } from '@scope-ai/config';
import { ErrorCodes, isScopeError, type ScopeError } from '@scope-ai/core';
import type { Output } from './ui/output.ts';

export const ExitCode = {
  ok: 0,
  gatesFailed: 1,
  usage: 2,
  failure: 3,
  interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export const ISSUES_URL = 'https://github.com/tanmaytyagii/scope/issues';

const USAGE_CODES = new Set<string>([
  ErrorCodes.usage,
  ErrorCodes.configInvalid,
  ErrorCodes.configNotFound,
  ErrorCodes.datasetInvalid,
  ErrorCodes.baselineInvalid,
  ErrorCodes.providerUnknown,
  ErrorCodes.notFound,
  ErrorCodes.badRequest,
]);

/** Thrown by commands to exit with a specific code after printing their own output. */
export class ExitError extends Error {
  readonly exitCode: ExitCodeValue;
  constructor(exitCode: ExitCodeValue, message = '') {
    super(message);
    this.exitCode = exitCode;
  }
}

export function exitCodeFor(error: unknown): ExitCodeValue {
  if (error instanceof ExitError) return error.exitCode;
  if (isScopeError(error)) {
    if (error.code === ErrorCodes.cancelled) return ExitCode.interrupted;
    return USAGE_CODES.has(error.code) ? ExitCode.usage : ExitCode.failure;
  }
  return ExitCode.failure;
}

function styler(out: Output): Styler {
  const s = out.errStyle;
  return { error: s.red, warning: s.yellow, dim: s.dim, bold: s.bold, accent: s.cyan };
}

function sourceFor(error: ConfigError, file: string | undefined): string | undefined {
  if (!file) return undefined;
  if (error.sources[file]) return error.sources[file];
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function renderError(error: unknown, out: Output): void {
  if (error instanceof ExitError) {
    if (error.message) out.stderr.write(`${error.message}\n`);
    return;
  }
  if (out.json) {
    const body = isScopeError(error)
      ? {
          error: {
            code: error.code,
            message: error.message,
            ...(error.hint ? { hint: error.hint } : {}),
            ...(error instanceof ConfigError ? { diagnostics: error.diagnostics } : {}),
          },
        }
      : { error: { code: 'internal', message: (error as Error)?.message ?? String(error) } };
    out.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  }
  const s = out.errStyle;
  if (error instanceof ConfigError) {
    const blocks = error.diagnostics.map((d) =>
      renderDiagnostic(d, sourceFor(error, d.file), styler(out)),
    );
    const errors = error.diagnostics.filter((d) => d.severity === 'error').length;
    out.stderr.write(`\n${blocks.join('\n\n')}\n\n`);
    out.stderr.write(
      `${s.red(`${errors} ${errors === 1 ? 'error' : 'errors'}`)} ${s.dim('— nothing was executed.')}\n`,
    );
    return;
  }
  if (isScopeError(error)) {
    const e = error as ScopeError;
    out.stderr.write(`\n${s.red('error')}  ${e.message}\n`);
    if (e.hint) out.stderr.write(`\n  ${s.cyan('hint:')} ${e.hint}\n`);
    if (e.code === ErrorCodes.storageUnavailable || e.code === ErrorCodes.storageMigrationFailed) {
      out.stderr.write(`\n  Run ${s.bold('scope doctor')} for a full diagnosis.\n`);
    }
    if (out.verbose && e.cause)
      out.stderr.write(`\n${s.dim(String((e.cause as Error)?.stack ?? e.cause))}\n`);
    out.stderr.write(`${s.dim(`  (${e.code})`)}\n\n`);
    return;
  }
  const err = error as Error;
  out.stderr.write(`\n${s.red('error')}  Unexpected error: ${err?.message ?? String(error)}\n`);
  out.stderr.write(
    `\n  This is probably a bug in SCOPE. Please report it at ${ISSUES_URL}\n  with the command you ran and the output of ${s.bold('scope doctor')}.\n`,
  );
  if (out.verbose && err?.stack) out.stderr.write(`\n${s.dim(err.stack)}\n`);
  else out.stderr.write(`  ${s.dim('Run with --verbose for the stack trace.')}\n`);
  out.stderr.write('\n');
}
