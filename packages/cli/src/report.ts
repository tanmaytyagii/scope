/**
 * Run reports in three formats: terminal text, GitHub-flavored Markdown (job summaries and
 * pull-request comments) and JSON. Pure functions over run data.
 */
import {
  type Baseline,
  type CaseChange,
  type CaseSnapshot,
  type Comparison,
  type ConfigDiff,
  type ConfigSnapshot,
  compareConfig,
  compareRuns,
  type EvaluatorSummary,
  formatDelta,
  formatDuration,
  formatMetric,
  formatPercent,
  formatRelativeTime,
  formatScore,
  formatTokens,
  formatUsd,
  type GateResult,
  headlineMetrics,
  type MetricDelta,
  type RunSummary,
} from '@scope-ai/core';
import type { Run } from '@scope-ai/storage';
import { plainStyle, type Style, type Symbols, symbols } from './ui/style.ts';
import { renderTable } from './ui/table.ts';

/** The baseline a run was compared with, as reports describe it. */
export interface ReportBaseline {
  runNumber: number;
  commit: string | null;
  createdAt: string;
}

export function reportBaseline(baseline: Baseline): ReportBaseline {
  return {
    runNumber: baseline.source.runNumber,
    commit: baseline.source.git?.commit ?? null,
    createdAt: baseline.createdAt,
  };
}

export interface ReportInput {
  run: Run;
  summary: RunSummary;
  gates: GateResult[];
  baseline: ReportBaseline | null;
  /** Per-case comparison against the baseline, when both have case data. */
  comparison: Comparison | null;
  /** Failing cases to list (already limited by the caller). */
  failures: Array<{ caseId: string; traceId: string; outcome: string; reasons: string[] }>;
  /** Base URL of a SCOPE dashboard, for links. */
  dashboardUrl?: string | null;
}

const KIND_LABEL: Record<string, string> = {
  deterministic: 'deterministic',
  heuristic: 'heuristic',
  model: 'model',
};

export function resultLabel(run: Run): string {
  if (run.status === 'cancelled') return 'CANCELLED';
  if (run.status === 'failed') return 'ERROR';
  switch (run.gateStatus) {
    case 'failed':
      return 'FAILED';
    case 'warned':
      return 'PASSED WITH WARNINGS';
    case 'passed':
      return 'PASSED';
    default:
      return 'COMPLETED';
  }
}

export function buildComparison(
  summary: RunSummary,
  cases: Record<string, CaseSnapshot>,
  baseline: Baseline | null,
  head?: ConfigSnapshot,
): Comparison | null {
  if (!baseline) return null;
  const comparison = compareRuns(
    { summary: baseline.summary, cases: baseline.cases },
    { summary, cases },
  );
  if (head)
    comparison.config = compareConfig(
      {
        params: baseline.config?.params ?? null,
        workflow: baseline.config?.workflowHash ?? null,
        datasetHash: baseline.dataset?.hash ?? null,
      },
      head,
    );
  return comparison;
}

// ─── text ────────────────────────────────────────────────────────────────────────────────────

function gateIcon(g: GateResult, s: Style, sym: Symbols): string {
  if (g.status === 'skipped') return s.dim(sym.skip);
  if (g.status === 'passed') return s.green(sym.pass);
  return g.severity === 'warn' ? s.yellow(sym.warn) : s.red(sym.fail);
}

function passRateBar(rate: number | null, width = 12): string {
  if (rate === null) return ' '.repeat(width);
  const filled = Math.round(rate * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function renderSummaryText(
  summary: RunSummary,
  s: Style = plainStyle,
  sym: Symbols = symbols(),
): string {
  const lines: string[] = [];
  const c = summary.cases;
  const passColor =
    summary.passRate === null
      ? s.dim
      : summary.passRate >= 0.9
        ? s.green
        : summary.passRate >= 0.7
          ? s.yellow
          : s.red;
  lines.push(
    `  ${s.dim('Pass rate ')}  ${passColor(`${formatPercent(summary.passRate)}`)}  ${s.dim(`${c.passed}/${c.total} passed${c.failed ? ` · ${c.failed} failed` : ''}${c.errored ? ` · ${c.errored} errored` : ''}`)}`,
  );
  lines.push(
    `  ${s.dim('Latency   ')}  p50 ${formatDuration(summary.latency.p50Ms)} ${s.dim(sym.dot)} p95 ${formatDuration(summary.latency.p95Ms)}`,
  );
  lines.push(
    `  ${s.dim('Tokens    ')}  ${formatTokens(summary.tokens.total)} ${s.dim(`(${formatTokens(summary.tokens.input)} in ${sym.dot} ${formatTokens(summary.tokens.output)} out${summary.tokens.estimated ? ' · estimated' : ''})`)}`,
  );
  const cost = summary.cost;
  const costNote = cost.unpricedModels.length
    ? s.yellow(` + unpriced: ${cost.unpricedModels.join(', ')}`)
    : '';
  lines.push(
    `  ${s.dim('Cost      ')}  ${formatUsd(cost.totalUsd)} ${s.dim('estimated')}${costNote}`,
  );
  return lines.join('\n');
}

export function renderEvaluatorsText(
  evaluators: EvaluatorSummary[],
  s: Style = plainStyle,
): string {
  if (evaluators.length === 0) return `  ${s.dim('No evaluators configured.')}`;
  return renderTable(
    evaluators,
    [
      { header: 'Evaluator', value: (e) => s.bold(e.name) },
      { header: 'Kind', value: (e) => s.dim(KIND_LABEL[e.kind] ?? e.kind) },
      { header: 'Pass', value: (e) => formatPercent(e.passRate), align: 'right' },
      { header: '', value: (e) => s.dim(passRateBar(e.passRate)) },
      { header: 'Mean score', value: (e) => formatScore(e.meanScore), align: 'right' },
      {
        header: 'Results',
        value: (e) =>
          s.dim(
            [
              `${e.passed} passed`,
              e.failed ? `${e.failed} failed` : '',
              e.errored ? `${e.errored} errored` : '',
              e.skipped ? `${e.skipped} skipped` : '',
            ]
              .filter(Boolean)
              .join(' · '),
          ),
      },
    ],
    s.dim,
  );
}

export function renderGatesText(
  gates: GateResult[],
  s: Style = plainStyle,
  sym: Symbols = symbols(),
): string {
  if (gates.length === 0)
    return `  ${s.dim('No gates configured. Add `gates:` to the workflow to fail runs on regressions.')}`;
  return gates
    .map((g) => {
      const actual = g.actual === null ? '—' : formatMetric(g.actual, g.unit);
      const detail =
        g.status === 'skipped'
          ? s.dim(g.message)
          : s.dim(
              `${actual}${g.baseline !== null && g.condition !== 'min' && g.condition !== 'max' ? ` (baseline ${formatMetric(g.baseline, g.unit)})` : ''}`,
            );
      return `  ${gateIcon(g, s, sym)} ${g.metric} ${g.expectation}  ${detail}`;
    })
    .join('\n');
}

function showValue(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/**
 * What changed in configuration, as short phrases: "sentences 2 → 1", "the workflow file",
 * "the dataset". Empty when nothing is known to have changed.
 */
export function describeConfig(config: ConfigDiff | undefined): string[] {
  if (!config) return [];
  const out = config.params.map((p) => `${p.key} ${showValue(p.base)} → ${showValue(p.head)}`);
  if (config.workflowChanged) out.push('the workflow file');
  if (config.datasetChanged) out.push('the dataset');
  return out;
}

export function renderComparisonText(
  comparison: Comparison,
  evaluators: ReadonlyArray<{ name: string; kind: string }>,
  s: Style = plainStyle,
  sym: Symbols = symbols(),
): string {
  const interesting = headlineMetrics(comparison.metrics, evaluators);
  const arrow = (m: MetricDelta) =>
    m.change === 'improved'
      ? s.green('▲ better')
      : m.change === 'regressed'
        ? s.red('▼ worse')
        : s.dim(m.change === 'n/a' ? '' : '= same');
  const table = renderTable(
    interesting,
    [
      { header: 'Metric', value: (m) => m.label },
      { header: 'Baseline', value: (m) => formatMetric(m.base, m.unit), align: 'right' },
      { header: 'Current', value: (m) => formatMetric(m.head, m.unit), align: 'right' },
      { header: 'Change', value: (m) => formatDelta(m.base, m.head, m.unit), align: 'right' },
      { header: '', value: arrow },
    ],
    s.dim,
  );
  const counts = comparison.counts;
  const parts = [
    counts.regressed ? s.red(`${counts.regressed} regressed`) : '',
    counts.fixed ? s.green(`${counts.fixed} fixed`) : '',
    counts.changed ? `${counts.changed} changed` : '',
    counts.added ? `${counts.added} new` : '',
    counts.removed ? `${counts.removed} removed` : '',
    `${counts.unchanged} unchanged`,
  ].filter(Boolean);
  const lines = [table, '', `  ${s.dim('Cases')}  ${parts.join(s.dim(` ${sym.dot} `))}`];
  const changed = describeConfig(comparison.config);
  if (changed.length) lines.push(`  ${s.dim('Changed')}  ${changed.join(s.dim(` ${sym.dot} `))}`);
  for (const c of comparison.cases
    .filter((x) => x.kind === 'regressed' || x.kind === 'fixed')
    .slice(0, 10)) {
    lines.push(
      `    ${c.kind === 'regressed' ? s.red(sym.fail) : s.green(sym.pass)} ${c.caseId}  ${s.dim(describeCaseChange(c))}`,
    );
  }
  return lines.join('\n');
}

export function describeCaseChange(c: CaseChange): string {
  const moved = c.evaluators.filter((e) => e.change === 'regressed' || e.change === 'improved');
  const detail = moved
    .map((e) => {
      const b = e.base?.score;
      const h = e.head?.score;
      const scores =
        b !== null && b !== undefined && h !== null && h !== undefined
          ? ` ${formatScore(b)} → ${formatScore(h)}`
          : '';
      return `${e.evaluator} ${e.base?.status ?? '—'} → ${e.head?.status ?? '—'}${scores}`;
    })
    .join('; ');
  return `${c.base?.outcome ?? 'new'} → ${c.head?.outcome ?? 'removed'}${detail ? ` (${detail})` : ''}`;
}

// ─── markdown ────────────────────────────────────────────────────────────────────────────────

const MD_ICON = { passed: '✅', failed: '❌', warned: '⚠️', skipped: '➖', none: 'ℹ️' } as const;

function mdEscape(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/</g, '&lt;');
}

export function renderMarkdown(input: ReportInput): string {
  const { run, summary, gates, baseline, comparison } = input;
  const icon =
    run.status !== 'completed'
      ? '⚠️'
      : run.gateStatus === 'failed'
        ? '❌'
        : run.gateStatus === 'warned'
          ? '⚠️'
          : '✅';
  const lines: string[] = [];
  lines.push(
    `### ${icon} SCOPE · ${run.workflowName}${run.variant ? ` · \`${run.variant}\`` : ''} — ${resultLabel(run).toLowerCase()}`,
  );
  const facts = [
    `Run #${run.number}`,
    `${summary.cases.total} cases`,
    run.git?.commit ? `commit \`${run.git.commit.slice(0, 7)}\`` : null,
    baseline
      ? `baseline: run #${baseline.runNumber}${baseline.commit ? ` (\`${baseline.commit.slice(0, 7)}\`)` : ''}, ${formatRelativeTime(Date.parse(baseline.createdAt))}`
      : 'no baseline',
  ].filter(Boolean);
  lines.push('', `<sub>${facts.join(' · ')}</sub>`, '');

  const failedGates = gates.filter((g) => g.status === 'failed');
  if (failedGates.length) {
    lines.push(`**${failedGates.length === 1 ? 'Reason' : 'Reasons'}:**`);
    for (const g of failedGates)
      lines.push(`- ${g.severity === 'warn' ? '⚠️' : '❌'} ${mdEscape(g.message)}`);
    lines.push('');
  }
  const changed = describeConfig(comparison?.config);
  if (changed.length)
    lines.push(
      `**Changed since the baseline:** ${changed.map((c) => mdEscape(c)).join(' · ')}`,
      '',
    );

  // Metrics table (with baseline column when comparing).
  const metricRows: Array<{
    label: string;
    unit: MetricDelta['unit'];
    base: number | null;
    head: number | null;
    change: MetricDelta['change'] | null;
    id: string;
  }> = comparison
    ? headlineMetrics(comparison.metrics, summary.evaluators).map((m) => ({
        label: m.label,
        unit: m.unit,
        base: m.base,
        head: m.head,
        change: m.change,
        id: m.id,
      }))
    : [
        {
          label: 'Pass rate',
          unit: 'ratio',
          base: null,
          head: summary.passRate,
          change: null,
          id: 'pass_rate',
        },
        ...summary.evaluators.map((e) =>
          e.kind === 'deterministic'
            ? {
                label: `${e.name} pass rate`,
                unit: 'ratio' as const,
                base: null,
                head: e.passRate,
                change: null,
                id: `evaluator.${e.name}.pass_rate`,
              }
            : {
                label: `${e.name} score`,
                unit: 'score' as const,
                base: null,
                head: e.meanScore,
                change: null,
                id: `evaluator.${e.name}.mean_score`,
              },
        ),
        {
          label: 'Latency p95',
          unit: 'ms',
          base: null,
          head: summary.latency.p95Ms,
          change: null,
          id: 'latency.p95_ms',
        },
        {
          label: 'Tokens',
          unit: 'tokens',
          base: null,
          head: summary.tokens.total,
          change: null,
          id: 'tokens.total',
        },
        {
          label: 'Cost (est.)',
          unit: 'usd',
          base: null,
          head: summary.cost.totalUsd,
          change: null,
          id: 'cost.total_usd',
        },
      ];
  const gateFor = (id: string) => {
    const relevant = gates.filter((g) => g.metric === id && g.status !== 'skipped');
    if (relevant.some((g) => g.status === 'failed' && g.severity === 'fail')) return MD_ICON.failed;
    if (relevant.some((g) => g.status === 'failed')) return MD_ICON.warned;
    if (relevant.length) return MD_ICON.passed;
    return '';
  };
  if (comparison) {
    lines.push(
      '| Metric | Baseline | Current | Change | Gate |',
      '| --- | ---: | ---: | ---: | :---: |',
    );
    for (const m of metricRows) {
      const trend = m.change === 'improved' ? ' ↑' : m.change === 'regressed' ? ' ↓' : '';
      lines.push(
        `| ${mdEscape(m.label)} | ${formatMetric(m.base, m.unit)} | ${formatMetric(m.head, m.unit)} | ${formatDelta(m.base, m.head, m.unit)}${trend} | ${gateFor(m.id)} |`,
      );
    }
  } else {
    lines.push('| Metric | Value | Gate |', '| --- | ---: | :---: |');
    for (const m of metricRows)
      lines.push(`| ${mdEscape(m.label)} | ${formatMetric(m.head, m.unit)} | ${gateFor(m.id)} |`);
  }
  lines.push('');

  if (gates.length) {
    lines.push(
      '<details><summary>Gates</summary>',
      '',
      '| | Metric | Expected | Actual |',
      '| :---: | --- | --- | --- |',
    );
    for (const g of gates) {
      const status =
        g.status === 'passed'
          ? MD_ICON.passed
          : g.status === 'skipped'
            ? MD_ICON.skipped
            : g.severity === 'warn'
              ? MD_ICON.warned
              : MD_ICON.failed;
      lines.push(
        `| ${status} | \`${g.metric}\` | ${mdEscape(g.expectation)} | ${g.status === 'skipped' ? mdEscape(g.message) : formatMetric(g.actual, g.unit)} |`,
      );
    }
    lines.push('', '</details>', '');
  }

  if (comparison && (comparison.counts.regressed || comparison.counts.fixed)) {
    const moved = comparison.cases.filter((c) => c.kind === 'regressed' || c.kind === 'fixed');
    lines.push(
      `<details><summary>${comparison.counts.regressed} regressed, ${comparison.counts.fixed} fixed ${comparison.counts.regressed + comparison.counts.fixed === 1 ? 'case' : 'cases'}</summary>`,
      '',
    );
    lines.push('| Case | Change |', '| --- | --- |');
    for (const c of moved.slice(0, 50))
      lines.push(
        `| \`${mdEscape(c.caseId)}\` | ${c.kind === 'regressed' ? '❌' : '✅'} ${mdEscape(describeCaseChange(c))} |`,
      );
    if (moved.length > 50) lines.push(`| … | ${moved.length - 50} more |`);
    lines.push('', '</details>', '');
  }

  if (input.failures.length) {
    lines.push(
      `<details><summary>Failing cases (${summary.cases.failed + summary.cases.errored})</summary>`,
      '',
    );
    lines.push('| Case | Outcome | Why |', '| --- | --- | --- |');
    for (const f of input.failures) {
      const link = input.dashboardUrl
        ? `[\`${mdEscape(f.caseId)}\`](${input.dashboardUrl}/traces/${f.traceId})`
        : `\`${mdEscape(f.caseId)}\``;
      lines.push(`| ${link} | ${f.outcome} | ${mdEscape(f.reasons.join('; ').slice(0, 300))} |`);
    }
    lines.push('', '</details>', '');
  }

  const kinds = new Set(summary.evaluators.map((e) => e.kind));
  const notes = ['Costs are estimates from a dated pricing table.'];
  if (kinds.has('heuristic')) notes.unshift('Heuristic scores are signals, not verdicts.');
  if (kinds.has('model')) notes.unshift('Model-graded scores are a judge model’s opinion.');
  if (summary.tokens.estimated) notes.push('Token counts include local estimates.');
  lines.push(`<sub>${notes.join(' ')} Generated by SCOPE.</sub>`);
  return `${lines.join('\n')}\n`;
}

// ─── json ────────────────────────────────────────────────────────────────────────────────────

export function reportJson(input: ReportInput) {
  return {
    schema: 'scope.report/v1',
    run: {
      id: input.run.id,
      number: input.run.number,
      workflow: input.run.workflowName,
      variant: input.run.variant,
      status: input.run.status,
      gateStatus: input.run.gateStatus,
      result: resultLabel(input.run),
      startedAt: new Date(input.run.startedAt).toISOString(),
      durationMs: input.run.durationMs,
      git: input.run.git,
      dataset: input.run.dataset,
    },
    summary: input.summary,
    gates: input.gates,
    baseline: input.baseline,
    comparison: input.comparison
      ? {
          metrics: input.comparison.metrics,
          counts: input.comparison.counts,
          cases: input.comparison.cases.filter((c) => c.kind !== 'unchanged'),
          config: input.comparison.config ?? null,
        }
      : null,
    failures: input.failures,
  };
}
