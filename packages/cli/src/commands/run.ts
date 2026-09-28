/**
 * scope run <workflow> — execute a workflow over its dataset, evaluate every case, apply gates,
 * store everything, and exit with the result.
 */
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  baselineFileName,
  type Dataset,
  type DatasetCase,
  datasetFromInputs,
  loadDataset,
  loadWorkflow,
  prepareCases,
  readBaseline,
} from '@scope-ai/config';
import {
  type Baseline,
  type CaseResult,
  ErrorCodes,
  evaluateGates,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  formatScore,
  formatUsd,
  gateStatus,
  type JsonObject,
  type RunSummary,
  ScopeError,
  snapshotCase,
  summarizeRun,
} from '@scope-ai/core';
import { type CaseExecution, Engine, type PreparedWorkflow, toCaseResult } from '@scope-ai/engine';
import type { Run } from '@scope-ai/storage';
import type { CommandContext } from '../context.ts';
import { ExitCode, type ExitCodeValue, ExitError } from '../errors.ts';
import { collectGitInfo, detectTrigger } from '../git.ts';
import {
  buildComparison,
  renderComparisonText,
  renderEvaluatorsText,
  renderGatesText,
  renderMarkdown,
  renderSummaryText,
  reportJson,
  resultLabel,
} from '../report.ts';
import { Progress } from '../ui/progress.ts';
import { renderTable } from '../ui/table.ts';

export interface RunCommandOptions {
  variant?: string[];
  allVariants?: boolean;
  dataset?: string;
  input?: string[];
  inputJson?: string;
  case?: string[];
  tag?: string[];
  limit?: string;
  concurrency?: string;
  bail?: boolean;
  baseline?: string | false;
  fail?: boolean;
  summaryFile?: string;
}

function parseInputs(pairs: string[] | undefined, json: string | undefined): JsonObject | null {
  if (!pairs?.length && !json) return null;
  let inputs: JsonObject = {};
  if (json) {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('must be a JSON object');
      inputs = parsed as JsonObject;
    } catch (error) {
      throw new ScopeError(
        ErrorCodes.usage,
        `--input-json is not valid: ${(error as Error).message}`,
        { hint: `Example: --input-json '{"question": "Where is my order?"}'` },
      );
    }
  }
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0)
      throw new ScopeError(ErrorCodes.usage, `--input "${pair}" should be key=value`, {
        hint: 'Example: --input question="Where is my order?"',
      });
    inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return inputs;
}

function selectCases(cases: DatasetCase[], options: RunCommandOptions): DatasetCase[] {
  let selected = cases;
  if (options.case?.length) {
    const wanted = new Set(options.case);
    selected = selected.filter((c) => wanted.has(c.id));
    const missing = [...wanted].filter((id) => !cases.some((c) => c.id === id));
    if (missing.length) {
      throw new ScopeError(
        ErrorCodes.usage,
        `No case with id ${missing.map((m) => `"${m}"`).join(', ')}`,
        {
          hint: `The dataset has ${cases.length} cases, e.g. ${cases
            .slice(0, 3)
            .map((c) => c.id)
            .join(', ')}.`,
        },
      );
    }
  }
  if (options.tag?.length) {
    const tags = new Set(options.tag);
    selected = selected.filter((c) => c.tags.some((t) => tags.has(t)));
  }
  if (options.limit !== undefined) {
    const n = Number(options.limit);
    if (!Number.isInteger(n) || n < 1)
      throw new ScopeError(ErrorCodes.usage, '--limit must be a positive integer');
    selected = selected.slice(0, n);
  }
  if (selected.length === 0)
    throw new ScopeError(ErrorCodes.usage, 'No cases selected', {
      hint: 'Check --case, --tag and --limit.',
    });
  return selected;
}

interface VariantResult {
  run: Run;
  summary: RunSummary;
  exitCode: ExitCodeValue;
}

export async function runCommand(
  ctx: CommandContext,
  workflowPath: string,
  options: RunCommandOptions,
): Promise<void> {
  const project = ctx.project();
  ctx.writeSchemas();
  const loaded = loadWorkflow(workflowPath, { root: ctx.cwd, env: ctx.env });
  const variants: Array<string | null> = options.allVariants
    ? [null, ...Object.keys(loaded.definition.variants ?? {})]
    : options.variant?.length
      ? options.variant.map((v) => (v === 'base' || v === 'default' ? null : v))
      : [null];

  const store = await ctx.store();
  const projectRow = await ctx.projectRow();
  const engine = new Engine({
    project,
    exporter: { export: (bundle) => store.ingest(projectRow.id, [bundle]).then(() => undefined) },
    logger: ctx.logger,
    env: ctx.env,
  });

  // Validate every requested variant before running any of them.
  const prepared: PreparedWorkflow[] = [];
  for (const variant of variants) prepared.push(await engine.prepare(loaded, { variant }));
  for (const w of prepared[0]?.warnings ?? []) {
    ctx.out.warn(
      `${w.file}${w.line ? `:${w.line}` : ''}: ${w.message}${w.hint ? ctx.out.errStyle.dim(` — ${w.hint}`) : ''}`,
    );
  }

  const adhoc = parseInputs(options.input, options.inputJson);
  let dataset: Dataset;
  if (adhoc) dataset = datasetFromInputs(adhoc, loaded.definition.name);
  else if (options.dataset)
    dataset = loadDataset(options.dataset, {
      baseDir: ctx.cwd,
      root: project.root,
      workflowName: loaded.definition.name,
    });
  else if (loaded.definition.dataset)
    dataset = loadDataset(loaded.definition.dataset, {
      baseDir: resolve(loaded.path, '..'),
      root: project.root,
      workflowName: loaded.definition.name,
    });
  else {
    throw new ScopeError(ErrorCodes.usage, `${loaded.displayPath} has no dataset`, {
      hint: `Add \`dataset: datasets/${loaded.definition.name}.jsonl\` to the workflow, pass --dataset <file>, or run one input with --input key=value.`,
    });
  }
  const { cases: allCases, warnings } = prepareCases(dataset, loaded.definition.inputs);
  for (const w of warnings) ctx.out.warn(w.message);
  const cases = selectCases(allCases, options);
  const subset = cases.length !== allCases.length;

  const workflowVersion = await store.registerWorkflowVersion(projectRow.id, {
    name: loaded.definition.name,
    description: loaded.definition.description ?? null,
    hash: loaded.hash,
    definition: loaded.definition,
    source: loaded.text,
    path: relative(project.root, loaded.path),
  });
  const git = collectGitInfo(project.root, ctx.env);
  const trigger = detectTrigger(ctx.env);

  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts === 1) {
      ctx.out.info(
        `\n${ctx.out.errStyle.yellow('Stopping')} — finishing in-flight cases. Press Ctrl-C again to exit immediately.`,
      );
      controller.abort(new ScopeError(ErrorCodes.cancelled, 'Run cancelled by user'));
    } else process.exit(ExitCode.interrupted);
  };
  process.on('SIGINT', onSigint);

  const results: VariantResult[] = [];
  const reports: unknown[] = [];
  const markdown: string[] = [];
  try {
    for (const prep of prepared) {
      if (controller.signal.aborted) break;
      const baseline = resolveBaseline(ctx, options, prep, project.baselinesDir);
      if (baseline && !subset) checkBaselineCompatibility(ctx, baseline, prep, dataset);
      const result = await executeVariant(ctx, {
        engine,
        prepared: prep,
        cases,
        dataset,
        workflowId: workflowVersion.workflowId,
        workflowVersionId: workflowVersion.versionId,
        projectId: projectRow.id,
        git,
        trigger,
        baseline: subset ? null : baseline,
        baselinePath: baseline
          ? options.baseline
            ? String(options.baseline)
            : relative(
                project.root,
                join(project.baselinesDir, baselineFileName(prep.name, prep.variant)),
              )
          : null,
        signal: controller.signal,
        concurrency: options.concurrency ? Number(options.concurrency) : undefined,
        bail: options.bail ?? false,
        failOnGates: options.fail !== false,
      });
      results.push(result.variant);
      reports.push(result.report);
      markdown.push(result.markdown);
    }
  } finally {
    process.off('SIGINT', onSigint);
  }

  if (results.length > 1) printVariantComparison(ctx, results);
  if (options.summaryFile) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(options.summaryFile, `${markdown.join('\n')}\n`);
  }
  ctx.out.emitJson(results.length === 1 ? reports[0] : { runs: reports });
  const exitCode = results.reduce<ExitCodeValue>(
    (worst, r) => (r.exitCode > worst ? r.exitCode : worst),
    ExitCode.ok,
  );
  if (exitCode !== ExitCode.ok) throw new ExitError(exitCode);
}

function resolveBaseline(
  ctx: CommandContext,
  options: RunCommandOptions,
  prep: PreparedWorkflow,
  dir: string,
): Baseline | null {
  if (options.baseline === false) return null;
  if (typeof options.baseline === 'string') {
    const file = resolve(ctx.cwd, options.baseline);
    return readBaseline(file, relative(ctx.cwd, file) || file);
  }
  const conventional = join(dir, baselineFileName(prep.name, prep.variant));
  if (existsSync(conventional)) return readBaseline(conventional, relative(ctx.cwd, conventional));
  return null;
}

function checkBaselineCompatibility(
  ctx: CommandContext,
  baseline: Baseline,
  prep: PreparedWorkflow,
  dataset: Dataset,
): void {
  if (baseline.workflow !== prep.name) {
    throw new ScopeError(
      ErrorCodes.baselineInvalid,
      `The baseline is for workflow "${baseline.workflow}", not "${prep.name}"`,
      {
        hint: 'Pass the matching baseline file with --baseline, or --no-baseline.',
      },
    );
  }
  if (baseline.dataset && baseline.dataset.hash !== dataset.hash) {
    ctx.out.warn(
      `the dataset changed since the baseline was saved (${baseline.dataset.caseCount} → ${dataset.cases.length} cases); per-case comparisons may include added or removed cases`,
    );
  }
}

interface ExecuteParams {
  engine: Engine;
  prepared: PreparedWorkflow;
  cases: DatasetCase[];
  dataset: Dataset;
  workflowId: string;
  workflowVersionId: string;
  projectId: string;
  git: ReturnType<typeof collectGitInfo>;
  trigger: ReturnType<typeof detectTrigger>;
  baseline: Baseline | null;
  baselinePath: string | null;
  signal: AbortSignal;
  concurrency: number | undefined;
  bail: boolean;
  failOnGates: boolean;
}

async function executeVariant(
  ctx: CommandContext,
  p: ExecuteParams,
): Promise<{ variant: VariantResult; report: unknown; markdown: string }> {
  const out = ctx.out;
  const s = out.style;
  const store = await ctx.store();
  const model = typeof p.prepared.params.model === 'string' ? p.prepared.params.model : null;
  let run = await store.createRun({
    projectId: p.projectId,
    workflowId: p.workflowId,
    workflowVersionId: p.workflowVersionId,
    workflowName: p.prepared.name,
    variant: p.prepared.variant,
    params: p.prepared.params,
    dataset: {
      name: p.dataset.name,
      source: p.dataset.source,
      caseCount: p.dataset.cases.length,
      hash: p.dataset.hash,
    },
    git: p.git,
    trigger: p.trigger,
    baseline: p.baseline
      ? {
          file: p.baselinePath ?? 'baseline',
          runNumber: p.baseline.source.runNumber,
          commit: p.baseline.source.git?.commit ?? null,
          createdAt: p.baseline.createdAt,
        }
      : null,
    caseCount: p.cases.length,
  });

  const facts = [
    `run ${s.bold(`#${run.number}`)}`,
    `${p.cases.length} ${p.cases.length === 1 ? 'case' : 'cases'}`,
    p.prepared.variant ? `variant ${s.cyan(p.prepared.variant)}` : null,
    model ? model : null,
    p.baseline ? `baseline run #${p.baseline.source.runNumber}` : null,
  ].filter(Boolean);
  out.print('');
  out.print(
    `${s.bold('SCOPE')} ${s.dim('·')} ${s.bold(p.prepared.name)}  ${s.dim(facts.join(' · '))}`,
  );
  out.print('');

  const progress = new Progress(out, p.cases.length);
  const started = performance.now();
  let executions: CaseExecution[] = [];
  let cancelled = false;
  try {
    const result = await p.engine.run(p.prepared, p.cases, {
      runId: run.id,
      ...(p.concurrency !== undefined ? { concurrency: p.concurrency } : {}),
      bail: p.bail,
      signal: p.signal,
      onCaseStart: (c) => progress.start(c.id),
      onCaseComplete: (execution) => progress.complete(execution),
    });
    executions = result.executions;
    cancelled = result.cancelled;
  } catch (error) {
    progress.stop();
    await store.completeRun(run.id, {
      status: 'failed',
      summary: null,
      gates: [],
      gateStatus: 'none',
      error: { type: 'Error', message: (error as Error).message },
    });
    throw error;
  }
  progress.stop();
  const elapsed = performance.now() - started;

  const caseResults: CaseResult[] = executions.map(toCaseResult);
  const summary = summarizeRun(caseResults, {
    evaluatorOrder: p.prepared.evaluators.map((e) => e.name),
  });
  const gates = cancelled
    ? []
    : evaluateGates(summary, p.prepared.gates, p.baseline?.summary ?? null);
  const status = gateStatus(gates);
  run = await store.completeRun(run.id, {
    status: cancelled ? 'cancelled' : 'completed',
    summary,
    gates,
    gateStatus: cancelled ? 'none' : status,
  });

  const snapshots = Object.fromEntries(caseResults.map((r) => [r.caseId, snapshotCase(r)]));
  const comparison = buildComparison(summary, snapshots, p.baseline);
  const failures = executions
    .filter(
      (e) =>
        e.status === 'error' ||
        e.evaluations.some((x) => x.status === 'failed' || x.status === 'error'),
    )
    .map((e) => ({
      caseId: e.caseId,
      traceId: e.traceId,
      outcome:
        e.status === 'error' || e.evaluations.some((x) => x.status === 'error')
          ? 'errored'
          : 'failed',
      reasons:
        e.status === 'error'
          ? [e.error?.message ?? 'execution failed']
          : e.evaluations
              .filter((x) => x.status === 'failed' || x.status === 'error')
              .map((x) => `${x.evaluator}: ${x.reason}`),
    }));

  // ── human output ──
  if (failures.length) {
    out.print(s.bold('Failures'));
    for (const f of failures.slice(0, 15)) {
      const icon = f.outcome === 'errored' ? s.red(out.sym.error) : s.red(out.sym.fail);
      out.print(`  ${icon} ${s.bold(f.caseId)}  ${s.dim(f.traceId.slice(0, 7))}`);
      for (const r of f.reasons.slice(0, 3))
        out.print(`      ${s.dim(r.length > 140 ? `${r.slice(0, 140)}…` : r)}`);
    }
    if (failures.length > 15)
      out.print(s.dim(`  … and ${failures.length - 15} more (scope runs ${run.number})`));
    out.print('');
  }
  out.print(s.bold('Summary'));
  out.print(renderSummaryText(summary, s, out.sym));
  out.print('');
  out.print(s.bold('Evaluators'));
  out.print(renderEvaluatorsText(summary.evaluators, s));
  out.print('');
  if (comparison && p.baseline) {
    out.print(
      `${s.bold('Compared with baseline')} ${s.dim(`run #${p.baseline.source.runNumber}${p.baseline.source.git?.commit ? ` · ${p.baseline.source.git.commit.slice(0, 7)}` : ''} · saved ${formatRelativeTime(Date.parse(p.baseline.createdAt))}`)}`,
    );
    out.print(renderComparisonText(comparison, summary.evaluators, s, out.sym));
    out.print('');
  }
  if (!cancelled) {
    out.print(s.bold('Gates'));
    out.print(renderGatesText(gates, s, out.sym));
    out.print('');
  }

  const label = resultLabel(run);
  const color =
    label === 'PASSED' || label === 'COMPLETED'
      ? s.green
      : label.startsWith('PASSED')
        ? s.yellow
        : s.red;
  out.result(
    `${color(s.bold(label))}  ${s.dim(`run #${run.number} · ${executions.length} ${executions.length === 1 ? 'case' : 'cases'} in ${formatDuration(elapsed)}`)}`,
  );
  const failedGates = gates.filter((g) => g.status === 'failed' && g.severity === 'fail');
  for (const g of failedGates) out.result(`  ${s.red(out.sym.fail)} ${g.message}`);
  out.print(`  ${s.dim('Inspect')}  scope runs ${run.number}   ${s.dim('·')}   scope ui`);
  if (!p.baseline && !cancelled && status !== 'failed')
    out.print(
      `  ${s.dim('Baseline')} scope baseline save ${run.number}  ${s.dim('— enables regression gates in CI')}`,
    );
  out.print('');

  const input = {
    run,
    summary,
    gates,
    baseline: p.baseline,
    comparison,
    failures: failures.slice(0, 50),
  };
  let exitCode: ExitCodeValue = ExitCode.ok;
  if (cancelled) exitCode = ExitCode.interrupted;
  else if (status === 'failed' && p.failOnGates) exitCode = ExitCode.gatesFailed;
  return {
    variant: { run, summary, exitCode },
    report: reportJson(input),
    markdown: renderMarkdown(input),
  };
}

function printVariantComparison(ctx: CommandContext, results: VariantResult[]): void {
  const out = ctx.out;
  const s = out.style;
  const evaluatorNames = [
    ...new Set(results.flatMap((r) => r.summary.evaluators.map((e) => e.name))),
  ];
  const best = (values: Array<number | null>, higher: boolean) => {
    const known = values.filter((v): v is number => v !== null);
    if (known.length < 2) return null;
    return higher ? Math.max(...known) : Math.min(...known);
  };
  const passBest = best(
    results.map((r) => r.summary.passRate),
    true,
  );
  const p95Best = best(
    results.map((r) => r.summary.latency.p95Ms),
    false,
  );
  const mark = (value: number | null, target: number | null, text: string) =>
    value !== null && value === target ? s.green(text) : text;
  out.print(s.bold('Variants'));
  out.print(
    renderTable(
      results,
      [
        { header: 'Variant', value: (r) => s.bold(r.run.variant ?? 'base') },
        { header: 'Run', value: (r) => `#${r.run.number}` },
        {
          header: 'Pass rate',
          value: (r) => mark(r.summary.passRate, passBest, formatPercent(r.summary.passRate)),
          align: 'right',
        },
        ...evaluatorNames.map((name) => ({
          header: name,
          align: 'right' as const,
          value: (r: VariantResult) => {
            const scores = results.map(
              (x) => x.summary.evaluators.find((e) => e.name === name)?.meanScore ?? null,
            );
            const value = r.summary.evaluators.find((e) => e.name === name)?.meanScore ?? null;
            return mark(value, best(scores, true), formatScore(value));
          },
        })),
        {
          header: 'p95',
          value: (r) =>
            mark(r.summary.latency.p95Ms, p95Best, formatDuration(r.summary.latency.p95Ms)),
          align: 'right',
        },
        { header: 'Cost', value: (r) => formatUsd(r.summary.cost.totalUsd), align: 'right' },
        { header: 'Result', value: (r) => resultLabel(r.run).toLowerCase() },
      ],
      s.dim,
    ),
  );
  out.print(
    `  ${s.dim(`Compare in detail: scope compare ${results[0]?.run.number} ${results[1]?.run.number}`)}`,
  );
  out.print('');
}

/** Exported for tests. */
export const __test = { parseInputs, selectCases };
