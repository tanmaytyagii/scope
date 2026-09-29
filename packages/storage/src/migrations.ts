/**
 * Schema migrations, shared by SQLite and PostgreSQL. Migrations are append-only: never edit a
 * released migration; add a new one.
 */
import { type Kysely, sql } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';
import type { DialectName } from './dialects.ts';

type AnyDb = Kysely<unknown>;

function jsonType(dialect: DialectName) {
  return dialect === 'postgres' ? sql`jsonb` : sql`text`;
}

function migration0001(dialect: DialectName): Migration {
  const json = jsonType(dialect);
  return {
    async up(db: AnyDb) {
      await db.schema
        .createTable('projects')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('slug', 'text', (c) => c.notNull().unique())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('api_keys')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('prefix', 'text', (c) => c.notNull())
        .addColumn('hash', 'text', (c) => c.notNull().unique())
        .addColumn('scopes', 'text', (c) => c.notNull())
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addColumn('last_used_at', 'bigint')
        .addColumn('revoked_at', 'bigint')
        .execute();
      await db.schema
        .createIndex('api_keys_project_idx')
        .on('api_keys')
        .column('project_id')
        .execute();

      await db.schema
        .createTable('workflows')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('latest_version_id', 'text')
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addColumn('updated_at', 'bigint', (c) => c.notNull())
        .addUniqueConstraint('workflows_project_name_unique', ['project_id', 'name'])
        .execute();

      await db.schema
        .createTable('workflow_versions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('workflow_id', 'text', (c) =>
          c.notNull().references('workflows.id').onDelete('cascade'),
        )
        .addColumn('hash', 'text', (c) => c.notNull())
        .addColumn('definition', json, (c) => c.notNull())
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('path', 'text')
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addUniqueConstraint('workflow_versions_hash_unique', ['workflow_id', 'hash'])
        .execute();

      await db.schema
        .createTable('runs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('number', 'integer', (c) => c.notNull())
        .addColumn('workflow_id', 'text', (c) =>
          c.notNull().references('workflows.id').onDelete('cascade'),
        )
        .addColumn('workflow_version_id', 'text', (c) =>
          c.notNull().references('workflow_versions.id'),
        )
        .addColumn('workflow_name', 'text', (c) => c.notNull())
        .addColumn('variant', 'text')
        .addColumn('params', json, (c) => c.notNull())
        .addColumn('dataset', json)
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('gate_status', 'text', (c) => c.notNull())
        .addColumn('summary', json)
        .addColumn('gates', json)
        .addColumn('git', json)
        .addColumn('trigger', 'text', (c) => c.notNull())
        .addColumn('baseline', json)
        .addColumn('error', json)
        .addColumn('case_count', 'integer', (c) => c.notNull())
        .addColumn('pass_rate', 'double precision')
        .addColumn('started_at', 'bigint', (c) => c.notNull())
        .addColumn('ended_at', 'bigint')
        .addColumn('duration_ms', 'double precision')
        .addUniqueConstraint('runs_project_number_unique', ['project_id', 'number'])
        .execute();
      await db.schema
        .createIndex('runs_project_started_idx')
        .on('runs')
        .columns(['project_id', 'started_at'])
        .execute();
      await db.schema
        .createIndex('runs_workflow_started_idx')
        .on('runs')
        .columns(['workflow_id', 'started_at'])
        .execute();

      await db.schema
        .createTable('traces')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('run_id', 'text', (c) => c.references('runs.id').onDelete('cascade'))
        .addColumn('case_id', 'text')
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('start_time', 'double precision', (c) => c.notNull())
        .addColumn('end_time', 'double precision', (c) => c.notNull())
        .addColumn('duration_ms', 'double precision', (c) => c.notNull())
        .addColumn('input', json)
        .addColumn('output', json)
        .addColumn('input_preview', 'text', (c) => c.notNull())
        .addColumn('output_preview', 'text', (c) => c.notNull())
        .addColumn('metadata', json, (c) => c.notNull())
        .addColumn('error', json)
        .addColumn('input_tokens', 'integer', (c) => c.notNull())
        .addColumn('output_tokens', 'integer', (c) => c.notNull())
        .addColumn('total_tokens', 'integer', (c) => c.notNull())
        .addColumn('tokens_estimated', 'integer', (c) => c.notNull())
        .addColumn('cost_usd', 'double precision')
        .addColumn('span_count', 'integer', (c) => c.notNull())
        .addColumn('llm_call_count', 'integer', (c) => c.notNull())
        .addColumn('eval_status', 'text')
        .addColumn('eval_count', 'integer', (c) => c.notNull())
        .addColumn('search_text', 'text', (c) => c.notNull())
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('traces_project_start_idx')
        .on('traces')
        .columns(['project_id', 'start_time'])
        .execute();
      await db.schema
        .createIndex('traces_run_idx')
        .on('traces')
        .columns(['run_id', 'case_id'])
        .execute();
      await db.schema
        .createIndex('traces_project_name_idx')
        .on('traces')
        .columns(['project_id', 'name', 'start_time'])
        .execute();
      await db.schema
        .createIndex('traces_project_status_idx')
        .on('traces')
        .columns(['project_id', 'status', 'start_time'])
        .execute();

      await db.schema
        .createTable('spans')
        .addColumn('trace_id', 'text', (c) =>
          c.notNull().references('traces.id').onDelete('cascade'),
        )
        .addColumn('id', 'text', (c) => c.notNull())
        .addColumn('project_id', 'text', (c) => c.notNull())
        .addColumn('parent_id', 'text')
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('status_message', 'text')
        .addColumn('start_time', 'double precision', (c) => c.notNull())
        .addColumn('end_time', 'double precision', (c) => c.notNull())
        .addColumn('duration_ms', 'double precision', (c) => c.notNull())
        .addColumn('input', json)
        .addColumn('output', json)
        .addColumn('attributes', json, (c) => c.notNull())
        .addColumn('events', json, (c) => c.notNull())
        .addColumn('error', json)
        .addColumn('provider', 'text')
        .addColumn('model', 'text')
        .addColumn('input_tokens', 'integer')
        .addColumn('output_tokens', 'integer')
        .addColumn('cost_usd', 'double precision')
        .addColumn('in_evaluation', 'integer', (c) => c.notNull())
        .addPrimaryKeyConstraint('spans_pk', ['trace_id', 'id'])
        .execute();
      await db.schema
        .createIndex('spans_project_model_idx')
        .on('spans')
        .columns(['project_id', 'model', 'start_time'])
        .execute();

      await db.schema
        .createTable('evaluations')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('project_id', 'text', (c) => c.notNull())
        .addColumn('trace_id', 'text', (c) =>
          c.notNull().references('traces.id').onDelete('cascade'),
        )
        .addColumn('run_id', 'text')
        .addColumn('span_id', 'text')
        .addColumn('evaluator', 'text', (c) => c.notNull())
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('score', 'double precision')
        .addColumn('threshold', 'double precision')
        .addColumn('reason', 'text', (c) => c.notNull())
        .addColumn('metadata', json, (c) => c.notNull())
        .addColumn('duration_ms', 'double precision', (c) => c.notNull())
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('evaluations_run_idx')
        .on('evaluations')
        .columns(['run_id', 'evaluator'])
        .execute();
      await db.schema
        .createIndex('evaluations_trace_idx')
        .on('evaluations')
        .column('trace_id')
        .execute();
      await db.schema
        .createIndex('evaluations_project_evaluator_idx')
        .on('evaluations')
        .columns(['project_id', 'evaluator', 'created_at'])
        .execute();
    },
    async down(db: AnyDb) {
      for (const table of [
        'evaluations',
        'spans',
        'traces',
        'runs',
        'workflow_versions',
        'workflows',
        'api_keys',
        'projects',
      ]) {
        await db.schema.dropTable(table).ifExists().execute();
      }
    },
  };
}

/**
 * What a run looked like next to the baseline it was compared with (metric deltas and changed
 * cases), as computed when it ran. Kept apart from `runs` so run lists never load it.
 */
function migration0002(dialect: DialectName): Migration {
  const json = jsonType(dialect);
  return {
    async up(db: AnyDb) {
      await db.schema
        .createTable('run_comparisons')
        .addColumn('run_id', 'text', (c) =>
          c.primaryKey().references('runs.id').onDelete('cascade'),
        )
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('baseline', json, (c) => c.notNull())
        .addColumn('comparison', json, (c) => c.notNull())
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .execute();
    },
    async down(db: AnyDb) {
      await db.schema.dropTable('run_comparisons').ifExists().execute();
    },
  };
}

/**
 * What produced a run (SCOPE and Node.js versions, fingerprints of the files the workflow names,
 * evaluator identities, models called). A few kilobytes, so it lives on the run. Null for runs
 * made before SCOPE 0.4.
 */
function migration0003(dialect: DialectName): Migration {
  const json = jsonType(dialect);
  return {
    async up(db: AnyDb) {
      await db.schema.alterTable('runs').addColumn('manifest', json).execute();
    },
    async down(db: AnyDb) {
      await db.schema.alterTable('runs').dropColumn('manifest').execute();
    },
  };
}

/**
 * Covering indexes for the dashboard's time-window aggregates, so they read an index in time
 * order instead of looking up every row in the window (docs/performance.md): at 300,000 traces
 * the overview went from 617 ms to 22 ms on first load and the models page from 1.2 s to 20 ms,
 * for 3% more disk. The traces index starts like `traces_project_start_idx`, which it replaces.
 */
function migration0004(_dialect: DialectName): Migration {
  return {
    async up(db: AnyDb) {
      await db.schema
        .createIndex('spans_model_calls_idx')
        .on('spans')
        .columns([
          'project_id',
          'start_time',
          'provider',
          'model',
          'in_evaluation',
          'status',
          'duration_ms',
          'input_tokens',
          'output_tokens',
          'cost_usd',
        ])
        .where(sql.ref('kind'), '=', sql.lit('llm'))
        .execute();
      await db.schema
        .createIndex('traces_project_window_idx')
        .on('traces')
        .columns([
          'project_id',
          'start_time',
          'status',
          'total_tokens',
          'cost_usd',
          'llm_call_count',
        ])
        .execute();
      await db.schema.dropIndex('traces_project_start_idx').execute();
      await db.schema
        .createIndex('evaluations_project_window_idx')
        .on('evaluations')
        .columns(['project_id', 'created_at', 'status', 'evaluator', 'kind', 'type', 'score'])
        .execute();
      await db.schema
        .createIndex('evaluations_project_status_idx')
        .on('evaluations')
        .columns(['project_id', 'status', 'created_at'])
        .execute();
    },
    async down(db: AnyDb) {
      await db.schema
        .createIndex('traces_project_start_idx')
        .on('traces')
        .columns(['project_id', 'start_time'])
        .execute();
      for (const name of [
        'spans_model_calls_idx',
        'traces_project_window_idx',
        'evaluations_project_window_idx',
        'evaluations_project_status_idx',
      ])
        await db.schema.dropIndex(name).ifExists().execute();
    },
  };
}

export class ScopeMigrations implements MigrationProvider {
  readonly #dialect: DialectName;
  constructor(dialect: DialectName) {
    this.#dialect = dialect;
  }
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      '0001_initial': migration0001(this.#dialect),
      '0002_run_comparisons': migration0002(this.#dialect),
      '0003_run_manifest': migration0003(this.#dialect),
      '0004_window_indexes': migration0004(this.#dialect),
    };
  }
}

export const LATEST_MIGRATION = '0004_window_indexes';
