/**
 * Trace explorer — "what exactly happened in this execution?" The span tree and timing on the
 * left, the selected span's content on the right, and the evaluation results below. The
 * selected span is in the URL (?span=), so any moment of a trace is linkable.
 */
import type { TraceDetail } from '@scope-ai/protocol';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTrace } from '../../api/queries.ts';
import { isTypingTarget, useTitle, useUrlState } from '../../app/hooks.ts';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  pluralize,
} from '../../lib/format.ts';
import { filterSpans, parentIds, type SpanFilterKind } from '../../lib/spans.ts';
import { Button, buttonClass } from '../../ui/Button.tsx';
import { Kbd, SearchInput, Segmented } from '../../ui/Controls.tsx';
import { IdChip } from '../../ui/Copy.tsx';
import { PageHeader } from '../../ui/Figures.tsx';
import { ChevronLeft, ChevronRight } from '../../ui/icons.tsx';
import { Panel } from '../../ui/Panel.tsx';
import { ErrorState, Loading } from '../../ui/States.tsx';
import { OutcomeBadge } from '../../ui/Status.tsx';
import { Tooltip } from '../../ui/Tooltip.tsx';
import { EvaluationList } from './Evaluations.tsx';
import { SpanDetail } from './SpanDetail.tsx';
import { Waterfall } from './Waterfall.tsx';

type FailingCases = NonNullable<TraceDetail['failingCases']>;

/**
 * Steps through the run's failing and errored cases, in the run's case order, with [ and ].
 * "What failed?" becomes a walk through every failure without going back to the run.
 */
function FailingCaseNav({ failing }: { failing: FailingCases }) {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const target = e.key === '[' ? failing.previous : e.key === ']' ? failing.next : null;
      if (!target) return;
      e.preventDefault();
      navigate(`/traces/${target.traceId}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [failing, navigate]);

  const step = (direction: 'previous' | 'next') => {
    const target = failing[direction];
    const icon = direction === 'previous' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />;
    const key = direction === 'previous' ? '[' : ']';
    const label = direction === 'previous' ? 'Previous' : 'Next';
    if (!target)
      return (
        <Button size="sm" disabled aria-label={`No ${direction} failing case`}>
          {icon}
        </Button>
      );
    return (
      <Tooltip
        content={
          <span className="flex items-center gap-1.5">
            {label} failing case: {target.caseId} <Kbd>{key}</Kbd>
          </span>
        }
      >
        <Link
          to={`/traces/${target.traceId}`}
          aria-label={`${label} failing case: ${target.caseId}`}
          aria-keyshortcuts={key}
          className={buttonClass('default', 'sm')}
        >
          {icon}
        </Link>
      </Tooltip>
    );
  };

  return (
    <nav aria-label="Failing cases of this run" className="flex items-center gap-1.5">
      <span className="tabular mr-1 text-sm text-fg-2">
        {failing.position
          ? `Failing case ${failing.position} of ${failing.total}`
          : pluralize(failing.total, 'failing case')}
      </span>
      {step('previous')}
      {step('next')}
    </nav>
  );
}

const SPAN_FILTERS: ReadonlyArray<{ value: SpanFilterKind; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'errors', label: 'Errors' },
  { value: 'llm', label: 'Model calls' },
];

function Explorer({ data }: { data: TraceDetail }) {
  const [state, setState] = useUrlState(['span', 'q', 'only'] as const);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const only: SpanFilterKind = state.only === 'errors' || state.only === 'llm' ? state.only : 'all';
  const filtered = useMemo(
    () => filterSpans(data.spans, { q: state.q, only }),
    [data.spans, state.q, only],
  );
  const t = data.trace;
  const root =
    data.spans.find((s) => s.parentId === null && s.kind !== 'evaluation') ?? data.spans[0];
  const selected = data.spans.find((s) => s.id === state.span) ?? root;
  const evaluationBySpan = useMemo(
    () => new Map(data.evaluations.filter((e) => e.spanId).map((e) => [e.spanId as string, e])),
    [data.evaluations],
  );
  const parents = useMemo(() => parentIds(data.spans), [data.spans]);

  const select = (id: string, reveal = false) => {
    setState({ span: id === root?.id ? null : id });
    // Below xl the detail panel is stacked under the tree: bring it into view on click.
    if (reveal && window.matchMedia('(max-width: 1279px)').matches)
      requestAnimationFrame(() =>
        document
          .getElementById('span-detail')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
  };
  const toggle = (id: string, open?: boolean) =>
    setCollapsed((current) => {
      const next = new Set(current);
      const shouldOpen = open ?? next.has(id);
      if (shouldOpen) next.delete(id);
      else next.add(id);
      return next;
    });

  const failed = data.evaluations.filter(
    (e) => e.status === 'failed' || e.status === 'error',
  ).length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-1.5">
            <Link to="/traces" className="hover:text-fg hover:underline">
              Traces
            </Link>
            {data.run && (
              <>
                <span aria-hidden>/</span>
                <Link to={`/runs/${data.run.number}`} className="hover:text-fg hover:underline">
                  Run #{data.run.number}
                  {data.run.variant ? ` · ${data.run.variant}` : ''}
                </Link>
              </>
            )}
          </span>
        }
        title={
          <>
            {t.caseId ?? t.name}
            <OutcomeBadge outcome={t.status} label={t.status === 'ok' ? 'completed' : 'error'} />
            {t.evalStatus && (
              <OutcomeBadge
                outcome={t.evalStatus}
                label={
                  t.evalStatus === 'passed'
                    ? 'evaluations passed'
                    : t.evalStatus === 'failed'
                      ? `${failed} ${failed === 1 ? 'evaluation' : 'evaluations'} failed`
                      : 'evaluator error'
                }
              />
            )}
          </>
        }
        actions={
          data.failingCases && data.failingCases.total > 0 ? (
            <FailingCaseNav failing={data.failingCases} />
          ) : undefined
        }
        meta={
          <>
            {t.caseId && <span className="text-fg">{t.name}</span>}
            <span title={t.startTime}>{formatDateTime(t.startTime)}</span>
            <span>{formatDuration(t.durationMs)}</span>
            <span>{pluralize(t.spanCount, 'span')}</span>
            {t.llmCallCount > 0 && (
              <>
                <span>{pluralize(t.llmCallCount, 'model call')}</span>
                {t.usage.estimated ? (
                  <Tooltip content="Estimated locally: the provider did not report token counts.">
                    <span className="cursor-help">~{formatTokens(t.usage.totalTokens)} tokens</span>
                  </Tooltip>
                ) : (
                  <span>{formatTokens(t.usage.totalTokens)} tokens</span>
                )}
                <span>
                  {t.costUsd === null ? 'cost unknown' : `${formatCost(t.costUsd)} estimated`}
                </span>
              </>
            )}
            <IdChip id={t.id} length={12} />
          </>
        }
      />
      {t.error && (
        <div
          role="alert"
          className="rounded-lg border border-line bg-bad-wash px-4 py-3 text-sm text-bad-fg"
        >
          <div className="font-semibold">
            {t.error.type}
            {t.error.code ? ` (${t.error.code})` : ''}: {t.error.message}
          </div>
          {t.error.hint && <div className="mt-1 text-fg-2">{t.error.hint}</div>}
        </div>
      )}
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <div className="min-w-0 space-y-5">
          <Panel
            title="Spans"
            description={
              filtered
                ? `${filtered.matched.size} of ${pluralize(data.spans.length, 'span')} match`
                : `${pluralize(data.spans.length, 'span')} · click or use the arrow keys`
            }
            actions={
              parents.size > 0 &&
              !filtered && (
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => (c.size ? new Set() : new Set(parents)))}
                  className="text-xs text-accent-fg hover:underline"
                >
                  {collapsed.size ? 'Expand all' : 'Collapse all'}
                </button>
              )
            }
          >
            {data.spans.length > 1 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
                <SearchInput
                  value={state.q}
                  onChange={(q) => setState({ q })}
                  placeholder="Filter by name or model"
                  label="Filter spans by name, kind or model"
                  className="w-full min-w-40 flex-1 sm:w-auto"
                />
                <Segmented
                  label="Show"
                  value={only}
                  options={SPAN_FILTERS}
                  onChange={(value) => setState({ only: value === 'all' ? null : value })}
                />
              </div>
            )}
            {filtered && filtered.matched.size === 0 ? (
              <div className="px-4 py-6 text-sm text-fg-2">
                No spans match.{' '}
                <button
                  type="button"
                  onClick={() => setState({ q: null, only: null })}
                  className="text-accent-fg hover:underline"
                >
                  Clear the filter
                </button>
              </div>
            ) : (
              <Waterfall
                spans={data.spans}
                selected={selected?.id ?? null}
                onSelect={select}
                collapsed={collapsed}
                onToggle={toggle}
                filtered={filtered}
              />
            )}
          </Panel>
          <Panel
            title="Evaluations"
            description={
              data.evaluations.length
                ? `${data.evaluations.length - failed} of ${data.evaluations.length} passed or skipped`
                : undefined
            }
          >
            <EvaluationList evaluations={data.evaluations} onShowSpan={(id) => select(id, true)} />
          </Panel>
        </div>
        <Panel
          id="span-detail"
          className="min-w-0 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto"
        >
          {selected ? (
            <SpanDetail
              span={selected}
              trace={data}
              evaluation={evaluationBySpan.get(selected.id)}
            />
          ) : (
            <p className="px-4 py-6 text-sm text-fg-2">This trace has no spans.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}

export function TraceExplorer() {
  const { trace: id = '' } = useParams();
  const trace = useTrace(id);
  useTitle(trace.data ? (trace.data.trace.caseId ?? trace.data.trace.name) : 'Trace');
  if (trace.isPending) return <Loading rows={10} label="Loading trace" />;
  if (trace.isError) return <ErrorState error={trace.error} onRetry={() => void trace.refetch()} />;
  return <Explorer data={trace.data} />;
}
