/**
 * Trace queries: listing with filters and keyset pagination, trace detail, and per-run case
 * results used by run pages, comparisons and re-evaluation.
 */
import {
  type CaseResult,
  type CaseSnapshot,
  caseOutcome,
  ErrorCodes,
  type ErrorInfo,
  type EvaluationRecord,
  type EvaluationStatus,
  type EvaluatorKind,
  type JsonObject,
  type JsonValue,
  ScopeError,
  type SpanEvent,
  type SpanKind,
  type SpanRecord,
  type SpanStatus,
  type TraceRecord,
} from '@scope-ai/core';
import {
  type ExpressionBuilder,
  type Kysely,
  type Selectable,
  type SelectQueryBuilder,
  sql,
} from 'kysely';
import type { DialectName } from './dialects.ts';
import type { CaseEvaluation, Page, RunCase, TraceSummary } from './records.ts';
import type { Database } from './schema.ts';
import {
  decodeCursor,
  encodeCursor,
  likePattern,
  pageSize,
  readJson,
  readJsonOrNull,
} from './util.ts';

export type TraceSort = 'newest' | 'oldest' | 'slowest' | 'costliest';

export interface TraceFilters {
  runId?: string;
  name?: string;
  status?: SpanStatus;
  /** Evaluation outcome; "none" means the trace has no judged evaluations. */
  eval?: 'passed' | 'failed' | 'errored' | 'none';
  /** "model" or "provider:model". */
  model?: string;
  q?: string;
  caseId?: string;
  since?: number;
  until?: number;
  sort?: TraceSort;
  limit?: number;
  cursor?: string | null;
}

type TracesQuery = SelectQueryBuilder<Database, 'traces' | 'runs', Record<string, unknown>>;

const SUMMARY_COLUMNS = [
  'traces.id',
  'traces.run_id',
  'runs.number as run_number',
  'traces.case_id',
  'traces.name',
  'traces.status',
  'traces.start_time',
  'traces.duration_ms',
  'traces.input_preview',
  'traces.output_preview',
  'traces.input_tokens',
  'traces.output_tokens',
  'traces.total_tokens',
  'traces.tokens_estimated',
  'traces.cost_usd',
  'traces.span_count',
  'traces.llm_call_count',
  'traces.eval_status',
  'traces.eval_count',
  'traces.error',
] as const;

interface SummaryRow {
  id: string;
  run_id: string | null;
  run_number: number | null;
  case_id: string | null;
  name: string;
  status: string;
  start_time: number;
  duration_ms: number;
  input_preview: string;
  output_preview: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  tokens_estimated: number;
  cost_usd: number | null;
  span_count: number;
  llm_call_count: number;
  eval_status: string | null;
  eval_count: number;
  error: unknown;
}

export function mapTraceSummary(row: SummaryRow): TraceSummary {
  return {
    id: row.id,
    runId: row.run_id,
    runNumber: row.run_number,
    caseId: row.case_id,
    name: row.name,
    status: row.status as SpanStatus,
    startTime: row.start_time,
    durationMs: row.duration_ms,
    inputPreview: row.input_preview,
    outputPreview: row.output_preview,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    tokensEstimated: row.tokens_estimated === 1,
    costUsd: row.cost_usd,
    spanCount: row.span_count,
    llmCallCount: row.llm_call_count,
    evalStatus: row.eval_status as TraceSummary['evalStatus'],
    evalCount: row.eval_count,
    error: readJsonOrNull<ErrorInfo>(row.error),
  };
}

export function selectTraceSummaries(db: Kysely<Database>, projectId: string) {
  return db
    .selectFrom('traces')
    .leftJoin('runs', 'runs.id', 'traces.run_id')
    .select(SUMMARY_COLUMNS)
    .where('traces.project_id', '=', projectId);
}

const SORTS: Record<
  TraceSort,
  {
    column: 'traces.start_time' | 'traces.duration_ms' | 'traces.cost_usd';
    direction: 'asc' | 'desc';
  }
> = {
  newest: { column: 'traces.start_time', direction: 'desc' },
  oldest: { column: 'traces.start_time', direction: 'asc' },
  slowest: { column: 'traces.duration_ms', direction: 'desc' },
  costliest: { column: 'traces.cost_usd', direction: 'desc' },
};

export async function listTraces(
  db: Kysely<Database>,
  projectId: string,
  filters: TraceFilters = {},
): Promise<Page<TraceSummary>> {
  const limit = pageSize(filters.limit);
  const sort = SORTS[filters.sort ?? 'newest'];
  const cursor = decodeCursor(filters.cursor);
  let query = selectTraceSummaries(db, projectId) as unknown as TracesQuery;
  if (filters.runId) query = query.where('traces.run_id', '=', filters.runId);
  if (filters.name) query = query.where('traces.name', '=', filters.name);
  if (filters.status) query = query.where('traces.status', '=', filters.status);
  if (filters.caseId) query = query.where('traces.case_id', '=', filters.caseId);
  if (filters.since !== undefined) query = query.where('traces.start_time', '>=', filters.since);
  if (filters.until !== undefined) query = query.where('traces.start_time', '<', filters.until);
  if (filters.eval) {
    query =
      filters.eval === 'none'
        ? query.where('traces.eval_status', 'is', null)
        : query.where('traces.eval_status', '=', filters.eval);
  }
  if (filters.q?.trim()) {
    query = query.where(
      sql<boolean>`traces.search_text like ${likePattern(filters.q.trim())} escape '\\'`,
    );
  }
  if (filters.model) {
    const model = filters.model;
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('spans')
          .select(sql`1`.as('one'))
          // No spans.project_id condition: the trace is the project's, and with one SQLite walks
          // every span of the model instead of the trace's few spans.
          .whereRef('spans.trace_id', '=', 'traces.id')
          .where((inner) =>
            inner.or([
              inner('spans.model', '=', model),
              inner(sql`spans.provider || ':' || spans.model`, '=', model),
            ]),
          ),
      ),
    );
  }

  // Keyset pagination on (sort column, id). Costs sort unknown (null) values last.
  const sortExpr =
    sort.column === 'traces.cost_usd'
      ? sql<number>`coalesce(traces.cost_usd, -1)`
      : sql.ref<number>(sort.column);
  if (cursor) {
    const v = Number(cursor.v);
    const op = sort.direction === 'desc' ? '<' : '>';
    query = query.where((eb: ExpressionBuilder<Database, 'traces' | 'runs'>) =>
      eb.or([eb(sortExpr, op, v), eb.and([eb(sortExpr, '=', v), eb('traces.id', op, cursor.id)])]),
    );
  }
  const rows = (await query
    .orderBy(sortExpr, sort.direction)
    .orderBy('traces.id', sort.direction)
    .limit(limit + 1)
    .execute()) as unknown as SummaryRow[];
  const items = rows.slice(0, limit).map(mapTraceSummary);
  const last = items[items.length - 1];
  let nextCursor: string | null = null;
  if (rows.length > limit && last) {
    const v =
      sort.column === 'traces.start_time'
        ? last.startTime
        : sort.column === 'traces.duration_ms'
          ? last.durationMs
          : (last.costUsd ?? -1);
    nextCursor = encodeCursor({ v, id: last.id });
  }
  return { items, nextCursor };
}

export interface CaseLink {
  caseId: string;
  traceId: string;
}

/** Where a case stands among its run's failing and errored cases (ordered by case id). */
export interface FailingCases {
  total: number;
  /** 1-based position of this case among them; null when this case passed. */
  position: number | null;
  previous: CaseLink | null;
  next: CaseLink | null;
}

export interface TraceDetail {
  trace: TraceRecord & { evalStatus: TraceSummary['evalStatus'] };
  spans: SpanRecord[];
  evaluations: EvaluationRecord[];
  run: { id: string; number: number; workflowName: string; variant: string | null } | null;
  /** Null for traces outside a run. */
  failingCases: FailingCases | null;
  /** Spans returned without their input and output because of `contentBudget`. */
  omittedContent: string[];
}

export interface TraceReadOptions {
  /**
   * Include span inputs and outputs up to this many bytes in total, in span order; spans whose
   * content does not fit come without it and are listed in `omittedContent`. Unset: all content.
   * Bounds memory and response size for large traces; `getSpan` returns one span in full.
   */
  contentBudget?: number;
}

/** Every span column except the content (input, output). */
const SPAN_STRUCTURE = [
  'trace_id',
  'id',
  'project_id',
  'parent_id',
  'name',
  'kind',
  'status',
  'status_message',
  'start_time',
  'end_time',
  'duration_ms',
  'attributes',
  'events',
  'error',
  'provider',
  'model',
  'input_tokens',
  'output_tokens',
  'cost_usd',
  'in_evaluation',
] as const;

/** Serialized size of a JSON column in bytes (0 for null). */
function jsonBytes(dialect: DialectName, column: 'input' | 'output') {
  return dialect === 'postgres'
    ? sql<number>`coalesce(octet_length(${sql.ref(column)}::text), 0)`
    : sql<number>`coalesce(length(cast(${sql.ref(column)} as blob)), 0)`;
}

/** The spans of a trace, with content only for spans that fit in `budget` bytes. */
async function spansWithin(
  db: Kysely<Database>,
  dialect: DialectName,
  traceId: string,
  budget: number,
): Promise<{ rows: Selectable<Database['spans']>[]; omitted: string[] }> {
  const structure = await db
    .selectFrom('spans')
    .select([
      ...SPAN_STRUCTURE,
      jsonBytes(dialect, 'input').as('input_bytes'),
      jsonBytes(dialect, 'output').as('output_bytes'),
    ])
    .where('trace_id', '=', traceId)
    .orderBy('start_time')
    .orderBy('id')
    .execute();
  let remaining = budget;
  const included: string[] = [];
  const omitted: string[] = [];
  for (const row of structure) {
    const bytes = Number(row.input_bytes) + Number(row.output_bytes);
    if (bytes === 0) continue;
    if (bytes <= remaining) {
      remaining -= bytes;
      included.push(row.id);
    } else {
      omitted.push(row.id);
    }
  }
  const content = new Map<string, { input: unknown; output: unknown }>();
  for (let i = 0; i < included.length; i += 500) {
    const rows = await db
      .selectFrom('spans')
      .select(['id', 'input', 'output'])
      .where('trace_id', '=', traceId)
      .where('id', 'in', included.slice(i, i + 500))
      .execute();
    for (const row of rows) content.set(row.id, { input: row.input, output: row.output });
  }
  return {
    rows: structure.map(({ input_bytes: _in, output_bytes: _out, ...row }) => ({
      ...row,
      input: (content.get(row.id)?.input ?? null) as Selectable<Database['spans']>['input'],
      output: (content.get(row.id)?.output ?? null) as Selectable<Database['spans']>['output'],
    })),
    omitted,
  };
}

/** One span of a trace, in full, with the time its trace's offsets are measured from. */
export async function getSpan(
  db: Kysely<Database>,
  projectId: string,
  traceRef: string,
  spanId: string,
): Promise<{ span: SpanRecord; origin: number } | null> {
  const traceId = await resolveTraceId(db, projectId, traceRef);
  if (!traceId || !/^[0-9a-f]{16}$/.test(spanId)) return null;
  const [row, trace, first] = await Promise.all([
    db
      .selectFrom('spans')
      .selectAll()
      .where('trace_id', '=', traceId)
      .where('id', '=', spanId)
      .executeTakeFirst(),
    db
      .selectFrom('traces')
      .select('start_time')
      .where('project_id', '=', projectId)
      .where('id', '=', traceId)
      .executeTakeFirst(),
    db
      .selectFrom('spans')
      .select((eb) => eb.fn.min<number>('start_time').as('start'))
      .where('trace_id', '=', traceId)
      .executeTakeFirst(),
  ]);
  if (!row || !trace) return null;
  const origin = Math.min(trace.start_time, Number(first?.start ?? trace.start_time));
  return { span: mapSpan(row), origin };
}

export function mapSpan(row: Selectable<Database['spans']>): SpanRecord {
  return {
    traceId: row.trace_id,
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind as SpanKind,
    status: row.status as SpanStatus,
    statusMessage: row.status_message,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMs: row.duration_ms,
    input: readJsonOrNull<JsonValue>(row.input),
    output: readJsonOrNull<JsonValue>(row.output),
    attributes: readJson(row.attributes),
    events: readJson<SpanEvent[]>(row.events),
    error: readJsonOrNull<ErrorInfo>(row.error),
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
  };
}

export function mapEvaluation(row: Selectable<Database['evaluations']>): EvaluationRecord {
  return {
    id: row.id,
    traceId: row.trace_id,
    runId: row.run_id,
    spanId: row.span_id,
    evaluator: row.evaluator,
    type: row.type,
    kind: row.kind as EvaluatorKind,
    status: row.status as EvaluationStatus,
    score: row.score,
    threshold: row.threshold,
    reason: row.reason,
    metadata: readJson<JsonObject>(row.metadata),
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

/** Resolves a full trace id or a unique prefix (at least 4 hex characters). */
export async function resolveTraceId(
  db: Kysely<Database>,
  projectId: string,
  ref: string,
): Promise<string | null> {
  const id = ref.trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(id)) return id;
  if (!/^[0-9a-f]{4,31}$/.test(id)) return null;
  const rows = await db
    .selectFrom('traces')
    .select('id')
    .where('project_id', '=', projectId)
    .where(sql<boolean>`id like ${`${id}%`}`)
    .limit(2)
    .execute();
  if (rows.length > 1) {
    throw new ScopeError(
      ErrorCodes.badRequest,
      `Trace id prefix "${ref}" matches more than one trace`,
      {
        hint: 'Use more characters of the trace id.',
      },
    );
  }
  return rows[0]?.id ?? null;
}

export async function getTrace(
  db: Kysely<Database>,
  dialect: DialectName,
  projectId: string,
  ref: string,
  options: TraceReadOptions = {},
): Promise<TraceDetail | null> {
  const id = await resolveTraceId(db, projectId, ref);
  if (!id) return null;
  const row = await db
    .selectFrom('traces')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return null;
  const [{ rows: spanRows, omitted }, evalRows, run, failingCases] = await Promise.all([
    options.contentBudget === undefined
      ? db
          .selectFrom('spans')
          .selectAll()
          .where('trace_id', '=', id)
          .orderBy('start_time')
          .orderBy('id')
          .execute()
          .then((rows) => ({ rows, omitted: [] as string[] }))
      : spansWithin(db, dialect, id, options.contentBudget),
    db
      .selectFrom('evaluations')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('trace_id', '=', id)
      .orderBy('created_at')
      .orderBy('evaluator')
      .execute(),
    row.run_id
      ? db
          .selectFrom('runs')
          .select(['id', 'number', 'workflow_name', 'variant'])
          .where('id', '=', row.run_id)
          .executeTakeFirst()
      : Promise.resolve(undefined),
    row.run_id && row.case_id
      ? failingNeighbors(db, projectId, row.run_id, { caseId: row.case_id, traceId: row.id })
      : Promise.resolve(null),
  ]);
  const spanStart = new Map(spanRows.map((sp) => [sp.id, sp.start_time]));
  return {
    trace: {
      id: row.id,
      runId: row.run_id,
      caseId: row.case_id,
      name: row.name,
      status: row.status as SpanStatus,
      startTime: row.start_time,
      endTime: row.end_time,
      durationMs: row.duration_ms,
      input: readJsonOrNull<JsonValue>(row.input),
      output: readJsonOrNull<JsonValue>(row.output),
      metadata: readJson<JsonObject>(row.metadata),
      error: readJsonOrNull<ErrorInfo>(row.error),
      usage: {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        totalTokens: row.total_tokens,
        ...(row.tokens_estimated ? { estimated: true } : {}),
      },
      costUsd: row.cost_usd,
      spanCount: row.span_count,
      llmCallCount: row.llm_call_count,
      evalStatus: row.eval_status as TraceSummary['evalStatus'],
    },
    spans: spanRows.map(mapSpan),
    // Evaluations in the order they ran (their spans' start times), i.e. as configured.
    evaluations: evalRows
      .map(mapEvaluation)
      .sort(
        (a, b) =>
          (spanStart.get(a.spanId ?? '') ?? a.createdAt) -
          (spanStart.get(b.spanId ?? '') ?? b.createdAt),
      ),
    run: run
      ? { id: run.id, number: run.number, workflowName: run.workflow_name, variant: run.variant }
      : null,
    failingCases,
    omittedContent: omitted,
  };
}

/**
 * The failing and errored cases of a run next to one case, in the order of the run's case list
 * (case id, then trace id), so the trace explorer can step through what went wrong.
 */
async function failingNeighbors(
  db: Kysely<Database>,
  projectId: string,
  runId: string,
  current: CaseLink,
): Promise<FailingCases> {
  const failing = () =>
    db
      .selectFrom('traces')
      .where('project_id', '=', projectId)
      .where('run_id', '=', runId)
      .where((eb) =>
        eb.or([eb('status', '=', 'error'), eb('eval_status', 'in', ['failed', 'errored'])]),
      );
  const before = (eb: ExpressionBuilder<Database, 'traces'>) =>
    eb.or([
      eb('case_id', '<', current.caseId),
      eb.and([eb('case_id', '=', current.caseId), eb('id', '<', current.traceId)]),
    ]);
  const after = (eb: ExpressionBuilder<Database, 'traces'>) =>
    eb.or([
      eb('case_id', '>', current.caseId),
      eb.and([eb('case_id', '=', current.caseId), eb('id', '>', current.traceId)]),
    ]);
  const [previous, next, earlier, total, self] = await Promise.all([
    failing()
      .select(['id', 'case_id'])
      .where(before)
      .orderBy('case_id', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst(),
    failing()
      .select(['id', 'case_id'])
      .where(after)
      .orderBy('case_id')
      .orderBy('id')
      .limit(1)
      .executeTakeFirst(),
    failing()
      .select((eb) => eb.fn.countAll().as('n'))
      .where(before)
      .executeTakeFirstOrThrow(),
    failing()
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirstOrThrow(),
    failing().select('id').where('id', '=', current.traceId).executeTakeFirst(),
  ]);
  const link = (r: { id: string; case_id: string | null } | undefined): CaseLink | null =>
    r?.case_id ? { caseId: r.case_id, traceId: r.id } : null;
  return {
    total: Number(total.n),
    position: self ? Number(earlier.n) + 1 : null,
    previous: link(previous),
    next: link(next),
  };
}

// ─── run cases ───────────────────────────────────────────────────────────────────────────────

export interface RunCaseFilters {
  outcome?: 'passed' | 'failed' | 'errored';
  evaluator?: string;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

export async function listRunCases(
  db: Kysely<Database>,
  projectId: string,
  runId: string,
  filters: RunCaseFilters = {},
): Promise<Page<RunCase>> {
  const limit = pageSize(filters.limit);
  const cursor = decodeCursor(filters.cursor);
  let query = db
    .selectFrom('traces')
    .select([
      'id',
      'case_id',
      'status',
      'eval_status',
      'duration_ms',
      'total_tokens',
      'cost_usd',
      'input_preview',
      'output_preview',
      'error',
    ])
    .where('project_id', '=', projectId)
    .where('run_id', '=', runId);
  if (filters.outcome === 'errored') {
    query = query.where((eb) =>
      eb.or([eb('status', '=', 'error'), eb('eval_status', '=', 'errored')]),
    );
  } else if (filters.outcome === 'failed') {
    query = query.where('status', '=', 'ok').where('eval_status', '=', 'failed');
  } else if (filters.outcome === 'passed') {
    query = query
      .where('status', '=', 'ok')
      .where((eb) => eb.or([eb('eval_status', '=', 'passed'), eb('eval_status', 'is', null)]));
  }
  if (filters.evaluator) {
    const evaluator = filters.evaluator;
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('evaluations')
          .select(sql`1`.as('one'))
          .whereRef('evaluations.trace_id', '=', 'traces.id')
          .where('evaluations.evaluator', '=', evaluator)
          .where('evaluations.status', 'in', ['failed', 'error']),
      ),
    );
  }
  if (filters.q?.trim())
    query = query.where(
      sql<boolean>`search_text like ${likePattern(filters.q.trim())} escape '\\'`,
    );
  if (cursor)
    query = query.where((eb) =>
      eb.or([
        eb('case_id', '>', String(cursor.v)),
        eb.and([eb('case_id', '=', String(cursor.v)), eb('id', '>', cursor.id)]),
      ]),
    );
  const rows = await query
    .orderBy('case_id')
    .orderBy('id')
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);

  const evaluations = page.length
    ? await db
        .selectFrom('evaluations')
        .select(['trace_id', 'evaluator', 'type', 'kind', 'status', 'score', 'reason'])
        // The page's traces are this project's; with a project_id condition SQLite walks every
        // evaluation of the project through its (project_id, evaluator) index.
        .where(
          'trace_id',
          'in',
          page.map((r) => r.id),
        )
        .orderBy('created_at')
        .execute()
    : [];
  const byTrace = new Map<string, CaseEvaluation[]>();
  for (const e of evaluations) {
    const list = byTrace.get(e.trace_id) ?? [];
    list.push({
      evaluator: e.evaluator,
      type: e.type,
      kind: e.kind as EvaluatorKind,
      status: e.status as EvaluationStatus,
      score: e.score,
      reason: e.reason,
    });
    byTrace.set(e.trace_id, list);
  }
  const items: RunCase[] = page.map((r) => {
    const evals = byTrace.get(r.id) ?? [];
    return {
      caseId: r.case_id ?? r.id,
      traceId: r.id,
      status: r.status as SpanStatus,
      outcome: caseOutcome({ status: r.status as SpanStatus, evaluations: evals }),
      durationMs: r.duration_ms,
      totalTokens: r.total_tokens,
      costUsd: r.cost_usd,
      inputPreview: r.input_preview,
      outputPreview: r.output_preview,
      error: readJsonOrNull<ErrorInfo>(r.error),
      evaluations: evals,
    };
  });
  const last = page[page.length - 1];
  return {
    items,
    nextCursor:
      rows.length > limit && last ? encodeCursor({ v: last.case_id ?? '', id: last.id }) : null,
  };
}

/** Per-case facts for a whole run, keyed by case id. */
export async function runCaseResults(
  db: Kysely<Database>,
  projectId: string,
  runId: string,
): Promise<CaseResult[]> {
  const [traces, evaluations, unpriced] = await Promise.all([
    db
      .selectFrom('traces')
      .select([
        'id',
        'case_id',
        'status',
        'duration_ms',
        'input_tokens',
        'output_tokens',
        'total_tokens',
        'tokens_estimated',
        'cost_usd',
      ])
      .where('project_id', '=', projectId)
      .where('run_id', '=', runId)
      .orderBy('case_id')
      .execute(),
    db
      .selectFrom('evaluations')
      .select(['trace_id', 'evaluator', 'type', 'kind', 'status', 'score'])
      .where('project_id', '=', projectId)
      .where('run_id', '=', runId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('spans')
      .innerJoin('traces', 'traces.id', 'spans.trace_id')
      .select(['spans.trace_id', 'spans.provider', 'spans.model'])
      // Scoped through the run's traces (indexed), not spans.project_id (every span of the project).
      .where('traces.project_id', '=', projectId)
      .where('traces.run_id', '=', runId)
      .where('spans.kind', '=', 'llm')
      .where('spans.in_evaluation', '=', 0)
      .where('spans.cost_usd', 'is', null)
      .execute(),
  ]);
  const evalsByTrace = new Map<string, CaseResult['evaluations']>();
  for (const e of evaluations) {
    const list = evalsByTrace.get(e.trace_id) ?? [];
    list.push({
      evaluator: e.evaluator,
      type: e.type,
      kind: e.kind as EvaluatorKind,
      status: e.status as EvaluationStatus,
      score: e.score,
    });
    evalsByTrace.set(e.trace_id, list);
  }
  const unpricedByTrace = new Map<string, Set<string>>();
  for (const s of unpriced) {
    if (!s.model) continue;
    const set = unpricedByTrace.get(s.trace_id) ?? new Set<string>();
    set.add(s.provider ? `${s.provider}:${s.model}` : s.model);
    unpricedByTrace.set(s.trace_id, set);
  }
  return traces.map((t) => ({
    caseId: t.case_id ?? t.id,
    traceId: t.id,
    status: t.status as SpanStatus,
    durationMs: t.duration_ms,
    usage: {
      inputTokens: t.input_tokens,
      outputTokens: t.output_tokens,
      totalTokens: t.total_tokens,
      ...(t.tokens_estimated ? { estimated: true } : {}),
    },
    costUsd: t.cost_usd,
    unpricedModels: [...(unpricedByTrace.get(t.id) ?? [])].sort(),
    evaluations: evalsByTrace.get(t.id) ?? [],
  }));
}

export function toSnapshots(results: readonly CaseResult[]): Record<string, CaseSnapshot> {
  const out: Record<string, CaseSnapshot> = {};
  for (const r of results) {
    const evaluators: CaseSnapshot['evaluators'] = {};
    for (const e of r.evaluations) evaluators[e.evaluator] = { status: e.status, score: e.score };
    out[r.caseId] = {
      outcome: caseOutcome(r),
      durationMs: r.durationMs,
      traceId: r.traceId,
      evaluators,
    };
  }
  return out;
}

export async function traceNames(
  db: Kysely<Database>,
  projectId: string,
): Promise<Array<{ name: string; count: number; lastSeen: number }>> {
  const rows = await db
    .selectFrom('traces')
    .select([
      'name',
      (eb) => eb.fn.count<number>('id').as('n'),
      (eb) => eb.fn.max<number>('start_time').as('last'),
    ])
    .where('project_id', '=', projectId)
    .groupBy('name')
    .orderBy('name')
    .limit(500)
    .execute();
  return rows.map((r) => ({ name: r.name, count: Number(r.n), lastSeen: Number(r.last) }));
}
