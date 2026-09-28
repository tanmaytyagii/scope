/**
 * Span tree and waterfall layout for the trace explorer. Pure functions, unit-tested.
 */
import type { Span } from '@scope-ai/protocol';

export interface SpanRow {
  span: Span;
  depth: number;
  childCount: number;
  /** True for spans inside an evaluation subtree (not part of the workflow's own latency). */
  inEvaluation: boolean;
  /** Position of the bar as fractions (0–1) of the trace's total extent. */
  left: number;
  width: number;
}

export interface Waterfall {
  rows: SpanRow[];
  /** Time from the first span's start to the last span's end, in ms. */
  totalMs: number;
}

interface Node {
  span: Span;
  children: Node[];
}

function buildNodes(spans: readonly Span[]): Node[] {
  const nodes = new Map<string, Node>();
  for (const span of spans) nodes.set(span.id, { span, children: [] });
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.span.parentId ? nodes.get(node.span.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: Node[]) => {
    list.sort(
      (a, b) => a.span.offsetMs - b.span.offsetMs || a.span.name.localeCompare(b.span.name),
    );
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}

/**
 * Flattens spans depth-first into waterfall rows, skipping the descendants of collapsed spans.
 * Spans whose parent is missing become roots, so partial traces still render.
 */
export function layoutWaterfall(
  spans: readonly Span[],
  collapsed: ReadonlySet<string> = new Set(),
): Waterfall {
  const end = Math.max(0, ...spans.map((s) => s.offsetMs + s.durationMs));
  const totalMs = end > 0 ? end : 1;
  const rows: SpanRow[] = [];
  const visit = (node: Node, depth: number, inEvaluation: boolean) => {
    const evaluation = inEvaluation || node.span.kind === 'evaluation';
    rows.push({
      span: node.span,
      depth,
      childCount: node.children.length,
      inEvaluation: evaluation,
      left: node.span.offsetMs / totalMs,
      width: Math.max(node.span.durationMs / totalMs, 0),
    });
    if (collapsed.has(node.span.id)) return;
    for (const child of node.children) visit(child, depth + 1, evaluation);
  };
  for (const root of buildNodes(spans)) visit(root, 0, false);
  return { rows, totalMs: end };
}

/** Ids of every span that has children, for "collapse all". */
export function parentIds(spans: readonly Span[]): Set<string> {
  const ids = new Set<string>();
  for (const s of spans) if (s.parentId) ids.add(s.parentId);
  return ids;
}

/** The chain of ancestors of a span, root first, for breadcrumbs. */
export function ancestors(spans: readonly Span[], id: string): Span[] {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const chain: Span[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

/** Tick positions for a time axis of `totalMs`, at round intervals. */
export function timeTicks(totalMs: number, target = 5): number[] {
  if (!(totalMs > 0)) return [0];
  const raw = totalMs / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let t = 0; t <= totalMs + step * 1e-9; t += step) ticks.push(Number(t.toPrecision(12)));
  return ticks;
}
