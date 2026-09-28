/**
 * Compare two runs — "did variant B beat variant A, and exactly which cases changed?" Metric
 * deltas are direction-aware (higher pass rate is better, higher latency is worse); small
 * differences within noise tolerance are reported as unchanged.
 */
import type { CaseChange, Comparison, MetricDelta } from '@scope-ai/protocol';
import { useState } from 'react';
import { Link } from 'react-router';
import { allItems, useComparison, useRuns } from '../api/queries.ts';
import { useTitle, useUrlState } from '../app/hooks.ts';
import { formatDelta, formatDuration, formatMetric, formatScore } from '../lib/format.ts';
import { Button } from '../ui/Button.tsx';
import { Select } from '../ui/Controls.tsx';
import { PageHeader } from '../ui/Figures.tsx';
import { Alert, ArrowDown, ArrowRight, ArrowUp, IconCompare } from '../ui/icons.tsx';
import { Panel } from '../ui/Panel.tsx';
import { EmptyState, ErrorState, Loading } from '../ui/States.tsx';
import { OutcomeBadge, Pill, type Tone } from '../ui/Status.tsx';
import { Table, TD, TH, THead, TR } from '../ui/Table.tsx';

function Verdict({ change }: { change: MetricDelta['change'] }) {
  if (change === 'improved')
    return (
      <Pill tone="good" icon={<ArrowUp size={12} />}>
        better
      </Pill>
    );
  if (change === 'regressed')
    return (
      <Pill tone="bad" icon={<ArrowDown size={12} />}>
        worse
      </Pill>
    );
  if (change === 'unchanged') return <span className="text-xs text-fg-3">no change</span>;
  return <span className="text-xs text-fg-3">—</span>;
}

const KIND_TONE: Record<CaseChange['kind'], Tone> = {
  regressed: 'bad',
  fixed: 'good',
  changed: 'info',
  added: 'neutral',
  removed: 'neutral',
  unchanged: 'neutral',
};

function describeEvaluators(change: CaseChange): string[] {
  return change.evaluators
    .filter((e) => e.change === 'improved' || e.change === 'regressed' || !e.base || !e.head)
    .map((e) => {
      const from = e.base
        ? `${e.base.status}${e.base.score !== null ? ` ${formatScore(e.base.score)}` : ''}`
        : 'absent';
      const to = e.head
        ? `${e.head.status}${e.head.score !== null ? ` ${formatScore(e.head.score)}` : ''}`
        : 'absent';
      return `${e.evaluator}: ${from} → ${to}`;
    });
}

function RunPicker({
  label,
  value,
  onChange,
  runs,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  runs: Array<{ number: number; workflow: string; variant: string | null }>;
}) {
  return (
    <Select
      label={label}
      value={value}
      onChange={onChange}
      options={[
        { value: '', label: `Choose ${label.toLowerCase()}…` },
        ...runs.map((r) => ({
          value: String(r.number),
          label: `#${r.number} · ${r.workflow}${r.variant ? ` · ${r.variant}` : ''}`,
        })),
      ]}
    />
  );
}

function Metrics({ data }: { data: Comparison }) {
  const [all, setAll] = useState(false);
  const byId = new Map(data.metrics.map((m) => [m.id, m]));
  const headline = data.headline
    .map((id) => byId.get(id))
    .filter((m): m is MetricDelta => Boolean(m));
  const shown = all ? data.metrics : headline;
  return (
    <Panel
      title="Metrics"
      description="Change from the base run to the head run; tolerances absorb timer and rounding noise"
      actions={
        data.metrics.length > headline.length && (
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
          <TH align="right">Base #{data.base.run.number}</TH>
          <TH align="right">Head #{data.head.run.number}</TH>
          <TH align="right">Change</TH>
          <TH>Verdict</TH>
        </THead>
        <tbody>
          {shown.map((m) => (
            <TR key={m.id}>
              <TD>
                <div className="text-fg">{m.label}</div>
                <div className="font-mono text-2xs text-fg-3">{m.id}</div>
              </TD>
              <TD align="right">{formatMetric(m.base, m.unit)}</TD>
              <TD align="right">{formatMetric(m.head, m.unit)}</TD>
              <TD align="right" className="text-fg-2">
                {formatDelta(m.base, m.head, m.unit)}
              </TD>
              <TD>
                <Verdict change={m.change} />
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

function Cases({
  data,
  includeUnchanged,
  onToggle,
}: {
  data: Comparison;
  includeUnchanged: boolean;
  onToggle: () => void;
}) {
  const c = data.counts;
  return (
    <Panel
      title="Cases"
      description="Per-case outcome changes, worst first"
      actions={
        <label className="flex items-center gap-2 text-xs text-fg-2">
          <input
            type="checkbox"
            checked={includeUnchanged}
            onChange={onToggle}
            className="accent-(--accent)"
          />
          Include {c.unchanged} unchanged
        </label>
      }
    >
      <div className="flex flex-wrap gap-2 border-b border-line px-4 py-2.5">
        <Pill tone={c.regressed ? 'bad' : 'neutral'}>{c.regressed} regressed</Pill>
        <Pill tone={c.fixed ? 'good' : 'neutral'}>{c.fixed} fixed</Pill>
        <Pill tone={c.changed ? 'info' : 'neutral'}>{c.changed} score changes</Pill>
        {c.added > 0 && <Pill>{c.added} only in head</Pill>}
        {c.removed > 0 && <Pill>{c.removed} only in base</Pill>}
        <Pill>{c.unchanged} unchanged</Pill>
      </div>
      {data.cases.length === 0 ? (
        <p className="px-4 py-6 text-sm text-fg-2">No case changed its outcome or scores.</p>
      ) : (
        <Table>
          <THead>
            <TH>Case</TH>
            <TH>Change</TH>
            <TH>Outcome</TH>
            <TH>Evaluators</TH>
            <TH align="right">Duration</TH>
            <TH>Traces</TH>
          </THead>
          <tbody>
            {data.cases.map((change) => (
              <TR
                key={change.caseId}
                to={change.head?.traceId ? `/traces/${change.head.traceId}` : undefined}
              >
                <TD className="font-medium text-fg">{change.caseId}</TD>
                <TD>
                  <Pill tone={KIND_TONE[change.kind]}>{change.kind}</Pill>
                </TD>
                <TD>
                  <span className="inline-flex items-center gap-1.5">
                    {change.base ? (
                      <OutcomeBadge outcome={change.base.outcome} />
                    ) : (
                      <span className="text-fg-3">—</span>
                    )}
                    <ArrowRight size={12} className="text-fg-3" />
                    {change.head ? (
                      <OutcomeBadge outcome={change.head.outcome} />
                    ) : (
                      <span className="text-fg-3">—</span>
                    )}
                  </span>
                </TD>
                <TD className="max-w-md">
                  <ul className="space-y-0.5 font-mono text-2xs text-fg-2">
                    {describeEvaluators(change).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </TD>
                <TD align="right" className="text-fg-2">
                  {formatDuration(change.base?.durationMs)} →{' '}
                  {formatDuration(change.head?.durationMs)}
                </TD>
                <TD>
                  <span className="flex gap-3 text-xs">
                    {change.base?.traceId && (
                      <Link
                        to={`/traces/${change.base.traceId}`}
                        className="text-accent-fg hover:underline"
                      >
                        base
                      </Link>
                    )}
                    {change.head?.traceId && (
                      <Link
                        to={`/traces/${change.head.traceId}`}
                        className="text-accent-fg hover:underline"
                      >
                        head
                      </Link>
                    )}
                  </span>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

export function Compare() {
  const [state, setState] = useUrlState(['base', 'head', 'unchanged'] as const);
  useTitle(state.base && state.head ? `Compare #${state.base} → #${state.head}` : 'Compare runs');
  const runs = allItems(useRuns({}, 100).data).filter((r) => r.summary);
  const includeUnchanged = state.unchanged === '1';
  const comparison = useComparison(state.base, state.head, includeUnchanged);

  const pickers = (
    <div className="flex flex-wrap items-center gap-2">
      <RunPicker
        label="Base run"
        value={state.base}
        onChange={(base) => setState({ base })}
        runs={runs}
      />
      <ArrowRight size={14} className="text-fg-3" />
      <RunPicker
        label="Head run"
        value={state.head}
        onChange={(head) => setState({ head })}
        runs={runs}
      />
      <Button
        size="md"
        variant="ghost"
        disabled={!state.base || !state.head}
        onClick={() => setState({ base: state.head, head: state.base })}
      >
        Swap
      </Button>
    </div>
  );

  const header = (
    <PageHeader
      eyebrow={
        <Link to="/runs" className="hover:text-fg hover:underline">
          Runs
        </Link>
      }
      title={
        comparison.data ? (
          <>
            <IconCompare size={18} />
            Run #{comparison.data.base.run.number} → run #{comparison.data.head.run.number}
          </>
        ) : (
          'Compare runs'
        )
      }
      meta={
        comparison.data &&
        `${comparison.data.base.run.workflow}${comparison.data.base.run.variant ? ` · ${comparison.data.base.run.variant}` : ''} → ${comparison.data.head.run.workflow}${comparison.data.head.run.variant ? ` · ${comparison.data.head.run.variant}` : ''}`
      }
      actions={pickers}
    />
  );

  if (!state.base || !state.head) {
    return (
      <>
        {header}
        <Panel>
          <EmptyState title="Choose two runs to compare">
            Pick a base (the reference) and a head (the change). Typical pairs: the default
            parameters against a variant, or last week’s run against today’s. From the terminal:{' '}
            <code className="text-xs">scope compare 11 12</code>.
          </EmptyState>
        </Panel>
      </>
    );
  }
  if (comparison.isPending)
    return (
      <>
        {header}
        <Loading rows={8} />
      </>
    );
  if (comparison.isError)
    return (
      <>
        {header}
        <ErrorState error={comparison.error} />
      </>
    );

  const data = comparison.data;
  return (
    <div
      className={`space-y-5 ${comparison.isPlaceholderData ? 'opacity-60 transition-opacity' : ''}`}
    >
      {header}
      {data.base.run.workflow !== data.head.run.workflow && (
        <p
          role="note"
          className="flex items-center gap-2 rounded-lg border border-line bg-warn-wash px-4 py-3 text-sm text-warn-fg"
        >
          <Alert size={14} />
          These runs are from different workflows ({data.base.run.workflow} and{' '}
          {data.head.run.workflow}); case ids may not correspond.
        </p>
      )}
      <Metrics data={data} />
      <Cases
        data={data}
        includeUnchanged={includeUnchanged}
        onToggle={() => setState({ unchanged: includeUnchanged ? null : '1' })}
      />
    </div>
  );
}
