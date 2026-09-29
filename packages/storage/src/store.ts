/**
 * The SCOPE store: the only module that knows SQL.
 *
 * Every tenant-owned query is scoped by `projectId`. Aggregations run in SQL or over bounded
 * result sets; list endpoints use keyset pagination.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type CaseResult,
  type CaseSnapshot,
  type DatasetInfo,
  ErrorCodes,
  type ErrorInfo,
  type EvaluationRecord,
  type EvaluationStatus,
  type EvaluatorKind,
  type GateResult,
  type GateStatus,
  type GitInfo,
  type JsonObject,
  type Logger,
  newId,
  type RunStatus,
  type RunSummary,
  type RunTrigger,
  ScopeError,
  silentLogger,
  type TraceBundle,
} from '@scope-ai/core';
import { Kysely, type Selectable, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import {
  type EvaluationListItem,
  type EvaluatorHealth,
  evaluatorHealth,
  listEvaluations,
  type ModelUsage,
  modelUsage,
  type Overview,
  type OverviewOptions,
  overview,
  projectStats,
  type TimeWindow,
} from './analytics.ts';
import {
  createDialect,
  type DialectName,
  parseStorageUrl,
  type StorageTarget,
} from './dialects.ts';
import { ingestBundles, ingestSpans, type SpanBatch, summarizeEvalStatus } from './ingest.ts';
import { LATEST_MIGRATION, ScopeMigrations } from './migrations.ts';
import type {
  ApiKey,
  ApiKeyScope,
  BaselineComparisonRecord,
  BaselineRef,
  Page,
  Project,
  Run,
  RunCase,
  TraceSummary,
  WorkflowDetail,
  WorkflowSummary,
} from './records.ts';
import type { Database } from './schema.ts';
import {
  getTrace,
  listRunCases,
  listTraces,
  type RunCaseFilters,
  runCaseResults,
  type TraceDetail,
  type TraceFilters,
  toSnapshots,
  traceNames,
} from './traces.ts';
import {
  decodeCursor,
  encodeCursor,
  pageSize,
  readJson,
  readJsonOrNull,
  writeJson,
  writeJsonOrNull,
} from './util.ts';

export interface OpenStoreOptions {
  logger?: Logger;
  /** Run pending migrations on open (default true). */
  autoMigrate?: boolean;
}

export interface MigrationState {
  applied: string[];
  pending: string[];
}

export interface CreateRunInput {
  projectId: string;
  workflowId: string;
  workflowVersionId: string;
  workflowName: string;
  variant: string | null;
  params: JsonObject;
  dataset: DatasetInfo | null;
  git: GitInfo | null;
  trigger: RunTrigger;
  baseline: BaselineRef | null;
  caseCount: number;
  startedAt?: number;
}

export interface CompleteRunInput {
  status: RunStatus;
  summary: RunSummary | null;
  gates: GateResult[];
  gateStatus: GateStatus;
  error?: ErrorInfo | null;
  endedAt?: number;
}

type RunRow = Selectable<Database['runs']>;

/** Changed cases stored per baseline comparison; the rest are counted. */
export const MAX_STORED_CASE_CHANGES = 500;

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    workflowVersionId: row.workflow_version_id,
    variant: row.variant,
    params: readJson<JsonObject>(row.params),
    dataset: readJsonOrNull<DatasetInfo>(row.dataset),
    status: row.status as RunStatus,
    gateStatus: row.gate_status as GateStatus,
    summary: readJsonOrNull<RunSummary>(row.summary),
    gates: readJsonOrNull<GateResult[]>(row.gates) ?? [],
    git: readJsonOrNull<GitInfo>(row.git),
    trigger: row.trigger as RunTrigger,
    baseline: readJsonOrNull<BaselineRef>(row.baseline),
    error: readJsonOrNull<ErrorInfo>(row.error),
    caseCount: row.case_count,
    passRate: row.pass_rate,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
  };
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown };
  return e?.code === '23505' || /UNIQUE constraint failed/i.test(String(e?.message ?? ''));
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export class Store {
  readonly db: Kysely<Database>;
  readonly dialect: DialectName;
  readonly target: StorageTarget;
  readonly #logger: Logger;
  /** PostgreSQL schema the connection works in (from search_path); null on SQLite. */
  #schema: string | null = null;

  private constructor(db: Kysely<Database>, target: StorageTarget, logger: Logger) {
    this.db = db;
    this.dialect = target.dialect;
    this.target = target;
    this.#logger = logger;
  }

  static async open(url: string, options: OpenStoreOptions = {}): Promise<Store> {
    const target = parseStorageUrl(url);
    const logger = options.logger ?? silentLogger;
    const dialect = await createDialect(target);
    const db = new Kysely<Database>({ dialect });
    const store = new Store(db, target, logger);
    try {
      await store.ping();
      if (target.dialect === 'postgres') {
        const row = await sql<{ schema: string | null }>`select current_schema() as schema`.execute(
          db,
        );
        store.#schema = row.rows[0]?.schema ?? null;
      }
    } catch (error) {
      await db.destroy().catch(() => {});
      throw error;
    }
    if (options.autoMigrate ?? true) await store.migrate();
    return store;
  }

  async ping(): Promise<void> {
    try {
      await sql`select 1`.execute(this.db);
    } catch (error) {
      const message = (error as Error).message;
      throw new ScopeError(
        ErrorCodes.storageUnavailable,
        `Unable to connect to ${this.dialect === 'postgres' ? 'PostgreSQL' : 'SQLite'} at ${this.target.display}: ${message}`,
        {
          hint:
            this.dialect === 'postgres'
              ? 'Check SCOPE_DATABASE_URL (or storage.url), that the database is running and reachable, and the credentials. Run `scope doctor`.'
              : 'Check that the path is writable. Run `scope doctor`.',
          cause: error,
        },
      );
    }
  }

  #migrator(): Migrator {
    return new Migrator({
      db: this.db,
      provider: new ScopeMigrations(this.dialect),
      migrationTableName: 'scope_migrations',
      migrationLockTableName: 'scope_migrations_lock',
      // Pin the migration tables to the connection's schema. Unpinned, Kysely finds tables of
      // the same name in any schema (e.g. another deployment in `public`) and skips creating
      // them, which breaks installs that use a dedicated schema through search_path.
      ...(this.#schema ? { migrationTableSchema: this.#schema } : {}),
    });
  }

  async migrate(): Promise<string[]> {
    const { error, results } = await this.#migrator().migrateToLatest();
    const applied = (results ?? [])
      .filter((r) => r.status === 'Success')
      .map((r) => r.migrationName);
    if (applied.length)
      this.#logger.info('applied database migrations', { migrations: applied.join(',') });
    if (error) {
      throw new ScopeError(
        ErrorCodes.storageMigrationFailed,
        `Database migration failed: ${(error as Error).message}`,
        {
          hint: 'The database may have been modified outside SCOPE, or a newer SCOPE version migrated it. Run `scope doctor`.',
          cause: error,
        },
      );
    }
    return applied;
  }

  async migrationState(): Promise<MigrationState> {
    const migrations = await this.#migrator().getMigrations();
    return {
      applied: migrations.filter((m) => m.executedAt).map((m) => m.name),
      pending: migrations.filter((m) => !m.executedAt).map((m) => m.name),
    };
  }

  static readonly latestMigration = LATEST_MIGRATION;

  async close(): Promise<void> {
    await this.db.destroy();
  }

  // ─── projects ──────────────────────────────────────────────────────────────────────────────

  async ensureProject(slug: string, name: string = slug): Promise<Project> {
    const existing = await this.getProjectBySlug(slug);
    if (existing) return existing;
    const project: Project = { id: newId('prj'), slug, name, createdAt: Date.now() };
    await this.db
      .insertInto('projects')
      .values({ id: project.id, slug, name, created_at: project.createdAt })
      .onConflict((oc) => oc.column('slug').doNothing())
      .execute();
    return (await this.getProjectBySlug(slug)) as Project;
  }

  async getProjectBySlug(slug: string): Promise<Project | null> {
    const row = await this.db
      .selectFrom('projects')
      .selectAll()
      .where('slug', '=', slug)
      .executeTakeFirst();
    return row ? { id: row.id, slug: row.slug, name: row.name, createdAt: row.created_at } : null;
  }

  async getProject(id: string): Promise<Project | null> {
    const row = await this.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? { id: row.id, slug: row.slug, name: row.name, createdAt: row.created_at } : null;
  }

  async listProjects(): Promise<Project[]> {
    const rows = await this.db.selectFrom('projects').selectAll().orderBy('created_at').execute();
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      createdAt: row.created_at,
    }));
  }

  // ─── API keys ──────────────────────────────────────────────────────────────────────────────

  /** Creates a key and returns the secret once; only its hash is stored. */
  async createApiKey(
    projectId: string,
    name: string,
    scopes: ApiKeyScope[],
  ): Promise<{ key: ApiKey; secret: string }> {
    const secret = `scope_${randomBytes(32).toString('base64url').replace(/[-_]/g, '').slice(0, 32)}`;
    const key: ApiKey = {
      id: newId('key'),
      projectId,
      name,
      prefix: secret.slice(0, 12),
      scopes: [...new Set(scopes)].sort() as ApiKeyScope[],
      createdAt: Date.now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    await this.db
      .insertInto('api_keys')
      .values({
        id: key.id,
        project_id: projectId,
        name,
        prefix: key.prefix,
        hash: hashApiKey(secret),
        scopes: key.scopes.join(','),
        created_at: key.createdAt,
        last_used_at: null,
        revoked_at: null,
      })
      .execute();
    return { key, secret };
  }

  /** Looks up an active key by its secret, comparing hashes in constant time. */
  async authenticateApiKey(secret: string): Promise<ApiKey | null> {
    const hash = hashApiKey(secret);
    const row = await this.db
      .selectFrom('api_keys')
      .selectAll()
      .where('hash', '=', hash)
      .executeTakeFirst();
    if (!row || row.revoked_at !== null) return null;
    if (!timingSafeEqual(Buffer.from(row.hash, 'hex'), Buffer.from(hash, 'hex'))) return null;
    const now = Date.now();
    // Touch at most once a minute to avoid a write per request.
    if (row.last_used_at === null || now - row.last_used_at > 60_000) {
      await this.db
        .updateTable('api_keys')
        .set({ last_used_at: now })
        .where('id', '=', row.id)
        .execute();
    }
    return this.#mapKey(row);
  }

  async listApiKeys(projectId: string): Promise<ApiKey[]> {
    const rows = await this.db
      .selectFrom('api_keys')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((r) => this.#mapKey(r));
  }

  async revokeApiKey(projectId: string, id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('api_keys')
      .set({ revoked_at: Date.now() })
      .where('project_id', '=', projectId)
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  #mapKey(row: Selectable<Database['api_keys']>): ApiKey {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes.split(',').filter(Boolean) as ApiKeyScope[],
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    };
  }

  // ─── workflows ─────────────────────────────────────────────────────────────────────────────

  async registerWorkflowVersion(
    projectId: string,
    input: {
      name: string;
      description: string | null;
      hash: string;
      definition: unknown;
      source: string;
      path: string | null;
    },
  ): Promise<{ workflowId: string; versionId: string }> {
    const now = Date.now();
    return this.db.transaction().execute(async (trx) => {
      let workflow = await trx
        .selectFrom('workflows')
        .select(['id'])
        .where('project_id', '=', projectId)
        .where('name', '=', input.name)
        .executeTakeFirst();
      if (!workflow) {
        const id = newId('wf');
        await trx
          .insertInto('workflows')
          .values({
            id,
            project_id: projectId,
            name: input.name,
            description: input.description,
            latest_version_id: null,
            created_at: now,
            updated_at: now,
          })
          .execute();
        workflow = { id };
      }
      let version = await trx
        .selectFrom('workflow_versions')
        .select(['id'])
        .where('workflow_id', '=', workflow.id)
        .where('hash', '=', input.hash)
        .executeTakeFirst();
      if (!version) {
        const id = newId('wfv');
        await trx
          .insertInto('workflow_versions')
          .values({
            id,
            workflow_id: workflow.id,
            hash: input.hash,
            definition: writeJson(input.definition),
            source: input.source,
            path: input.path,
            created_at: now,
          })
          .execute();
        version = { id };
      }
      await trx
        .updateTable('workflows')
        .set({ latest_version_id: version.id, description: input.description, updated_at: now })
        .where('id', '=', workflow.id)
        .execute();
      return { workflowId: workflow.id, versionId: version.id };
    });
  }

  async listWorkflows(projectId: string): Promise<WorkflowSummary[]> {
    const workflows = await this.db
      .selectFrom('workflows')
      .leftJoin('workflow_versions', 'workflow_versions.workflow_id', 'workflows.id')
      .select([
        'workflows.id',
        'workflows.name',
        'workflows.description',
        'workflows.updated_at',
        (eb) => eb.fn.count<number>('workflow_versions.id').as('version_count'),
      ])
      .where('workflows.project_id', '=', projectId)
      .groupBy(['workflows.id', 'workflows.name', 'workflows.description', 'workflows.updated_at'])
      .orderBy('workflows.updated_at', 'desc')
      .execute();
    if (workflows.length === 0) return [];
    const ids = workflows.map((w) => w.id);
    const counts = await this.db
      .selectFrom('runs')
      .select([
        'workflow_id',
        (eb) => eb.fn.count<number>('id').as('n'),
        (eb) => eb.fn.max<number>('started_at').as('last'),
      ])
      .where('workflow_id', 'in', ids)
      .groupBy('workflow_id')
      .execute();
    const lastRuns = counts.length
      ? await this.db
          .selectFrom('runs')
          .selectAll()
          .where((eb) =>
            eb.or(
              counts.map((c) =>
                eb.and([
                  eb('workflow_id', '=', c.workflow_id),
                  eb('started_at', '=', Number(c.last)),
                ]),
              ),
            ),
          )
          .execute()
      : [];
    return workflows.map((w) => {
      const count = counts.find((c) => c.workflow_id === w.id);
      const last = lastRuns.find((r) => r.workflow_id === w.id);
      return {
        id: w.id,
        name: w.name,
        description: w.description,
        versionCount: Number(w.version_count),
        runCount: Number(count?.n ?? 0),
        updatedAt: w.updated_at,
        lastRun: last
          ? {
              id: last.id,
              number: last.number,
              variant: last.variant,
              status: last.status as RunStatus,
              gateStatus: last.gate_status as GateStatus,
              passRate: last.pass_rate,
              startedAt: last.started_at,
            }
          : null,
      };
    });
  }

  async getWorkflow(projectId: string, name: string): Promise<WorkflowDetail | null> {
    const workflow = await this.db
      .selectFrom('workflows')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('name', '=', name)
      .executeTakeFirst();
    if (!workflow) return null;
    const versions = await this.db
      .selectFrom('workflow_versions')
      .selectAll()
      .where('workflow_id', '=', workflow.id)
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    const latest = versions.find((v) => v.id === workflow.latest_version_id) ?? versions[0] ?? null;
    return {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      updatedAt: workflow.updated_at,
      versions: versions.map((v) => ({
        id: v.id,
        hash: v.hash,
        path: v.path,
        createdAt: v.created_at,
      })),
      latest: latest
        ? {
            id: latest.id,
            hash: latest.hash,
            source: latest.source,
            definition: readJson(latest.definition),
            path: latest.path,
          }
        : null,
    };
  }

  async getWorkflowVersion(
    versionId: string,
  ): Promise<{ hash: string; source: string; definition: unknown; path: string | null } | null> {
    const v = await this.db
      .selectFrom('workflow_versions')
      .selectAll()
      .where('id', '=', versionId)
      .executeTakeFirst();
    return v
      ? { hash: v.hash, source: v.source, definition: readJson(v.definition), path: v.path }
      : null;
  }

  // ─── runs ──────────────────────────────────────────────────────────────────────────────────

  async createRun(input: CreateRunInput): Promise<Run> {
    const startedAt = input.startedAt ?? Date.now();
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = newId('run');
      try {
        await this.db.transaction().execute(async (trx) => {
          const row = await trx
            .selectFrom('runs')
            .select((eb) => eb.fn.max<number>('number').as('max'))
            .where('project_id', '=', input.projectId)
            .executeTakeFirst();
          const number = Number(row?.max ?? 0) + 1;
          await trx
            .insertInto('runs')
            .values({
              id,
              project_id: input.projectId,
              number,
              workflow_id: input.workflowId,
              workflow_version_id: input.workflowVersionId,
              workflow_name: input.workflowName,
              variant: input.variant,
              params: writeJson(input.params),
              dataset: writeJsonOrNull(input.dataset),
              status: 'running',
              gate_status: 'none',
              summary: null,
              gates: null,
              git: writeJsonOrNull(input.git),
              trigger: input.trigger,
              baseline: writeJsonOrNull(input.baseline),
              error: null,
              case_count: input.caseCount,
              pass_rate: null,
              started_at: startedAt,
              ended_at: null,
              duration_ms: null,
            })
            .execute();
        });
        return (await this.getRun(input.projectId, id)) as Run;
      } catch (error) {
        // Two runs started concurrently can pick the same number; retry with the next one.
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new ScopeError(
      ErrorCodes.internal,
      'Could not allocate a run number after several attempts',
    );
  }

  async completeRun(runId: string, input: CompleteRunInput): Promise<Run> {
    const endedAt = input.endedAt ?? Date.now();
    const row = await this.db
      .selectFrom('runs')
      .select(['project_id', 'started_at'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    await this.db
      .updateTable('runs')
      .set({
        status: input.status,
        summary: writeJsonOrNull(input.summary),
        gates: writeJson(input.gates),
        gate_status: input.gateStatus,
        error: writeJsonOrNull(input.error ?? null),
        pass_rate: input.summary?.passRate ?? null,
        ended_at: endedAt,
        duration_ms: endedAt - row.started_at,
      })
      .where('id', '=', runId)
      .execute();
    return (await this.getRun(row.project_id, runId)) as Run;
  }

  /** Finds a run by id, id prefix, or number ("42" or "#42"). */
  async getRun(projectId: string, ref: string): Promise<Run | null> {
    const numberMatch = /^#?(\d+)$/.exec(ref.trim());
    let query = this.db.selectFrom('runs').selectAll().where('project_id', '=', projectId);
    if (numberMatch) query = query.where('number', '=', Number(numberMatch[1]));
    else if (ref.startsWith('run_') && ref.length === 30) query = query.where('id', '=', ref);
    else {
      // Short ids are shown lowercased; ULIDs are uppercase Crockford base32.
      const body = (ref.startsWith('run_') ? ref.slice(4) : ref).toUpperCase();
      if (!/^[0-9A-Z]{4,26}$/.test(body)) return null;
      query = query.where(sql<boolean>`id like ${`run\\_${body}%`} escape '\\'`);
    }
    const rows = await query.limit(2).execute();
    if (rows.length > 1) {
      throw new ScopeError(ErrorCodes.badRequest, `Run reference "${ref}" is ambiguous`, {
        hint: 'Use more characters of the id, or the run number.',
      });
    }
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async latestRun(
    projectId: string,
    filters: { workflow?: string; variant?: string | null; status?: RunStatus } = {},
  ): Promise<Run | null> {
    let query = this.db.selectFrom('runs').selectAll().where('project_id', '=', projectId);
    if (filters.workflow) query = query.where('workflow_name', '=', filters.workflow);
    if (filters.variant !== undefined)
      query =
        filters.variant === null
          ? query.where('variant', 'is', null)
          : query.where('variant', '=', filters.variant);
    if (filters.status) query = query.where('status', '=', filters.status);
    const row = await query.orderBy('number', 'desc').limit(1).executeTakeFirst();
    return row ? mapRun(row) : null;
  }

  async listRuns(
    projectId: string,
    filters: {
      workflow?: string;
      variant?: string;
      status?: RunStatus;
      gateStatus?: GateStatus;
      limit?: number;
      cursor?: string | null;
    } = {},
  ): Promise<{ items: Run[]; nextCursor: string | null }> {
    const limit = pageSize(filters.limit);
    const cursor = decodeCursor(filters.cursor);
    let query = this.db.selectFrom('runs').selectAll().where('project_id', '=', projectId);
    if (filters.workflow) query = query.where('workflow_name', '=', filters.workflow);
    if (filters.variant) query = query.where('variant', '=', filters.variant);
    if (filters.status) query = query.where('status', '=', filters.status);
    if (filters.gateStatus) query = query.where('gate_status', '=', filters.gateStatus);
    if (cursor) query = query.where('number', '<', Number(cursor.v));
    const rows = await query
      .orderBy('number', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(mapRun);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last ? encodeCursor({ v: last.number, id: last.id }) : null,
    };
  }

  async listVariants(projectId: string, workflow: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('runs')
      .select('variant')
      .distinct()
      .where('project_id', '=', projectId)
      .where('workflow_name', '=', workflow)
      .where('variant', 'is not', null)
      .execute();
    return rows.map((r) => r.variant as string).sort();
  }

  /**
   * Stores how a run compared with its baseline. Changed cases beyond
   * MAX_STORED_CASE_CHANGES are counted, not stored.
   */
  async saveBaselineComparison(
    projectId: string,
    input: Omit<BaselineComparisonRecord, 'omittedCases' | 'createdAt'>,
  ): Promise<void> {
    const changed = input.cases.filter((c) => c.kind !== 'unchanged');
    const cases = changed.slice(0, MAX_STORED_CASE_CHANGES);
    const comparison = {
      metrics: input.metrics,
      counts: input.counts,
      cases,
      omittedCases: changed.length - cases.length,
    };
    await this.db
      .insertInto('run_comparisons')
      .values({
        run_id: input.runId,
        project_id: projectId,
        baseline: writeJson(input.baseline),
        comparison: writeJson(comparison),
        created_at: Date.now(),
      })
      .onConflict((oc) =>
        oc.column('run_id').doUpdateSet({
          baseline: writeJson(input.baseline),
          comparison: writeJson(comparison),
        }),
      )
      .execute();
  }

  async getBaselineComparison(
    projectId: string,
    runId: string,
  ): Promise<BaselineComparisonRecord | null> {
    const row = await this.db
      .selectFrom('run_comparisons')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('run_id', '=', runId)
      .executeTakeFirst();
    if (!row) return null;
    const comparison = readJson<
      Pick<BaselineComparisonRecord, 'metrics' | 'counts' | 'cases' | 'omittedCases'>
    >(row.comparison);
    return {
      runId: row.run_id,
      baseline: readJson<BaselineRef>(row.baseline),
      ...comparison,
      createdAt: Number(row.created_at),
    };
  }

  async deleteRun(projectId: string, runId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('runs')
      .where('project_id', '=', projectId)
      .where('id', '=', runId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  // ─── ingestion ─────────────────────────────────────────────────────────────────────────────

  /** Stores finished traces with their spans and evaluations. Idempotent per id. */
  /**
   * Adds spans to traces that may arrive over several calls (OpenTelemetry), recomputing each
   * touched trace from all of its spans.
   */
  async ingestSpans(
    projectId: string,
    batches: readonly SpanBatch[],
    maxSpansPerTrace: number,
  ): Promise<{ traces: number; spans: number; rejectedSpans: number; dropped: number }> {
    return ingestSpans(this.db, projectId, batches, maxSpansPerTrace);
  }

  async ingest(
    projectId: string,
    bundles: readonly TraceBundle[],
  ): Promise<{ traces: number; spans: number; evaluations: number; rejected: number }> {
    return ingestBundles(this.db, projectId, bundles);
  }

  /** Replaces the evaluations of one trace (used by `scope evaluate` to re-score a run). */
  async replaceEvaluations(
    projectId: string,
    traceId: string,
    evaluations: readonly EvaluationRecord[],
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('evaluations')
        .where('project_id', '=', projectId)
        .where('trace_id', '=', traceId)
        .execute();
      if (evaluations.length > 0) {
        await trx
          .insertInto('evaluations')
          .values(
            evaluations.map((e) => ({
              id: e.id,
              project_id: projectId,
              trace_id: traceId,
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
          )
          .execute();
      }
      await trx
        .updateTable('traces')
        .set({ eval_status: summarizeEvalStatus(evaluations), eval_count: evaluations.length })
        .where('id', '=', traceId)
        .where('project_id', '=', projectId)
        .execute();
    });
  }

  // ─── queries ───────────────────────────────────────────────────────────────────────────────

  listTraces(projectId: string, filters?: TraceFilters): Promise<Page<TraceSummary>> {
    return listTraces(this.db, projectId, filters);
  }

  getTrace(projectId: string, ref: string): Promise<TraceDetail | null> {
    return getTrace(this.db, projectId, ref);
  }

  traceNames(projectId: string): Promise<Array<{ name: string; count: number; lastSeen: number }>> {
    return traceNames(this.db, projectId);
  }

  listRunCases(projectId: string, runId: string, filters?: RunCaseFilters): Promise<Page<RunCase>> {
    return listRunCases(this.db, projectId, runId, filters);
  }

  runCaseResults(projectId: string, runId: string): Promise<CaseResult[]> {
    return runCaseResults(this.db, projectId, runId);
  }

  async runCaseSnapshots(projectId: string, runId: string): Promise<Record<string, CaseSnapshot>> {
    return toSnapshots(await runCaseResults(this.db, projectId, runId));
  }

  overview(projectId: string, options: OverviewOptions): Promise<Overview> {
    return overview(this.db, projectId, options);
  }

  modelUsage(projectId: string, window: TimeWindow): Promise<ModelUsage[]> {
    return modelUsage(this.db, projectId, window);
  }

  evaluatorHealth(projectId: string, window: TimeWindow): Promise<EvaluatorHealth[]> {
    return evaluatorHealth(this.db, projectId, window);
  }

  listEvaluations(
    projectId: string,
    filters?: {
      evaluator?: string;
      status?: EvaluationStatus;
      kind?: EvaluatorKind;
      runId?: string;
      since?: number;
      limit?: number;
      cursor?: string | null;
    },
  ): Promise<Page<EvaluationListItem>> {
    return listEvaluations(this.db, projectId, filters);
  }

  projectStats(projectId: string) {
    return projectStats(this.db, projectId);
  }
}
