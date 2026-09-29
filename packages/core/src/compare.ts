/**
 * Comparison of two runs (or a run and a baseline): metric deltas and per-case changes.
 */
import { type JsonObject, type JsonValue, stableStringify } from './json.ts';
import { describeMetric, listMetrics, type MetricDescriptor, readMetric } from './metrics.ts';
import {
  type CaseOutcome,
  type CaseResult,
  caseOutcome,
  type EvaluationStatus,
  type GitInfo,
} from './model.ts';
import type { RunSummary } from './summary.ts';

/** The per-case facts retained for comparison and stored in baseline files. */
export interface CaseSnapshot {
  outcome: CaseOutcome;
  durationMs: number;
  traceId: string | null;
  evaluators: Record<string, { status: EvaluationStatus; score: number | null }>;
}

export function snapshotCase(result: CaseResult): CaseSnapshot {
  const evaluators: CaseSnapshot['evaluators'] = {};
  for (const e of result.evaluations)
    evaluators[e.evaluator] = { status: e.status, score: e.score };
  return {
    outcome: caseOutcome(result),
    durationMs: result.durationMs,
    traceId: result.traceId,
    evaluators,
  };
}

export type ChangeDirection = 'improved' | 'regressed' | 'unchanged' | 'n/a';

export interface MetricDelta extends MetricDescriptor {
  base: number | null;
  head: number | null;
  delta: number | null;
  /** Relative change in percent, when the base is non-zero. */
  relativePct: number | null;
  change: ChangeDirection;
}

/** Changes smaller than these are reported as unchanged (noise). */
const ABSOLUTE_TOLERANCE: Partial<Record<MetricDescriptor['unit'], number>> = {
  ratio: 0.0005,
  score: 0.0005,
};
const RELATIVE_TOLERANCE_PCT: Partial<Record<MetricDescriptor['unit'], number>> = {
  ms: 3,
  tokens: 1,
  usd: 1,
};

/** Latency differences below this many milliseconds are timer noise, not change. */
const LATENCY_NOISE_MS = 5;

export function classifyChange(
  descriptor: MetricDescriptor,
  base: number | null,
  head: number | null,
): ChangeDirection {
  if (base === null || head === null) return 'n/a';
  const delta = head - base;
  if (descriptor.unit === 'ms' && Math.abs(delta) < LATENCY_NOISE_MS) return 'unchanged';
  const abs = ABSOLUTE_TOLERANCE[descriptor.unit];
  if (abs !== undefined && Math.abs(delta) < abs) return 'unchanged';
  const rel = RELATIVE_TOLERANCE_PCT[descriptor.unit];
  if (rel !== undefined) {
    if (base === 0 && head === 0) return 'unchanged';
    if (base !== 0 && (Math.abs(delta) / Math.abs(base)) * 100 < rel) return 'unchanged';
  }
  if (delta === 0) return 'unchanged';
  const better = descriptor.direction === 'higher' ? delta > 0 : delta < 0;
  return better ? 'improved' : 'regressed';
}

export function compareSummaries(base: RunSummary, head: RunSummary): MetricDelta[] {
  const ids: string[] = [];
  for (const m of [...listMetrics(base), ...listMetrics(head)])
    if (!ids.includes(m.id)) ids.push(m.id);
  const out: MetricDelta[] = [];
  for (const id of ids) {
    const descriptor = describeMetric(id);
    if (!descriptor) continue;
    const b = readMetric(base, id);
    const h = readMetric(head, id);
    out.push({
      ...descriptor,
      base: b,
      head: h,
      delta: b === null || h === null ? null : h - b,
      relativePct: b === null || h === null || b === 0 ? null : ((h - b) / Math.abs(b)) * 100,
      change: classifyChange(descriptor, b, h),
    });
  }
  return out;
}

/**
 * The metrics worth showing in a comparison: pass rate, one row per evaluator (pass rate for
 * deterministic evaluators, whose scores are just pass/fail; mean score otherwise), p95 latency,
 * tokens and cost.
 */
export function headlineMetrics<T extends { id: string }>(
  metrics: readonly T[],
  evaluators: ReadonlyArray<{ name: string; kind: string }>,
): T[] {
  const kinds = new Map(evaluators.map((e) => [e.name, e.kind]));
  const fixed = ['pass_rate', 'latency.p95_ms', 'tokens.total', 'cost.total_usd'];
  const order = [
    'pass_rate',
    ...evaluators.map((e) => `evaluator.${e.name}.`),
    'latency.p95_ms',
    'tokens.total',
    'cost.total_usd',
  ];
  const keep = metrics.filter((m) => {
    if (fixed.includes(m.id)) return true;
    const match = /^evaluator\.(.+)\.(pass_rate|mean_score)$/.exec(m.id);
    if (!match) return false;
    const kind = kinds.get(match[1] as string);
    return kind === 'deterministic' ? match[2] === 'pass_rate' : match[2] === 'mean_score';
  });
  const matches = (entry: string, id: string) =>
    entry.endsWith('.') ? id.startsWith(entry) : id === entry;
  const rank = (id: string) => {
    const i = order.findIndex((entry) => matches(entry, id));
    return i === -1 ? order.length : i;
  };
  return keep.sort((a, b) => rank(a.id) - rank(b.id));
}

export type CaseChangeKind = 'regressed' | 'fixed' | 'changed' | 'unchanged' | 'added' | 'removed';

export interface EvaluatorChange {
  evaluator: string;
  base: { status: EvaluationStatus; score: number | null } | null;
  head: { status: EvaluationStatus; score: number | null } | null;
  change: ChangeDirection;
}

export interface CaseChange {
  caseId: string;
  kind: CaseChangeKind;
  base: CaseSnapshot | null;
  head: CaseSnapshot | null;
  evaluators: EvaluatorChange[];
}

const OUTCOME_RANK: Record<CaseOutcome, number> = { errored: 0, failed: 1, passed: 2 };
const STATUS_RANK: Record<EvaluationStatus, number> = {
  error: 0,
  failed: 1,
  skipped: 1.5,
  passed: 2,
};
const SCORE_TOLERANCE = 0.0005;

function compareEvaluator(
  name: string,
  base: CaseSnapshot['evaluators'][string] | undefined,
  head: CaseSnapshot['evaluators'][string] | undefined,
): EvaluatorChange {
  const change: EvaluatorChange = {
    evaluator: name,
    base: base ?? null,
    head: head ?? null,
    change: 'n/a',
  };
  if (!base || !head) return change;
  const rankDelta = STATUS_RANK[head.status] - STATUS_RANK[base.status];
  if (rankDelta !== 0) {
    change.change = rankDelta > 0 ? 'improved' : 'regressed';
  } else if (
    base.score !== null &&
    head.score !== null &&
    Math.abs(head.score - base.score) >= SCORE_TOLERANCE
  ) {
    change.change = head.score > base.score ? 'improved' : 'regressed';
  } else {
    change.change = 'unchanged';
  }
  return change;
}

export function compareCases(
  base: Readonly<Record<string, CaseSnapshot>>,
  head: Readonly<Record<string, CaseSnapshot>>,
): CaseChange[] {
  const ids = [...new Set([...Object.keys(base), ...Object.keys(head)])];
  const changes: CaseChange[] = [];
  for (const caseId of ids) {
    const b = base[caseId] ?? null;
    const h = head[caseId] ?? null;
    const evaluatorNames = [
      ...new Set([...Object.keys(b?.evaluators ?? {}), ...Object.keys(h?.evaluators ?? {})]),
    ];
    const evaluators = evaluatorNames.map((name) =>
      compareEvaluator(name, b?.evaluators[name], h?.evaluators[name]),
    );
    let kind: CaseChangeKind;
    if (!b) kind = 'added';
    else if (!h) kind = 'removed';
    else {
      const rankDelta = OUTCOME_RANK[h.outcome] - OUTCOME_RANK[b.outcome];
      if (rankDelta < 0) kind = 'regressed';
      else if (rankDelta > 0) kind = 'fixed';
      else if (evaluators.some((e) => e.change === 'improved' || e.change === 'regressed'))
        kind = 'changed';
      else kind = 'unchanged';
    }
    changes.push({ caseId, kind, base: b, head: h, evaluators });
  }
  const order: Record<CaseChangeKind, number> = {
    regressed: 0,
    fixed: 1,
    changed: 2,
    added: 3,
    removed: 4,
    unchanged: 5,
  };
  return changes.sort((x, y) => order[x.kind] - order[y.kind] || x.caseId.localeCompare(y.caseId));
}

export interface ComparisonSide {
  summary: RunSummary;
  cases: Readonly<Record<string, CaseSnapshot>>;
}

export interface Comparison {
  metrics: MetricDelta[];
  cases: CaseChange[];
  counts: Record<CaseChangeKind, number>;
  /** Configuration differences, when the caller knows both sides' configuration. */
  config?: ConfigDiff;
}

export function compareRuns(base: ComparisonSide, head: ComparisonSide): Comparison {
  const cases = compareCases(base.cases, head.cases);
  const counts: Record<CaseChangeKind, number> = {
    regressed: 0,
    fixed: 0,
    changed: 0,
    unchanged: 0,
    added: 0,
    removed: 0,
  };
  for (const c of cases) counts[c.kind]++;
  return { metrics: compareSummaries(base.summary, head.summary), cases, counts };
}

// ─── Several runs side by side ───────────────────────────────────────────────────────────────

/** Runs compared side by side at most (a table stays readable up to here). */
export const MAX_COMPARED_RUNS = 4;

export interface MetricRow extends MetricDescriptor {
  /** One value per run, in the order the runs were given. */
  values: Array<number | null>;
  /**
   * Runs with the best value. Values within noise tolerance of the best share it; empty when every
   * known value is within tolerance (nothing to choose between) or fewer than two are known.
   */
  best: number[];
}

export interface CaseRow {
  caseId: string;
  /** One entry per run; null when the case is not in that run. */
  outcomes: Array<CaseOutcome | null>;
  traceIds: Array<string | null>;
}

export interface RunMatrix {
  metrics: MetricRow[];
  /** Cases whose outcome is not the same in every run, by case id. */
  cases: CaseRow[];
  caseCount: number;
}

export function compareMany(sides: readonly ComparisonSide[]): RunMatrix {
  const ids: string[] = [];
  for (const side of sides)
    for (const m of listMetrics(side.summary)) if (!ids.includes(m.id)) ids.push(m.id);
  const metrics: MetricRow[] = [];
  for (const id of ids) {
    const descriptor = describeMetric(id);
    if (!descriptor) continue;
    const values = sides.map((s) => readMetric(s.summary, id));
    const known = values.filter((v): v is number => v !== null);
    let best: number[] = [];
    if (known.length >= 2) {
      const top = descriptor.direction === 'higher' ? Math.max(...known) : Math.min(...known);
      // A value is as good as the best when the change from it to the best is noise.
      const tied = values.map(
        (v) => v !== null && classifyChange(descriptor, v, top) === 'unchanged',
      );
      if (tied.some((t, i) => !t && values[i] !== null))
        best = tied.flatMap((t, i) => (t ? [i] : []));
    }
    metrics.push({ ...descriptor, values, best });
  }

  const caseIds = [...new Set(sides.flatMap((s) => Object.keys(s.cases)))].sort();
  const cases: CaseRow[] = [];
  for (const caseId of caseIds) {
    const snapshots = sides.map((s) => s.cases[caseId] ?? null);
    const outcomes = snapshots.map((c) => c?.outcome ?? null);
    if (outcomes.every((o) => o === outcomes[0])) continue;
    cases.push({ caseId, outcomes, traceIds: snapshots.map((c) => c?.traceId ?? null) });
  }
  return { metrics, cases, caseCount: caseIds.length };
}

// ─── Baselines ───────────────────────────────────────────────────────────────────────────────

export const BASELINE_SCHEMA = 'scope.baseline/v1';

/** A committed reference point for regression gates (docs/decisions/0006). */
export interface Baseline {
  schema: typeof BASELINE_SCHEMA;
  workflow: string;
  variant: string | null;
  createdAt: string;
  source: {
    runId: string;
    runNumber: number;
    git: GitInfo | null;
  };
  dataset: { name: string; caseCount: number; hash: string } | null;
  /**
   * The configuration the source run used (added in SCOPE 0.3; absent in older files), so a
   * comparison can say what changed besides the results.
   */
  config?: BaselineConfig;
  summary: RunSummary;
  cases: Record<string, CaseSnapshot>;
}

export interface BaselineConfig {
  /** Parameters after the variant was applied. */
  params: JsonObject;
  /** SHA-256 of the workflow file; identical files have identical hashes on any machine. */
  workflowHash: string | null;
  /** Fingerprints of the files the workflow names, by `<kind> <ref>` (SCOPE 0.4+). */
  files?: Record<string, string>;
  /** SCOPE version that made the run (0.4+). */
  scope?: string;
}

// ─── Configuration differences ───────────────────────────────────────────────────────────────

/** What a run was configured with, as far as comparisons need it. */
export interface ConfigSnapshot {
  params: JsonObject | null;
  /** Anything that identifies the workflow version (a file hash, or a stored version id). */
  workflow: string | null;
  datasetHash: string | null;
  /** Fingerprints of the files the workflow names, by `<kind> <ref>`; null when not recorded. */
  files?: Record<string, string> | null;
  scope?: string | null;
}

/** The key a manifest file is compared under: "corpus ../docs/*.md". */
export function fileKey(file: { kind: string; ref: string }): string {
  return `${file.kind} ${file.ref}`;
}

export interface ParamChange {
  key: string;
  /** Absent on one side: null. */
  base: JsonValue | null;
  head: JsonValue | null;
}

/** What differs in configuration between two runs, beyond their results. */
export interface ConfigDiff {
  /** Parameters with different values; empty when both sides are known and equal. */
  params: ParamChange[];
  /** Whether the workflow file changed; null when either side does not record it. */
  workflowChanged: boolean | null;
  /** Whether the dataset changed; null when either side does not record it. */
  datasetChanged: boolean | null;
  /** False when the base side predates configuration records (parameters unknown). */
  paramsKnown: boolean;
  /**
   * Files the workflow names (function modules, custom evaluators, retrieval corpora) whose
   * contents differ, or that only one side has, as `<kind> <ref>`. Empty when either side does
   * not record them. (Absent in comparisons stored before SCOPE 0.4.)
   */
  files: string[];
  /** The SCOPE versions, when both are known and differ. */
  scope: { base: string; head: string } | null;
}

export function compareConfig(base: ConfigSnapshot, head: ConfigSnapshot): ConfigDiff {
  const params: ParamChange[] = [];
  const paramsKnown = base.params !== null && head.params !== null;
  if (base.params && head.params) {
    const keys = [...new Set([...Object.keys(base.params), ...Object.keys(head.params)])].sort();
    for (const key of keys) {
      const b = base.params[key] ?? null;
      const h = head.params[key] ?? null;
      if (stableStringify(b) !== stableStringify(h)) params.push({ key, base: b, head: h });
    }
  }
  const differ = (a: string | null, b: string | null) =>
    a === null || b === null ? null : a !== b;
  const files: string[] = [];
  if (base.files && head.files) {
    const keys = [...new Set([...Object.keys(base.files), ...Object.keys(head.files)])].sort();
    for (const key of keys) if (base.files[key] !== head.files[key]) files.push(key);
  }
  const scope =
    base.scope && head.scope && base.scope !== head.scope
      ? { base: base.scope, head: head.scope }
      : null;
  return {
    params,
    workflowChanged: differ(base.workflow, head.workflow),
    datasetChanged: differ(base.datasetHash, head.datasetHash),
    paramsKnown,
    files,
    scope,
  };
}
