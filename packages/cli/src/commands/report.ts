/**
 * scope report [run] — render a run as text, Markdown (for GitHub) or JSON.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { readBaseline } from '@scope-ai/config';
import { type Baseline, type Comparison, ErrorCodes, ScopeError } from '@scope-ai/core';
import type { Run, Store } from '@scope-ai/storage';
import type { CommandContext } from '../context.ts';
import { type JUnitCase, renderJUnit } from '../junit.ts';
import {
  buildComparison,
  type ReportBaseline,
  type ReportInput,
  renderComparisonText,
  renderEvaluatorsText,
  renderGatesText,
  renderMarkdown,
  renderSummaryText,
  reportBaseline,
  reportJson,
  resultLabel,
} from '../report.ts';
import { plainStyle } from '../ui/style.ts';
import { resolveRun } from './runs.ts';

export interface ReportOptions {
  format?: string;
  baseline?: string;
  output?: string;
  dashboardUrl?: string;
}

export async function buildReportInput(
  ctx: CommandContext,
  store: Store,
  projectId: string,
  run: Run,
  baselinePath: string | undefined,
  dashboardUrl: string | null,
): Promise<ReportInput> {
  if (!run.summary) {
    throw new ScopeError(
      ErrorCodes.usage,
      `Run #${run.number} has not completed (status: ${run.status})`,
      { hint: 'Reports are available for completed runs.' },
    );
  }
  // What the run's gates compared against, as stored when it ran — the baseline file may have
  // changed since. An explicit --baseline, or a run from before SCOPE 0.2, reads the file.
  const stored = baselinePath ? null : await store.getBaselineComparison(projectId, run.id);
  let reportedBaseline: ReportBaseline | null = stored
    ? {
        runNumber: stored.baseline.runNumber,
        commit: stored.baseline.commit,
        createdAt: stored.baseline.createdAt,
      }
    : null;
  let comparison: Comparison | null = stored
    ? {
        metrics: stored.metrics,
        counts: stored.counts,
        cases: stored.cases,
        ...(stored.config ? { config: stored.config } : {}),
      }
    : null;
  const file = stored
    ? undefined
    : (baselinePath ?? (run.baseline ? resolve(ctx.project().root, run.baseline.file) : undefined));
  let baseline: Baseline | null = null;
  if (file) {
    const path = resolve(ctx.cwd, file);
    if (existsSync(path)) baseline = readBaseline(path, relative(ctx.cwd, path));
    else if (baselinePath)
      throw new ScopeError(ErrorCodes.baselineInvalid, `Baseline file not found: ${baselinePath}`);
  }
  if (baseline) {
    reportedBaseline = reportBaseline(baseline);
    const snapshots = await store.runCaseSnapshots(projectId, run.id);
    comparison = buildComparison(run.summary, snapshots, baseline, {
      params: run.params,
      workflow: await store.workflowVersionHash(projectId, run.workflowVersionId),
      datasetHash: run.dataset?.hash ?? null,
    });
  }
  const failing = [
    ...(await store.listRunCases(projectId, run.id, { outcome: 'errored', limit: 50 })).items,
    ...(await store.listRunCases(projectId, run.id, { outcome: 'failed', limit: 50 })).items,
  ].slice(0, 50);
  return {
    run,
    summary: run.summary,
    gates: run.gates,
    baseline: reportedBaseline,
    comparison,
    failures: failing.map((c) => ({
      caseId: c.caseId,
      traceId: c.traceId,
      outcome: c.outcome,
      reasons: c.error
        ? [c.error.message]
        : c.evaluations
            .filter((e) => e.status === 'failed' || e.status === 'error')
            .map((e) => `${e.evaluator}: ${e.reason}`),
    })),
    dashboardUrl,
  };
}

export async function reportCommand(
  ctx: CommandContext,
  ref: string | undefined,
  options: ReportOptions,
): Promise<void> {
  const format = options.format ?? (ctx.out.json ? 'json' : 'text');
  if (!['text', 'markdown', 'md', 'json', 'junit'].includes(format)) {
    throw new ScopeError(ErrorCodes.usage, `Unknown report format "${format}"`, {
      hint: 'Use text, markdown, json or junit.',
    });
  }
  const store = await ctx.store();
  const project = await ctx.projectRow();
  const run = await resolveRun(store, project.id, ref);
  const input = await buildReportInput(
    ctx,
    store,
    project.id,
    run,
    options.baseline,
    options.dashboardUrl ?? ctx.env.SCOPE_DASHBOARD_URL ?? null,
  );

  let content: string;
  if (format === 'junit') {
    const cases: JUnitCase[] = [];
    let cursor: string | null = null;
    do {
      const page = await store.listRunCases(project.id, run.id, { limit: 200, cursor });
      for (const c of page.items)
        cases.push({
          caseId: c.caseId,
          outcome: c.outcome,
          durationMs: c.durationMs,
          reasons: c.error
            ? [c.error.message]
            : c.evaluations
                .filter((e) => e.status === 'failed' || e.status === 'error')
                .map((e) => `${e.evaluator}: ${e.reason}`),
          traceId: c.traceId,
        });
      cursor = page.nextCursor;
    } while (cursor);
    content = renderJUnit(
      [{ run, gates: run.gates, cases }],
      options.dashboardUrl ?? ctx.env.SCOPE_DASHBOARD_URL ?? null,
    );
  } else if (format === 'json') content = `${JSON.stringify(reportJson(input), null, 2)}\n`;
  else if (format === 'markdown' || format === 'md') content = renderMarkdown(input);
  else {
    // Files get plain text; terminals get color.
    const style = options.output ? plainStyle : ctx.out.style;
    const parts = [
      `${style.bold(`${resultLabel(run)}`)}  ${run.workflowName}${run.variant ? ` (${run.variant})` : ''} · run #${run.number}`,
      '',
      style.bold('Summary'),
      renderSummaryText(input.summary, style, ctx.out.sym),
      '',
      style.bold('Evaluators'),
      renderEvaluatorsText(input.summary.evaluators, style),
      '',
    ];
    if (input.comparison)
      parts.push(
        style.bold('Compared with baseline'),
        renderComparisonText(input.comparison, input.summary.evaluators, style, ctx.out.sym),
        '',
      );
    parts.push(style.bold('Gates'), renderGatesText(input.gates, style, ctx.out.sym), '');
    content = `${parts.join('\n')}\n`;
  }

  if (options.output) {
    writeFileSync(resolve(ctx.cwd, options.output), content);
    ctx.out.info(
      `${ctx.out.errStyle.green(ctx.out.sym.pass)} Wrote ${format} report for run #${run.number} to ${options.output}`,
    );
  } else {
    ctx.out.stdout.write(content);
  }
}
