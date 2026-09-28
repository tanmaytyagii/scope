/** Trace-level computations derived from spans. */
import type { SpanRecord, Usage } from './model.ts';

export interface TraceRollup {
  usage: Usage;
  costUsd: number | null;
  spanCount: number;
  llmCallCount: number;
  unpricedModels: string[];
}

/**
 * Computes token, cost and count rollups for a trace.
 *
 * Spans inside an `evaluation` subtree are excluded from usage and cost, so a trace reports
 * what the application spent — not what judging it cost. They still count toward `spanCount`.
 */
export function rollupSpans(spans: readonly SpanRecord[]): TraceRollup {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const evaluationCache = new Map<string, boolean>();
  const inEvaluation = (span: SpanRecord): boolean => {
    const cached = evaluationCache.get(span.id);
    if (cached !== undefined) return cached;
    let result = false;
    let current: SpanRecord | undefined = span;
    const guard = new Set<string>();
    while (current && !guard.has(current.id)) {
      guard.add(current.id);
      if (current.kind === 'evaluation') {
        result = true;
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    evaluationCache.set(span.id, result);
    return result;
  };

  const usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let cost = 0;
  let costKnown = true;
  let llmCallCount = 0;
  const unpriced = new Set<string>();

  for (const span of spans) {
    if (span.kind !== 'llm' || inEvaluation(span)) continue;
    llmCallCount++;
    usage.inputTokens += span.inputTokens ?? 0;
    usage.outputTokens += span.outputTokens ?? 0;
    const cacheRead = span.attributes['gen_ai.usage.cache_read_input_tokens'];
    const cacheWrite = span.attributes['gen_ai.usage.cache_creation_input_tokens'];
    if (typeof cacheRead === 'number')
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cacheRead;
    if (typeof cacheWrite === 'number')
      usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + cacheWrite;
    if (span.attributes['scope.usage.estimated'] === true) usage.estimated = true;
    if (span.costUsd === null) {
      costKnown = false;
      if (span.model) unpriced.add(span.provider ? `${span.provider}:${span.model}` : span.model);
    } else {
      cost += span.costUsd;
    }
  }
  usage.totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);

  return {
    usage,
    costUsd: costKnown ? cost : null,
    spanCount: spans.length,
    llmCallCount,
    unpricedModels: [...unpriced].sort(),
  };
}

export interface SpanNode<
  S extends { id: string; parentId: string | null; startTime: number } = SpanRecord,
> {
  span: S;
  children: SpanNode<S>[];
  depth: number;
}

/** Builds a span tree ordered by start time. Orphans (missing parent) become roots. */
export function buildSpanTree<S extends { id: string; parentId: string | null; startTime: number }>(
  spans: readonly S[],
): SpanNode<S>[] {
  const nodes = new Map<string, SpanNode<S>>();
  for (const span of spans) nodes.set(span.id, { span, children: [], depth: 0 });
  const roots: SpanNode<S>[] = [];
  for (const node of nodes.values()) {
    const parent = node.span.parentId ? nodes.get(node.span.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sortAndDepth = (list: SpanNode<S>[], depth: number) => {
    list.sort((a, b) => a.span.startTime - b.span.startTime);
    for (const n of list) {
      n.depth = depth;
      sortAndDepth(n.children, depth + 1);
    }
  };
  sortAndDepth(roots, 0);
  return roots;
}

/** Depth-first flattening of a span tree. */
export function flattenSpanTree<
  S extends { id: string; parentId: string | null; startTime: number },
>(roots: readonly SpanNode<S>[]): SpanNode<S>[] {
  const out: SpanNode<S>[] = [];
  const visit = (n: SpanNode<S>) => {
    out.push(n);
    for (const c of n.children) visit(c);
  };
  for (const r of roots) visit(r);
  return out;
}
