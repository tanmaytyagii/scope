/**
 * The run metric namespace used by gates, reports, comparisons and the API.
 *
 *   pass_rate · error_rate
 *   latency.p50_ms · latency.p95_ms · latency.mean_ms · latency.max_ms
 *   tokens.total · tokens.mean_per_case
 *   cost.total_usd · cost.mean_per_case_usd
 *   evaluator.<name>.pass_rate · evaluator.<name>.mean_score
 */
import type { RunSummary } from './summary.ts';

export type MetricUnit = 'ratio' | 'score' | 'ms' | 'tokens' | 'usd';
export type MetricDirection = 'higher' | 'lower';

export interface MetricDescriptor {
  id: string;
  label: string;
  unit: MetricUnit;
  /** Which direction is an improvement. */
  direction: MetricDirection;
}

interface StaticMetric extends MetricDescriptor {
  read: (s: RunSummary) => number | null;
}

const STATIC_METRICS: readonly StaticMetric[] = [
  {
    id: 'pass_rate',
    label: 'Pass rate',
    unit: 'ratio',
    direction: 'higher',
    read: (s) => s.passRate,
  },
  {
    id: 'error_rate',
    label: 'Error rate',
    unit: 'ratio',
    direction: 'lower',
    read: (s) => s.errorRate,
  },
  {
    id: 'latency.p50_ms',
    label: 'Latency p50',
    unit: 'ms',
    direction: 'lower',
    read: (s) => s.latency.p50Ms,
  },
  {
    id: 'latency.p95_ms',
    label: 'Latency p95',
    unit: 'ms',
    direction: 'lower',
    read: (s) => s.latency.p95Ms,
  },
  {
    id: 'latency.mean_ms',
    label: 'Latency mean',
    unit: 'ms',
    direction: 'lower',
    read: (s) => s.latency.meanMs,
  },
  {
    id: 'latency.max_ms',
    label: 'Latency max',
    unit: 'ms',
    direction: 'lower',
    read: (s) => s.latency.maxMs,
  },
  {
    id: 'tokens.total',
    label: 'Tokens',
    unit: 'tokens',
    direction: 'lower',
    read: (s) => s.tokens.total,
  },
  {
    id: 'tokens.mean_per_case',
    label: 'Tokens per case',
    unit: 'tokens',
    direction: 'lower',
    read: (s) => s.tokens.meanPerCase,
  },
  {
    id: 'cost.total_usd',
    label: 'Cost',
    unit: 'usd',
    direction: 'lower',
    read: (s) => s.cost.totalUsd,
  },
  {
    id: 'cost.mean_per_case_usd',
    label: 'Cost per case',
    unit: 'usd',
    direction: 'lower',
    read: (s) => s.cost.meanPerCaseUsd,
  },
];

const STATIC_BY_ID = new Map(STATIC_METRICS.map((m) => [m.id, m]));

const EVALUATOR_METRIC = /^evaluator\.([A-Za-z0-9_-]+)\.(pass_rate|mean_score)$/;

export const STATIC_METRIC_IDS: readonly string[] = STATIC_METRICS.map((m) => m.id);

export function parseEvaluatorMetric(
  id: string,
): { evaluator: string; field: 'pass_rate' | 'mean_score' } | null {
  const match = EVALUATOR_METRIC.exec(id);
  if (!match) return null;
  return { evaluator: match[1] as string, field: match[2] as 'pass_rate' | 'mean_score' };
}

/** Describes a metric id, or returns null if the id is not part of the namespace. */
export function describeMetric(id: string): MetricDescriptor | null {
  const stat = STATIC_BY_ID.get(id);
  if (stat) {
    const { read: _read, ...descriptor } = stat;
    return descriptor;
  }
  const ev = parseEvaluatorMetric(id);
  if (ev) {
    return {
      id,
      label: ev.field === 'pass_rate' ? `${ev.evaluator} pass rate` : `${ev.evaluator} score`,
      unit: ev.field === 'pass_rate' ? 'ratio' : 'score',
      direction: 'higher',
    };
  }
  return null;
}

/** Reads a metric from a summary. Returns null when the metric has no value in this run. */
export function readMetric(summary: RunSummary, id: string): number | null {
  const stat = STATIC_BY_ID.get(id);
  if (stat) return stat.read(summary);
  const ev = parseEvaluatorMetric(id);
  if (ev) {
    const entry = summary.evaluators.find((e) => e.name === ev.evaluator);
    if (!entry) return null;
    return ev.field === 'pass_rate' ? entry.passRate : entry.meanScore;
  }
  return null;
}

/** All metrics that have a meaningful value for this summary, in display order. */
export function listMetrics(summary: RunSummary): MetricDescriptor[] {
  const out: MetricDescriptor[] = [];
  for (const m of STATIC_METRICS) {
    const { read: _read, ...descriptor } = m;
    out.push(descriptor);
  }
  for (const e of summary.evaluators) {
    for (const field of ['mean_score', 'pass_rate'] as const) {
      const d = describeMetric(`evaluator.${e.name}.${field}`);
      if (d) out.push(d);
    }
  }
  return out;
}
