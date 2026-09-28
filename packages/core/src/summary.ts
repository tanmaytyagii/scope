/** Run summaries: the aggregate numbers every report, gate and comparison is built from. */
import { type CaseResult, caseOutcome, type EvaluatorKind } from './model.ts';
import { max, mean, percentile, ratio, sum } from './stats.ts';

export interface EvaluatorSummary {
  name: string;
  type: string;
  kind: EvaluatorKind;
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  /** passed / (passed + failed + errored); skipped results do not count. */
  passRate: number | null;
  /** Mean of non-null scores. */
  meanScore: number | null;
}

export interface RunSummary {
  cases: { total: number; passed: number; failed: number; errored: number };
  passRate: number | null;
  errorRate: number | null;
  latency: {
    p50Ms: number | null;
    p95Ms: number | null;
    meanMs: number | null;
    maxMs: number | null;
  };
  tokens: {
    input: number;
    output: number;
    total: number;
    meanPerCase: number | null;
    estimated: boolean;
  };
  cost: {
    /** Sum over cases with a known cost. */
    totalUsd: number | null;
    meanPerCaseUsd: number | null;
    /** True when at least one case's cost is unknown, so the total is a lower bound. */
    incomplete: boolean;
    unpricedModels: string[];
  };
  evaluators: EvaluatorSummary[];
}

export interface SummarizeOptions {
  /** Evaluator order as configured; unknown evaluators are appended in first-seen order. */
  evaluatorOrder?: readonly string[];
}

export function summarizeRun(
  results: readonly CaseResult[],
  options: SummarizeOptions = {},
): RunSummary {
  const outcomes = results.map(caseOutcome);
  const passed = outcomes.filter((o) => o === 'passed').length;
  const failed = outcomes.filter((o) => o === 'failed').length;
  const errored = outcomes.filter((o) => o === 'errored').length;
  const total = results.length;

  const durations = results.map((r) => r.durationMs);
  const inputTokens = sum(results.map((r) => r.usage.inputTokens));
  const outputTokens = sum(results.map((r) => r.usage.outputTokens));
  const totalTokens = sum(results.map((r) => r.usage.totalTokens));

  const knownCosts = results.filter((r) => r.costUsd !== null).map((r) => r.costUsd as number);
  const unpriced = new Set<string>();
  for (const r of results) for (const m of r.unpricedModels) unpriced.add(m);

  const evaluatorMap = new Map<string, EvaluatorSummary & { scores: number[] }>();
  const order: string[] = [...(options.evaluatorOrder ?? [])];
  for (const r of results) {
    for (const e of r.evaluations) {
      let entry = evaluatorMap.get(e.evaluator);
      if (!entry) {
        entry = {
          name: e.evaluator,
          type: e.type,
          kind: e.kind,
          total: 0,
          passed: 0,
          failed: 0,
          errored: 0,
          skipped: 0,
          passRate: null,
          meanScore: null,
          scores: [],
        };
        evaluatorMap.set(e.evaluator, entry);
        if (!order.includes(e.evaluator)) order.push(e.evaluator);
      }
      entry.total++;
      if (e.status === 'passed') entry.passed++;
      else if (e.status === 'failed') entry.failed++;
      else if (e.status === 'error') entry.errored++;
      else entry.skipped++;
      if (e.score !== null && e.status !== 'skipped' && e.status !== 'error')
        entry.scores.push(e.score);
    }
  }

  const evaluators: EvaluatorSummary[] = [];
  for (const name of order) {
    const entry = evaluatorMap.get(name);
    if (!entry) continue;
    const { scores, ...rest } = entry;
    evaluators.push({
      ...rest,
      passRate: ratio(entry.passed, entry.passed + entry.failed + entry.errored),
      meanScore: mean(scores),
    });
  }

  return {
    cases: { total, passed, failed, errored },
    passRate: ratio(passed, total),
    errorRate: ratio(errored, total),
    latency: {
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      meanMs: mean(durations),
      maxMs: max(durations),
    },
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total: totalTokens,
      meanPerCase: total === 0 ? null : totalTokens / total,
      estimated: results.some((r) => r.usage.estimated === true),
    },
    cost: {
      totalUsd: knownCosts.length === 0 && total > 0 ? null : sum(knownCosts),
      meanPerCaseUsd: knownCosts.length === 0 ? null : sum(knownCosts) / knownCosts.length,
      incomplete: knownCosts.length < total,
      unpricedModels: [...unpriced].sort(),
    },
    evaluators,
  };
}
