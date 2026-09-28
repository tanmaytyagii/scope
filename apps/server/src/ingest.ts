/**
 * POST /api/v1/ingest — traces from SDKs.
 *
 * The request is validated as a whole (a malformed batch is a client bug, reported with the
 * failing fields), then every trace is prepared for storage:
 *
 * 1. spans and evaluations are grouped under the trace they name, which must be in the batch;
 * 2. spans beyond the per-trace limit are dropped (roots first, then earliest) and counted;
 * 3. the server's privacy policy is applied again — redaction, size bounds, and dropping
 *    content when capture is disabled — because not every client is our SDK;
 * 4. token, cost and count rollups are recomputed from the spans, as the SDK computes them.
 */
import {
  type Attributes,
  type AttributeValue,
  capture,
  ErrorCodes,
  type ErrorInfo,
  type EvaluationRecord,
  type JsonObject,
  type JsonValue,
  type PrivacyPolicy,
  redactText,
  rollupSpans,
  ScopeError,
  type SpanRecord,
  type TraceBundle,
} from '@scope-ai/core';
import {
  INGEST_PROTOCOL_VERSION,
  type IngestEvaluation,
  IngestRequest,
  type IngestResponse,
  type IngestSpan,
  type IngestTrace,
} from '@scope-ai/protocol';
import type { Project } from '@scope-ai/storage';
import { validationError } from './errors.ts';
import type { AppContext, Deps } from './types.ts';

const PROJECT_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface PreparedBatch {
  bundles: TraceBundle[];
  droppedSpans: number;
}

function badRequest(message: string, hint?: string): ScopeError {
  return new ScopeError(ErrorCodes.badRequest, message, { hint });
}

// ─── privacy ─────────────────────────────────────────────────────────────────────────────────

/** Content (inputs, outputs, evaluator evidence): redacted, bounded, or null when capture is off. */
function content(value: JsonValue | null, policy: PrivacyPolicy): JsonValue | null {
  return value === null ? null : capture(value, policy).value;
}

/** Structure (metadata, attributes, messages): always kept, always redacted and bounded. */
function structure(value: JsonValue, policy: PrivacyPolicy): JsonValue {
  return capture(value, { ...policy, captureContent: true }).value ?? null;
}

function redact(text: string, policy: PrivacyPolicy): string {
  return redactText(text, policy).text;
}

function redactAttributes(attributes: Attributes, policy: PrivacyPolicy): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    let next: AttributeValue = value;
    if (typeof value === 'string') next = redact(value, policy);
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string'))
      next = (value as string[]).map((v) => redact(v, policy));
    out[key] = next;
  }
  return out;
}

function redactError(error: ErrorInfo | null, policy: PrivacyPolicy): ErrorInfo | null {
  if (!error) return null;
  const out: ErrorInfo = { type: error.type, message: redact(error.message, policy) };
  if (error.code) out.code = error.code;
  if (error.hint) out.hint = redact(error.hint, policy);
  if (error.stack) out.stack = redact(error.stack, policy);
  return out;
}

function asObject(value: JsonValue | null): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// ─── preparation ─────────────────────────────────────────────────────────────────────────────

function prepareSpan(span: IngestSpan, traceId: string, policy: PrivacyPolicy): SpanRecord {
  const attributes = redactAttributes(span.attributes, policy);
  if (!policy.captureContent && (span.input !== null || span.output !== null))
    attributes['scope.content.omitted'] = true;
  return {
    traceId,
    id: span.id,
    parentId: span.parentId,
    name: span.name,
    kind: span.kind,
    status: span.status,
    statusMessage: span.statusMessage === null ? null : redact(span.statusMessage, policy),
    startTime: span.startTime,
    endTime: span.endTime,
    durationMs: span.durationMs,
    input: content(span.input, policy),
    output: content(span.output, policy),
    attributes,
    events: span.events.map((e) => ({
      name: e.name,
      time: e.time,
      ...(e.attributes ? { attributes: redactAttributes(e.attributes, policy) } : {}),
    })),
    error: redactError(span.error, policy),
    provider: span.provider,
    model: span.model,
    inputTokens: span.inputTokens,
    outputTokens: span.outputTokens,
    costUsd: span.costUsd,
  };
}

function prepareEvaluation(
  e: IngestEvaluation,
  traceId: string,
  policy: PrivacyPolicy,
): EvaluationRecord {
  return {
    id: e.id,
    traceId,
    runId: e.runId,
    spanId: e.spanId,
    evaluator: e.evaluator,
    type: e.type,
    kind: e.kind,
    status: e.status,
    score: e.score,
    threshold: e.threshold,
    reason: redact(e.reason, policy),
    // Evidence often quotes the output, so it follows the content policy.
    metadata: asObject(content(e.metadata, policy)),
    durationMs: e.durationMs,
    createdAt: e.createdAt,
  };
}

/** Keeps at most `limit` spans: root spans first, then the earliest. */
function limitSpans(spans: IngestSpan[], limit: number): { kept: IngestSpan[]; dropped: number } {
  if (spans.length <= limit) return { kept: spans, dropped: 0 };
  const ordered = [...spans].sort(
    (a, b) =>
      Number(a.parentId !== null) - Number(b.parentId !== null) || a.startTime - b.startTime,
  );
  return { kept: ordered.slice(0, limit), dropped: spans.length - limit };
}

function prepareTrace(
  trace: IngestTrace,
  spans: IngestSpan[],
  evaluations: IngestEvaluation[],
  policy: PrivacyPolicy,
  maxSpans: number,
): { bundle: TraceBundle; dropped: number } {
  const { kept, dropped } = limitSpans(spans, maxSpans);
  const spanRecords = kept.map((s) => prepareSpan(s, trace.id, policy));
  const rollup = rollupSpans(spanRecords);
  const metadata = asObject(structure(trace.metadata, policy));
  if (dropped > 0) {
    const previous = metadata['scope.dropped_spans'];
    metadata['scope.dropped_spans'] = (typeof previous === 'number' ? previous : 0) + dropped;
  }
  return {
    bundle: {
      trace: {
        id: trace.id,
        runId: trace.runId,
        caseId: trace.caseId,
        name: trace.name,
        status: trace.status,
        startTime: trace.startTime,
        endTime: trace.endTime,
        durationMs: trace.durationMs,
        input: content(trace.input, policy),
        output: content(trace.output, policy),
        metadata,
        error: redactError(trace.error, policy),
        usage: rollup.usage,
        costUsd: rollup.costUsd,
        spanCount: spanRecords.length,
        llmCallCount: rollup.llmCallCount,
      },
      spans: spanRecords,
      evaluations: evaluations.map((e) => prepareEvaluation(e, trace.id, policy)),
    },
    dropped,
  };
}

/** Groups and prepares a validated request. Throws a 400 for batches that do not hang together. */
export function prepareBatch(
  request: IngestRequest,
  policy: PrivacyPolicy,
  maxSpansPerTrace: number,
): PreparedBatch {
  const traceIndex = new Map<string, number>();
  request.traces.forEach((t, i) => {
    if (traceIndex.has(t.id))
      throw badRequest(`traces[${i}].id: trace ${t.id} appears more than once in the request`);
    traceIndex.set(t.id, i);
  });
  const spansByTrace = new Map<string, IngestSpan[]>();
  request.spans.forEach((s, i) => {
    if (!traceIndex.has(s.traceId)) {
      throw badRequest(
        `spans[${i}].traceId: trace ${s.traceId} is not in this request`,
        'Send each span in the same request as its trace.',
      );
    }
    const list = spansByTrace.get(s.traceId) ?? [];
    list.push(s);
    spansByTrace.set(s.traceId, list);
  });
  const evalsByTrace = new Map<string, IngestEvaluation[]>();
  request.evaluations.forEach((e, i) => {
    if (!traceIndex.has(e.traceId)) {
      throw badRequest(
        `evaluations[${i}].traceId: trace ${e.traceId} is not in this request`,
        'Send each evaluation in the same request as its trace.',
      );
    }
    const list = evalsByTrace.get(e.traceId) ?? [];
    list.push(e);
    evalsByTrace.set(e.traceId, list);
  });

  let droppedSpans = 0;
  const bundles = request.traces.map((trace) => {
    const prepared = prepareTrace(
      trace,
      spansByTrace.get(trace.id) ?? [],
      evalsByTrace.get(trace.id) ?? [],
      policy,
      maxSpansPerTrace,
    );
    droppedSpans += prepared.dropped;
    return prepared.bundle;
  });
  return { bundles, droppedSpans };
}

// ─── handler ─────────────────────────────────────────────────────────────────────────────────

async function readBody(c: AppContext): Promise<unknown> {
  const type = c.req.header('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    throw new ScopeError(
      ErrorCodes.unsupportedMediaType,
      'The request body must be application/json',
      { hint: 'Send Content-Type: application/json.' },
    );
  }
  const text = await c.req.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw badRequest(`The request body is not valid JSON: ${(error as Error).message}`);
  }
}

async function targetProject(
  c: AppContext,
  deps: Deps,
  named: string | undefined,
): Promise<Project> {
  const project = c.get('project');
  if (!named || named === project.slug) return project;
  if (deps.auth.mode === 'api-key') {
    throw new ScopeError(
      ErrorCodes.forbidden,
      `This API key belongs to project "${project.slug}", but the request names project "${named}"`,
      { hint: 'Unset SCOPE_PROJECT, or use a key created for that project.' },
    );
  }
  if (!PROJECT_SLUG.test(named)) {
    throw badRequest(
      `project: "${named}" is not a valid project name`,
      'Use lowercase letters, digits, ".", "_" and "-" (at most 64 characters).',
    );
  }
  return deps.store.ensureProject(named);
}

/** Checks that run ids named by traces and evaluations exist in the project. */
async function checkRuns(deps: Deps, project: Project, bundles: TraceBundle[]): Promise<void> {
  const ids = new Set<string>();
  for (const b of bundles) {
    if (b.trace.runId) ids.add(b.trace.runId);
    for (const e of b.evaluations) if (e.runId) ids.add(e.runId);
  }
  for (const id of ids) {
    const run = await deps.store.getRun(project.id, id);
    if (run?.id !== id) {
      throw badRequest(
        `runId: run ${id} does not exist in project "${project.slug}"`,
        'Traces recorded outside a SCOPE run should have runId null.',
      );
    }
  }
}

export async function handleIngest(c: AppContext, deps: Deps): Promise<IngestResponse> {
  const version = c.req.header('scope-protocol');
  if (version !== undefined && version !== String(INGEST_PROTOCOL_VERSION)) {
    throw badRequest(
      `Unsupported scope-protocol version "${version}"; this server speaks version ${INGEST_PROTOCOL_VERSION}`,
      'Upgrade the SCOPE server, or use an SDK release that matches it.',
    );
  }
  const body = await readBody(c);
  const parsed = IngestRequest.safeParse(body);
  if (!parsed.success) {
    deps.metrics.ingestRejected.inc({ reason: 'validation' });
    throw validationError('body', parsed.error.issues);
  }
  const project = await targetProject(c, deps, parsed.data.project);
  const { bundles, droppedSpans } = prepareBatch(parsed.data, deps.privacy, deps.maxSpansPerTrace);
  await checkRuns(deps, project, bundles);
  const result = await deps.store.ingest(project.id, bundles);

  deps.metrics.ingestedTraces.inc({}, result.traces);
  deps.metrics.ingestedSpans.inc({}, result.spans);
  deps.metrics.ingestedEvaluations.inc({}, result.evaluations);
  if (result.rejected)
    deps.metrics.ingestRejected.inc({ reason: 'foreign_trace' }, result.rejected);
  if (droppedSpans) deps.metrics.droppedSpans.inc({}, droppedSpans);
  deps.logger.debug('ingested traces', {
    project: project.slug,
    traces: result.traces,
    spans: result.spans,
    evaluations: result.evaluations,
    rejected: result.rejected,
    droppedSpans,
  });
  return {
    project: project.slug,
    accepted: { traces: result.traces, spans: result.spans, evaluations: result.evaluations },
    rejectedTraces: result.rejected,
    droppedSpans,
  };
}
