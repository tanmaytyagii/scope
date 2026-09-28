/**
 * Evaluator kinds. Every result in SCOPE says how it was judged, because a heuristic score and
 * a model's opinion deserve different trust than a rule.
 */
import type { EvaluatorKind, SpanKind } from '@scope-ai/protocol';
import { cx } from './cx.ts';
import { Tooltip } from './Tooltip.tsx';

export const KIND_EXPLANATIONS: Record<EvaluatorKind, { label: string; text: string }> = {
  deterministic: {
    label: 'deterministic',
    text: 'A rule. The same output always gets the same result.',
  },
  heuristic: {
    label: 'heuristic',
    text: 'An approximation from text overlap and patterns — a signal to investigate, not a verdict.',
  },
  model: {
    label: 'model',
    text: 'A model’s opinion, recorded with the judge model and its reasoning. Not ground truth.',
  },
};

const GLYPH: Record<EvaluatorKind, string> = { deterministic: '=', heuristic: '≈', model: '◇' };

export function KindBadge({ kind, className }: { kind: EvaluatorKind; className?: string }) {
  const k = KIND_EXPLANATIONS[kind];
  return (
    <Tooltip content={k.text}>
      <span
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users get the explanation
        tabIndex={0}
        className={cx(
          'inline-flex h-5 cursor-help items-center gap-1 rounded-sm border border-line px-1.5 text-2xs text-fg-2',
          className,
        )}
      >
        <span aria-hidden className="font-mono text-fg-3">
          {GLYPH[kind]}
        </span>
        {k.label}
      </span>
    </Tooltip>
  );
}

const SPAN_KIND_LABEL: Record<SpanKind, string> = {
  workflow: 'workflow',
  step: 'step',
  llm: 'LLM',
  retrieval: 'retrieval',
  tool: 'tool',
  function: 'function',
  evaluation: 'eval',
  custom: 'span',
};

export function SpanKindTag({ kind }: { kind: SpanKind }) {
  return (
    <span className="inline-flex h-4 items-center rounded-sm border border-line px-1 font-mono text-2xs leading-none text-fg-2">
      {SPAN_KIND_LABEL[kind]}
    </span>
  );
}
