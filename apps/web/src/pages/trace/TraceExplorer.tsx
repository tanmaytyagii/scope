/**
 * Trace explorer — "what exactly happened in this execution?" The span tree and timing on the
 * left, the selected span's content on the right, and the evaluation results below. The
 * selected span is in the URL (?span=), so any moment of a trace is linkable.
 */
import type { TraceDetail } from '@scope-ai/protocol';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTrace } from '../../api/queries.ts';
import { useTitle, useUrlState } from '../../app/hooks.ts';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  pluralize,
} from '../../lib/format.ts';
import { parentIds } from '../../lib/spans.ts';
import { IdChip } from '../../ui/Copy.tsx';
import { PageHeader } from '../../ui/Figures.tsx';
import { Panel } from '../../ui/Panel.tsx';
import { ErrorState, Loading } from '../../ui/States.tsx';
import { OutcomeBadge } from '../../ui/Status.tsx';
import { Tooltip } from '../../ui/Tooltip.tsx';
import { EvaluationList } from './Evaluations.tsx';
import { SpanDetail } from './SpanDetail.tsx';
import { Waterfall } from './Waterfall.tsx';

function Explorer({ data }: { data: TraceDetail }) {
  const [state, setState] = useUrlState(['span'] as const);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
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
            description={`${pluralize(data.spans.length, 'span')} · click or use the arrow keys`}
            actions={
              parents.size > 0 && (
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
            <Waterfall
              spans={data.spans}
              selected={selected?.id ?? null}
              onSelect={select}
              collapsed={collapsed}
              onToggle={toggle}
            />
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
