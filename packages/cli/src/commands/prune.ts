/**
 * scope prune — delete old runs and traces, or one run or trace.
 *
 *   scope prune --older-than 30d [--only traces|runs] [--project <name> | --all-projects]
 *   scope prune --run <run>
 *   scope prune --trace <id>
 *
 * Without --yes nothing is deleted: the command says what would be. Deletion runs in batches
 * and can be interrupted and run again. SQLite keeps the file size until `--vacuum`.
 */
import { statSync } from 'node:fs';
import {
  ErrorCodes,
  formatBytes,
  formatNumber,
  formatTimestamp,
  parseCutoff,
  ScopeError,
} from '@scope-ai/core';
import type { PruneCounts, PruneSelection } from '@scope-ai/storage';
import type { CommandContext } from '../context.ts';

export interface PruneOptions {
  olderThan?: string;
  only?: string;
  run?: string;
  trace?: string;
  project?: string;
  allProjects?: boolean;
  yes?: boolean;
  vacuum?: boolean;
}

const usage = (message: string, hint: string) =>
  new ScopeError(ErrorCodes.usage, message, { hint });

export async function pruneCommand(ctx: CommandContext, options: PruneOptions): Promise<void> {
  const chosen = [options.olderThan, options.run, options.trace].filter((v) => v !== undefined);
  if (chosen.length !== 1)
    throw usage(
      'Choose what to delete: --older-than, --run or --trace',
      'e.g. `scope prune --older-than 30d` to see what is older than 30 days.',
    );
  if (options.only !== undefined && !['traces', 'runs'].includes(options.only))
    throw usage(
      `--only "${options.only}" is not traces or runs`,
      'Use --only traces or --only runs.',
    );
  if (options.only !== undefined && options.olderThan === undefined)
    throw usage('--only applies to --older-than', 'Remove --only, or add --older-than.');
  if (options.allProjects && options.project)
    throw usage('--project and --all-projects exclude each other', 'Use one of them.');
  if (options.allProjects && options.olderThan === undefined)
    throw usage(
      '--all-projects applies to --older-than',
      'A run or trace is always deleted from one project (--project).',
    );
  if (options.vacuum && !options.yes)
    throw usage(
      '--vacuum needs --yes',
      'Nothing is deleted without --yes, so there is nothing to compact.',
    );

  const store = await ctx.store();
  const project = options.allProjects
    ? null
    : options.project
      ? await store.getProjectBySlug(options.project)
      : await ctx.projectRow();
  if (options.project && !project)
    throw new ScopeError(ErrorCodes.notFound, `Project "${options.project}" not found`, {
      hint: 'List projects with `scope doctor` or check the name.',
    });

  const selection: PruneSelection = { projectIds: project ? [project.id] : null };
  let what = '';
  let none = 'nothing matches';
  if (options.olderThan !== undefined) {
    const before = parseCutoff(options.olderThan);
    if (before === null)
      throw usage(
        `--older-than "${options.olderThan}" is not a duration or date`,
        'Use a duration such as 90m, 24h, 30d or 2w, or a date such as 2026-09-01.',
      );
    if (before > Date.now())
      throw usage(`--older-than "${options.olderThan}" is in the future`, 'Use a past date.');
    selection.before = before;
    if (options.only) selection.only = options.only as 'traces' | 'runs';
    const kinds =
      options.only === 'traces'
        ? 'application traces'
        : options.only === 'runs'
          ? 'runs'
          : 'runs and application traces';
    what = `${kinds} that started before ${formatTimestamp(before)}`;
    none = `no ${kinds.replace(' and ', ' or ')} started before ${formatTimestamp(before)}`;
  } else if (options.run !== undefined && project) {
    const run = await store.getRun(project.id, options.run.replace(/^#/, ''));
    if (!run)
      throw new ScopeError(ErrorCodes.notFound, `Run ${options.run} not found`, {
        hint: `No such run in project "${project.slug}". List runs with \`scope runs\`.`,
      });
    selection.runId = run.id;
    what = `run #${run.number} (${run.workflowName}${run.variant ? ` · ${run.variant}` : ''})`;
  } else if (options.trace !== undefined && project) {
    const detail = await store.getTrace(project.id, options.trace, { contentBudget: 0 });
    if (!detail)
      throw new ScopeError(ErrorCodes.notFound, `Trace ${options.trace} not found`, {
        hint: `No such trace in project "${project.slug}". List traces with \`scope traces\`.`,
      });
    if (detail.run)
      throw usage(
        `Trace ${detail.trace.id.slice(0, 12)} is part of run #${detail.run.number}`,
        `A run's traces are its results; delete the whole run with \`scope prune --run ${detail.run.number}\`.`,
      );
    selection.traceId = detail.trace.id;
    what = `trace ${detail.trace.id.slice(0, 12)} (${detail.trace.name})`;
  }

  const where = project ? `project "${project.slug}"` : 'every project';
  const plan = await store.planPrune(selection);
  const empty = plan.runs + plan.traces === 0;
  const s = ctx.out.style;

  if (empty || !options.yes) {
    ctx.out.emitJson({ ...countsJson(plan), project: project?.slug ?? null, deleted: false });
    if (empty) {
      ctx.out.result(`Nothing to delete in ${where}: ${none}.`);
      return;
    }
    ctx.out.print(`Would delete ${what} from ${where}:`);
    printCounts(ctx, plan);
    ctx.out.result(`${s.yellow('Nothing was deleted.')} Run again with --yes to delete.`);
    return;
  }

  const sizeBefore = sqliteSize(store.target);
  const deleted = await store.prune(selection);
  let vacuumed = false;
  if (options.vacuum) vacuumed = await store.vacuum();
  const sizeAfter = sqliteSize(store.target);
  ctx.out.emitJson({
    ...countsJson(deleted),
    project: project?.slug ?? null,
    deleted: true,
    vacuumed,
    ...(sizeBefore !== null && sizeAfter !== null
      ? { bytesBefore: sizeBefore, bytesAfter: sizeAfter }
      : {}),
  });
  ctx.out.print(`Deleted ${what} from ${where}:`);
  printCounts(ctx, deleted);
  if (vacuumed && sizeBefore !== null && sizeAfter !== null)
    ctx.out.print(`  database file ${formatBytes(sizeBefore)} → ${formatBytes(sizeAfter)}`);
  else if (options.vacuum)
    ctx.out.print(s.dim('  PostgreSQL reuses the space of deleted rows by itself (autovacuum).'));
  else if (store.target.dialect === 'sqlite')
    ctx.out.print(
      s.dim('  SQLite reuses the freed space; run with --vacuum to shrink the file as well.'),
    );
  ctx.out.result(`${s.green(ctx.out.sym.pass)} Done.`);
}

function countsJson(c: PruneCounts) {
  return {
    runs: c.runs,
    runTraces: c.runTraces,
    traces: c.traces,
    spans: c.spans,
    evaluations: c.evaluations,
    oldest: c.oldest === null ? null : new Date(c.oldest).toISOString(),
    newest: c.newest === null ? null : new Date(c.newest).toISOString(),
  };
}

function printCounts(ctx: CommandContext, c: PruneCounts): void {
  const n = formatNumber;
  if (c.runs)
    ctx.out.print(`  ${n(c.runs)} ${c.runs === 1 ? 'run' : 'runs'}, with ${n(c.runTraces)} traces`);
  if (c.traces)
    ctx.out.print(`  ${n(c.traces)} application ${c.traces === 1 ? 'trace' : 'traces'}`);
  ctx.out.print(`  ${n(c.spans)} spans · ${n(c.evaluations)} evaluations`);
  if (c.oldest !== null && c.newest !== null)
    ctx.out.print(`  from ${formatTimestamp(c.oldest)} to ${formatTimestamp(c.newest)}`);
}

/** Size of a SQLite database file (with its WAL), or null for PostgreSQL and in-memory. */
function sqliteSize(target: { dialect: string; location: string }): number | null {
  if (target.dialect !== 'sqlite' || target.location === ':memory:') return null;
  let total = 0;
  for (const suffix of ['', '-wal']) {
    try {
      total += statSync(`${target.location}${suffix}`).size;
    } catch {
      // no WAL file
    }
  }
  return total;
}
