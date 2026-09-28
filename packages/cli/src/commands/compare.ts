/**
 * scope compare <base> <head> — compare two runs; either side may be a baseline file.
 */
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { readBaseline } from '@scope-ai/config';
import {
  type CaseSnapshot,
  compareRuns,
  ErrorCodes,
  type RunSummary,
  ScopeError,
} from '@scope-ai/core';
import type { CommandContext } from '../context.ts';
import { describeCaseChange, renderComparisonText } from '../report.ts';
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
