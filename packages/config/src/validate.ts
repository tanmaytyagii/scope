/**
 * Converts Zod validation issues into positioned, actionable diagnostics.
 */
import { suggest } from '@scope-ai/core';
import type { z } from 'zod';
import { type Diagnostic, formatPath, type PathSegment } from './diagnostics.ts';
import { positioned, type SourceFile } from './source.ts';

type AnySchema = z.ZodType;
type Issue = z.core.$ZodIssue;

interface Def {
  type: string;
  shape?: Record<string, AnySchema>;
  element?: AnySchema;
  innerType?: AnySchema;
  options?: AnySchema[];
  valueType?: AnySchema;
  in?: AnySchema;
  out?: AnySchema;
  getter?: () => AnySchema;
}

function defOf(schema: AnySchema): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

function unwrap(schema: AnySchema): AnySchema[] {
  const def = defOf(schema);
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
      return def.innerType ? unwrap(def.innerType) : [schema];
    case 'pipe':
      return def.in ? unwrap(def.in) : [schema];
    case 'lazy':
      return def.getter ? unwrap(def.getter()) : [schema];
    case 'union':
      return (def.options ?? []).flatMap(unwrap);
    default:
      return [schema];
  }
}

/** The object keys a schema accepts at a document path, for "did you mean" suggestions. */
export function knownKeysAt(schema: AnySchema, path: readonly PathSegment[]): string[] {
  let candidates = unwrap(schema);
  for (const seg of path) {
    const next: AnySchema[] = [];
    for (const c of candidates) {
      const def = defOf(c);
      if (def.type === 'object' && def.shape && typeof seg === 'string' && seg in def.shape) {
        next.push(...unwrap(def.shape[seg] as AnySchema));
      } else if (def.type === 'array' && def.element && typeof seg === 'number') {
        next.push(...unwrap(def.element));
      } else if (def.type === 'record' && def.valueType) {
        next.push(...unwrap(def.valueType));
      }
    }
    candidates = next;
  }
  const keys = new Set<string>();
  for (const c of candidates) {
    const def = defOf(c);
    if (def.type === 'object' && def.shape) for (const k of Object.keys(def.shape)) keys.add(k);
  }
  return [...keys];
}

function valueAt(data: unknown, path: readonly PathSegment[]): unknown {
  let current = data;
  for (const seg of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[seg];
  }
  return current;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'string')
    return `the string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
  return `${typeof value} ${String(value)}`;
}

function expectedName(expected: string): string {
  switch (expected) {
    case 'object':
      return 'a mapping';
    case 'array':
      return 'a list';
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'true or false';
    default:
      return expected;
  }
}

/** Picks the union branch whose issues go deepest into the value (the branch the user meant). */
function bestUnionBranch(branches: Issue[][]): Issue[] {
  let best = branches[0] ?? [];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const branch of branches) {
    const depth = Math.max(0, ...branch.map((i) => i.path.length));
    const rootTypeMismatch = branch.some((i) => i.path.length === 0 && i.code === 'invalid_type');
    const score = (rootTypeMismatch ? -100 : 0) + depth * 10 - branch.length;
    if (score > bestScore) {
      best = branch;
      bestScore = score;
    }
  }
  return best;
}

export function issuesToDiagnostics(
  issues: readonly Issue[],
  options: {
    source: SourceFile;
    schema: AnySchema;
    data: unknown;
    basePath?: readonly PathSegment[];
  },
): Diagnostic[] {
  const { source, schema, data } = options;
  const base = options.basePath ?? [];
  const out: Diagnostic[] = [];

  for (const issue of issues) {
    const path = [...base, ...(issue.path as PathSegment[])];
    const display = formatPath(path);

    switch (issue.code) {
      case 'unrecognized_keys': {
        const known = knownKeysAt(schema, issue.path as PathSegment[]);
        for (const key of issue.keys) {
          const guess = suggest(key, known);
          out.push(
            positioned(
              source,
              [...path, key],
              {
                severity: 'error',
                path: display,
                message: `unknown key "${key}"`,
                hint: guess
                  ? `Did you mean "${guess}"?`
                  : known.length
                    ? `Allowed keys: ${known.join(', ')}.`
                    : undefined,
              },
              { key: true },
            ),
          );
        }
        break;
      }
      case 'invalid_type': {
        const actual = valueAt(data, issue.path as PathSegment[]);
        const key = path[path.length - 1];
        if (actual === undefined) {
          out.push(
            positioned(source, path, {
              severity: 'error',
              path: formatPath(path.slice(0, -1)),
              message: `missing required key "${String(key)}"`,
              hint: `Add \`${String(key)}:\` (expected ${expectedName(issue.expected)}).`,
            }),
          );
        } else {
          out.push(
            positioned(source, path, {
              severity: 'error',
              path: display,
              message: `expected ${expectedName(issue.expected)}, got ${describeType(actual)}`,
            }),
          );
        }
        break;
      }
      case 'invalid_union': {
        const branch = bestUnionBranch(issue.errors as Issue[][]);
        const rootMismatch = branch.every((i) => i.path.length === 0 && i.code === 'invalid_type');
        if (rootMismatch) {
          const expectations = [
            ...new Set(
              (issue.errors as Issue[][]).flatMap((b) =>
                b
                  .filter((i) => i.code === 'invalid_type')
                  .map((i) => expectedName((i as { expected: string }).expected)),
              ),
            ),
          ];
          out.push(
            positioned(source, path, {
              severity: 'error',
              path: display,
              message: `expected ${expectations.join(' or ')}, got ${describeType(valueAt(data, issue.path as PathSegment[]))}`,
            }),
          );
        } else {
          out.push(...issuesToDiagnostics(branch, { source, schema, data, basePath: path }));
        }
        break;
      }
      case 'invalid_value': {
        const values = issue.values.map((v) => String(v));
        const actual = valueAt(data, issue.path as PathSegment[]);
        const guess = typeof actual === 'string' ? suggest(actual, values) : undefined;
        out.push(
          positioned(source, path, {
            severity: 'error',
            path: display,
            message: `${describeType(actual)} is not allowed; expected one of: ${values.join(', ')}`,
            hint: guess ? `Did you mean "${guess}"?` : undefined,
          }),
        );
        break;
      }
      case 'too_small':
      case 'too_big': {
        out.push(
          positioned(source, path, {
            severity: 'error',
            path: display,
            message: friendlyBound(issue),
          }),
        );
        break;
      }
      default:
        out.push(
          positioned(source, path, { severity: 'error', path: display, message: issue.message }),
        );
    }
  }
  return dedupe(out);
}

function friendlyBound(issue: Issue): string {
  const i = issue as Issue & {
    origin?: string;
    minimum?: number | bigint;
    maximum?: number | bigint;
    inclusive?: boolean;
  };
  if (i.code === 'too_small') {
    if (i.origin === 'array')
      return `must contain at least ${i.minimum} item${Number(i.minimum) === 1 ? '' : 's'}`;
    if (i.origin === 'string')
      return Number(i.minimum) === 1
        ? 'must not be empty'
        : `must be at least ${i.minimum} characters`;
    return `must be ${i.inclusive ? '≥' : '>'} ${i.minimum}`;
  }
  if (i.origin === 'array') return `must contain at most ${i.maximum} items`;
  if (i.origin === 'string') return `must be at most ${i.maximum} characters`;
  return `must be ${i.inclusive ? '≤' : '<'} ${i.maximum}`;
}

function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.line}:${d.column}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
