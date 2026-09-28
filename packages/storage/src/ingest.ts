/**
 * Trace ingestion: one transaction per call, idempotent per id (re-sent traces are ignored),
 * with denormalized columns for listing and aggregation computed once, at write time.
 */
import type { EvaluationRecord, SpanRecord, TraceBundle } from '@scope-ai/core';
import type { Kysely } from 'kysely';
import type { Database } from './schema.ts';
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
