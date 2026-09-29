/**
 * Overview — "How is my AI system doing?" Headline numbers for the window, the two trends that
 * matter day to day (volume with errors, latency), quality run over run, and what is failing now.
 */
import type { Overview as OverviewData, TimeWindowName } from '@scope-ai/protocol';
import { Link } from 'react-router';
import { useOverview } from '../api/queries.ts';
import { useTitle, useUrlState } from '../app/hooks.ts';
import { Columns } from '../charts/Columns.tsx';
import { ChartFrame, DataTable, Legend, TooltipRow } from '../charts/Frame.tsx';
import { Lines } from '../charts/Lines.tsx';
import { Sparkline } from '../charts/Sparkline.tsx';
import { RunTrend } from '../components/RunTrend.tsx';
import { TraceTable } from '../components/TraceTable.tsx';
import {
  formatDateTime,
  formatDay,
  formatDuration,
  formatHour,
  formatNumber,
  formatPercent,
  formatTokens,
  formatUsd,
  pluralize,
} from '../lib/format.ts';
import { Segmented } from '../ui/Controls.tsx';
import { Meter, PageHeader, StatRow, StatTile } from '../ui/Figures.tsx';
import { Alert, ArrowRight, Bolt, Cross } from '../ui/icons.tsx';
import { KindBadge } from '../ui/Kind.tsx';
import { Panel } from '../ui/Panel.tsx';
import { EmptyState, ErrorState, Loading } from '../ui/States.tsx';
import { Table, TD, TH, THead, TR } from '../ui/Table.tsx';

const WINDOWS: ReadonlyArray<{ value: TimeWindowName; label: string }> = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

/** Axis labels: hours for a day, days otherwise (tooltips carry the exact interval). */
function bucketLabel(window: TimeWindowName) {
  return (iso: string) => (window === '24h' ? formatHour(iso) : formatDay(iso));
}

const axisDuration = (ms: number) => (ms === 0 ? '0' : formatDuration(ms));

function KpiRow({ data }: { data: OverviewData }) {
  const { traces, evaluations, runs, series } = data;
  const judged = evaluations.passed + evaluations.failed + evaluations.errored;
  return (
    <StatRow>
      <StatTile
        label="Traces"
        value={formatNumber(traces.total)}
        sub={
          traces.errors > 0 ? (
            <span className="inline-flex items-center gap-1 text-bad-fg">
              <Bolt size={12} /> {pluralize(traces.errors, 'error')} (
              {formatPercent(traces.errorRate)})
            </span>
          ) : (
            'no errors'
          )
        }
        trend={
          <Sparkline
            label={`Traces per interval over the window; ${formatNumber(traces.total)} in total`}
            values={series.map((s) => s.ok + s.error)}
          />
        }
      />
      <StatTile
        label="Evaluation pass rate"
        value={formatPercent(evaluations.passRate)}
        sub={
          judged === 0
            ? 'no evaluations'
            : `${formatNumber(evaluations.passed)} of ${formatNumber(judged)} passed${evaluations.errored ? ` · ${evaluations.errored} errored` : ''}`
        }
        tone={evaluations.passRate !== null && evaluations.passRate < 0.8 ? 'warn' : undefined}
      />
      <StatTile
        label="Latency p95"
        value={formatDuration(traces.p95Ms)}
        sub={`p50 ${formatDuration(traces.p50Ms)}${traces.sampled ? ' · sampled' : ''}`}
        trend={<Sparkline label="p95 latency per interval" values={series.map((s) => s.p95Ms)} />}
      />
      <StatTile
        label="Estimated cost"
        value={formatUsd(traces.costUsd)}
        sub={
          traces.unpricedTraces > 0
            ? `${pluralize(traces.unpricedTraces, 'trace')} with unknown prices not included`
            : `${formatTokens(traces.totalTokens)} tokens`
        }
        trend={
          <Sparkline label="Estimated cost per interval" values={series.map((s) => s.costUsd)} />
        }
      />
      <StatTile
        label="Runs"
        value={formatNumber(runs.total)}
        sub={
          runs.total === 0 ? (
            'no runs in this window'
          ) : (
            <span className="flex flex-wrap gap-x-2">
              {runs.failed > 0 && (
                <Link
                  to="/runs?gateStatus=failed"
                  className="inline-flex items-center gap-1 text-bad-fg hover:underline"
                >
                  <Cross size={12} /> {runs.failed} {runs.failed === 1 ? 'run' : 'runs'} failed
                  gates
                </Link>
              )}
              {runs.warned > 0 && (
                <span className="inline-flex items-center gap-1 text-warn-fg">
                  <Alert size={12} /> {runs.warned} with warnings
                </span>
              )}
              {runs.passed > 0 && <span>{runs.passed} passed</span>}
              {runs.none > 0 && <span>{runs.none} without gates</span>}
            </span>
          )
        }
      />
    </StatRow>
  );
}

function VolumeChart({
  data,
  window,
  pending,
}: {
  data: OverviewData;
  window: TimeWindowName;
  pending: boolean;
}) {
  const label = bucketLabel(window);
  const hasErrors = data.series.some((s) => s.error > 0);
  return (
    <ChartFrame
      title="Traces and errors"
      description="Traces started per interval"
      pending={pending}
      legend={
        <Legend
          items={[
            { label: 'ok', color: 'var(--neutral-mark)' },
            ...(hasErrors
              ? [
                  {
                    label: 'error',
                    color: 'var(--bad)',
                    icon: <Bolt size={12} className="text-bad-fg" />,
                  },
                ]
              : []),
          ]}
        />
      }
      chart={
        <Columns
          ariaLabel="Traces per interval, split into ok and error. Use the Table button for values."
          yFormat={(v) => formatNumber(v)}
          data={data.series.map((s) => ({
            key: s.start,
            label: label(s.start),
            segments: [
              { value: s.ok, color: 'var(--neutral-mark)' },
              { value: s.error, color: 'var(--bad)' },
            ],
            tooltip: (
              <>
                <div className="mb-1 text-fg-3">{formatDateTime(s.start)}</div>
                <TooltipRow color="var(--neutral-mark)" label="ok" value={formatNumber(s.ok)} />
                <TooltipRow color="var(--bad)" label="error" value={formatNumber(s.error)} />
              </>
            ),
          }))}
        />
      }
      table={
        <DataTable
          columns={[
            { label: 'Interval' },
            { label: 'OK', align: 'right' },
            { label: 'Error', align: 'right' },
          ]}
          rows={data.series.map((s) => [
            formatDateTime(s.start),
            formatNumber(s.ok),
            formatNumber(s.error),
          ])}
        />
      }
    />
  );
}

function LatencyChart({
  data,
  window,
  pending,
}: {
  data: OverviewData;
  window: TimeWindowName;
  pending: boolean;
}) {
  const label = bucketLabel(window);
  return (
    <ChartFrame
      title="Latency"
      description="Trace duration percentiles per interval"
      pending={pending}
      legend={
        <Legend
          items={[
            { label: 'p95', color: 'var(--series-1)', shape: 'line' },
            { label: 'p50', color: 'var(--series-2)', shape: 'line' },
          ]}
        />
      }
      chart={
        <Lines
          ariaLabel="p50 and p95 trace latency per interval. Use the Table button for values."
          x={data.series.map((s) => s.start)}
          xFormat={label}
          tooltipTitle={(x) => formatDateTime(x)}
          yFormat={axisDuration}
          series={[
            {
              id: 'p95',
              label: 'p95',
              color: 'var(--series-1)',
              values: data.series.map((s) => s.p95Ms),
            },
            {
              id: 'p50',
              label: 'p50',
              color: 'var(--series-2)',
              values: data.series.map((s) => s.p50Ms),
            },
          ]}
        />
      }
      table={
        <DataTable
          columns={[
            { label: 'Interval' },
            { label: 'p50', align: 'right' },
            { label: 'p95', align: 'right' },
          ]}
          rows={data.series.map((s) => [
            formatDateTime(s.start),
            formatDuration(s.p50Ms),
            formatDuration(s.p95Ms),
          ])}
        />
      }
    />
  );
}

function FailingEvaluators({ data }: { data: OverviewData }) {
  return (
    <Panel
      title="Failing evaluators"
      description="Evaluators with failed or errored results in this window"
      actions={
        <Link
          to="/evaluations"
          className="inline-flex items-center gap-1 text-xs text-accent-fg hover:underline"
        >
          All evaluators <ArrowRight size={12} />
        </Link>
      }
    >
      {data.failingEvaluators.length === 0 ? (
        <p className="px-4 py-6 text-sm text-fg-2">No evaluator failed in this window.</p>
      ) : (
        <Table>
          <THead>
            <TH>Evaluator</TH>
            <TH align="right">Failed</TH>
            <TH align="right">Pass rate</TH>
          </THead>
          <tbody>
            {data.failingEvaluators.map((e) => (
              <TR
                key={e.evaluator}
                to={`/evaluations?evaluator=${encodeURIComponent(e.evaluator)}&status=failed`}
              >
                <TD>
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/evaluations?evaluator=${encodeURIComponent(e.evaluator)}&status=failed`}
                      className="font-medium text-fg hover:underline"
                    >
                      {e.evaluator}
                    </Link>
                    <KindBadge kind={e.kind} />
                  </div>
                </TD>
                <TD align="right">
                  {formatNumber(e.failed)}{' '}
                  <span className="text-fg-3">/ {formatNumber(e.total)}</span>
                </TD>
                <TD align="right">
                  <Meter value={e.passRate} label={`${e.evaluator} pass rate`} />
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

export function Overview() {
  useTitle('Overview');
  const [state, setState] = useUrlState(['window'] as const);
  const window = (
    WINDOWS.some((w) => w.value === state.window) ? state.window : '7d'
  ) as TimeWindowName;
  const overview = useOverview(window);

  const header = (
    <PageHeader
      title="Overview"
      meta={
        <span>
          How the project is doing over the last {WINDOWS.find((w) => w.value === window)?.label}
        </span>
      }
      actions={
        <Segmented
          label="Time window"
          value={window}
          onChange={(w) => setState({ window: w === '7d' ? null : w })}
          options={WINDOWS.map((w) => ({ value: w.value, label: w.value }))}
        />
      }
    />
  );

  if (overview.isPending)
    return (
      <>
        {header}
        <Loading rows={6} />
      </>
    );
  if (overview.isError)
    return (
      <>
        {header}
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      </>
    );

  const data = overview.data;
  const pending = overview.isPlaceholderData || overview.isFetching;
  const empty = data.traces.total === 0 && data.runTrend.length === 0;

  if (empty) {
    return (
      <>
        {header}
        <Panel>
          <EmptyState
            title="No traces in this window yet"
            command="scope run workflows/support.yaml"
          >
            <p>
              Run a workflow to record traces and evaluations — the starter project from{' '}
              <code className="text-xs">scope init</code> runs offline. Applications instrumented
              with <code className="text-xs">@scope-ai/sdk</code> send traces here when{' '}
              <code className="text-xs">SCOPE_URL</code> points at this server.
            </p>
          </EmptyState>
        </Panel>
      </>
    );
  }

  return (
    <div className="space-y-5">
      {header}
      <KpiRow data={data} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <VolumeChart data={data} window={window} pending={pending} />
        <LatencyChart data={data} window={window} pending={pending} />
      </div>
      {data.runTrend.length > 0 && (
        <RunTrend
          pending={pending}
          runs={data.runTrend.map((r) => ({ ...r }))}
          description={`Last ${data.runTrend.length} completed runs across all workflows, oldest first`}
        />
      )}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel
          title="Recent failures"
          description="Traces that errored or failed an evaluation"
          actions={
            <Link
              to="/traces?eval=failed"
              className="inline-flex items-center gap-1 text-xs text-accent-fg hover:underline"
            >
              All failing traces <ArrowRight size={12} />
            </Link>
          }
        >
          {data.recentFailures.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-2">Nothing failed in this window.</p>
          ) : (
            <TraceTable traces={data.recentFailures} showPreview={false} />
          )}
        </Panel>
        <FailingEvaluators data={data} />
      </div>
    </div>
  );
}
