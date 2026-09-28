/**
 * Datasets: the cases a workflow is run against.
 *
 * Supported sources: JSONL (one case per line), JSON or YAML (a list of cases, or `{ cases: [...] }`),
 * and inline `dataset: { cases: [...] }` in the workflow. A case is either structured —
 * `{ id, inputs, expected, metadata, tags }` — or flat, in which case every key other than
 * `id`, `expected`, `metadata` and `tags` is an input.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, relative, resolve } from 'node:path';
import {
  ErrorCodes,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  stableStringify,
} from '@scope-ai/core';
import { parse as parseYamlText } from 'yaml';
import { ConfigError, type Diagnostic } from './diagnostics.ts';
import type { DatasetRef, InputSpec } from './schema.ts';

export interface DatasetCase {
  id: string;
  inputs: JsonObject;
  expected: JsonValue | null;
  metadata: JsonObject;
  tags: string[];
}

export interface Dataset {
  name: string;
  /** Path relative to the project root, or null for inline cases. */
  source: string | null;
  cases: DatasetCase[];
  /** SHA-256 over the normalized cases; baselines record it to detect dataset changes. */
  hash: string;
}

const RESERVED = new Set(['id', 'inputs', 'expected', 'metadata', 'tags']);
export const MAX_CASES = 100_000;

function datasetError(
  message: string,
  file: string | undefined,
  line?: number,
  hint?: string,
): ConfigError {
  const d: Diagnostic = { severity: 'error', message };
  if (file) d.file = file;
  if (line) {
    d.line = line;
    d.column = 1;
  }
  if (hint) d.hint = hint;
  return new ConfigError([d], {}, ErrorCodes.datasetInvalid);
}

function normalizeCase(
  raw: unknown,
  where: { file?: string; line?: number; index: number },
): Omit<DatasetCase, 'id'> & { id?: string } {
  if (!isJsonObject(raw as JsonValue)) {
    throw datasetError(
      `case ${where.index + 1} must be an object`,
      where.file,
      where.line,
      'Each case is a JSON object such as {"inputs": {"question": "..."}, "expected": "..."}.',
    );
  }
  const obj = raw as JsonObject;
  if (obj.id !== undefined && typeof obj.id !== 'string' && typeof obj.id !== 'number') {
    throw datasetError(`case ${where.index + 1}: "id" must be a string`, where.file, where.line);
  }
  let inputs: JsonObject;
  if (obj.inputs !== undefined) {
    if (!isJsonObject(obj.inputs))
      throw datasetError(
        `case ${where.index + 1}: "inputs" must be an object`,
        where.file,
        where.line,
      );
    const extra = Object.keys(obj).filter((k) => !RESERVED.has(k));
    if (extra.length > 0) {
      throw datasetError(
        `case ${where.index + 1}: unexpected keys ${extra.map((k) => `"${k}"`).join(', ')} next to "inputs"`,
        where.file,
        where.line,
        'Put inputs inside "inputs", or remove "inputs" and list them at the top level.',
      );
    }
    inputs = obj.inputs;
  } else {
    inputs = {};
    for (const [k, v] of Object.entries(obj)) if (!RESERVED.has(k)) inputs[k] = v;
  }
  const metadata = obj.metadata === undefined ? {} : obj.metadata;
  if (!isJsonObject(metadata))
    throw datasetError(
      `case ${where.index + 1}: "metadata" must be an object`,
      where.file,
      where.line,
    );
  const tags = obj.tags === undefined ? [] : obj.tags;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
    throw datasetError(
      `case ${where.index + 1}: "tags" must be a list of strings`,
      where.file,
      where.line,
    );
  }
  const normalized: Omit<DatasetCase, 'id'> & { id?: string } = {
    inputs,
    expected: obj.expected === undefined ? null : obj.expected,
    metadata,
    tags: tags as string[],
  };
  if (obj.id !== undefined) normalized.id = String(obj.id);
  return normalized;
}

function assignIds(
  cases: Array<Omit<DatasetCase, 'id'> & { id?: string }>,
  file: string | undefined,
): DatasetCase[] {
  const seen = new Map<string, number>();
  const explicit = new Set<string>();
  const out: DatasetCase[] = [];
  cases.forEach((c, i) => {
    let id = c.id;
    if (id !== undefined) {
      if (explicit.has(id)) {
        throw datasetError(
          `duplicate case id "${id}" (case ${i + 1})`,
          file,
          undefined,
          'Case ids must be unique; they identify cases across runs and in baselines.',
        );
      }
      explicit.add(id);
    } else {
      // Content-derived ids stay stable when cases are reordered or inserted.
      const base = `c-${createHash('sha256').update(stableStringify(c.inputs)).digest('hex').slice(0, 8)}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      id = count === 1 ? base : `${base}-${count}`;
    }
    out.push({ id, inputs: c.inputs, expected: c.expected, metadata: c.metadata, tags: c.tags });
  });
  return out;
}

function parseFile(path: string, display: string): Array<{ raw: unknown; line?: number }> {
  const text = readFileSync(path, 'utf8');
  const ext = extname(path).toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') {
    const rows: Array<{ raw: unknown; line: number }> = [];
    text.split(/\r?\n/).forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) return;
      try {
        rows.push({ raw: JSON.parse(trimmed), line: i + 1 });
      } catch (error) {
        throw datasetError(
          `invalid JSON on line ${i + 1}: ${(error as Error).message}`,
          display,
          i + 1,
          'Each line of a JSONL file must be one complete JSON object.',
        );
      }
    });
    return rows;
  }
  let data: unknown;
  try {
    data = ext === '.json' ? JSON.parse(text) : parseYamlText(text);
  } catch (error) {
    throw datasetError(
      `could not parse dataset: ${(error as Error).message.split('\n')[0]}`,
      display,
    );
  }
  const list = Array.isArray(data)
    ? data
    : isJsonObject(data as JsonValue) && Array.isArray((data as { cases?: unknown }).cases)
      ? (data as { cases: unknown[] }).cases
      : null;
  if (!list)
    throw datasetError(
      'a dataset file must contain a list of cases, or an object with a "cases" list',
      display,
    );
  return list.map((raw) => ({ raw }));
}

export interface LoadDatasetOptions {
  /** Directory relative paths are resolved against (the workflow file's directory). */
  baseDir: string;
  /** Project root, for display paths. */
  root: string;
  workflowName: string;
}

export function loadDataset(ref: DatasetRef, options: LoadDatasetOptions): Dataset {
  let cases: DatasetCase[];
  let name: string;
  let source: string | null;
  if (typeof ref === 'string' || 'path' in ref) {
    const file = typeof ref === 'string' ? ref : ref.path;
    const path = resolve(options.baseDir, file);
    const display = relative(options.root, path) || path;
    if (!existsSync(path)) {
      throw datasetError(
        `dataset file not found: ${display}`,
        undefined,
        undefined,
        `Paths are relative to the workflow file. Create ${display} or fix \`dataset:\`.`,
      );
    }
    const rows = parseFile(path, display);
    if (rows.length === 0) throw datasetError('the dataset has no cases', display);
    if (rows.length > MAX_CASES)
      throw datasetError(
        `the dataset has ${rows.length} cases; the limit is ${MAX_CASES}`,
        display,
      );
    cases = assignIds(
      rows.map((r, index) =>
        normalizeCase(r.raw, { file: display, index, ...(r.line ? { line: r.line } : {}) }),
      ),
      display,
    );
    name = (typeof ref === 'object' && ref.name) || basename(path, extname(path));
    source = display;
  } else {
    cases = assignIds(
      ref.cases.map((raw, index) => normalizeCase(raw, { index })),
      undefined,
    );
    name = ref.name ?? `${options.workflowName}-inline`;
    source = null;
  }
  return { name, source, cases, hash: hashCases(cases) };
}

export function datasetFromInputs(inputs: JsonObject, workflowName: string): Dataset {
  const cases = assignIds([{ inputs, expected: null, metadata: {}, tags: [] }], undefined);
  return { name: `${workflowName}-adhoc`, source: null, cases, hash: hashCases(cases) };
}

function hashCases(cases: DatasetCase[]): string {
  return createHash('sha256')
    .update(stableStringify(cases as unknown as JsonValue))
    .digest('hex');
}

function typeMatches(value: JsonValue, type: InputSpec['type']): boolean {
  switch (type ?? 'string') {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isJsonObject(value);
    case 'array':
      return Array.isArray(value);
    default:
      return true;
  }
}

/**
 * Applies input defaults and checks each case against the workflow's declared inputs.
 * Returns the cases with defaults filled in, plus warnings; throws a ConfigError listing every
 * error.
 */
export function prepareCases(
  dataset: Dataset,
  inputs: Record<string, InputSpec> | undefined,
): { cases: DatasetCase[]; warnings: Diagnostic[] } {
  if (!inputs) return { cases: dataset.cases, warnings: [] };
  const problems: Diagnostic[] = [];
  const prepared = dataset.cases.map((c) => {
    const values: JsonObject = { ...c.inputs };
    for (const [name, spec] of Object.entries(inputs)) {
      if (values[name] === undefined && spec.default !== undefined)
        values[name] = spec.default as JsonValue;
      const value = values[name];
      if (value === undefined) {
        if (spec.required !== false) {
          problems.push({
            severity: 'error',
            message: `case "${c.id}" is missing required input "${name}"`,
            ...(dataset.source ? { file: dataset.source } : {}),
          });
        }
        continue;
      }
      if (!typeMatches(value, spec.type)) {
        problems.push({
          severity: 'error',
          message: `case "${c.id}": input "${name}" should be ${spec.type ?? 'string'}, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`,
          ...(dataset.source ? { file: dataset.source } : {}),
        });
      }
    }
    const unknown = Object.keys(values).filter((k) => !(k in inputs));
    for (const k of unknown) {
      problems.push({
        severity: 'warning',
        message: `case "${c.id}" has input "${k}", which the workflow does not declare`,
        ...(dataset.source ? { file: dataset.source } : {}),
      });
    }
    return { ...c, inputs: values };
  });
  const errors = problems.filter((p) => p.severity === 'error');
  if (errors.length > 0) {
    const shown = errors.slice(0, 20);
    if (errors.length > 20)
      shown.push({ severity: 'error', message: `…and ${errors.length - 20} more` });
    throw new ConfigError(shown, {}, ErrorCodes.datasetInvalid);
  }
  const warnings = problems.filter((p) => p.severity === 'warning');
  return { cases: prepared, warnings: warnings.slice(0, 5) };
}
