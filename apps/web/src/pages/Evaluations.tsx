/**
 * Evaluations — "which evaluators are failing, how are they trending, and on what?" Every
 * evaluator shows how it judges; heuristic and model results are signals and opinions.
 */
import type { EvaluatorKind, TimeWindowName } from '@scope-ai/protocol';
import { Link } from 'react-router';
import { allItems, useEvaluations, useEvaluators } from '../api/queries.ts';
import { useTitle, useUrlState } from '../app/hooks.ts';
import { Sparkline } from '../charts/Sparkline.tsx';
import { formatNumber, formatScore, relativeTime } from '../lib/format.ts';
import { Segmented, Select } from '../ui/Controls.tsx';
import { Meter, PageHeader } from '../ui/Figures.tsx';
import { KIND_EXPLANATIONS, KindBadge } from '../ui/Kind.tsx';
import { Panel } from '../ui/Panel.tsx';
import { EmptyState, ErrorState, Loading } from '../ui/States.tsx';
import { OutcomeBadge } from '../ui/Status.tsx';
import { MoreRows, Table, TD, TH, THead, TR } from '../ui/Table.tsx';

const KINDS: EvaluatorKind[] = ['deterministic', 'heuristic', 'model'];
const WINDOWS: TimeWindowName[] = ['24h', '7d', '30d', '90d'];

function Health({ window }: { window: TimeWindowName }) {
  const health = useEvaluators(window);
  const [, setFilters] = useUrlState(['evaluator', 'status'] as const);
  if (health.isPending) return <Loading rows={5} />;
  if (health.isError)
    return <ErrorState error={health.error} onRetry={() => void health.refetch()} />;
  const items = health.data.items;
  if (items.length === 0)
    return (
      <EmptyState title="No evaluation results in this window">
        Evaluators are configured per workflow under <code className="text-xs">evaluators:</code>{' '}
        and run on every case during <code className="text-xs">scope run</code>.
      </EmptyState>
    );
  return (
    <Table className={health.isPlaceholderData ? 'opacity-60' : undefined}>
      <THead>
        <TH>Evaluator</TH>
        <TH>Kind</TH>
        <TH align="right">Pass rate</TH>
        <TH align="right">Mean score</TH>
        <TH align="right">Results</TH>
        <TH>Recent runs</TH>
        <TH align="right">Last result</TH>
      </THead>
      <tbody>
        {items.map((e) => {
          const bad = e.failed + e.errored;
          return (
            <TR key={e.evaluator}>
              <TD>
                <div className="font-medium text-fg">{e.evaluator}</div>
                <div className="font-mono text-2xs text-fg-3">{e.type}</div>
              </TD>
              <TD>
                <KindBadge kind={e.kind} />
              </TD>
              <TD align="right">
                <Meter value={e.passRate} label={`${e.evaluator} pass rate`} />
              </TD>
              <TD align="right">{formatScore(e.meanScore)}</TD>
              <TD align="right">
                {bad > 0 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setFilters({ evaluator: e.evaluator, status: e.failed ? 'failed' : 'error' })
                    }
                    className="tabular rounded-sm text-bad-fg hover:underline"
                  >
                    {formatNumber(bad)} failed
                  </button>
                ) : (
                  <span className="text-fg-3">0 failed</span>
                )}
                <span className="text-fg-3"> / {formatNumber(e.total)}</span>
              </TD>
              <TD>
                {e.trend.length > 1 ? (
                  <span className="flex items-center gap-2">
                    <Sparkline
                      domain={[0, 1]}
                      values={e.trend.map((t) => t.passRate)}
                      label={`${e.evaluator} pass rate over the last ${e.trend.length} runs: from ${formatScore(e.trend[0]?.passRate)} to ${formatScore(e.trend.at(-1)?.passRate)}`}
                    />
                    <span className="text-2xs text-fg-3">
                      #{e.trend[0]?.runNumber}–#{e.trend.at(-1)?.runNumber}
                    </span>
                  </span>
                ) : (
                  <span className="text-xs text-fg-3">—</span>
                )}
              </TD>
              <TD align="right" className="text-fg-3">
                {relativeTime(e.lastSeenAt)}
              </TD>
            </TR>
          );
        })}
      </tbody>
    </Table>
  );
}

function Results({ evaluators }: { evaluators: string[] }) {
  const [filters, setFilters] = useUrlState(['evaluator', 'status', 'kind', 'run'] as const);
  // Failures are what this list is for; "any" shows every result.
  const status = filters.status || 'failed';
  const results = useEvaluations({ ...filters, status: status === 'any' ? undefined : status });
  const items = allItems(results.data);
  return (
    <Panel
      title="Results"
      description={
        status === 'any'
          ? 'Every evaluation result, newest first'
          : `Results with status “${status}”, newest first`
      }
      className={results.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <Select
          label="Evaluator"
          value={filters.evaluator}
          onChange={(evaluator) => setFilters({ evaluator })}
          options={[
            { value: '', label: 'All evaluators' },
            ...evaluators.map((e) => ({ value: e, label: e })),
          ]}
        />
        <Select
          label="Result"
          value={status}
          onChange={(value) => setFilters({ status: value === 'failed' ? null : value })}
          options={[
            { value: 'failed', label: 'Failed' },
            { value: 'error', label: 'Errored' },
            { value: 'passed', label: 'Passed' },
            { value: 'skipped', label: 'Skipped' },
            { value: 'any', label: 'Any result' },
          ]}
        />
        <Select
          label="Kind"
          value={filters.kind}
          onChange={(kind) => setFilters({ kind })}
          options={[
            { value: '', label: 'Any kind' },
            ...KINDS.map((k) => ({ value: k, label: k })),
          ]}
        />
        {filters.run && (
          <button
            type="button"
            onClick={() => setFilters({ run: null })}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-line-strong bg-raised px-2.5 text-xs text-fg"
          >
            Run #{filters.run} <span aria-hidden>×</span>
            <span className="sr-only">Remove run filter</span>
          </button>
        )}
      </div>
      {results.isPending ? (
        <Loading rows={6} />
      ) : results.isError ? (
        <ErrorState error={results.error} onRetry={() => void results.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={status === 'failed' ? 'No failed results' : 'No results match these filters'}
        >
          {status === 'failed' && 'Every evaluator passed on the results that match these filters.'}
        </EmptyState>
      ) : (
        <>
          <Table>
            <THead>
              <TH>Result</TH>
              <TH>Evaluator</TH>
              <TH>Case</TH>
              <TH>Run</TH>
              <TH align="right">Score / threshold</TH>
              <TH>Reason</TH>
              <TH align="right">When</TH>
            </THead>
            <tbody>
              {items.map((e) => (
                <TR key={e.id} to={`/traces/${e.traceId}`}>
                  <TD>
                    <OutcomeBadge outcome={e.status} />
                  </TD>
                  <TD>
                    <span className="flex items-center gap-2">
                      <span className="text-fg">{e.evaluator}</span>
                      <KindBadge kind={e.kind} />
                    </span>
                  </TD>
                  <TD>
                    <Link to={`/traces/${e.traceId}`} className="text-fg hover:underline">
                      {e.caseId ?? e.traceName}
                    </Link>
                  </TD>
                  <TD>
                    {e.run ? (
                      <Link
                        to={`/runs/${e.run.number}`}
                        className="tabular text-fg-2 hover:underline"
                      >
                        #{e.run.number}
                      </Link>
                    ) : (
                      <span className="text-fg-3">—</span>
                    )}
                  </TD>
                  <TD align="right">
                    {formatScore(e.score)}
                    {e.threshold !== null && (
                      <span className="text-fg-3"> / {formatScore(e.threshold)}</span>
                    )}
                  </TD>
                  <TD className="max-w-md">
                    <span className="line-clamp-2 text-xs text-fg-2">{e.reason}</span>
                  </TD>
                  <TD align="right" className="text-fg-3">
                    {relativeTime(e.createdAt)}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
          <MoreRows
            hasMore={Boolean(results.hasNextPage)}
            loading={results.isFetchingNextPage}
            onMore={() => void results.fetchNextPage()}
            shown={items.length}
            noun={items.length === 1 ? 'result' : 'results'}
          />
        </>
      )}
    </Panel>
  );
}

export function Evaluations() {
  useTitle('Evaluations');
  const [state, setState] = useUrlState(['window'] as const);
  const window = (
    WINDOWS.includes(state.window as TimeWindowName) ? state.window : '7d'
  ) as TimeWindowName;
  const health = useEvaluators(window);
  const evaluators = health.data?.items.map((e) => e.evaluator) ?? [];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Evaluations"
        meta="How each evaluator is judging your outputs, and the results behind the numbers."
        actions={
          <Segmented
            label="Time window"
            value={window}
            onChange={(w) => setState({ window: w === '7d' ? null : w })}
            options={WINDOWS.map((w) => ({ value: w, label: w }))}
          />
        }
      />
      <Panel
        title="Evaluators"
        description="Pass rate and mean score in the window; the trend covers recent runs"
      >
        <dl className="grid gap-x-6 gap-y-2 border-b border-line px-4 py-3 text-xs md:grid-cols-3">
          {KINDS.map((k) => (
            <div key={k} className="flex items-start gap-2">
              <dt>
                <KindBadge kind={k} />
              </dt>
              <dd className="text-fg-2">{KIND_EXPLANATIONS[k].text}</dd>
            </div>
          ))}
        </dl>
        <Health window={window} />
      </Panel>
      <Results evaluators={evaluators} />
    </div>
  );
}
