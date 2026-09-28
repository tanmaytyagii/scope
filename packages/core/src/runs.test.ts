import { describe, expect, it } from 'vitest';
import { compareRuns, snapshotCase } from './compare.ts';
import { formatDelta, formatDuration, formatPercent, formatUsd } from './format.ts';
import { evaluateGates, gateStatus } from './gates.ts';
import { describeMetric, readMetric } from './metrics.ts';
import type { CaseResult, EvaluationStatus } from './model.ts';
import { estimateCost, lookupPrice } from './pricing.ts';
import { percentile } from './stats.ts';
import { summarizeRun } from './summary.ts';

function makeCase(
  caseId: string,
  opts: {
    durationMs?: number;
    status?: 'ok' | 'error';
    cost?: number | null;
    tokens?: number;
    evals?: Array<[string, EvaluationStatus, number | null]>;
  } = {},
): CaseResult {
  const tokens = opts.tokens ?? 100;
  return {
    caseId,
    traceId: `t-${caseId}`,
    status: opts.status ?? 'ok',
    durationMs: opts.durationMs ?? 100,
    usage: { inputTokens: tokens * 0.8, outputTokens: tokens * 0.2, totalTokens: tokens },
    costUsd: opts.cost === undefined ? 0.001 : opts.cost,
    unpricedModels: opts.cost === null ? ['acme:mystery'] : [],
    evaluations: (opts.evals ?? []).map(([evaluator, status, score]) => ({
      evaluator,
      type: evaluator === 'grounded' ? 'groundedness' : 'contains',
      kind: evaluator === 'grounded' ? 'heuristic' : 'deterministic',
      status,
      score,
    })),
  };
}

describe('percentile', () => {
  it('interpolates between ranks', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([100, 200, 300, 400, 500], 95)).toBeCloseTo(480);
  });
});

describe('summarizeRun', () => {
  const cases = [
    makeCase('a', {
      durationMs: 100,
      evals: [
        ['grounded', 'passed', 0.9],
        ['facts', 'passed', 1],
      ],
    }),
    makeCase('b', {
      durationMs: 200,
      evals: [
        ['grounded', 'failed', 0.4],
        ['facts', 'passed', 1],
      ],
    }),
    makeCase('c', {
      durationMs: 300,
      evals: [
        ['grounded', 'error', null],
        ['facts', 'failed', 0],
      ],
    }),
    makeCase('d', { durationMs: 400, status: 'error', cost: null, evals: [] }),
  ];
  const summary = summarizeRun(cases, { evaluatorOrder: ['facts', 'grounded'] });

  it('classifies case outcomes', () => {
    expect(summary.cases).toEqual({ total: 4, passed: 1, failed: 1, errored: 2 });
    expect(summary.passRate).toBe(0.25);
    expect(summary.errorRate).toBe(0.5);
  });

  it('computes latency and token aggregates', () => {
    expect(summary.latency.p50Ms).toBe(250);
    expect(summary.latency.maxMs).toBe(400);
    expect(summary.tokens.total).toBe(400);
    expect(summary.tokens.meanPerCase).toBe(100);
  });

  it('reports cost as a lower bound when some prices are unknown', () => {
    expect(summary.cost.totalUsd).toBeCloseTo(0.003);
    expect(summary.cost.incomplete).toBe(true);
    expect(summary.cost.unpricedModels).toEqual(['acme:mystery']);
  });

  it('aggregates evaluators in configured order, excluding errors from mean score', () => {
    expect(summary.evaluators.map((e) => e.name)).toEqual(['facts', 'grounded']);
    const grounded = summary.evaluators[1];
    expect(grounded).toMatchObject({ passed: 1, failed: 1, errored: 1, kind: 'heuristic' });
    expect(grounded?.passRate).toBeCloseTo(1 / 3);
    expect(grounded?.meanScore).toBeCloseTo(0.65);
  });

  it('handles an empty run', () => {
    const empty = summarizeRun([]);
    expect(empty.passRate).toBeNull();
    expect(empty.cost.totalUsd).toBe(0);
    expect(empty.latency.p95Ms).toBeNull();
  });
});

describe('metrics', () => {
  const summary = summarizeRun([makeCase('a', { evals: [['grounded', 'passed', 0.8]] })]);
  it('reads static and evaluator metrics', () => {
    expect(readMetric(summary, 'pass_rate')).toBe(1);
    expect(readMetric(summary, 'evaluator.grounded.mean_score')).toBe(0.8);
    expect(readMetric(summary, 'evaluator.missing.mean_score')).toBeNull();
    expect(describeMetric('latency.p95_ms')).toMatchObject({ unit: 'ms', direction: 'lower' });
    expect(describeMetric('nonsense')).toBeNull();
  });
});

describe('evaluateGates', () => {
  const base = summarizeRun([
    makeCase('a', { durationMs: 1000, cost: 0.003, evals: [['grounded', 'passed', 0.92]] }),
    makeCase('b', { durationMs: 1000, cost: 0.003, evals: [['grounded', 'passed', 0.9]] }),
  ]);
  const head = summarizeRun([
    makeCase('a', { durationMs: 1200, cost: 0.004, evals: [['grounded', 'passed', 0.88]] }),
    makeCase('b', { durationMs: 1200, cost: 0.004, evals: [['grounded', 'failed', 0.8]] }),
  ]);

  it('checks absolute thresholds', () => {
    const results = evaluateGates(head, [
      { metric: 'pass_rate', min: 0.9 },
      { metric: 'latency.p95_ms', max: 2000 },
    ]);
    expect(results.map((r) => r.status)).toEqual(['failed', 'passed']);
    expect(results[0]?.message).toBe('Pass rate 50.0% is below the minimum of 90.0%');
    expect(results[0]?.expectation).toBe('≥ 90.0%');
    expect(gateStatus(results)).toBe('failed');
  });

  it('checks regressions against a baseline', () => {
    const results = evaluateGates(
      head,
      [
        { metric: 'evaluator.grounded.mean_score', maxDecrease: 0.05 },
        { metric: 'latency.p95_ms', maxIncreasePct: 10, severity: 'warn' },
        { metric: 'cost.total_usd', maxIncreasePct: 50, severity: 'warn' },
      ],
      base,
    );
    expect(results.map((r) => [r.metric, r.status])).toEqual([
      ['evaluator.grounded.mean_score', 'failed'],
      ['latency.p95_ms', 'failed'],
      ['cost.total_usd', 'passed'],
    ]);
    expect(results[0]?.message).toContain('0.910 → 0.840 (−0.070)');
    expect(results[1]?.message).toContain('+20.0%');
  });

  it('downgrades to warned when only warn-severity gates fail', () => {
    const results = evaluateGates(
      head,
      [{ metric: 'latency.p95_ms', maxIncreasePct: 10, severity: 'warn' }],
      base,
    );
    expect(gateStatus(results)).toBe('warned');
  });

  it('skips regression gates without a baseline and gates on missing metrics', () => {
    const results = evaluateGates(head, [
      { metric: 'pass_rate', maxDecrease: 0.01 },
      { metric: 'evaluator.nope.pass_rate', min: 0.5 },
    ]);
    expect(results.map((r) => r.status)).toEqual(['skipped', 'skipped']);
    expect(gateStatus(results)).toBe('passed');
  });

  it('returns none when no gates are configured', () => {
    expect(gateStatus([])).toBe('none');
  });
});

describe('compareRuns', () => {
  const baseCases = [
    makeCase('a', { evals: [['grounded', 'passed', 0.9]] }),
    makeCase('b', { evals: [['grounded', 'failed', 0.3]] }),
    makeCase('c', { evals: [['grounded', 'passed', 0.8]] }),
    makeCase('gone', { evals: [['grounded', 'passed', 0.8]] }),
  ];
  const headCases = [
    makeCase('a', { evals: [['grounded', 'failed', 0.5]] }),
    makeCase('b', { evals: [['grounded', 'passed', 0.9]] }),
    makeCase('c', { evals: [['grounded', 'passed', 0.95]] }),
    makeCase('new', { evals: [['grounded', 'passed', 0.8]] }),
  ];
  const toSide = (cases: CaseResult[]) => ({
    summary: summarizeRun(cases),
    cases: Object.fromEntries(cases.map((c) => [c.caseId, snapshotCase(c)])),
  });
  const comparison = compareRuns(toSide(baseCases), toSide(headCases));

  it('classifies per-case changes, regressions first', () => {
    expect(comparison.cases.map((c) => [c.caseId, c.kind])).toEqual([
      ['a', 'regressed'],
      ['b', 'fixed'],
      ['c', 'changed'],
      ['new', 'added'],
      ['gone', 'removed'],
    ]);
    expect(comparison.counts).toMatchObject({
      regressed: 1,
      fixed: 1,
      changed: 1,
      added: 1,
      removed: 1,
    });
  });

  it('computes direction-aware metric deltas', () => {
    const passRate = comparison.metrics.find((m) => m.id === 'pass_rate');
    expect(passRate).toMatchObject({ base: 0.75, head: 0.75, change: 'unchanged' });
    const score = comparison.metrics.find((m) => m.id === 'evaluator.grounded.mean_score');
    expect(score?.change).toBe('improved');
  });
});

describe('pricing', () => {
  it('finds exact and snapshot matches', () => {
    expect(lookupPrice('openai', 'gpt-4o').key).toBe('openai:gpt-4o');
    expect(lookupPrice('openai', 'gpt-4o-2024-08-06').key).toBe('openai:gpt-4o');
    expect(lookupPrice('anthropic', 'claude-opus-5').price?.input).toBe(5);
  });

  it('prefers project overrides', () => {
    const overrides = {
      'openai:gpt-4o': { input: 1, output: 2, asOf: '2026-01-01', source: 'contract' },
    };
    expect(
      estimateCost('openai', 'gpt-4o', { inputTokens: 1_000_000, outputTokens: 0 }, overrides).usd,
    ).toBe(1);
  });

  it('computes cost including cache tokens', () => {
    const cost = estimateCost('anthropic', 'claude-sonnet-5', {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 10_000,
    });
    // 1000*2 + 500*10 + 10000*0.2 = 9000 per million
    expect(cost.usd).toBeCloseTo(0.009);
    expect(cost.asOf).toBe('2026-06-24');
  });

  it('returns null for unknown models and zero for local models', () => {
    expect(estimateCost('acme', 'mystery', { inputTokens: 10, outputTokens: 10 }).usd).toBeNull();
    expect(estimateCost('local', 'extractive', { inputTokens: 10, outputTokens: 10 }).usd).toBe(0);
  });
});

describe('format', () => {
  it('formats durations, percents, money and deltas', () => {
    expect(formatDuration(412.4)).toBe('412 ms');
    expect(formatDuration(1840)).toBe('1.84 s');
    expect(formatDuration(123_000)).toBe('2m 03s');
    expect(formatPercent(0.9421)).toBe('94.2%');
    expect(formatUsd(0.0032)).toBe('$0.0032');
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatDelta(0.942, 0.951, 'ratio')).toBe('+0.9 pp');
    expect(formatDelta(0.917, 0.873, 'score')).toBe('−0.044');
    expect(formatDelta(1800, 2100, 'ms')).toBe('+16.7%');
    expect(formatDelta(null, 1, 'ms')).toBe('—');
  });
});
