/**
 * Gates: thresholds on run metrics that decide whether a run passes.
 *
 * Absolute conditions (`min`, `max`) compare the run against fixed numbers. Regression
 * conditions (`max_decrease`, `max_increase`, `*_pct`) compare the run against a baseline.
 * Each condition produces one result so reports can say exactly which check failed.
 */
import { formatDelta, formatMetric } from './format.ts';
import { describeMetric, type MetricDescriptor, readMetric } from './metrics.ts';
import type { GateStatus } from './model.ts';
import type { RunSummary } from './summary.ts';

export type GateSeverity = 'fail' | 'warn';

export interface GateDefinition {
  metric: string;
  min?: number;
  max?: number;
  /** Largest allowed absolute decrease versus the baseline. */
  maxDecrease?: number;
  /** Largest allowed absolute increase versus the baseline. */
  maxIncrease?: number;
  /** Largest allowed relative decrease versus the baseline, in percent. */
  maxDecreasePct?: number;
  /** Largest allowed relative increase versus the baseline, in percent. */
  maxIncreasePct?: number;
  severity?: GateSeverity;
}

export type GateCondition =
  | 'min'
  | 'max'
  | 'max_decrease'
  | 'max_increase'
  | 'max_decrease_pct'
  | 'max_increase_pct';

export interface GateResult {
  metric: string;
  label: string;
  unit: MetricDescriptor['unit'];
  condition: GateCondition;
  /** Human-readable form of the condition, e.g. "≥ 90.0%". */
  expectation: string;
  threshold: number;
  severity: GateSeverity;
  status: 'passed' | 'failed' | 'skipped';
  actual: number | null;
  baseline: number | null;
  message: string;
}

const EPSILON = 1e-9;

const CONDITIONS: ReadonlyArray<{
  key: keyof GateDefinition;
  condition: GateCondition;
  regression: boolean;
}> = [
  { key: 'min', condition: 'min', regression: false },
  { key: 'max', condition: 'max', regression: false },
  { key: 'maxDecrease', condition: 'max_decrease', regression: true },
  { key: 'maxIncrease', condition: 'max_increase', regression: true },
  { key: 'maxDecreasePct', condition: 'max_decrease_pct', regression: true },
  { key: 'maxIncreasePct', condition: 'max_increase_pct', regression: true },
];

function expectation(
  condition: GateCondition,
  threshold: number,
  unit: MetricDescriptor['unit'],
): string {
  switch (condition) {
    case 'min':
      return `≥ ${formatMetric(threshold, unit)}`;
    case 'max':
      return `≤ ${formatMetric(threshold, unit)}`;
    case 'max_decrease':
      return unit === 'ratio'
        ? `drop ≤ ${(threshold * 100).toFixed(1)} pp vs baseline`
        : `drop ≤ ${formatMetric(threshold, unit)} vs baseline`;
    case 'max_increase':
      return unit === 'ratio'
        ? `rise ≤ ${(threshold * 100).toFixed(1)} pp vs baseline`
        : `rise ≤ ${formatMetric(threshold, unit)} vs baseline`;
    case 'max_decrease_pct':
      return `drop ≤ ${threshold}% vs baseline`;
    case 'max_increase_pct':
      return `rise ≤ ${threshold}% vs baseline`;
  }
}

/** Evaluates gate definitions against a run summary and optional baseline summary. */
export function evaluateGates(
  summary: RunSummary,
  gates: readonly GateDefinition[],
  baseline?: RunSummary | null,
): GateResult[] {
  const results: GateResult[] = [];
  for (const gate of gates) {
    const descriptor = describeMetric(gate.metric) ?? {
      id: gate.metric,
      label: gate.metric,
      unit: 'score' as const,
      direction: 'higher' as const,
    };
    const actual = readMetric(summary, gate.metric);
    const base = baseline ? readMetric(baseline, gate.metric) : null;
    const severity = gate.severity ?? 'fail';

    for (const { key, condition, regression } of CONDITIONS) {
      const threshold = gate[key];
      if (typeof threshold !== 'number') continue;
      const result: GateResult = {
        metric: gate.metric,
        label: descriptor.label,
        unit: descriptor.unit,
        condition,
        expectation: expectation(condition, threshold, descriptor.unit),
        threshold,
        severity,
        status: 'passed',
        actual,
        baseline: base,
        message: '',
      };
      const fmt = (v: number | null) => formatMetric(v, descriptor.unit);

      if (actual === null) {
        result.status = 'skipped';
        result.message = `${descriptor.label} has no value in this run`;
        results.push(result);
        continue;
      }
      if (regression && !baseline) {
        result.status = 'skipped';
        result.message = 'No baseline to compare against';
        results.push(result);
        continue;
      }
      if (regression && base === null) {
        result.status = 'skipped';
        result.message = `${descriptor.label} has no value in the baseline`;
        results.push(result);
        continue;
      }

      let ok = true;
      switch (condition) {
        case 'min':
          ok = actual >= threshold - EPSILON;
          result.message = ok
            ? `${descriptor.label} ${fmt(actual)} meets the minimum of ${fmt(threshold)}`
            : `${descriptor.label} ${fmt(actual)} is below the minimum of ${fmt(threshold)}`;
          break;
        case 'max':
          ok = actual <= threshold + EPSILON;
          result.message = ok
            ? `${descriptor.label} ${fmt(actual)} is within the maximum of ${fmt(threshold)}`
            : `${descriptor.label} ${fmt(actual)} exceeds the maximum of ${fmt(threshold)}`;
          break;
        case 'max_decrease':
        case 'max_increase': {
          const b = base as number;
          const change = condition === 'max_decrease' ? b - actual : actual - b;
          ok = change <= threshold + EPSILON;
          const verb = condition === 'max_decrease' ? 'dropped' : 'rose';
          result.message = `${descriptor.label} ${fmt(b)} → ${fmt(actual)} (${formatDelta(b, actual, descriptor.unit)})${
            ok
              ? ''
              : `; ${verb} more than the allowed ${descriptor.unit === 'ratio' ? `${(threshold * 100).toFixed(1)} pp` : fmt(threshold)}`
          }`;
          break;
        }
        case 'max_decrease_pct':
        case 'max_increase_pct': {
          const b = base as number;
          if (Math.abs(b) < EPSILON) {
            result.status = 'skipped';
            result.message = `${descriptor.label} is 0 in the baseline, so a percentage change is undefined`;
            results.push(result);
            continue;
          }
          const pct = ((actual - b) / Math.abs(b)) * 100;
          const change = condition === 'max_decrease_pct' ? -pct : pct;
          ok = change <= threshold + EPSILON;
          const verb = condition === 'max_decrease_pct' ? 'dropped' : 'rose';
          result.message = `${descriptor.label} ${fmt(b)} → ${fmt(actual)} (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)${
            ok ? '' : `; ${verb} more than the allowed ${threshold}%`
          }`;
          break;
        }
      }
      result.status = ok ? 'passed' : 'failed';
      results.push(result);
    }
  }
  return results;
}

export function gateStatus(results: readonly GateResult[]): GateStatus {
  if (results.length === 0) return 'none';
  if (results.some((r) => r.status === 'failed' && r.severity === 'fail')) return 'failed';
  if (results.some((r) => r.status === 'failed' && r.severity === 'warn')) return 'warned';
  return 'passed';
}
