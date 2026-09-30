/**
 * Retention: what to delete, and deleting it in small batches.
 *
 * Two kinds of data age out: runs (with their traces, spans, evaluations and stored comparisons)
 * and application traces — traces recorded outside a run by the SDK or OpenTelemetry. A single
 * run or application trace can also be deleted by id. Deletion cascades through foreign keys
 * whose child columns are all indexed, and runs in batches so no transaction holds the database
 * for long.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from './schema.ts';

export interface PruneSelection {
  /** Projects to prune; `null` for every project in the database. */
  projectIds: readonly string[] | null;
  /** Data that started before this time (epoch milliseconds). */
  before?: number;
  /** With `before`: only application traces, or only runs. Default both. */
  only?: 'traces' | 'runs';
  /** One run, with its traces. */
  runId?: string;
  /** One application trace (not part of a run). */
  traceId?: string;
}

export interface PruneCounts {
  runs: number;
  /** Traces that belong to those runs. */
  runTraces: number;
  /** Application traces (outside runs). */
  traces: number;
  spans: number;
  evaluations: number;
  /** Start time of the oldest and newest run or trace selected. */
  oldest: number | null;
  newest: number | null;
}

/** Runs still running are only pruned once they are clearly abandoned. */
const RUNNING_GRACE_MS = 24 * 3_600_000;
const BATCH = 200;

type Db = Kysely<Database> | Transaction<Database>;

function runQuery(db: Db, s: PruneSelection, now: number) {
  let q = db.selectFrom('runs');
  if (s.projectIds) q = q.where('project_id', 'in', s.projectIds);
  if (s.runId !== undefined) return q.where('id', '=', s.runId);
  if (s.before === undefined || s.only === 'traces' || s.traceId !== undefined)
    return q.where((eb) => eb.val(false));
  const before = s.before;
  return q
    .where('started_at', '<', before)
    .where((eb) =>
      eb.or([eb('status', '!=', 'running'), eb('started_at', '<', now - RUNNING_GRACE_MS)]),
    );
}

function traceQuery(db: Db, s: PruneSelection) {
  let q = db.selectFrom('traces').where('run_id', 'is', null);
  if (s.projectIds) q = q.where('project_id', 'in', s.projectIds);
  if (s.traceId !== undefined) return q.where('id', '=', s.traceId);
  if (s.before === undefined || s.only === 'runs' || s.runId !== undefined)
    return q.where((eb) => eb.val(false));
  return q.where('start_time', '<', s.before);
}

async function count(query: { executeTakeFirst(): Promise<{ n: unknown } | undefined> }) {
  return Number((await query.executeTakeFirst())?.n ?? 0);
}

/** What a prune would delete, without deleting anything. */
export async function planPrune(
  db: Kysely<Database>,
  s: PruneSelection,
  now = Date.now(),
): Promise<PruneCounts> {
  const runs = runQuery(db, s, now);
  const traces = traceQuery(db, s);
  const runIds = runs.select('id');
  // A run's traces and application traces are disjoint sets (run_id set, or null), so a union
  // keeps each side on its own index. `run_id in (…) or id in (…)` made PostgreSQL read every
  // trace, span and evaluation in the database, however little was selected.
  const traceIds = (tdb: Db) =>
    tdb
      .selectFrom('traces')
      .select('id')
      .where('run_id', 'in', runQuery(tdb, s, now).select('id'))
      .unionAll(traceQuery(tdb, s).select('id'));
  const [runCount, runTraces, appTraces, spans, evaluations, runRange, traceRange] =
    await Promise.all([
      count(runs.select((eb) => eb.fn.countAll().as('n'))),
      count(
        db
          .selectFrom('traces')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('run_id', 'in', runIds),
      ),
      count(traces.select((eb) => eb.fn.countAll().as('n'))),
      count(
        db
          .selectFrom('spans')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('trace_id', 'in', traceIds(db)),
      ),
      count(
        db
          .selectFrom('evaluations')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('trace_id', 'in', traceIds(db)),
      ),
      runs
        .select((eb) => [
          eb.fn.min<number>('started_at').as('oldest'),
          eb.fn.max<number>('started_at').as('newest'),
        ])
        .executeTakeFirst(),
      traces
        .select((eb) => [
          eb.fn.min<number>('start_time').as('oldest'),
          eb.fn.max<number>('start_time').as('newest'),
        ])
        .executeTakeFirst(),
    ]);
  const times = (pick: 'oldest' | 'newest') =>
    [runRange?.[pick], traceRange?.[pick]].filter((t) => t !== null && t !== undefined).map(Number);
  const oldest = times('oldest');
  const newest = times('newest');
  return {
    runs: runCount,
    runTraces,
    traces: appTraces,
    spans,
    evaluations,
    oldest: oldest.length ? Math.min(...oldest) : null,
    newest: newest.length ? Math.max(...newest) : null,
  };
}

/**
 * Deletes what `planPrune` describes, in batches: runs a few at a time (each takes its traces
 * with it), then application traces. Returns what was deleted. Safe to interrupt: every batch
 * is complete on its own, and running it again continues.
 */
export async function prune(
  db: Kysely<Database>,
  s: PruneSelection,
  now = Date.now(),
): Promise<PruneCounts> {
  const plan = await planPrune(db, s, now);
  for (;;) {
    const ids = (
      await runQuery(db, s, now)
        .select('id')
        .limit(BATCH / 10)
        .execute()
    ).map((r) => r.id);
    if (ids.length === 0) break;
    await db.deleteFrom('runs').where('id', 'in', ids).execute();
  }
  for (;;) {
    const ids = (await traceQuery(db, s).select('id').limit(BATCH).execute()).map((r) => r.id);
    if (ids.length === 0) break;
    await db.deleteFrom('traces').where('id', 'in', ids).execute();
  }
  return plan;
}
