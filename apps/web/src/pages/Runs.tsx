/** Runs — every execution of a workflow over its dataset. Select two to compare them. */
import type { Run } from '@scope-ai/protocol';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { allItems, useRuns, useWorkflows } from '../api/queries.ts';
import { useTitle, useUrlState } from '../app/hooks.ts';
import { formatCost, formatDuration, formatTokens, relativeTime } from '../lib/format.ts';
import { Button } from '../ui/Button.tsx';
import { Select } from '../ui/Controls.tsx';
import { Meter, PageHeader } from '../ui/Figures.tsx';
import { IconCompare } from '../ui/icons.tsx';
import { Panel } from '../ui/Panel.tsx';
import { EmptyState, ErrorState, Loading } from '../ui/States.tsx';
import { RunResult } from '../ui/Status.tsx';
import { MoreRows, Table, TD, TH, THead, TR } from '../ui/Table.tsx';

export function runLabel(run: Pick<Run, 'number' | 'variant'>): string {
  return `#${run.number}${run.variant ? ` · ${run.variant}` : ''}`;
}

const MAX_COMPARED = 4;

export function Runs() {
  useTitle('Runs');
  const navigate = useNavigate();
  const [filters, setFilters] = useUrlState(['workflow', 'variant', 'gateStatus'] as const);
  const runs = useRuns(filters);
  const workflows = useWorkflows();
  const [selected, setSelected] = useState<string[]>([]);
  const items = allItems(runs.data);

  // Two runs compare as base → head; three or four go side by side.
  const toggle = (id: string) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-(MAX_COMPARED - 1)), id],
    );
  const ready = selected.length >= 2;
  const compare = () => {
    const chosen = selected
      .map((id) => items.find((r) => r.id === id))
      .filter((r): r is Run => Boolean(r))
      .sort((x, y) => x.number - y.number);
    const [a, b] = chosen;
    if (chosen.length > 2) navigate(`/compare?runs=${chosen.map((r) => r.number).join(',')}`);
    else if (a && b) navigate(`/compare?base=${a.number}&head=${b.number}`);
  };

  return (
    <>
      <PageHeader
        title="Runs"
        meta="Each run executes a workflow over its dataset, evaluates every case and applies gates."
        actions={
          <Button variant={ready ? 'primary' : 'default'} disabled={!ready} onClick={compare}>
            <IconCompare size={14} />
            {ready ? `Compare selected (${selected.length})` : 'Compare (select 2–4 runs)'}
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          label="Workflow"
          value={filters.workflow}
          onChange={(v) => setFilters({ workflow: v })}
          options={[
            { value: '', label: 'All workflows' },
            ...(workflows.data?.items.map((w) => ({ value: w.name, label: w.name })) ?? []),
          ]}
        />
        <Select
          label="Result"
          value={filters.gateStatus}
          onChange={(v) => setFilters({ gateStatus: v })}
          options={[
            { value: '', label: 'Any result' },
            { value: 'failed', label: 'Gates failed' },
            { value: 'warned', label: 'Warnings' },
            { value: 'passed', label: 'Gates passed' },
            { value: 'none', label: 'No gates' },
          ]}
        />
        {filters.variant && (
          <button
            type="button"
            onClick={() => setFilters({ variant: null })}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-line-strong bg-raised px-2.5 text-xs text-fg"
          >
            Variant: {filters.variant} <span aria-hidden>×</span>
            <span className="sr-only">Remove variant filter</span>
          </button>
        )}
      </div>
      <Panel className={runs.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
        {runs.isPending ? (
          <Loading rows={8} />
        ) : runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
        ) : items.length === 0 ? (
          filters.workflow || filters.variant || filters.gateStatus ? (
            <EmptyState title="No runs match these filters" />
          ) : (
            <EmptyState title="No runs yet" command="scope run workflows/support.yaml">
              Runs appear here as soon as <code className="text-xs">scope run</code> finishes a
              case.
            </EmptyState>
          )
        ) : (
          <>
            <Table>
              <THead>
                <TH className="w-8">
                  <span className="sr-only">Select to compare</span>
                </TH>
                <TH>Run</TH>
                <TH>Workflow</TH>
                <TH>Result</TH>
                <TH align="right">Pass rate</TH>
                <TH align="right">Cases</TH>
                <TH align="right">p95</TH>
                <TH align="right">Tokens</TH>
                <TH align="right">Cost</TH>
                <TH>Commit</TH>
                <TH align="right">Started</TH>
              </THead>
              <tbody>
                {items.map((run) => (
                  <TR key={run.id} to={`/runs/${run.number}`} selected={selected.includes(run.id)}>
                    <TD>
                      <input
                        type="checkbox"
                        aria-label={`Select run #${run.number} to compare`}
                        checked={selected.includes(run.id)}
                        onChange={() => toggle(run.id)}
                        className="h-3.5 w-3.5 cursor-pointer accent-(--accent)"
                      />
                    </TD>
                    <TD>
                      <Link
                        to={`/runs/${run.number}`}
                        className="tabular font-medium text-fg hover:underline"
                      >
                        #{run.number}
                      </Link>
                    </TD>
                    <TD>
                      <span className="text-fg">{run.workflow}</span>
                      {run.variant && (
                        <span className="ml-1.5 rounded-sm bg-sunken px-1.5 py-0.5 text-2xs text-fg-2">
                          {run.variant}
                        </span>
                      )}
                    </TD>
                    <TD>
                      <RunResult status={run.status} gateStatus={run.gateStatus} />
                    </TD>
                    <TD align="right">
                      <Meter value={run.passRate} label={`Run #${run.number} pass rate`} />
                    </TD>
                    <TD align="right">{run.caseCount}</TD>
                    <TD align="right">{formatDuration(run.summary?.latency.p95Ms)}</TD>
                    <TD align="right">
                      {run.summary
                        ? `${run.summary.tokens.estimated ? '~' : ''}${formatTokens(run.summary.tokens.total)}`
                        : '—'}
                    </TD>
                    <TD
                      align="right"
                      className={run.summary?.cost.totalUsd === null ? 'text-fg-3' : undefined}
                    >
                      {run.summary
                        ? `${formatCost(run.summary.cost.totalUsd)}${run.summary.cost.incomplete && run.summary.cost.totalUsd !== null ? '+' : ''}`
                        : '—'}
                    </TD>
                    <TD>
                      {run.git?.commit ? (
                        <span
                          className="font-mono text-xs text-fg-2"
                          title={`${run.git.branch ?? ''} ${run.git.commit}`}
                        >
                          {run.git.commit.slice(0, 7)}
                          {run.git.dirty ? '*' : ''}
                        </span>
                      ) : (
                        <span className="text-fg-3">—</span>
                      )}
                    </TD>
                    <TD align="right" className="text-fg-3" title={run.startedAt}>
                      {relativeTime(run.startedAt)}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
            <MoreRows
              hasMore={Boolean(runs.hasNextPage)}
              loading={runs.isFetchingNextPage}
              onMore={() => void runs.fetchNextPage()}
              shown={items.length}
              noun={items.length === 1 ? 'run' : 'runs'}
            />
          </>
        )}
      </Panel>
    </>
  );
}
