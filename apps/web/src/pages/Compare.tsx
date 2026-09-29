/**
 * Compare two runs — "did variant B beat variant A, and exactly which cases changed?" Metric
 * deltas are direction-aware (higher pass rate is better, higher latency is worse); small
 * differences within noise tolerance are reported as unchanged.
 */
import type { Comparison } from '@scope-ai/protocol';
import { useState } from 'react';
import { Link } from 'react-router';
import { allItems, useComparison, useRuns } from '../api/queries.ts';
import { useTitle, useUrlState } from '../app/hooks.ts';
import { CaseChangeCounts, CaseChangeTable, MetricDeltaTable } from '../components/Comparison.tsx';
import { Button } from '../ui/Button.tsx';
import { Select } from '../ui/Controls.tsx';
import { PageHeader } from '../ui/Figures.tsx';
import { Alert, ArrowRight, IconCompare } from '../ui/icons.tsx';
import { Panel } from '../ui/Panel.tsx';
import { EmptyState, ErrorState, Loading } from '../ui/States.tsx';

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
  return (
    <Panel
      title="Metrics"
      description="Change from the base run to the head run; tolerances absorb timer and rounding noise"
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
      <MetricDeltaTable
        metrics={data.metrics}
        headline={data.headline}
        showAll={all}
        baseLabel={`Base #${data.base.run.number}`}
        headLabel={`Head #${data.head.run.number}`}
      />
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
          Include {data.counts.unchanged} unchanged
        </label>
      }
    >
      <CaseChangeCounts counts={data.counts} onlyHead="only in head" onlyBase="only in base" />
      {data.cases.length === 0 ? (
        <p className="px-4 py-6 text-sm text-fg-2">No case changed its outcome or scores.</p>
      ) : (
        <CaseChangeTable cases={data.cases} />
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
