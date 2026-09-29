/**
 * scope compare <base> <head> — compare two runs; either side may be a baseline file.
 * scope compare <a> <b> <c> [d] — up to four side by side: metrics per run and differing cases.
 */
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { readBaseline } from '@scope-ai/config';
import {
  type CaseSnapshot,
  compareMany,
  compareRuns,
  ErrorCodes,
  formatMetric,
  headlineMetrics,
  MAX_COMPARED_RUNS,
  type MetricRow,
  type RunSummary,
  ScopeError,
} from '@scope-ai/core';
import type { CommandContext } from '../context.ts';
import { describeCaseChange, renderComparisonText } from '../report.ts';
import { renderTable } from '../ui/table.ts';
import { resolveRun } from './runs.ts';

export interface ComparisonSideInfo {
  label: string;
  summary: RunSummary;
  cases: Record<string, CaseSnapshot>;
  workflow: string;
  variant: string | null;
}

export async function loadSide(ctx: CommandContext, ref: string): Promise<ComparisonSideInfo> {
  const path = resolve(ctx.cwd, ref);
  if (ref.endsWith('.json') || (existsSync(path) && !/^#?\d+$/.test(ref))) {
    const baseline = readBaseline(path, relative(ctx.cwd, path) || path);
    return {
      label: `baseline ${relative(ctx.cwd, path)} (run #${baseline.source.runNumber})`,
      summary: baseline.summary,
      cases: baseline.cases,
      workflow: baseline.workflow,
      variant: baseline.variant,
    };
  }
  const store = await ctx.store();
  const project = await ctx.projectRow();
  const run = await resolveRun(store, project.id, ref);
  if (!run.summary) {
    throw new ScopeError(
      ErrorCodes.usage,
      `Run #${run.number} has no summary (status: ${run.status})`,
      { hint: 'Compare completed runs.' },
    );
  }
  return {
    label: `run #${run.number}${run.variant ? ` (${run.variant})` : ''}`,
    summary: run.summary,
    cases: await store.runCaseSnapshots(project.id, run.id),
    workflow: run.workflowName,
    variant: run.variant,
  };
}

export async function compareCommand(
  ctx: CommandContext,
  baseRef: string,
  headRef: string,
): Promise<void> {
  const base = await loadSide(ctx, baseRef);
  const head = await loadSide(ctx, headRef);
  if (base.workflow !== head.workflow) {
    ctx.out.warn(
      `comparing different workflows (${base.workflow} vs ${head.workflow}); case ids may not correspond`,
    );
  }
  const comparison = compareRuns(
    { summary: base.summary, cases: base.cases },
    { summary: head.summary, cases: head.cases },
  );
  ctx.out.emitJson({ base: base.label, head: head.label, ...comparison });
  if (ctx.out.json) return;
  const s = ctx.out.style;
  ctx.out.print('');
  ctx.out.print(`${s.bold('Compare')}  ${base.label} ${s.dim(ctx.out.sym.arrow)} ${head.label}`);
  ctx.out.print('');
  ctx.out.result(renderComparisonText(comparison, head.summary.evaluators, s, ctx.out.sym));
  const changed = comparison.cases.filter((c) => c.kind === 'changed');
  if (changed.length) {
    ctx.out.print('');
    ctx.out.print(s.bold('Score changes'));
    for (const c of changed.slice(0, 15))
      ctx.out.print(`  ${s.dim(ctx.out.sym.bullet)} ${c.caseId}  ${s.dim(describeCaseChange(c))}`);
  }
  ctx.out.print('');
}

/** Runs (or baselines) side by side: every headline metric per run, then the cases that differ. */
export async function compareManyCommand(ctx: CommandContext, refs: string[]): Promise<void> {
  if (refs.length < 2 || refs.length > MAX_COMPARED_RUNS) {
    throw new ScopeError(
      ErrorCodes.usage,
      `Compare 2 to ${MAX_COMPARED_RUNS} runs (got ${refs.length})`,
      { hint: 'Example: scope compare 12 13 14' },
    );
  }
  if (refs.length === 2) return compareCommand(ctx, refs[0] as string, refs[1] as string);
  const sides = [];
  for (const ref of refs) sides.push(await loadSide(ctx, ref));
  const workflows = [...new Set(sides.map((s) => s.workflow))];
  if (workflows.length > 1)
    ctx.out.warn(
      `comparing different workflows (${workflows.join(', ')}); case ids may not correspond`,
    );
  const matrix = compareMany(sides);
  ctx.out.emitJson({ runs: sides.map((s) => s.label), ...matrix });
  if (ctx.out.json) return;

  const s = ctx.out.style;
  const labels = sides.map((side) => side.label);
  const headline = headlineMetrics(
    matrix.metrics,
    sides.flatMap((side) => side.summary.evaluators),
  );
  ctx.out.print('');
  ctx.out.print(`${s.bold('Compare')}  ${labels.join(s.dim(' · '))}`);
  ctx.out.print('');
  ctx.out.print(
    renderTable(
      headline,
      [
        { header: 'Metric', value: (m: MetricRow) => m.label },
        ...labels.map((label, i) => ({
          header: label,
          align: 'right' as const,
          value: (m: MetricRow) => {
            const text = formatMetric(m.values[i] ?? null, m.unit);
            return m.best.includes(i) ? s.green(`${text} ${ctx.out.sym.pass}`) : `${text}  `;
          },
        })),
      ],
      s.dim,
    ),
  );
  ctx.out.print(s.dim(`  ${ctx.out.sym.pass} best (values within noise of it share the mark)`));
  ctx.out.print('');
  if (matrix.cases.length === 0) {
    ctx.out.result(`Every case has the same outcome in all ${sides.length} runs.`);
  } else {
    ctx.out.print(
      s.bold(`Cases that differ`) + s.dim(` · ${matrix.cases.length} of ${matrix.caseCount}`),
    );
    ctx.out.result(
      renderTable(
        matrix.cases.slice(0, 30),
        [
          { header: 'Case', value: (c) => c.caseId, max: 40 },
          ...labels.map((label, i) => ({
            header: label,
            value: (c: (typeof matrix.cases)[number]) => {
              const outcome = c.outcomes[i];
              if (!outcome) return s.dim('not run');
              return outcome === 'passed' ? s.green(outcome) : s.red(outcome);
            },
          })),
        ],
        s.dim,
      ),
    );
    if (matrix.cases.length > 30)
      ctx.out.print(s.dim(`  … and ${matrix.cases.length - 30} more (--json lists every one)`));
  }
  ctx.out.print('');
}
