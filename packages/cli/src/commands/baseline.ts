/**
 * scope baseline save [run] — write a baseline file for regression gates (docs/decisions/0006).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { baselineFileName, readBaseline, serializeBaseline } from '@scope-ai/config';
import {
  BASELINE_SCHEMA,
  type Baseline,
  ErrorCodes,
  formatPercent,
  formatRelativeTime,
  ScopeError,
} from '@scope-ai/core';
import type { CommandContext } from '../context.ts';
import { resolveRun } from './runs.ts';

export interface BaselineOptions {
  output?: string;
  force?: boolean;
}

export async function baselineSaveCommand(
  ctx: CommandContext,
  ref: string | undefined,
  options: BaselineOptions,
): Promise<void> {
  const store = await ctx.store();
  const project = await ctx.projectRow();
  const run = await resolveRun(store, project.id, ref);
  if (run.status !== 'completed' || !run.summary) {
    throw new ScopeError(
      ErrorCodes.usage,
      `Run #${run.number} is ${run.status}; only completed runs can be baselines`,
      {
        hint: 'Pick a completed run from `scope runs`.',
      },
    );
  }
  if (run.dataset && run.caseCount < run.dataset.caseCount && !options.force) {
    throw new ScopeError(
      ErrorCodes.usage,
      `Run #${run.number} ran ${run.caseCount} of ${run.dataset.caseCount} cases`,
      {
        hint: 'A baseline should cover the whole dataset. Run all cases, or pass --force.',
      },
    );
  }
  if (run.gateStatus === 'failed' && !options.force) {
    throw new ScopeError(ErrorCodes.usage, `Run #${run.number} failed its gates`, {
      hint: 'A baseline is the reference for "no worse than this". Save a passing run, or pass --force if this is intentional.',
    });
  }
  const cases = await store.runCaseSnapshots(project.id, run.id);
  const baseline: Baseline = {
    schema: BASELINE_SCHEMA,
    workflow: run.workflowName,
    variant: run.variant,
    createdAt: new Date().toISOString(),
    source: { runId: run.id, runNumber: run.number, git: run.git },
    dataset: run.dataset
      ? { name: run.dataset.name, caseCount: run.dataset.caseCount, hash: run.dataset.hash }
      : null,
    config: {
      params: run.params,
      workflowHash: await store.workflowVersionHash(project.id, run.workflowVersionId),
    },
    summary: run.summary,
    cases,
  };
  const path = options.output
    ? resolve(ctx.cwd, options.output)
    : join(ctx.project().baselinesDir, baselineFileName(run.workflowName, run.variant));
  let previous: Baseline | null = null;
  if (existsSync(path)) {
    try {
      previous = readBaseline(path);
    } catch {
      previous = null;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeBaseline(baseline));

  const display = relative(ctx.cwd, path) || path;
  ctx.out.emitJson({
    path,
    baseline: {
      workflow: baseline.workflow,
      variant: baseline.variant,
      runNumber: run.number,
      cases: Object.keys(cases).length,
    },
  });
  const s = ctx.out.style;
  ctx.out.result(
    `${s.green(ctx.out.sym.pass)} Saved baseline ${s.bold(display)} from run #${run.number} ${s.dim(`(${Object.keys(cases).length} cases, pass rate ${formatPercent(run.summary.passRate)})`)}`,
  );
  if (previous) {
    ctx.out.print(
      s.dim(
        `  Replaced the baseline from run #${previous.source.runNumber}, saved ${formatRelativeTime(Date.parse(previous.createdAt))}.`,
      ),
    );
  }
  ctx.out.print(
    s.dim(
      '  Commit this file: future runs of this workflow compare against it, and CI fails on regressions.',
    ),
  );
}
