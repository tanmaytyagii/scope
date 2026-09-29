/**
 * A run: did it pass its gates, which evaluators failed, and on which cases — with a direct
 * path from every failing case to its trace.
 */
import type { GateResult, Run, RunCase } from '@scope-ai/protocol';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { allItems, useBaselineComparison, useRun, useRunCases, useRuns } from '../api/queries.ts';
import { useTitle, useUrlState } from '../app/hooks.ts';
import {
  CaseChangeCounts,
  CaseChangeTable,
  describeConfig,
  MetricDeltaTable,
} from '../components/Comparison.tsx';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatMetric,
  formatNumber,
  formatScore,
  formatTokens,
  relativeTime,
} from '../lib/format.ts';
import { readablePreview } from '../lib/payload.ts';
import { buttonClass } from '../ui/Button.tsx';
import { CodeBlock } from '../ui/CodeBlock.tsx';
import { SearchInput, Segmented, Select } from '../ui/Controls.tsx';
import { IdChip } from '../ui/Copy.tsx';
import { Meter, PageHeader, StatRow, StatTile } from '../ui/Figures.tsx';
import { Alert, Check, Cross, IconCompare, Skip } from '../ui/icons.tsx';
import { KindBadge } from '../ui/Kind.tsx';
import { Facts, Panel } from '../ui/Panel.tsx';
import { EmptyState, ErrorState, Loading } from '../ui/States.tsx';
import { OutcomeBadge, RunResult, StatusIcon } from '../ui/Status.tsx';
import { MoreRows, Table, TD, TH, THead, TR } from '../ui/Table.tsx';
import { Tooltip } from '../ui/Tooltip.tsx';

function GateIcon({ gate }: { gate: GateResult }) {
  if (gate.status === 'passed') return <Check size={14} className="text-good-fg" label="passed" />;
  if (gate.status === 'skipped') return <Skip size={14} className="text-fg-3" label="skipped" />;
  if (gate.severity === 'warn') return <Alert size={14} className="text-warn-fg" label="warning" />;
  return <Cross size={14} className="text-bad-fg" label="failed" />;
}

function Gates({ run }: { run: Run }) {
  if (run.gates.length === 0) {
    return (
      <Panel title="Gates">
        <p className="px-4 py-5 text-sm text-fg-2">
          This run had no gates, so nothing decided pass or fail. Add{' '}
          <code className="text-xs">gates:</code> to the workflow — for example{' '}
          <code className="text-xs">{'{ metric: pass_rate, min: 0.9 }'}</code>.
        </p>
      </Panel>
    );
  }
  return (
    <Panel title="Gates" description="Thresholds that decide the run’s exit code in CI">
      <Table>
        <THead>
          <TH className="w-8">
            <span className="sr-only">Result</span>
          </TH>
          <TH>Metric</TH>
          <TH>Condition</TH>
          <TH align="right">Actual</TH>
          <TH align="right">Baseline</TH>
          <TH>Detail</TH>
        </THead>
        <tbody>
          {run.gates.map((g) => (
            <TR key={`${g.metric}:${g.condition}`}>
              <TD>
                <GateIcon gate={g} />
              </TD>
              <TD>
                <div className="text-fg">{g.label}</div>
                <div className="font-mono text-2xs text-fg-3">{g.metric}</div>
              </TD>
              <TD className="text-fg-2">
                {g.expectation}
                {g.severity === 'warn' && (
                  <span className="ml-1.5 text-2xs text-fg-3">(warning only)</span>
                )}
              </TD>
              <TD align="right">{formatMetric(g.actual, g.unit)}</TD>
              <TD align="right" className="text-fg-3">
                {g.baseline === null ? '—' : formatMetric(g.baseline, g.unit)}
              </TD>
              <TD className="max-w-md text-xs text-fg-2">{g.message}</TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

function Evaluators({ run, onFilter }: { run: Run; onFilter: (evaluator: string) => void }) {
  const evaluators = run.summary?.evaluators ?? [];
  if (evaluators.length === 0) return null;
  return (
    <Panel title="Evaluators" description="How each evaluator judged this run’s cases">
      <Table>
        <THead>
          <TH>Evaluator</TH>
          <TH>Kind</TH>
          <TH align="right">Pass rate</TH>
          <TH align="right">Mean score</TH>
          <TH align="right">Passed</TH>
          <TH align="right">Failed</TH>
          <TH align="right">Errored</TH>
          <TH align="right">Skipped</TH>
          <TH>
            <span className="sr-only">Filter</span>
          </TH>
        </THead>
        <tbody>
          {evaluators.map((e) => (
            <TR key={e.name}>
              <TD>
                <div className="font-medium text-fg">{e.name}</div>
                <div className="font-mono text-2xs text-fg-3">{e.type}</div>
              </TD>
              <TD>
                <KindBadge kind={e.kind} />
              </TD>
              <TD align="right">
                <Meter value={e.passRate} label={`${e.name} pass rate`} />
              </TD>
              <TD align="right">{formatScore(e.meanScore)}</TD>
              <TD align="right">{e.passed}</TD>
              <TD align="right" className={e.failed ? 'text-bad-fg' : 'text-fg-3'}>
                {e.failed}
              </TD>
              <TD align="right" className={e.errored ? 'text-bad-fg' : 'text-fg-3'}>
                {e.errored}
              </TD>
              <TD align="right" className="text-fg-3">
                {e.skipped}
              </TD>
              <TD align="right">
                {e.failed + e.errored > 0 && (
                  <button
                    type="button"
                    onClick={() => onFilter(e.name)}
                    className="rounded-sm px-1.5 py-0.5 text-xs text-accent-fg hover:bg-hover"
                  >
                    Show failures
                  </button>
                )}
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

/** Chips in the workflow's evaluator order, so columns of chips line up from row to row. */
function EvaluationChips({ c, order }: { c: RunCase; order: readonly string[] }) {
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i === -1 ? order.length : i;
  };
  const evaluations = [...c.evaluations].sort((a, b) => rank(a.evaluator) - rank(b.evaluator));
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {evaluations.map((e) => (
        <Tooltip
          key={e.evaluator}
          content={
            <span>
              <strong className="font-semibold">{e.evaluator}</strong> · {e.status}
              {e.score !== null ? ` · score ${formatScore(e.score)}` : ''}
              <br />
              {e.reason}
            </span>
          }
        >
          <span
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable to reveal the reason
            tabIndex={0}
            className={`inline-flex cursor-help items-center gap-1 text-xs ${
              e.status === 'failed' || e.status === 'error' ? 'text-bad-fg' : 'text-fg-3'
            }`}
          >
            <StatusIcon outcome={e.status} />
            {e.evaluator}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

function Cases({ run }: { run: Run }) {
  const [filters, setFilters] = useUrlState(['outcome', 'evaluator', 'q'] as const);
  const cases = useRunCases(String(run.number), filters);
  const items = allItems(cases.data);
  const evaluators = run.summary?.evaluators.map((e) => e.name) ?? [];
  const outcome = (filters.outcome || 'all') as 'all' | 'failed' | 'errored' | 'passed';
  const counts = run.summary?.cases;
  return (
    <Panel
      id="cases"
      title="Cases"
      description="One trace per dataset case; open a case to see exactly what happened"
      className={cases.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}
    >
      <div
        className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5"
        data-page-search
      >
        <Segmented
          label="Outcome"
          value={outcome}
          onChange={(v) => setFilters({ outcome: v === 'all' ? null : v })}
          options={[
            { value: 'all', label: `All${counts ? ` ${counts.total}` : ''}` },
            { value: 'failed', label: `Failed${counts ? ` ${counts.failed}` : ''}` },
            { value: 'errored', label: `Errored${counts ? ` ${counts.errored}` : ''}` },
            { value: 'passed', label: `Passed${counts ? ` ${counts.passed}` : ''}` },
          ]}
        />
        {evaluators.length > 0 && (
          <Select
            label="Failing evaluator"
            value={filters.evaluator}
            onChange={(v) => setFilters({ evaluator: v })}
            options={[
              { value: '', label: 'Any evaluator' },
              ...evaluators.map((e) => ({ value: e, label: `${e} failed` })),
            ]}
          />
        )}
        <SearchInput
          label="Search cases"
          placeholder="Search case ids, inputs, outputs"
          value={filters.q}
          onChange={(q) => setFilters({ q })}
          className="w-full sm:w-72"
        />
      </div>
      {cases.isPending ? (
        <Loading rows={6} />
      ) : cases.isError ? (
        <ErrorState error={cases.error} onRetry={() => void cases.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="No cases match these filters" />
      ) : (
        <>
          <Table>
            <THead>
              <TH>Case</TH>
              <TH>Outcome</TH>
              <TH>Evaluations</TH>
              <TH className="hidden lg:table-cell">Output</TH>
              <TH align="right">Duration</TH>
              <TH align="right">Tokens</TH>
              <TH align="right">Cost</TH>
            </THead>
            <tbody>
              {items.map((c) => (
                <TR key={c.traceId} to={`/traces/${c.traceId}`}>
                  <TD>
                    <Link
                      to={`/traces/${c.traceId}`}
                      className="font-medium text-fg hover:underline"
                    >
                      {c.caseId}
                    </Link>
                  </TD>
                  <TD>
                    <OutcomeBadge outcome={c.outcome} />
                  </TD>
                  <TD>
                    <EvaluationChips c={c} order={evaluators} />
                  </TD>
                  <TD className="hidden max-w-sm lg:table-cell">
                    <span className="line-clamp-2 text-xs text-fg-2">
                      {c.error ? (
                        <span className="text-bad-fg">{c.error.message}</span>
                      ) : (
                        readablePreview(c.outputPreview) || '—'
                      )}
                    </span>
                  </TD>
                  <TD align="right">{formatDuration(c.durationMs)}</TD>
                  <TD align="right">{formatTokens(c.totalTokens)}</TD>
                  <TD align="right" className={c.costUsd === null ? 'text-fg-3' : undefined}>
                    {formatCost(c.costUsd)}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
          <MoreRows
            hasMore={Boolean(cases.hasNextPage)}
            loading={cases.isFetchingNextPage}
            onMore={() => void cases.fetchNextPage()}
            shown={items.length}
            noun={items.length === 1 ? 'case' : 'cases'}
          />
        </>
      )}
    </Panel>
  );
}

/**
 * "What changed?" — the run next to the baseline its regression gates used, as computed when it
 * ran. Runs from before SCOPE 0.2 did not store this; they show the baseline file in Details.
 */
function BaselineComparisonPanel({ run }: { run: Run }) {
  const stored = Boolean(run.baseline?.runId) && run.status === 'completed';
  const comparison = useBaselineComparison(String(run.number), stored);
  const [all, setAll] = useState(false);
  if (!stored || !run.baseline) return null;
  const b = run.baseline;
  const source = (
    <>
      <code className="text-xs">{b.file}</code> · saved from run #{b.runNumber}
      {b.commit ? ` @ ${b.commit.slice(0, 7)}` : ''} · {relativeTime(b.createdAt)}
    </>
  );
  if (comparison.isPending)
    return (
      <Panel title="Compared with baseline" description={source}>
        <Loading rows={3} label="Loading the baseline comparison" />
      </Panel>
    );
  if (comparison.isError)
    return (
      <Panel title="Compared with baseline" description={source}>
        <ErrorState error={comparison.error} onRetry={() => void comparison.refetch()} />
      </Panel>
    );
  const d = comparison.data;
  return (
    <Panel
      id="baseline"
      title="Compared with baseline"
      description={source}
      actions={
        <>
          {d.metrics.length > d.headline.length && (
            <button
              type="button"
              onClick={() => setAll((a) => !a)}
              className="text-xs text-accent-fg hover:underline"
            >
              {all ? 'Headline metrics' : `All ${d.metrics.length} metrics`}
            </button>
          )}
          {d.baselineRun && (
            <Link
              to={`/compare?base=${d.baselineRun.number}&head=${run.number}`}
              className="text-xs text-accent-fg hover:underline"
            >
              Compare with run #{d.baselineRun.number}
            </Link>
          )}
        </>
      }
    >
      <CaseChangeCounts
        counts={d.counts}
        onlyHead="new since the baseline"
        onlyBase="missing from this run"
      />
      {describeConfig(d.config).length > 0 && (
        <p className="border-b border-line px-4 py-2.5 text-sm text-fg-2">
          <span className="font-medium text-fg">Changed since the baseline:</span>{' '}
          {describeConfig(d.config).join(' · ')}
        </p>
      )}
      <MetricDeltaTable
        metrics={d.metrics}
        headline={d.headline}
        showAll={all}
        baseLabel="Baseline"
        headLabel={`Run #${run.number}`}
      />
      {d.cases.length === 0 ? (
        <p className="border-t border-line px-4 py-4 text-sm text-fg-2">
          No case changed its outcome or scores.
        </p>
      ) : (
        <div className="border-t border-line">
          <CaseChangeTable cases={d.cases} baseTraces={d.baselineRun !== null} />
          {d.omittedCases > 0 && (
            <p className="px-4 py-3 text-xs text-fg-2">
              …and {d.omittedCases} more changed cases, which were counted but not stored.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

function CompareWith({ run }: { run: Run }) {
  const navigate = useNavigate();
  const others = allItems(useRuns({ workflow: run.workflow }, 50).data).filter(
    (r) => r.id !== run.id && r.summary,
  );
  const previous = others.find((r) => r.number < run.number);
  // By id: a baseline's run number belongs to the database it was saved from, maybe another.
  const baselineRun = run.baseline?.runId
    ? others.find((r) => r.id === run.baseline?.runId)
    : undefined;
  const [target, setTarget] = useState('');
  const chosen = target || String(baselineRun?.number ?? previous?.number ?? '');
  if (others.length === 0 || !run.summary) return null;
  const go = () => {
    const other = Number(chosen);
    const [base, head] = other < run.number ? [other, run.number] : [run.number, other];
    navigate(`/compare?base=${base}&head=${head}`);
  };
  return (
    <div className="flex items-center gap-2">
      <Select
        label="Run to compare with"
        value={chosen}
        onChange={setTarget}
        options={others.map((r) => ({
          value: String(r.number),
          label: `#${r.number}${r.variant ? ` · ${r.variant}` : ''}${r.number === baselineRun?.number ? ' (baseline)' : r.number === previous?.number ? ' (previous)' : ''}`,
        }))}
      />
      <button type="button" onClick={go} className={buttonClass('default', 'md')}>
        <IconCompare size={14} /> Compare
      </button>
    </div>
  );
}

function Summary({ run }: { run: Run }) {
  const s = run.summary;
  if (!s) return null;
  return (
    <StatRow>
      <StatTile
        label="Pass rate"
        value={s.passRate === null ? '—' : `${(s.passRate * 100).toFixed(1)}%`}
        sub={`${s.cases.passed} of ${s.cases.total} cases passed${s.cases.errored ? ` · ${s.cases.errored} errored` : ''}`}
        tone={run.gateStatus === 'failed' ? 'bad' : undefined}
      />
      <StatTile
        label="Latency p95"
        value={formatDuration(s.latency.p95Ms)}
        sub={`p50 ${formatDuration(s.latency.p50Ms)} · max ${formatDuration(s.latency.maxMs)}`}
      />
      <StatTile
        label={s.tokens.estimated ? 'Tokens (estimated)' : 'Tokens'}
        value={formatTokens(s.tokens.total)}
        sub={`${formatTokens(s.tokens.input)} in · ${formatTokens(s.tokens.output)} out`}
      />
      <StatTile
        label="Estimated cost"
        value={formatCost(s.cost.totalUsd)}
        sub={
          s.cost.unpricedModels.length
            ? `unknown price: ${s.cost.unpricedModels.join(', ')}`
            : s.cost.meanPerCaseUsd !== null
              ? `${formatCost(s.cost.meanPerCaseUsd)} per case`
              : undefined
        }
      />
      <StatTile
        label="Duration"
        value={formatDuration(run.durationMs)}
        sub={`${formatNumber(run.caseCount)} cases · started ${relativeTime(run.startedAt)}`}
      />
    </StatRow>
  );
}

export function RunDetail() {
  const { run: ref = '' } = useParams();
  const run = useRun(ref);
  const [, setFilters] = useUrlState(['outcome', 'evaluator', 'q'] as const);
  useTitle(run.data ? `Run #${run.data.number}` : 'Run');

  if (run.isPending) return <Loading rows={8} />;
  if (run.isError) return <ErrorState error={run.error} onRetry={() => void run.refetch()} />;
  const r = run.data;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <Link to="/runs" className="hover:text-fg hover:underline">
            Runs
          </Link>
        }
        title={
          <>
            Run #{r.number}
            <RunResult status={r.status} gateStatus={r.gateStatus} />
          </>
        }
        meta={
          <>
            <Link
              to={`/workflows/${encodeURIComponent(r.workflow)}`}
              className="text-fg hover:underline"
            >
              {r.workflow}
            </Link>
            {r.variant && (
              <span className="rounded-sm bg-sunken px-1.5 py-0.5 text-xs">
                variant {r.variant}
              </span>
            )}
            <span title={r.startedAt}>{formatDateTime(r.startedAt)}</span>
            <span>via {r.trigger === 'ci' ? 'CI' : r.trigger === 'cli' ? 'CLI' : 'API'}</span>
            {r.git?.commit && (
              <span className="font-mono text-xs">
                {r.git.branch ? `${r.git.branch} @ ` : ''}
                {r.git.commit.slice(0, 7)}
                {r.git.dirty ? ' (uncommitted changes)' : ''}
                {r.git.pullRequest ? ` · PR #${r.git.pullRequest}` : ''}
              </span>
            )}
          </>
        }
        actions={<CompareWith run={r} />}
      />
      {r.error && (
        <div
          role="alert"
          className="rounded-lg border border-line bg-bad-wash px-4 py-3 text-sm text-bad-fg"
        >
          <strong className="font-semibold">The run failed:</strong> {r.error.message}
        </div>
      )}
      {r.status === 'running' && (
        <p className="rounded-lg border border-line bg-selected px-4 py-3 text-sm text-fg">
          This run is still in progress; results so far are shown and update as cases finish.
        </p>
      )}
      <Summary run={r} />
      <Gates run={r} />
      <BaselineComparisonPanel run={r} />
      <Evaluators
        run={r}
        onFilter={(evaluator) => {
          setFilters({ evaluator, outcome: null });
          document.getElementById('cases')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
      />
      <Cases run={r} />
      <Panel title="Details">
        <div className="grid grid-cols-1 gap-6 p-4 lg:grid-cols-2">
          <Facts
            items={[
              ['Run id', <IdChip key="id" id={r.id} length={10} />],
              ['Workflow version', <IdChip key="v" id={r.workflowVersionId} length={10} />],
              ['Dataset', r.dataset ? `${r.dataset.name} · ${r.dataset.caseCount} cases` : '—'],
              ['Dataset file', r.dataset?.source ?? '—'],
              [
                'Dataset hash',
                r.dataset ? (
                  <code key="h" className="text-xs">
                    {r.dataset.hash.slice(0, 16)}
                  </code>
                ) : (
                  '—'
                ),
              ],
              [
                'Baseline',
                r.baseline ? (
                  <span key="b">
                    <code className="text-xs">{r.baseline.file}</code> · run #{r.baseline.runNumber}
                    {r.baseline.commit ? ` @ ${r.baseline.commit.slice(0, 7)}` : ''}
                  </span>
                ) : (
                  'none'
                ),
              ],
              ['Finished', formatDateTime(r.endedAt)],
            ]}
          />
          <CodeBlock label="Parameters" value={r.params} collapse={false} />
        </div>
      </Panel>
    </div>
  );
}
