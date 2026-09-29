/**
 * Explicit mappings from storage records to API resources. Nothing is passed through
 * unmapped, so a new database column never leaks into the API by accident.
 */
import {
  BUILTIN_PRICES,
  type ConfigDiff,
  type EvaluationRecord,
  type JsonValue,
  lookupPrice,
  type ModelPrice,
  type PriceTable,
  type SpanRecord,
} from '@scope-ai/core';
import type * as api from '@scope-ai/protocol';
import type {
  ApiKey,
  EvaluationListItem,
  EvaluatorHealth,
  ModelUsage,
  Overview,
  Run,
  RunCase,
  TraceDetail,
  TraceSummary,
  WorkflowDetail,
  WorkflowSummary,
} from '@scope-ai/storage';

export const iso = (ms: number): string => new Date(ms).toISOString();
export const isoOrNull = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : iso(ms);

export function runDto(run: Run): api.Run {
  return {
    id: run.id,
    number: run.number,
    workflow: run.workflowName,
    workflowVersionId: run.workflowVersionId,
    variant: run.variant,
    status: run.status,
    gateStatus: run.gateStatus,
    trigger: run.trigger,
    params: run.params,
    dataset: run.dataset,
    git: run.git,
    baseline: run.baseline ? { ...run.baseline, runId: run.baseline.runId ?? null } : null,
    caseCount: run.caseCount,
    passRate: run.passRate,
    summary: run.summary,
    gates: run.gates,
    error: run.error,
    startedAt: iso(run.startedAt),
    endedAt: isoOrNull(run.endedAt),
    durationMs: run.durationMs,
    manifest: run.manifest,
  };
}

export function runCaseDto(c: RunCase): api.RunCase {
  return {
    caseId: c.caseId,
    traceId: c.traceId,
    status: c.status,
    outcome: c.outcome,
    durationMs: c.durationMs,
    totalTokens: c.totalTokens,
    costUsd: c.costUsd,
    inputPreview: c.inputPreview,
    outputPreview: c.outputPreview,
    error: c.error,
    evaluations: c.evaluations.map((e) => ({
      evaluator: e.evaluator,
      type: e.type,
      kind: e.kind,
      status: e.status,
      score: e.score,
      reason: e.reason,
    })),
  };
}

export function traceSummaryDto(t: TraceSummary): api.TraceSummary {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    caseId: t.caseId,
    run: t.runId && t.runNumber !== null ? { id: t.runId, number: t.runNumber } : null,
    startTime: iso(t.startTime),
    durationMs: t.durationMs,
    inputPreview: t.inputPreview,
    outputPreview: t.outputPreview,
    usage: {
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      totalTokens: t.totalTokens,
      estimated: t.tokensEstimated,
    },
    costUsd: t.costUsd,
    spanCount: t.spanCount,
    llmCallCount: t.llmCallCount,
    evalStatus: t.evalStatus,
    evalCount: t.evalCount,
    error: t.error,
  };
}

export function spanDto(span: SpanRecord, origin: number, contentOmitted = false): api.Span {
  return {
    id: span.id,
    parentId: span.parentId,
    name: span.name,
    kind: span.kind,
    status: span.status,
    statusMessage: span.statusMessage,
    startTime: iso(span.startTime),
    offsetMs: span.startTime - origin,
    durationMs: span.durationMs,
    input: span.input,
    output: span.output,
    attributes: span.attributes,
    events: span.events.map((e) => ({
      name: e.name,
      time: iso(e.time),
      offsetMs: e.time - origin,
      attributes: e.attributes ?? {},
    })),
    error: span.error,
    provider: span.provider,
    model: span.model,
    inputTokens: span.inputTokens,
    outputTokens: span.outputTokens,
    costUsd: span.costUsd,
    contentOmitted,
  };
}

/** A configuration diff as the API shows it; comparisons stored before SCOPE 0.4 lack files. */
export function configDiffDto(diff: ConfigDiff): api.ConfigDiff {
  return {
    params: diff.params,
    workflowChanged: diff.workflowChanged,
    datasetChanged: diff.datasetChanged,
    paramsKnown: diff.paramsKnown,
    // Comparisons stored before SCOPE 0.4 have neither.
    files: (diff.files as string[] | undefined) ?? [],
    scope: (diff.scope as ConfigDiff['scope'] | undefined) ?? null,
  };
}

export function evaluationDto(e: EvaluationRecord): api.Evaluation {
  return {
    id: e.id,
    spanId: e.spanId,
    evaluator: e.evaluator,
    type: e.type,
    kind: e.kind,
    status: e.status,
    score: e.score,
    threshold: e.threshold,
    reason: e.reason,
    metadata: e.metadata,
    durationMs: e.durationMs,
    createdAt: iso(e.createdAt),
  };
}

export function traceDetailDto(detail: TraceDetail): api.TraceDetail {
  const t = detail.trace;
  // Offsets are measured from the earliest recorded time, so every span has offset >= 0.
  const origin = detail.spans.reduce((min, s) => Math.min(min, s.startTime), t.startTime);
  const omitted = new Set(detail.omittedContent);
  return {
    trace: {
      id: t.id,
      name: t.name,
      status: t.status,
      caseId: t.caseId,
      startTime: iso(t.startTime),
      endTime: iso(t.endTime),
      durationMs: t.durationMs,
      input: t.input,
      output: t.output,
      metadata: t.metadata,
      error: t.error,
      usage: t.usage,
      costUsd: t.costUsd,
      spanCount: t.spanCount,
      llmCallCount: t.llmCallCount,
      evalStatus: t.evalStatus,
    },
    run: detail.run
      ? {
          id: detail.run.id,
          number: detail.run.number,
          workflow: detail.run.workflowName,
          variant: detail.run.variant,
        }
      : null,
    failingCases: detail.failingCases,
    spans: detail.spans.map((s) => spanDto(s, origin, omitted.has(s.id))),
    evaluations: detail.evaluations.map(evaluationDto),
  };
}

export function evaluatorHealthDto(e: EvaluatorHealth): api.EvaluatorHealth {
  return {
    evaluator: e.evaluator,
    type: e.type,
    kind: e.kind,
    total: e.total,
    passed: e.passed,
    failed: e.failed,
    errored: e.errored,
    skipped: e.skipped,
    passRate: e.passRate,
    meanScore: e.meanScore,
    lastSeenAt: iso(e.lastSeenAt),
    trend: e.trend.map((t) => ({
      runNumber: t.runNumber,
      passRate: t.passRate,
      meanScore: t.meanScore,
    })),
  };
}

export function evaluationListItemDto(e: EvaluationListItem): api.EvaluationListItem {
  return {
    id: e.id,
    traceId: e.traceId,
    traceName: e.traceName,
    caseId: e.caseId,
    run: e.runId && e.runNumber !== null ? { id: e.runId, number: e.runNumber } : null,
    evaluator: e.evaluator,
    type: e.type,
    kind: e.kind,
    status: e.status,
    score: e.score,
    threshold: e.threshold,
    reason: e.reason,
    outputPreview: e.outputPreview,
    createdAt: iso(e.createdAt),
  };
}

export function overviewDto(o: Overview): api.Overview {
  return {
    window: { since: iso(o.window.since), until: iso(o.window.until), bucketMs: o.window.bucketMs },
    traces: { ...o.traces },
    evaluations: { ...o.evaluations },
    runs: { ...o.runs },
    series: o.series.map((s) => ({
      start: iso(s.start),
      ok: s.ok,
      error: s.error,
      p50Ms: s.p50Ms,
      p95Ms: s.p95Ms,
      costUsd: s.costUsd,
    })),
    runTrend: o.runTrend.map((r) => ({
      id: r.id,
      number: r.number,
      workflow: r.workflowName,
      variant: r.variant,
      startedAt: iso(r.startedAt),
      passRate: r.passRate,
      gateStatus: r.gateStatus,
    })),
    recentFailures: o.recentFailures.map(traceSummaryDto),
    failingEvaluators: o.failingEvaluators.map((e) => ({
      evaluator: e.evaluator,
      kind: e.kind,
      total: e.total,
      failed: e.failed,
      passRate: e.passRate,
    })),
  };
}

export function priceEntryDto(
  model: string,
  price: ModelPrice,
  origin: 'builtin' | 'project',
): api.ModelPriceEntry {
  return {
    model,
    input: price.input,
    output: price.output,
    cacheRead: price.cacheRead ?? null,
    cacheWrite: price.cacheWrite ?? null,
    asOf: price.asOf,
    source: price.source,
    origin,
  };
}

/** The effective price table: project overrides first, then built-in entries they don't replace. */
export function pricingDto(overrides: PriceTable): api.ModelPriceEntry[] {
  const entries = Object.entries(overrides).map(([model, p]) => priceEntryDto(model, p, 'project'));
  for (const [model, p] of Object.entries(BUILTIN_PRICES))
    if (!overrides[model]) entries.push(priceEntryDto(model, p, 'builtin'));
  return entries;
}

export function modelUsageDto(m: ModelUsage, overrides: PriceTable): api.ModelUsage {
  const lookup = m.provider ? lookupPrice(m.provider, m.model, overrides) : null;
  return {
    provider: m.provider,
    model: m.model,
    usage: m.usage,
    calls: m.calls,
    errors: m.errors,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    costUsd: m.costUsd,
    unpricedCalls: m.unpricedCalls,
    p50Ms: m.p50Ms,
    p95Ms: m.p95Ms,
    lastUsedAt: iso(m.lastUsedAt),
    price:
      lookup?.price && lookup.key
        ? priceEntryDto(lookup.key, lookup.price, overrides[lookup.key] ? 'project' : 'builtin')
        : null,
    local: lookup?.free ?? false,
  };
}

export function workflowSummaryDto(w: WorkflowSummary): api.WorkflowSummary {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    versionCount: w.versionCount,
    runCount: w.runCount,
    updatedAt: iso(w.updatedAt),
    lastRun: w.lastRun
      ? {
          id: w.lastRun.id,
          number: w.lastRun.number,
          variant: w.lastRun.variant,
          status: w.lastRun.status,
          gateStatus: w.lastRun.gateStatus,
          passRate: w.lastRun.passRate,
          startedAt: iso(w.lastRun.startedAt),
        }
      : null,
  };
}

export function workflowDetailDto(w: WorkflowDetail, variants: string[]): api.WorkflowDetail {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    updatedAt: iso(w.updatedAt),
    versions: w.versions.map((v) => ({
      id: v.id,
      hash: v.hash,
      path: v.path,
      createdAt: iso(v.createdAt),
    })),
    latest: w.latest
      ? {
          id: w.latest.id,
          hash: w.latest.hash,
          path: w.latest.path,
          source: w.latest.source,
          // Stored as the validated workflow object, which is plain JSON.
          definition: (w.latest.definition ?? null) as JsonValue,
        }
      : null,
    variants,
  };
}

export function apiKeyDto(k: ApiKey): api.ApiKey {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    createdAt: iso(k.createdAt),
    lastUsedAt: isoOrNull(k.lastUsedAt),
    revokedAt: isoOrNull(k.revokedAt),
  };
}
