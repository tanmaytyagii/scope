/**
 * Evaluation results of a trace. Each says how it was judged; heuristic results are labelled as
 * signals and model results as opinions, with the evidence the evaluator recorded.
 */
import type { Evaluation } from '@scope-ai/protocol';
import { useState } from 'react';
import { formatDuration, formatScore } from '../../lib/format.ts';
import { CodeBlock } from '../../ui/CodeBlock.tsx';
import { KIND_EXPLANATIONS, KindBadge } from '../../ui/Kind.tsx';
import { OutcomeBadge } from '../../ui/Status.tsx';

function judgeModel(e: Evaluation): string | null {
  const judge = e.metadata.judge ?? e.metadata.model;
  return typeof judge === 'string' ? judge : null;
}

export function EvaluationCard({
  evaluation: e,
  onShowSpan,
}: {
  evaluation: Evaluation;
  onShowSpan?: () => void;
}) {
  const [evidence, setEvidence] = useState(false);
  const hasEvidence = Object.keys(e.metadata).length > 0;
  const judge = judgeModel(e);
  return (
    <article
      className="rounded-md border border-line bg-panel"
      aria-label={`${e.evaluator}: ${e.status}`}
    >
      <header className="flex flex-wrap items-center gap-2 px-3 pt-2.5">
        <OutcomeBadge outcome={e.status} />
        <h3 className="text-sm font-semibold text-fg">{e.evaluator}</h3>
        <code className="text-2xs text-fg-3">{e.type}</code>
        <KindBadge kind={e.kind} />
        <span className="tabular ml-auto text-xs text-fg-2">
          {e.score === null ? 'no score' : `score ${formatScore(e.score)}`}
          {e.threshold !== null && (
            <span className="text-fg-3"> · threshold {formatScore(e.threshold)}</span>
          )}
        </span>
      </header>
      <p className="px-3 pt-1.5 pb-2 text-sm text-fg">{e.reason}</p>
      {e.kind !== 'deterministic' && (
        <p className="px-3 pb-2 text-xs text-fg-3">
          {e.kind === 'model' && judge ? `Judged by ${judge}. ` : ''}
          {KIND_EXPLANATIONS[e.kind].text}
        </p>
      )}
      <footer className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-xs">
        <span className="text-fg-3">{formatDuration(e.durationMs)}</span>
        {hasEvidence && (
          <button
            type="button"
            aria-expanded={evidence}
            onClick={() => setEvidence((v) => !v)}
            className="rounded-sm px-1 font-medium text-accent-fg hover:bg-hover"
          >
            {evidence ? 'Hide evidence' : 'Show evidence'}
          </button>
        )}
        {onShowSpan && e.spanId && (
          <button
            type="button"
            onClick={onShowSpan}
            className="ml-auto rounded-sm px-1 text-fg-3 hover:bg-hover hover:text-fg"
          >
            Show span
          </button>
        )}
      </footer>
      {evidence && (
        <div className="px-3 pb-3">
          <CodeBlock label="Evidence" value={e.metadata} />
        </div>
      )}
    </article>
  );
}

export function EvaluationList({
  evaluations,
  onShowSpan,
}: {
  evaluations: Evaluation[];
  onShowSpan: (spanId: string) => void;
}) {
  if (evaluations.length === 0) {
    return (
      <p className="px-4 py-5 text-sm text-fg-2">
        This trace was not evaluated. Evaluators run on workflow traces during{' '}
        <code className="text-xs">scope run</code>; SDK traces carry the evaluations the application
        recorded.
      </p>
    );
  }
  const failing = evaluations.filter((e) => e.status === 'failed' || e.status === 'error');
  const ordered = [...failing, ...evaluations.filter((e) => !failing.includes(e))];
  return (
    <div className="space-y-2.5 p-4">
      {ordered.map((e) => (
        <EvaluationCard
          key={e.id}
          evaluation={e}
          onShowSpan={e.spanId ? () => onShowSpan(e.spanId as string) : undefined}
        />
      ))}
    </div>
  );
}
