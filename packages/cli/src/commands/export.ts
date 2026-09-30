/**
 * scope export — data out of SCOPE, as files other tools read.
 *
 *   scope export traces [--run N] [--since 7d] [--format jsonl|dataset] [-o file]
 *   scope export run [run] [--format csv|jsonl] [-o file]
 *
 * `traces --format dataset` turns observed traces (from applications or runs) into dataset cases,
 * the loop from production back to regression tests: export, review, add expected answers,
 * run with `scope run --dataset`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ErrorCodes,
  type JsonObject,
  type JsonValue,
  parseCutoff,
  ScopeError,
} from '@scope-ai/core';
import type { RunCase, TraceDetail, TraceFilters } from '@scope-ai/storage';
import type { CommandContext } from '../context.ts';
import { resolveRun } from './runs.ts';

export interface ExportTracesOptions {
  run?: string;
  workflow?: string;
  status?: string;
  eval?: string;
  since?: string;
  limit?: string;
  format?: string;
  output?: string;
}

export interface ExportRunOptions {
  format?: string;
  output?: string;
}

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** "7d", "24h", "30m" or an ISO date → epoch ms. */
function parseSince(value: string, now = Date.now()): number {
  const cutoff = parseCutoff(value, now);
  if (cutoff === null)
    throw new ScopeError(ErrorCodes.usage, `--since "${value}" is not a duration or date`, {
      hint: 'Use 30m, 24h, 7d or an ISO date such as 2026-09-01.',
    });
  return cutoff;
}

/**
 * Writes the export to a file, or to stdout — where the export itself is the output, in its
 * `--format`, with or without `--json`. With a file, `--json` prints a summary of what was written.
 */
function write(
  ctx: CommandContext,
  output: string | undefined,
  content: string,
  what: string,
  summary: { format: string; count: number },
) {
  if (output) {
    const file = resolve(ctx.cwd, output);
    writeFileSync(file, content);
    ctx.out.emitJson({ file, ...summary });
    ctx.out.info(`${ctx.out.errStyle.green(ctx.out.sym.pass)} Wrote ${what} to ${output}`);
  } else ctx.out.stdout.write(content);
}

/** A dataset case from a trace: its input as the case inputs, and its expected value if any. */
function toCase(detail: TraceDetail): JsonObject | null {
  const t = detail.trace;
  if (t.input === null) return null;
  const expected = isObject(t.metadata) ? t.metadata.expected : undefined;
  const item: JsonObject = {
    id: t.caseId ?? `trace-${t.id.slice(0, 12)}`,
    inputs: isObject(t.input) ? t.input : { input: t.input },
  };
  if (expected !== undefined) item.expected = expected as JsonValue;
  item.metadata = { source_trace: t.id, ...(t.runId ? { source_run: t.runId } : {}) };
  return item;
}

export async function exportTracesCommand(
  ctx: CommandContext,
  options: ExportTracesOptions,
): Promise<void> {
  const format = options.format ?? 'jsonl';
  if (format !== 'jsonl' && format !== 'dataset')
    throw new ScopeError(ErrorCodes.usage, `Unknown export format "${format}"`, {
      hint: 'Use jsonl (whole traces) or dataset (cases for scope run --dataset).',
    });
  const store = await ctx.store();
  const project = await ctx.projectRow();
  const limit = options.limit ? Number(options.limit) : 1000;
  if (!Number.isInteger(limit) || limit < 1)
    throw new ScopeError(ErrorCodes.usage, '--limit must be a positive integer');

  const filters: TraceFilters = { limit: Math.min(limit, 200), sort: 'newest' };
  if (options.run) filters.runId = (await resolveRun(store, project.id, options.run)).id;
  if (options.workflow) filters.name = options.workflow;
  if (options.status === 'ok' || options.status === 'error') filters.status = options.status;
  else if (options.status) throw new ScopeError(ErrorCodes.usage, '--status must be ok or error');
  if (options.eval) filters.eval = options.eval as TraceFilters['eval'];
  if (options.since) filters.since = parseSince(options.since);

  const lines: string[] = [];
  const ids = new Set<string>();
  let skippedNoInput = 0;
  let skippedDuplicate = 0;
  let exported = 0;
  let cursor: string | null = null;
  do {
    const page = await store.listTraces(project.id, { ...filters, cursor });
    for (const summary of page.items) {
      if (exported >= limit) break;
      const detail = await store.getTrace(project.id, summary.id);
      if (!detail) continue;
      if (format === 'jsonl') {
        lines.push(JSON.stringify(detail));
        exported++;
        continue;
      }
      const item = toCase(detail);
      if (!item) {
        skippedNoInput++;
        continue;
      }
      if (ids.has(item.id as string)) {
        skippedDuplicate++;
        continue;
      }
      ids.add(item.id as string);
      lines.push(JSON.stringify(item));
      exported++;
    }
    cursor = exported >= limit ? null : page.nextCursor;
  } while (cursor);

  write(
    ctx,
    options.output,
    lines.length ? `${lines.join('\n')}\n` : '',
    `${exported} ${format === 'dataset' ? 'cases' : 'traces'}`,
    { format, count: exported },
  );
  if (skippedNoInput)
    ctx.out.warn(
      `${skippedNoInput} trace(s) have no stored input (content capture was off) and were skipped`,
    );
  if (skippedDuplicate)
    ctx.out.warn(`${skippedDuplicate} trace(s) repeat a case id already exported and were skipped`);
  if (format === 'dataset' && exported > 0 && !ctx.out.json)
    ctx.out.info(
      ctx.out.errStyle.dim(
        '  Review the cases and add `expected` where evaluators need it, then: scope run --dataset <file>',
      ),
    );
}

// ─── run results ─────────────────────────────────────────────────────────────────────────────

/**
 * A CSV cell. Text that a spreadsheet would read as a formula (= + - @ at the start) is prefixed
 * with an apostrophe, because exported previews contain model output.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row per case; evaluator columns in the workflow's order (`order`), then any others. */
function toCsv(cases: RunCase[], order: readonly string[]): string {
  const evaluators = [
    ...new Set([...order, ...cases.flatMap((c) => c.evaluations.map((e) => e.evaluator))]),
  ];
  const header = [
    'case_id',
    'outcome',
    'duration_ms',
    'total_tokens',
    'cost_usd',
    ...evaluators.flatMap((e) => [`${e}.status`, `${e}.score`]),
    'error',
    'input_preview',
    'output_preview',
    'trace_id',
  ];
  const rows = cases.map((c) => {
    const byName = new Map(c.evaluations.map((e) => [e.evaluator, e]));
    return [
      c.caseId,
      c.outcome,
      c.durationMs,
      c.totalTokens,
      c.costUsd,
      ...evaluators.flatMap((e) => [byName.get(e)?.status ?? '', byName.get(e)?.score ?? '']),
      c.error?.message ?? '',
      c.inputPreview,
      c.outputPreview,
      c.traceId,
    ].map(cell);
  });
  return `${[header.map(cell), ...rows].map((r) => r.join(',')).join('\n')}\n`;
}

export async function exportRunCommand(
  ctx: CommandContext,
  ref: string | undefined,
  options: ExportRunOptions,
): Promise<void> {
  const format = options.format ?? 'csv';
  if (format !== 'csv' && format !== 'jsonl')
    throw new ScopeError(ErrorCodes.usage, `Unknown export format "${format}"`, {
      hint: 'Use csv (one row per case) or jsonl.',
    });
  const store = await ctx.store();
  const project = await ctx.projectRow();
  const run = await resolveRun(store, project.id, ref);
  const cases: RunCase[] = [];
  let cursor: string | null = null;
  do {
    const page = await store.listRunCases(project.id, run.id, { limit: 200, cursor });
    cases.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  const content =
    format === 'csv'
      ? toCsv(cases, run.summary?.evaluators.map((e) => e.name) ?? [])
      : `${cases.map((c) => JSON.stringify(c)).join('\n')}\n`;
  write(ctx, options.output, content, `${cases.length} cases of run #${run.number}`, {
    format,
    count: cases.length,
  });
}

/** Exported for tests. */
export const __test = { cell, parseSince };
