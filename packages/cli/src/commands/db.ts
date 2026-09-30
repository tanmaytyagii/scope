/**
 * scope db — the database, for operators.
 *
 *   scope db status          where it is, its schema, its size, and what each project holds
 *   scope db migrate         apply pending migrations (for SCOPE_AUTO_MIGRATE=false deployments)
 *   scope db backup <file>   a consistent copy of a SQLite database, while it stays in use
 *
 * None of them migrates on open: status reports pending migrations, and a backup is taken
 * before an upgrade changes the schema.
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  ErrorCodes,
  formatBytes,
  formatNumber,
  formatTimestamp,
  SCOPE_VERSION,
  ScopeError,
} from '@scope-ai/core';
import { newerSchemaError, type Store } from '@scope-ai/storage';
import type { CommandContext } from '../context.ts';
import { renderTable } from '../ui/table.ts';

function describe(ctx: CommandContext, store: Store): string {
  const where =
    store.dialect === 'sqlite'
      ? `SQLite ${relative(ctx.cwd, store.target.location) || store.target.location}`
      : `PostgreSQL ${store.target.display}`;
  return `${where} ${ctx.out.style.dim(`(from ${ctx.project().storage.source})`)}`;
}

export async function dbStatusCommand(ctx: CommandContext): Promise<void> {
  const store = await ctx.store({ migrate: false, allowNewerSchema: true });
  const state = await store.migrationState();
  const [bytes, projects] =
    state.newer.length || state.applied.length === 0
      ? [await store.databaseSize().catch(() => 0), []]
      : await Promise.all([store.databaseSize(), store.projectsOverview()]);
  ctx.out.emitJson({
    scope: SCOPE_VERSION,
    storage: { dialect: store.dialect, location: store.target.display },
    schema: state,
    bytes,
    projects: projects.map((p) => ({
      ...p,
      oldest: p.oldest === null ? null : new Date(p.oldest).toISOString(),
      newest: p.newest === null ? null : new Date(p.newest).toISOString(),
    })),
  });
  const s = ctx.out.style;
  const schema = state.newer.length
    ? s.red(`migrated by a newer SCOPE (${state.newer.join(', ')})`)
    : state.pending.length
      ? s.yellow(
          `${state.pending.length} pending: ${state.pending.join(', ')} — apply with \`scope db migrate\``,
        )
      : `up to date (${state.applied.at(-1) ?? 'empty'})`;
  ctx.out.print(`  ${s.dim('database')}  ${describe(ctx, store)}`);
  ctx.out.print(`  ${s.dim('schema')}    ${schema}`);
  ctx.out.print(`  ${s.dim('size')}      ${formatBytes(bytes)}`);
  if (projects.length) {
    ctx.out.print('');
    ctx.out.print(
      renderTable(
        projects,
        [
          { header: 'Project', value: (p) => p.slug },
          { header: 'Runs', value: (p) => formatNumber(p.runs), align: 'right' },
          { header: 'Traces', value: (p) => formatNumber(p.traces), align: 'right' },
          { header: 'Spans', value: (p) => formatNumber(p.spans), align: 'right' },
          { header: 'Evaluations', value: (p) => formatNumber(p.evaluations), align: 'right' },
          {
            header: 'Oldest trace',
            value: (p) => (p.oldest === null ? '—' : formatTimestamp(p.oldest)),
          },
        ],
        s.dim,
      ),
    );
  }
  if (state.newer.length) throw newerSchemaError(state.newer);
}

export async function dbMigrateCommand(ctx: CommandContext): Promise<void> {
  const store = await ctx.store({ migrate: false });
  const before = await store.migrationState();
  if (before.newer.length) throw newerSchemaError(before.newer);
  const applied = await store.migrate();
  const state = await store.migrationState();
  ctx.out.emitJson({ applied, schema: state });
  const s = ctx.out.style;
  if (applied.length === 0) {
    ctx.out.result(`Nothing to apply: ${describe(ctx, store)} is up to date.`);
    return;
  }
  for (const name of applied) ctx.out.print(`  ${s.green(ctx.out.sym.pass)} ${name}`);
  ctx.out.result(
    `${s.green(ctx.out.sym.pass)} Applied ${applied.length === 1 ? '1 migration' : `${applied.length} migrations`} to ${describe(ctx, store)}.`,
  );
}

export async function dbBackupCommand(
  ctx: CommandContext,
  file: string,
  options: { force?: boolean },
): Promise<void> {
  const store = await ctx.store({ migrate: false });
  if (store.dialect !== 'sqlite')
    throw new ScopeError(
      ErrorCodes.usage,
      '`scope db backup` copies SQLite databases; back up PostgreSQL with pg_dump',
      {
        hint: 'e.g. pg_dump --format=custom --file=scope.dump "$SCOPE_DATABASE_URL" — see docs/guides/operations.md.',
      },
    );
  const target = resolve(ctx.cwd, file);
  if (target === resolve(store.target.location))
    throw new ScopeError(ErrorCodes.usage, 'The backup would overwrite the database itself', {
      hint: 'Choose another file.',
    });
  if (existsSync(target) && !options.force)
    throw new ScopeError(ErrorCodes.usage, `${file} already exists`, {
      hint: 'Choose another file, or add --force to replace it.',
    });
  const started = Date.now();
  // VACUUM INTO refuses to write over a file.
  if (existsSync(target)) rmSync(target);
  await store.backupSqlite(target);
  const bytes = statSync(target).size;
  ctx.out.emitJson({ file: target, bytes, durationMs: Date.now() - started });
  ctx.out.result(
    `${ctx.out.style.green(ctx.out.sym.pass)} Backed up ${describe(ctx, store)} to ${relative(ctx.cwd, target) || target} (${formatBytes(bytes)}).`,
  );
}
