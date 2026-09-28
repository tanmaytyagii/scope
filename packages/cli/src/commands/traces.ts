/**
 * scope traces [trace] — list traces, or show one trace as a span tree with a timeline.
 */
import {
  asText,
  buildSpanTree,
  ErrorCodes,
  flattenSpanTree,
  formatDuration,
  formatRelativeTime,
  formatScore,
  formatTokens,
  formatUsd,
  type JsonValue,
  ScopeError,
  type SpanRecord,
} from '@scope-ai/core';
import type { TraceDetail, TraceFilters } from '@scope-ai/storage';
import type { CommandContext } from '../context.ts';
import type { Style, Symbols } from '../ui/style.ts';
import { padEnd, truncate } from '../ui/style.ts';
import { renderTable } from '../ui/table.ts';
import { resolveRun } from './runs.ts';

export interface TracesOptions {
  run?: string;
  workflow?: string;
  status?: string;
  eval?: string;
  search?: string;
  model?: string;
  limit?: string;
  full?: boolean;
}

export async function tracesCommand(
  ctx: CommandContext,
  ref: string | undefined,
  options: TracesOptions,
): Promise<void> {
  const store = await ctx.store();
  const project = await ctx.projectRow();
  if (ref) {
    const detail = await store.getTrace(project.id, ref);
    if (!detail) {
      throw new ScopeError(ErrorCodes.notFound, `No trace matches "${ref}"`, {
        hint: 'Use at least 4 characters of the trace id. `scope traces` lists recent traces.',
      });
    }
    ctx.out.emitJson(detail);
    if (!ctx.out.json) renderTrace(ctx, detail, options.full ?? false);
    return;
  }

  const filters: TraceFilters = { limit: options.limit ? Number(options.limit) : 25 };
  if (options.run) filters.runId = (await resolveRun(store, project.id, options.run)).id;
  if (options.workflow) filters.name = options.workflow;
  if (options.status) {
    if (options.status !== 'ok' && options.status !== 'error')
      throw new ScopeError(ErrorCodes.usage, '--status must be ok or error');
    filters.status = options.status;
  }
  if (options.eval) {
    if (!['passed', 'failed', 'errored', 'none'].includes(options.eval))
      throw new ScopeError(ErrorCodes.usage, '--eval must be passed, failed, errored or none');
    filters.eval = options.eval as TraceFilters['eval'] & string;
  }
  if (options.search) filters.q = options.search;
  if (options.model) filters.model = options.model;
  const page = await store.listTraces(project.id, filters);
  ctx.out.emitJson(page);
  const s = ctx.out.style;
  if (page.items.length === 0) {
    ctx.out.result('No traces match.');
    return;
  }
  ctx.out.result(
    renderTable(
      page.items,
      [
        { header: 'Trace', value: (t) => s.cyan(t.id.slice(0, 7)) },
        { header: 'Name', value: (t) => t.name, max: 22 },
        { header: 'Case', value: (t) => t.caseId ?? s.dim('—'), max: 24 },
        { header: 'Status', value: (t) => (t.status === 'ok' ? s.green('ok') : s.red('error')) },
        {
          header: 'Eval',
          value: (t) =>
            t.evalStatus === 'passed'
              ? s.green('passed')
              : t.evalStatus === 'failed'
                ? s.red('failed')
                : t.evalStatus === 'errored'
                  ? s.red('errored')
                  : s.dim('—'),
        },
        { header: 'Duration', value: (t) => formatDuration(t.durationMs), align: 'right' },
        { header: 'Tokens', value: (t) => formatTokens(t.totalTokens), align: 'right' },
        {
          header: 'Cost',
          value: (t) =>
            t.costUsd === null && t.llmCallCount > 0 ? s.dim('unknown') : formatUsd(t.costUsd),
          align: 'right',
        },
        { header: 'Run', value: (t) => (t.runNumber ? `#${t.runNumber}` : s.dim('—')) },
        { header: 'When', value: (t) => s.dim(formatRelativeTime(t.startTime)) },
      ],
      s.dim,
    ),
  );
  if (page.nextCursor)
    ctx.out.print(
      s.dim(
        `\n  Showing ${page.items.length} traces. Narrow with --run, --status, --eval or --search, or raise --limit.`,
      ),
    );
}

const KIND_WIDTH = 10;
const BAR_WIDTH = 24;

function bar(span: SpanRecord, start: number, total: number): string {
  if (total <= 0) return '▏';
  const offset = Math.min(
    BAR_WIDTH - 1,
    Math.floor(((span.startTime - start) / total) * BAR_WIDTH),
  );
  const width = Math.max(1, Math.round((span.durationMs / total) * BAR_WIDTH));
  const len = Math.min(width, BAR_WIDTH - offset);
  return `${' '.repeat(offset)}${len <= 1 && span.durationMs / total < 0.02 ? '▏' : '█'.repeat(len)}`;
}

function spanDetail(span: SpanRecord, s: Style, sym: Symbols): string | null {
  if (span.kind === 'llm' && span.model) {
    const parts = [
      `${span.provider}:${span.model}`,
      span.inputTokens !== null
        ? `${formatTokens(span.inputTokens)} in ${sym.dot} ${formatTokens(span.outputTokens ?? 0)} out${span.attributes['scope.usage.estimated'] ? ' (est.)' : ''}`
        : null,
      span.costUsd !== null ? formatUsd(span.costUsd) : 'cost unknown',
    ].filter(Boolean);
    const ignored = span.attributes['scope.request.ignored_params'];
    if (Array.isArray(ignored) && ignored.length) parts.push(`ignored: ${ignored.join(', ')}`);
    return s.dim(parts.join(` ${sym.dot} `));
  }
  if (span.kind === 'retrieval') {
    const docs = (span.output as { documents?: Array<{ source?: string; score?: number }> } | null)
      ?.documents;
    if (Array.isArray(docs)) {
      const sources = docs
        .slice(0, 3)
        .map((d) => `${d.source}${d.score !== undefined ? ` ${d.score}` : ''}`);
      return s.dim(
        `${docs.length} ${docs.length === 1 ? 'document' : 'documents'}${sources.length ? `: ${sources.join(', ')}${docs.length > 3 ? ', …' : ''}` : ''}`,
      );
    }
  }
  if (span.status === 'error' && span.statusMessage)
    return s.red(truncate(span.statusMessage, 100));
  return null;
}

function block(label: string, value: JsonValue | null, full: boolean, s: Style): string[] {
  if (value === null) return [];
  const text = asText(value);
  const shown =
    full || text.length <= 600
      ? text
      : `${text.slice(0, 600)}… ${s.dim(`(${text.length} chars; --full to show all)`)}`;
  return [s.bold(label), ...shown.split('\n').map((l) => `  ${l}`), ''];
}

function renderTrace(ctx: CommandContext, detail: TraceDetail, full: boolean): void {
  const out = ctx.out;
  const s = out.style;
  const sym = out.sym;
  const t = detail.trace;
  const status = t.status === 'ok' ? s.green(`${sym.pass} ok`) : s.red(`${sym.fail} error`);
  const facts = [
    formatDuration(t.durationMs),
    `${formatTokens(t.usage.totalTokens)} tokens${t.usage.estimated ? ' (est.)' : ''}`,
    t.costUsd === null && t.llmCallCount > 0 ? 'cost unknown' : formatUsd(t.costUsd),
    t.caseId ? `case ${t.caseId}` : null,
    detail.run
      ? `run #${detail.run.number}${detail.run.variant ? ` (${detail.run.variant})` : ''}`
      : null,
    formatRelativeTime(t.startTime),
  ].filter(Boolean);
  out.print('');
  out.print(
    `${s.bold('Trace')} ${s.cyan(t.id.slice(0, 7))}  ${s.bold(t.name)}  ${status}  ${s.dim(facts.join(` ${sym.dot} `))}`,
  );
  out.print(s.dim(`  ${t.id}`));
  if (t.error)
    out.print(`  ${s.red(t.error.message)}${t.error.hint ? s.dim(` — ${t.error.hint}`) : ''}`);
  out.print('');

  const start = Math.min(...detail.spans.map((x) => x.startTime));
  const end = Math.max(...detail.spans.map((x) => x.endTime));
  const total = Math.max(end - start, 1);
  const nodes = flattenSpanTree(buildSpanTree(detail.spans));
  const nameWidth = Math.min(
    40,
    Math.max(...nodes.map((n) => n.depth * 3 + n.span.name.length)) + 2,
  );
  out.print(
    s.dim(
      `  ${padEnd('Span', nameWidth)} ${padEnd('Kind', KIND_WIDTH)} ${'Duration'.padStart(9)}  Timeline`,
    ),
  );
  const isLast = (index: number): boolean => {
    const node = nodes[index];
    if (!node) return true;
    for (let j = index + 1; j < nodes.length; j++) {
      const other = nodes[j];
      if (!other || other.depth < node.depth) return true;
      if (other.depth === node.depth) return false;
    }
    return true;
  };
  const openAncestors: boolean[] = [];
  nodes.forEach((node, index) => {
    const span = node.span;
    const last = isLast(index);
    openAncestors[node.depth] = !last;
    const prefix =
      node.depth === 0
        ? ''
        : `${openAncestors
            .slice(1, node.depth)
            .map((open) => (open ? sym.pipe : sym.blank))
            .join(' ')}${node.depth > 1 ? ' ' : ''}${last ? sym.elbow : sym.tee} `;
    const name = truncate(`${prefix}${span.name}`, nameWidth);
    const color = span.status === 'error' ? s.red : node.depth === 0 ? s.bold : (x: string) => x;
    out.print(
      `  ${color(padEnd(name, nameWidth))} ${s.dim(padEnd(span.kind, KIND_WIDTH))} ${formatDuration(span.durationMs).padStart(9)}  ${s.cyan(bar(span, start, total))}`,
    );
    const info = spanDetail(span, s, sym);
    const indent = ' '.repeat(Math.min(nameWidth, node.depth * 3 + 3));
    if (info) out.print(`  ${indent}${info}`);
    if (full) {
      for (const [label, value] of [
        ['input', span.input],
        ['output', span.output],
      ] as const) {
        if (value === null) continue;
        const text = asText(value).split('\n');
        out.print(`  ${indent}${s.dim(`${label}:`)} ${text[0] ?? ''}`);
        for (const line of text.slice(1)) out.print(`  ${indent}  ${line}`);
      }
    }
  });
  out.print('');

  if (detail.evaluations.length) {
    out.print(s.bold('Evaluations'));
    const width = Math.max(...detail.evaluations.map((e) => e.evaluator.length));
    for (const e of detail.evaluations) {
      const icon =
        e.status === 'passed'
          ? s.green(sym.pass)
          : e.status === 'skipped'
            ? s.dim(sym.skip)
            : s.red(e.status === 'error' ? sym.error : sym.fail);
      out.print(
        `  ${icon} ${padEnd(s.bold(e.evaluator), width)}  ${s.dim(padEnd(e.kind, 13))} ${formatScore(e.score).padStart(5)}  ${e.reason}`,
      );
    }
    out.print('');
  }
  for (const line of [
    ...block('Input', t.input, full, s),
    ...block('Output', t.output, full, s),
    ...block('Expected', (t.metadata.expected as JsonValue | undefined) ?? null, full, s),
  ]) {
    out.print(line);
  }
}
