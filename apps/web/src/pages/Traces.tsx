/** Traces — every execution, from workflow runs and from instrumented applications. */
import { useRef } from 'react';
import { allItems, useModels, useTraces } from '../api/queries.ts';
import { useTitle, useUrlState } from '../app/hooks.ts';
import { TraceTable } from '../components/TraceTable.tsx';
import { SearchInput, Select } from '../ui/Controls.tsx';
import { PageHeader } from '../ui/Figures.tsx';
import { Panel } from '../ui/Panel.tsx';
import { EmptyState, ErrorState, Loading } from '../ui/States.tsx';
import { MoreRows } from '../ui/Table.tsx';

const KEYS = ['q', 'status', 'eval', 'run', 'model', 'sort', 'name'] as const;

export function Traces() {
  useTitle('Traces');
  const [filters, setFilters] = useUrlState(KEYS);
  const traces = useTraces(filters);
  const models = useModels('90d');
  const items = allItems(traces.data);
  const search = useRef<HTMLInputElement>(null);
  const filtered = KEYS.some((k) => k !== 'sort' && filters[k]);

  const modelOptions = [
    ...new Set(
      (models.data?.items ?? [])
        .filter((m) => m.usage === 'workflow')
        .map((m) => (m.provider ? `${m.provider}:${m.model}` : m.model)),
    ),
  ];

  return (
    <>
      <PageHeader
        title="Traces"
        meta="Each trace is one execution: a case in a run, or a request traced with the SDK."
      />
      <div className="mb-3 flex flex-wrap items-center gap-2" data-page-search>
        <SearchInput
          inputRef={search}
          label="Search traces"
          placeholder="Search names, ids, cases, inputs, outputs"
          value={filters.q}
          onChange={(q) => setFilters({ q })}
          className="w-full sm:w-80"
        />
        <Select
          label="Status"
          value={filters.status}
          onChange={(status) => setFilters({ status })}
          options={[
            { value: '', label: 'Any status' },
            { value: 'ok', label: 'Completed' },
            { value: 'error', label: 'Errored' },
          ]}
        />
        <Select
          label="Evaluation"
          value={filters.eval}
          onChange={(v) => setFilters({ eval: v })}
          options={[
            { value: '', label: 'Any evaluation' },
            { value: 'failed', label: 'Evaluation failed' },
            { value: 'errored', label: 'Evaluator errored' },
            { value: 'passed', label: 'All evaluations passed' },
            { value: 'none', label: 'Not evaluated' },
          ]}
        />
        {modelOptions.length > 0 && (
          <Select
            label="Model"
            value={filters.model}
            onChange={(model) => setFilters({ model })}
            options={[
              { value: '', label: 'Any model' },
              ...modelOptions.map((m) => ({ value: m, label: m })),
            ]}
          />
        )}
        <Select
          label="Sort"
          value={filters.sort}
          onChange={(sort) => setFilters({ sort: sort === 'newest' ? null : sort })}
          options={[
            { value: '', label: 'Newest first' },
            { value: 'oldest', label: 'Oldest first' },
            { value: 'slowest', label: 'Slowest first' },
            { value: 'costliest', label: 'Most expensive first' },
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
        {filtered && (
          <button
            type="button"
            onClick={() =>
              setFilters({ q: null, status: null, eval: null, run: null, model: null, name: null })
            }
            className="text-xs text-accent-fg hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>
      <Panel className={traces.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
        {traces.isPending ? (
          <Loading rows={10} />
        ) : traces.isError ? (
          <ErrorState error={traces.error} onRetry={() => void traces.refetch()} />
        ) : items.length === 0 ? (
          filtered ? (
            <EmptyState title="No traces match these filters" />
          ) : (
            <EmptyState title="No traces yet" command="scope run workflows/support.yaml">
              Traces are recorded by <code className="text-xs">scope run</code>, and by applications
              instrumented with <code className="text-xs">@scope-ai/sdk</code> that send to this
              server (<code className="text-xs">SCOPE_URL</code>).
            </EmptyState>
          )
        ) : (
          <>
            <TraceTable traces={items} />
            <MoreRows
              hasMore={Boolean(traces.hasNextPage)}
              loading={traces.isFetchingNextPage}
              onMore={() => void traces.fetchNextPage()}
              shown={items.length}
              noun={items.length === 1 ? 'trace' : 'traces'}
            />
          </>
        )}
      </Panel>
    </>
  );
}
