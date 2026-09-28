/**
 * Loading project modules: `function` step implementations and custom evaluators.
 *
 * These run with the CLI's privileges, like a test runner running test files. SCOPE only loads
 * modules referenced by the project's own workflow files, never from datasets or remote sources.
 */
import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ErrorCodes, ScopeError } from '@scope-ai/core';

const cache = new Map<string, Promise<Record<string, unknown>>>();

export function isModulePath(ref: string): boolean {
  return (
    ref.startsWith('./') ||
    ref.startsWith('../') ||
    ref.startsWith('/') ||
    /\.(?:m?[jt]s|cjs)$/.test(ref)
  );
}

export async function loadModule(ref: string, baseDir: string): Promise<Record<string, unknown>> {
  const path = resolve(baseDir, ref);
  if (!existsSync(path)) {
    throw new ScopeError(ErrorCodes.functionLoadFailed, `Module not found: ${ref}`, {
      hint: `Paths are relative to the workflow file (${baseDir}).`,
    });
  }
  let pending = cache.get(path);
  if (!pending) {
    pending = import(pathToFileURL(path).href).catch((error: Error) => {
      cache.delete(path);
      const ts = ['.ts', '.mts', '.cts'].includes(extname(path));
      throw new ScopeError(
        ErrorCodes.functionLoadFailed,
        `Could not load ${ref}: ${error.message}`,
        {
          hint:
            ts &&
            /Unknown file extension|strip-types|ERR_UNKNOWN_FILE_EXTENSION/.test(error.message)
              ? 'Loading TypeScript modules needs Node.js 22.18 or newer. Upgrade Node, or write the module in JavaScript (.mjs).'
              : 'Fix the error in the module; it is loaded as an ES module.',
          cause: error,
        },
      );
    });
    cache.set(path, pending);
  }
  return pending;
}

export async function loadExport<T>(
  ref: string,
  exportName: string,
  baseDir: string,
  what: string,
): Promise<T> {
  const mod = await loadModule(ref, baseDir);
  const value = mod[exportName];
  if (value === undefined) {
    const available = Object.keys(mod).filter((k) => k !== '__esModule');
    throw new ScopeError(ErrorCodes.functionLoadFailed, `${ref} has no export "${exportName}"`, {
      hint: available.length
        ? `Exports: ${available.join(', ')}. Set the export name for this ${what}.`
        : `Export the ${what} as default.`,
    });
  }
  return value as T;
}
