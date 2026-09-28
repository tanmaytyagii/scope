/**
 * scope evaluate <run> — re-score a stored run with the workflow's current evaluators.
 *
 * No workflow steps run, so iterating on evaluators costs nothing for the workflow's own model
 * calls. The run's previous evaluation results are replaced.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadWorkflow, readBaseline } from '@scope-ai/config';
import {
  asText,
  compareSummaries,
  ErrorCodes,
  evaluateGates,
  formatScore,
  gateStatus,
  type JsonValue,
  ScopeError,
  summarizeRun,
} from '@scope-ai/core';
import { Engine } from '@scope-ai/engine';
import type { CommandContext } from '../context.ts';
import { ExitCode, ExitError } from '../errors.ts';
import { renderEvaluatorsText, renderGatesText } from '../report.ts';
import { resolveRun } from './runs.ts';

export interface EvaluateOptions {
  workflow?: string;
  fail?: boolean;
}

export async function evaluateCommand(
  ctx: CommandContext,
  ref: string,
  options: EvaluateOptions,
): Promise<void> {
  const out = ctx.out;
  const s = out.style;
  const project = ctx.project();
  const store = await ctx.store();
  const projectRow = await ctx.projectRow();
  const run = await resolveRun(store, projectRow.id, ref);
  if (run.status === 'running')
    throw new ScopeError(ErrorCodes.usage, `Run #${run.number} is still running`);

  let workflowPath = options.workflow;
  if (!workflowPath) {
    const version = await store.getWorkflowVersion(run.workflowVersionId);
    if (!version?.path || !existsSync(resolve(project.root, version.path))) {
      throw new ScopeError(
        ErrorCodes.usage,
        `Cannot find the workflow file for run #${run.number}`,
        { hint: 'Pass it with --workflow <file>.' },
      );
    }
    workflowPath = resolve(project.root, version.path);
  }
  const loaded = loadWorkflow(workflowPath, { root: ctx.cwd, env: ctx.env });
  if (loaded.definition.name !== run.workflowName) {
    throw new ScopeError(
      ErrorCodes.usage,
      `${loaded.displayPath} defines workflow "${loaded.definition.name}", but run #${run.number} is "${run.workflowName}"`,
    );
  }
  const engine = new Engine({
    project,
    exporter: { export: () => {} },
    logger: ctx.logger,
    env: ctx.env,
  });
  const prepared = await engine.prepare(loaded, { variant: run.variant });

  const results = await store.runCaseResults(projectRow.id, run.id);
  out.info(
    s.dim(
      `Re-scoring ${results.length} cases of run #${run.number} with ${prepared.evaluators.length} evaluators…`,
    ),
  );
  for (const result of results) {
    const detail = await store.getTrace(projectRow.id, result.traceId);
    if (!detail) continue;
    if (detail.trace.status === 'error') {
      await store.replaceEvaluations(projectRow.id, detail.trace.id, []);
      continue;
    }
    const context = detail.spans
      .filter((sp) => sp.kind === 'retrieval')
      .map((sp) =>
        sp.output && typeof sp.output === 'object' && !Array.isArray(sp.output)
          ? asText((sp.output as { text?: JsonValue }).text ?? '')
          : '',
      )
      .filter(Boolean)
      .join('\n\n');
    const records = await engine.evaluateStored(prepared, {
      traceId: detail.trace.id,
      runId: run.id,
      input: detail.trace.input,
      output: detail.trace.output,
      expected: (detail.trace.metadata.expected as JsonValue | undefined) ?? null,
      context: context || null,
      durationMs: detail.trace.durationMs,
      usage: detail.trace.usage,
      costUsd: detail.trace.costUsd,
    });
    await store.replaceEvaluations(projectRow.id, detail.trace.id, records);
  }

  const updated = await store.runCaseResults(projectRow.id, run.id);
  const summary = summarizeRun(updated, { evaluatorOrder: prepared.evaluators.map((e) => e.name) });
  const baselineFile = run.baseline ? resolve(project.root, run.baseline.file) : null;
  const baseline = baselineFile && existsSync(baselineFile) ? readBaseline(baselineFile) : null;
  const gates = evaluateGates(summary, prepared.gates, baseline?.summary ?? null);
  const completed = await store.completeRun(run.id, {
    status: 'completed',
    summary,
    gates,
    gateStatus: gateStatus(gates),
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
  });

  out.emitJson({ run: completed, previousSummary: run.summary });
  out.print('');
  out.print(`${s.bold(`Re-evaluated run #${run.number}`)} ${s.dim(`with ${loaded.displayPath}`)}`);
  out.print('');
  out.print(s.bold('Evaluators'));
  out.print(renderEvaluatorsText(summary.evaluators, s));
  if (run.summary) {
    const changes = compareSummaries(run.summary, summary).filter(
      (m) =>
        m.id.startsWith('evaluator.') && m.id.endsWith('.mean_score') && m.change !== 'unchanged',
    );
    if (changes.length) {
      out.print('');
      out.print(s.bold('Changed scores'));
      for (const m of changes)
        out.print(`  ${m.label}  ${formatScore(m.base)} ${out.sym.arrow} ${formatScore(m.head)}`);
    }
  }
  out.print('');
  out.print(s.bold('Gates'));
  out.print(renderGatesText(gates, s, out.sym));
  out.print('');
  if (completed.gateStatus === 'failed' && options.fail !== false)
    throw new ExitError(ExitCode.gatesFailed);
}
