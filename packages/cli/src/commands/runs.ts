/**
 * scope runs [run] — list recent runs, or show one run in detail.
 */
import {
  ErrorCodes,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  formatUsd,
  ScopeError,
} from '@scope-ai/core';
import type { Run, Store } from '@scope-ai/storage';
import type { CommandContext } from '../context.ts';
import {
  renderEvaluatorsText,
  renderGatesText,
  renderSummaryText,
  resultLabel,
} from '../report.ts';
import type { Style } from '../ui/style.ts';
import { renderTable } from '../ui/table.ts';

export interface RunsOptions {
  workflow?: string;
  limit?: string;
}

export function resultCell(run: Run, s: Style): string {
  const label = resultLabel(run).toLowerCase();
  if (label === 'passed' || label === 'completed') return s.green(label);
  if (label.startsWith('passed')) return s.yellow('warnings');
  if (label === 'failed' || label === 'error') return s.red(label);
  return s.yellow(label);
}

export async function resolveRun(
  store: Store,
  projectId: string,
  ref: string | undefined,
): Promise<Run> {
  const run = ref ? await store.getRun(projectId, ref) : await store.latestRun(projectId);
  if (!run) {
    throw new ScopeError(ErrorCodes.notFound, ref ? `No run matches "${ref}"` : 'No runs yet', {
      hint: ref
        ? 'Use a run number (e.g. 12 or #12) or id. `scope runs` lists recent runs.'
        : 'Start one with `scope run <workflow.yaml>`.',
    });
  }
  return run;
}

export async function runsCommand(
  ctx: CommandContext,
  ref: string | undefined,
  options: RunsOptions,
): Promise<void> {
  const store = await ctx.store();
  const project = await ctx.projectRow();
  if (ref) return showRun(ctx, store, project.id, ref);

  const limit = options.limit ? Number(options.limit) : 20;
  const page = await store.listRuns(project.id, {
    ...(options.workflow ? { workflow: options.workflow } : {}),
    limit,
  });
  ctx.out.emitJson({ runs: page.items, nextCursor: page.nextCursor });
  const s = ctx.out.style;
  if (page.items.length === 0) {
    ctx.out.result(`No runs yet. Start one with ${s.bold('scope run <workflow.yaml>')}.`);
    return;
  }
  ctx.out.result(
    renderTable(
      page.items,
      [
        { header: 'Run', value: (r) => s.bold(`#${r.number}`) },
        { header: 'Workflow', value: (r) => r.workflowName, max: 28 },
        { header: 'Variant', value: (r) => r.variant ?? s.dim('—'), max: 18 },
        { header: 'Result', value: (r) => resultCell(r, s) },
        { header: 'Pass rate', value: (r) => formatPercent(r.passRate), align: 'right' },
        { header: 'Cases', value: (r) => String(r.caseCount), align: 'right' },
        {
          header: 'p95',
          value: (r) => formatDuration(r.summary?.latency.p95Ms ?? null),
          align: 'right',
        },
        {
          header: 'Cost',
          value: (r) => formatUsd(r.summary?.cost.totalUsd ?? null),
          align: 'right',
        },
        { header: 'Commit', value: (r) => (r.git?.commit ? r.git.commit.slice(0, 7) : s.dim('—')) },
        { header: 'Started', value: (r) => s.dim(formatRelativeTime(r.startedAt)) },
      ],
      s.dim,
    ),
  );
  if (page.nextCursor)
    ctx.out.print(
      s.dim(`\n  Showing ${page.items.length} most recent runs. Use --limit to see more.`),
    );
}

async function showRun(
  ctx: CommandContext,
  store: Store,
  projectId: string,
  ref: string,
): Promise<void> {
  const out = ctx.out;
  const s = out.style;
  const run = await resolveRun(store, projectId, ref);
  const failing = await store.listRunCases(projectId, run.id, { limit: 20, outcome: 'failed' });
  const errored = await store.listRunCases(projectId, run.id, { limit: 20, outcome: 'errored' });
  out.emitJson({ run, failingCases: [...errored.items, ...failing.items] });
  if (out.json) return;

  out.print('');
  out.print(
    `${s.bold(`Run #${run.number}`)}  ${s.bold(run.workflowName)}${run.variant ? `  ${s.cyan(run.variant)}` : ''}  ${resultCell(run, s)}`,
  );
  const facts = [
    `started ${formatRelativeTime(run.startedAt)}`,
    run.durationMs !== null ? `took ${formatDuration(run.durationMs)}` : 'still running',
    `${run.caseCount} cases`,
    run.dataset ? `dataset ${run.dataset.name}` : null,
    run.git?.commit
      ? `commit ${run.git.commit.slice(0, 7)}${run.git.dirty ? ' (dirty)' : ''}`
      : null,
    run.git?.branch ? `branch ${run.git.branch}` : null,
    run.trigger === 'ci' ? 'CI' : null,
  ].filter(Boolean);
  out.print(s.dim(`  ${facts.join(' · ')}`));
  if (Object.keys(run.params).length) {
    out.print(
      s.dim(
        `  params ${Object.entries(run.params)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')}`,
      ),
    );
  }
  if (run.baseline)
    out.print(
      s.dim(`  compared with baseline ${run.baseline.file} (run #${run.baseline.runNumber})`),
    );
  const m = run.manifest;
  if (m) {
    const files = m.files.length
      ? `${m.files.length} ${m.files.length === 1 ? 'file' : 'files'} fingerprinted (${m.files.map((f) => f.ref).join(', ')})`
      : 'no module or corpus files';
    out.print(s.dim(`  made by SCOPE ${m.scope} on Node.js ${m.node} · ${files}`));
    const models = m.models
      .filter((x) => !x.forEvaluation)
      .map((x) => {
        const reported = x.responseModels.filter((r) => r !== x.model);
        return `${x.provider}:${x.model}${reported.length ? ` (reported as ${reported.join(', ')})` : ''}`;
      });
    if (models.length) out.print(s.dim(`  models ${models.join(', ')}`));
  }
  out.print('');
  if (run.summary) {
    out.print(s.bold('Summary'));
    out.print(renderSummaryText(run.summary, s, out.sym));
    out.print('');
    out.print(s.bold('Evaluators'));
    out.print(renderEvaluatorsText(run.summary.evaluators, s));
    out.print('');
  }
  if (run.gates.length) {
    out.print(s.bold('Gates'));
    out.print(renderGatesText(run.gates, s, out.sym));
    out.print('');
  }
  const bad = [...errored.items, ...failing.items];
  if (bad.length) {
    out.print(s.bold('Failing cases'));
    for (const c of bad) {
      out.print(
        `  ${s.red(c.outcome === 'errored' ? out.sym.error : out.sym.fail)} ${s.bold(c.caseId)}  ${s.dim(`trace ${c.traceId.slice(0, 7)}`)}`,
      );
      const reasons = c.error
        ? [c.error.message]
        : c.evaluations
            .filter((e) => e.status === 'failed' || e.status === 'error')
            .map((e) => `${e.evaluator}: ${e.reason}`);
      for (const r of reasons.slice(0, 3))
        out.print(`      ${s.dim(r.length > 140 ? `${r.slice(0, 140)}…` : r)}`);
    }
    out.print('');
  }
  out.print(
    s.dim(
      `  scope traces --run ${run.number}   ·   scope report ${run.number}   ·   scope baseline save ${run.number}`,
    ),
  );
  out.print('');
}
