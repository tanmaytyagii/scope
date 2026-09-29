/**
 * Several runs side by side — "which variant, model or prompt did best, and on which cases do
 * they disagree?" Two to four runs: the parameters that differ, every metric per run with the
 * best marked (values within noise of it share it), and the cases whose outcome differs.
 */
import type { JsonValue, RunMatrix } from '@scope-ai/protocol';
import { useState } from 'react';
import { Link } from 'react-router';
import { allItems, useRunMatrix, useRuns } from '../api/queries.ts';
import { useTitle } from '../app/hooks.ts';
import { formatMetric, pluralize } from '../lib/format.ts';
import { Select } from '../ui/Controls.tsx';
import { PageHeader } from '../ui/Figures.tsx';
import { Alert, Check, Close, IconCompare } from '../ui/icons.tsx';
import { Panel } from '../ui/Panel.tsx';
import { ErrorState, Loading } from '../ui/States.tsx';
import { OutcomeBadge } from '../ui/Status.tsx';
import { Table, TD, TH, THead, TR } from '../ui/Table.tsx';

const MAX_RUNS = 4;

type MatrixRun = RunMatrix['runs'][number];

function runName(r: MatrixRun): string {
  return `#${r.run.number}${r.run.variant ? ` · ${r.run.variant}` : ''}`;
}

function showValue(value: JsonValue | undefined): string {
  if (value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Parameter keys whose value is not the same in every run: what the experiment varied. */
function differingParams(runs: MatrixRun[]): string[] {
  const keys = [...new Set(runs.flatMap((r) => Object.keys(r.params)))].sort();
  return keys.filter((k) => new Set(runs.map((r) => JSON.stringify(r.params[k] ?? null))).size > 1);
}

function RunHeads({
  runs,
  onRemove,
}: {
  runs: MatrixRun[];
  onRemove: ((number: number) => void) | null;
}) {
  return (
    <>
      {runs.map((r) => (
        <TH key={r.run.id} align="right">
          <span className="inline-flex items-center gap-1">
            <Link to={`/runs/${r.run.number}`} className="hover:underline">
              {runName(r)}
            </Link>
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(r.run.number)}
                aria-label={`Remove run #${r.run.number} from the comparison`}
                className="inline-flex h-5 w-5 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg"
              >
                <Close size={10} />
              </button>
            )}
          </span>
        </TH>
      ))}
    </>
  );
}

function Parameters({ data }: { data: RunMatrix }) {
  const keys = differingParams(data.runs);
  return (
    <Panel
      title="What differs"
      description={
        keys.length
          ? `${keys.length} ${keys.length === 1 ? 'parameter varies' : 'parameters vary'} between these runs`
          : 'These runs used the same parameters'
      }
    >
      {keys.length > 0 && (
        <Table>
          <THead>
            <TH>Parameter</TH>
            <RunHeads runs={data.runs} onRemove={null} />
          </THead>
          <tbody>
            {keys.map((k) => (
              <TR key={k}>
                <TD className="font-mono text-xs text-fg">{k}</TD>
                {data.runs.map((r) => (
                  <TD key={r.run.id} align="right" className="font-mono text-xs">
                    {showValue(r.params[k])}
                  </TD>
                ))}
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function Metrics({ data, onRemove }: { data: RunMatrix; onRemove: (n: number) => void }) {
  const [all, setAll] = useState(false);
  const byId = new Map(data.metrics.map((m) => [m.id, m]));
  const shown = all
    ? data.metrics
    : data.headline.map((id) => byId.get(id)).filter((m) => m !== undefined);
  return (
    <Panel
      title="Metrics"
      description="The best value is marked; values within noise tolerance of it share the mark"
      actions={
        data.metrics.length > data.headline.length && (
          <button
            type="button"
            onClick={() => setAll((a) => !a)}
            className="text-xs text-accent-fg hover:underline"
          >
            {all ? 'Show headline metrics' : `Show all ${data.metrics.length} metrics`}
          </button>
        )
      }
    >
      <Table>
        <THead>
          <TH>Metric</TH>
          <RunHeads runs={data.runs} onRemove={data.runs.length > 2 ? onRemove : null} />
        </THead>
        <tbody>
          {shown.map((m) => (
            <TR key={m.id}>
              <TD>
                <div className="text-fg">{m.label}</div>
                <div className="font-mono text-2xs text-fg-3">{m.id}</div>
              </TD>
              {m.values.map((v, i) => {
                const best = m.best.includes(i);
                return (
                  <TD
                    key={data.runs[i]?.run.id ?? i}
                    align="right"
                    className={best ? 'font-semibold text-fg' : 'text-fg-2'}
                  >
                    <span className="inline-flex items-center gap-1">
                      {best && <Check size={12} className="text-good-fg" label="best" />}
                      {formatMetric(v, m.unit)}
                    </span>
                  </TD>
                );
              })}
            </TR>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

function Cases({ data }: { data: RunMatrix }) {
  const differing = data.cases.length + data.omittedCases;
  return (
    <Panel
      title="Cases where the runs disagree"
      description={`The outcome differs in ${differing} of ${pluralize(data.caseCount, 'case')}`}
    >
      {data.cases.length === 0 ? (
        <p className="px-4 py-6 text-sm text-fg-2">
          Every case has the same outcome in all these runs.
        </p>
      ) : (
        <>
          <Table>
            <THead>
              <TH>Case</TH>
              <RunHeads runs={data.runs} onRemove={null} />
            </THead>
            <tbody>
              {data.cases.map((row) => (
                <TR key={row.caseId}>
                  <TD className="font-medium text-fg">{row.caseId}</TD>
                  {row.outcomes.map((outcome, i) => {
                    const trace = row.traceIds[i];
                    const run = data.runs[i];
                    return (
                      <TD key={run?.run.id ?? i} align="right">
                        {outcome === null ? (
                          <span className="text-xs text-fg-3">not run</span>
                        ) : trace ? (
                          <Link
                            to={`/traces/${trace}`}
                            aria-label={`${row.caseId} in run #${run?.run.number}: ${outcome}`}
                            className="inline-flex rounded-sm hover:opacity-80"
                          >
                            <OutcomeBadge outcome={outcome} />
                          </Link>
                        ) : (
                          <OutcomeBadge outcome={outcome} />
                        )}
                      </TD>
                    );
                  })}
                </TR>
              ))}
            </tbody>
          </Table>
          {data.omittedCases > 0 && (
            <p className="px-4 py-3 text-xs text-fg-2">
              …and {data.omittedCases} more cases that differ.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

export function RunMatrixView({
  runs,
  onChange,
}: {
  runs: string[];
  onChange: (runs: string[]) => void;
}) {
  useTitle(`Compare ${runs.map((r) => `#${r}`).join(' · ')}`);
  const matrix = useRunMatrix(runs);
  const available = allItems(useRuns({}, 100).data).filter(
    (r) => r.summary && !runs.includes(String(r.number)),
  );
  const remove = (n: number) => onChange(runs.filter((r) => r !== String(n)));

  const header = (
    <PageHeader
      eyebrow={
        <Link to="/runs" className="hover:text-fg hover:underline">
          Runs
        </Link>
      }
      title={
        <>
          <IconCompare size={18} />
          {runs.length} runs side by side
        </>
      }
      meta={
        matrix.data &&
        [...new Set(matrix.data.runs.map((r) => r.run.workflow))].map((w) => (
          <Link key={w} to={`/workflows/${encodeURIComponent(w)}`} className="hover:underline">
            {w}
          </Link>
        ))
      }
      actions={
        runs.length < MAX_RUNS && (
          <Select
            label="Add a run"
            value=""
            onChange={(v) => v && onChange([...runs, v])}
            options={[
              { value: '', label: 'Add a run…' },
              ...available.map((r) => ({
                value: String(r.number),
                label: `#${r.number} · ${r.workflow}${r.variant ? ` · ${r.variant}` : ''}`,
              })),
            ]}
          />
        )
      }
    />
  );

  if (matrix.isPending)
    return (
      <>
        {header}
        <Loading rows={8} />
      </>
    );
  if (matrix.isError)
    return (
      <>
        {header}
        <ErrorState error={matrix.error} />
      </>
    );
  const data = matrix.data;
  const workflows = [...new Set(data.runs.map((r) => r.run.workflow))];
  return (
    <div className={`space-y-5 ${matrix.isPlaceholderData ? 'opacity-60 transition-opacity' : ''}`}>
      {header}
      {workflows.length > 1 && (
        <p
          role="note"
          className="flex items-center gap-2 rounded-lg border border-line bg-warn-wash px-4 py-3 text-sm text-warn-fg"
        >
          <Alert size={14} />
          These runs are from different workflows ({workflows.join(', ')}); case ids may not
          correspond.
        </p>
      )}
      <Parameters data={data} />
      <Metrics data={data} onRemove={remove} />
      <Cases data={data} />
    </div>
  );
}
