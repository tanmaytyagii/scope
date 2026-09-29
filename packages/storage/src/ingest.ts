/**
 * Trace ingestion: one transaction per call, idempotent per id (re-sent traces are ignored),
 * with denormalized columns for listing and aggregation computed once, at write time.
 */
import {
  type EvaluationRecord,
  type JsonObject,
  rollupSpans,
  type SpanRecord,
  type TraceBundle,
} from '@scope-ai/core';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from './schema.ts';
import { mapSpan } from './traces.ts';
import { chunk, preview, writeJson, writeJsonOrNull } from './util.ts';

/** Rows per multi-row INSERT; keeps parameter counts within SQLite and PostgreSQL limits. */
const SPAN_BATCH = 400;

export function summarizeEvalStatus(
  evaluations: readonly Pick<EvaluationRecord, 'status'>[],
): 'passed' | 'failed' | 'errored' | null {
  const judged = evaluations.filter((e) => e.status !== 'skipped');
  if (judged.length === 0) return null;
  if (judged.some((e) => e.status === 'error')) return 'errored';
  if (judged.some((e) => e.status === 'failed')) return 'failed';
  return 'passed';
}

function evaluationSubtree(spans: readonly SpanRecord[]): Set<string> {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const inEval = new Set<string>();
  for (const span of spans) {
    let current: SpanRecord | undefined = span;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.kind === 'evaluation') {
        inEval.add(span.id);
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return inEval;
}

export async function ingestBundles(
  db: Kysely<Database>,
  projectId: string,
  bundles: readonly TraceBundle[],
): Promise<{ traces: number; spans: number; evaluations: number; rejected: number }> {
  if (bundles.length === 0) return { traces: 0, spans: 0, evaluations: 0, rejected: 0 };
  const now = Date.now();
  let spanCount = 0;
  let evalCount = 0;
  let accepted: readonly TraceBundle[] = bundles;
  await db.transaction().execute(async (trx) => {
    // A trace id that already belongs to another project must never receive this project's data.
    const foreign = new Set<string>();
    for (const ids of chunk(
      bundles.map((b) => b.trace.id),
      500,
    )) {
      const rows = await trx
        .selectFrom('traces')
        .select(['id', 'project_id'])
        .where('id', 'in', ids)
        .execute();
      for (const row of rows) if (row.project_id !== projectId) foreign.add(row.id);
    }
    accepted = bundles.filter((b) => !foreign.has(b.trace.id));
    if (accepted.length === 0) return;

    for (const traceChunk of chunk(accepted, 200)) {
      await trx
        .insertInto('traces')
        .values(
          traceChunk.map(({ trace, evaluations }) => {
            const inputPreview = preview(trace.input);
            const outputPreview = preview(trace.output);
            return {
              id: trace.id,
              project_id: projectId,
              run_id: trace.runId,
              case_id: trace.caseId,
              name: trace.name,
              status: trace.status,
              start_time: trace.startTime,
              end_time: trace.endTime,
              duration_ms: trace.durationMs,
              input: writeJsonOrNull(trace.input),
              output: writeJsonOrNull(trace.output),
              input_preview: inputPreview,
              output_preview: outputPreview,
              metadata: writeJson(trace.metadata),
              error: writeJsonOrNull(trace.error),
              input_tokens: trace.usage.inputTokens,
              output_tokens: trace.usage.outputTokens,
              total_tokens: trace.usage.totalTokens,
              tokens_estimated: trace.usage.estimated ? 1 : 0,
              cost_usd: trace.costUsd,
              span_count: trace.spanCount,
              llm_call_count: trace.llmCallCount,
              eval_status: summarizeEvalStatus(evaluations),
              eval_count: evaluations.length,
              search_text: [trace.name, trace.id, trace.caseId ?? '', inputPreview, outputPreview]
                .join(' ')
                .toLowerCase(),
              created_at: now,
            };
          }),
        )
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }

    // Spans and evaluations are attached to their bundle's trace, whatever ids they claim.
    const spanRows = accepted.flatMap(({ trace, spans }) => {
      const inEval = evaluationSubtree(spans);
      return spans.map((s) => ({
        trace_id: trace.id,
        id: s.id,
        project_id: projectId,
        parent_id: s.parentId,
        name: s.name,
        kind: s.kind,
        status: s.status,
        status_message: s.statusMessage,
        start_time: s.startTime,
        end_time: s.endTime,
        duration_ms: s.durationMs,
        input: writeJsonOrNull(s.input),
        output: writeJsonOrNull(s.output),
        attributes: writeJson(s.attributes),
        events: writeJson(s.events),
        error: writeJsonOrNull(s.error),
        provider: s.provider,
        model: s.model,
        input_tokens: s.inputTokens,
        output_tokens: s.outputTokens,
        cost_usd: s.costUsd,
        in_evaluation: inEval.has(s.id) ? 1 : 0,
      }));
    });
    spanCount = spanRows.length;
    for (const rows of chunk(spanRows, SPAN_BATCH)) {
      await trx
        .insertInto('spans')
        .values(rows)
        .onConflict((oc) => oc.columns(['trace_id', 'id']).doNothing())
        .execute();
    }

    const evalRows = accepted.flatMap(({ trace, evaluations }) =>
      evaluations.map((e) => ({
        id: e.id,
        project_id: projectId,
        trace_id: trace.id,
        run_id: e.runId,
        span_id: e.spanId,
        evaluator: e.evaluator,
        type: e.type,
        kind: e.kind,
        status: e.status,
        score: e.score,
        threshold: e.threshold,
        reason: e.reason,
        metadata: writeJson(e.metadata),
        duration_ms: e.durationMs,
        created_at: e.createdAt,
      })),
    );
    evalCount = evalRows.length;
    for (const rows of chunk(evalRows, SPAN_BATCH)) {
      await trx
        .insertInto('evaluations')
        .values(rows)
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }
  });
  return {
    traces: accepted.length,
    spans: spanCount,
    evaluations: evalCount,
    rejected: bundles.length - accepted.length,
  };
}

// ─── spans arriving over time ────────────────────────────────────────────────────────────────

export interface SpanBatch {
  traceId: string;
  spans: readonly SpanRecord[];
  /** Metadata for a trace this batch creates; an existing trace keeps its own. */
  metadata: JsonObject;
}

/**
 * Adds spans to traces that may already hold some. OpenTelemetry exporters send spans as they
 * end, so one trace arrives over several requests, children before their parent. Missing traces
 * are created, spans already stored are kept, and every touched trace is recomputed from all of
 * its stored spans: its root (name, status, timing, input, output, error), token and cost
 * rollups, and which spans belong to evaluations. A trace never stores more than
 * `maxSpansPerTrace` spans, however many requests it arrives in; the rest are counted as dropped.
 */
export async function ingestSpans(
  db: Kysely<Database>,
  projectId: string,
  batches: readonly SpanBatch[],
  maxSpansPerTrace: number,
): Promise<{ traces: number; spans: number; rejectedSpans: number; dropped: number }> {
  if (batches.length === 0) return { traces: 0, spans: 0, rejectedSpans: 0, dropped: 0 };
  const now = Date.now();
  let accepted: readonly SpanBatch[] = batches;
  let spanCount = 0;
  let dropped = 0;
  await db.transaction().execute(async (trx) => {
    const foreign = new Set<string>();
    for (const ids of chunk([...new Set(batches.map((b) => b.traceId))], 500)) {
      const rows = await trx
        .selectFrom('traces')
        .select(['id', 'project_id'])
        .where('id', 'in', ids)
        .execute();
      for (const row of rows) if (row.project_id !== projectId) foreign.add(row.id);
    }
    accepted = batches.filter((b) => !foreign.has(b.traceId));
    if (accepted.length === 0) return;

    for (const traceChunk of chunk(accepted, 200)) {
      await trx
        .insertInto('traces')
        .values(
          traceChunk.map((b) => ({
            id: b.traceId,
            project_id: projectId,
            run_id: null,
            case_id: null,
            name: b.spans[0]?.name ?? 'trace',
            status: 'ok',
            start_time: 0,
            end_time: 0,
            duration_ms: 0,
            input: null,
            output: null,
            input_preview: '',
            output_preview: '',
            metadata: writeJson(b.metadata),
            error: null,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            tokens_estimated: 0,
            cost_usd: null,
            span_count: 0,
            llm_call_count: 0,
            eval_status: null,
            eval_count: 0,
            search_text: '',
            created_at: now,
          })),
        )
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }

    // Room left in each trace, counting what earlier requests stored.
    const room = new Map<string, number>();
    for (const ids of chunk([...new Set(accepted.map((b) => b.traceId))], 500)) {
      const counts = await trx
        .selectFrom('spans')
        .select(['trace_id', (eb) => eb.fn.countAll().as('n')])
        .where('trace_id', 'in', ids)
        .groupBy('trace_id')
        .execute();
      for (const id of ids) room.set(id, maxSpansPerTrace);
      for (const c of counts) room.set(c.trace_id, Math.max(0, maxSpansPerTrace - Number(c.n)));
    }
    const kept = accepted.map((b) => {
      const left = room.get(b.traceId) ?? 0;
      const spans = b.spans.slice(0, left);
      dropped += b.spans.length - spans.length;
      room.set(b.traceId, left - spans.length);
      return { ...b, spans };
    });

    const rows = kept.flatMap((b) =>
      b.spans.map((s) => ({
        trace_id: b.traceId,
        id: s.id,
        project_id: projectId,
        parent_id: s.parentId,
        name: s.name,
        kind: s.kind,
        status: s.status,
        status_message: s.statusMessage,
        start_time: s.startTime,
        end_time: s.endTime,
        duration_ms: s.durationMs,
        input: writeJsonOrNull(s.input),
        output: writeJsonOrNull(s.output),
        attributes: writeJson(s.attributes),
        events: writeJson(s.events),
        error: writeJsonOrNull(s.error),
        provider: s.provider,
        model: s.model,
        input_tokens: s.inputTokens,
        output_tokens: s.outputTokens,
        cost_usd: s.costUsd,
        in_evaluation: 0,
      })),
    );
    spanCount = rows.length;
    for (const part of chunk(rows, SPAN_BATCH)) {
      await trx
        .insertInto('spans')
        .values(part)
        .onConflict((oc) => oc.columns(['trace_id', 'id']).doNothing())
        .execute();
    }
    await recomputeTraces(trx, projectId, [...new Set(accepted.map((b) => b.traceId))]);
  });
  const acceptedIds = new Set(accepted.map((b) => b.traceId));
  return {
    traces: acceptedIds.size,
    spans: spanCount,
    // Spans of traces that belong to another project.
    rejectedSpans: batches
      .filter((b) => !acceptedIds.has(b.traceId))
      .reduce((n, b) => n + b.spans.length, 0),
    dropped,
  };
}

/** The span a trace is named after: the earliest span without a parent, else the earliest orphan. */
function rootOf(spans: readonly SpanRecord[]): SpanRecord | undefined {
  const ids = new Set(spans.map((s) => s.id));
  const byStart = [...spans].sort((a, b) => a.startTime - b.startTime);
  return (
    byStart.find((s) => s.parentId === null) ??
    byStart.find((s) => s.parentId !== null && !ids.has(s.parentId))
  );
}

async function recomputeTraces(
  trx: Transaction<Database>,
  projectId: string,
  traceIds: readonly string[],
): Promise<void> {
  for (const ids of chunk(traceIds, 100)) {
    const rows = await trx
      .selectFrom('spans')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('trace_id', 'in', ids)
      .execute();
    const byTrace = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byTrace.get(row.trace_id) ?? [];
      list.push(row);
      byTrace.set(row.trace_id, list);
    }
    for (const [traceId, spanRows] of byTrace) {
      const spans = spanRows.map(mapSpan);
      const inEval = evaluationSubtree(spans);
      for (const row of spanRows) {
        const flag = inEval.has(row.id) ? 1 : 0;
        if (Number(row.in_evaluation) !== flag)
          await trx
            .updateTable('spans')
            .set({ in_evaluation: flag })
            .where('trace_id', '=', traceId)
            .where('id', '=', row.id)
            .execute();
      }
      const root = rootOf(spans);
      const start = Math.min(...spans.map((s) => s.startTime));
      const end = Math.max(...spans.map((s) => s.endTime));
      const rollup = rollupSpans(spans);
      const inputPreview = preview(root?.input ?? null);
      const outputPreview = preview(root?.output ?? null);
      const name = root?.name ?? 'trace';
      await trx
        .updateTable('traces')
        .set({
          name,
          status: root?.status ?? (spans.some((s) => s.status === 'error') ? 'error' : 'ok'),
          start_time: start,
          end_time: end,
          duration_ms: Math.round((end - start) * 1000) / 1000,
          input: writeJsonOrNull(root?.input ?? null),
          output: writeJsonOrNull(root?.output ?? null),
          input_preview: inputPreview,
          output_preview: outputPreview,
          error: writeJsonOrNull(root?.error ?? null),
          input_tokens: rollup.usage.inputTokens,
          output_tokens: rollup.usage.outputTokens,
          total_tokens: rollup.usage.totalTokens,
          tokens_estimated: rollup.usage.estimated ? 1 : 0,
          cost_usd: rollup.costUsd,
          span_count: spans.length,
          llm_call_count: rollup.llmCallCount,
          search_text: [name, traceId, inputPreview, outputPreview].join(' ').toLowerCase(),
        })
        .where('id', '=', traceId)
        .where('project_id', '=', projectId)
        .execute();
    }
  }
}
