/**
 * scope ui — the local dashboard: loopback only, no authentication, the current project.
 * scope server — a shared server: API keys required, every project in the database.
 */
import { spawn } from 'node:child_process';
import { relative } from 'node:path';
import {
  createLogger,
  createPrivacyPolicy,
  ErrorCodes,
  type Logger,
  parseLogLevel,
  pluralize,
  ScopeError,
} from '@scope-ai/core';
import {
  type AuthConfig,
  findWebRoot,
  isLoopbackHost,
  type RunningServer,
  startServer,
} from '@scope-ai/server';
import type { CommandContext } from '../context.ts';

export const DEFAULT_PORT = 4700;

export interface ServeOptions {
  port?: string;
  host?: string;
  open?: boolean;
  insecureNoAuth?: boolean;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ScopeError(ErrorCodes.usage, `Invalid port "${value}"`, {
      hint: `Use a number between 1 and 65535, e.g. --port ${DEFAULT_PORT}.`,
    });
  }
  return port;
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(command, args as string[], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {
    // Opening a browser is a convenience; the URL is printed either way.
  }
}

/** Resolves when the process is asked to stop (Ctrl-C or SIGTERM). */
function untilStopped(): Promise<string> {
  return new Promise((resolve) => {
    const stop = (signal: string) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve(signal);
    };
    const onInt = () => stop('SIGINT');
    const onTerm = () => stop('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
  });
}

async function serve(
  ctx: CommandContext,
  settings: { auth: AuthConfig; host: string; port: number; logger: Logger },
): Promise<RunningServer> {
  const project = ctx.project();
  const store = await ctx.store();
  return startServer({
    store,
    auth: settings.auth,
    host: settings.host,
    port: settings.port,
    privacy: createPrivacyPolicy(project.privacy),
    pricing: project.pricing,
    logger: settings.logger,
    webRoot: findWebRoot(),
    ...(ctx.env.SCOPE_MAX_INGEST_BYTES
      ? { maxIngestBytes: Number(ctx.env.SCOPE_MAX_INGEST_BYTES) }
      : {}),
    ...(ctx.env.SCOPE_MAX_SPANS_PER_TRACE
      ? { maxSpansPerTrace: Number(ctx.env.SCOPE_MAX_SPANS_PER_TRACE) }
      : {}),
  });
}

async function shutdown(ctx: CommandContext, server: RunningServer): Promise<void> {
  const signal = await untilStopped();
  ctx.out.info(ctx.out.errStyle.dim(`\nStopping (${signal})…`));
  await server.close();
}

export async function uiCommand(ctx: CommandContext, options: ServeOptions): Promise<void> {
  const host = options.host ?? ctx.env.SCOPE_HOST ?? '127.0.0.1';
  if (!isLoopbackHost(host) && !options.insecureNoAuth) {
    throw new ScopeError(
      ErrorCodes.usage,
      `scope ui has no authentication, so it only listens on this machine (not ${host})`,
      {
        hint: 'To share SCOPE, run `scope server` (API keys required). To expose this dashboard anyway, add --insecure-no-auth: anyone who can reach it can read every trace.',
      },
    );
  }
  const port = parsePort(options.port ?? ctx.env.SCOPE_PORT);
  const project = ctx.project();
  const projectRow = await ctx.projectRow();
  const logger = createLogger({
    level: ctx.options.verbose ? 'debug' : 'warn',
    format: 'pretty',
    write: (line) => ctx.out.stderr.write(`${ctx.out.errStyle.dim(line)}\n`),
  });
  const server = await serve(ctx, {
    auth: { mode: 'none', defaultProject: projectRow },
    host,
    port,
    logger,
  });
  const store = await ctx.store();
  const stats = await store.projectStats(projectRow.id);
  const dashboard = findWebRoot() !== null;

  ctx.out.emitJson({
    url: server.url,
    project: projectRow.slug,
    storage: store.target.display,
    dashboard,
    auth: 'none',
  });
  const s = ctx.out.style;
  const storage =
    store.dialect === 'sqlite'
      ? `SQLite ${relative(ctx.cwd, store.target.location) || store.target.location}`
      : store.target.display;
  ctx.out.print('');
  ctx.out.result(`${s.bold('SCOPE')}  ${s.cyan(server.url)}`);
  ctx.out.print('');
  ctx.out.print(
    `  ${s.dim('project')}   ${project.name} ${s.dim(`· ${pluralize(stats.runs, 'run')} · ${pluralize(stats.traces, 'trace')}`)}`,
  );
  ctx.out.print(`  ${s.dim('storage')}   ${storage}`);
  ctx.out.print(
    `  ${s.dim('SDK')}       SCOPE_URL=${server.url} ${s.dim('— instrumented apps send traces here')}`,
  );
  ctx.out.print(`  ${s.dim('API')}       ${server.url}/api/v1/openapi.json`);
  if (!dashboard) {
    ctx.out.print('');
    ctx.out.print(
      `  ${s.yellow('The dashboard is not built in this checkout; serving the API only.')}`,
    );
    ctx.out.print(`  ${s.dim('Build it with: npm run build -w @scope-ai/web')}`);
  }
  if (!isLoopbackHost(host)) {
    ctx.out.print('');
    ctx.out.print(
      `  ${s.red('No authentication:')} anyone who can reach ${host}:${server.port} can read every trace.`,
    );
  }
  ctx.out.print('');
  ctx.out.print(s.dim('  Press Ctrl+C to stop.'));
  if (options.open && dashboard) openBrowser(server.url);
  await shutdown(ctx, server);
}

export async function serverCommand(ctx: CommandContext, options: ServeOptions): Promise<void> {
  const host = options.host ?? ctx.env.SCOPE_HOST ?? '0.0.0.0';
  const port = parsePort(options.port ?? ctx.env.SCOPE_PORT);
  const format = ctx.env.SCOPE_LOG_FORMAT === 'pretty' ? 'pretty' : 'json';
  const logger = createLogger({
    level: ctx.options.verbose ? 'debug' : parseLogLevel(ctx.env.SCOPE_LOG_LEVEL, 'info'),
    format,
    write: (line) => ctx.out.stderr.write(`${line}\n`),
  });
  const store = await ctx.store();
  const server = await serve(ctx, { auth: { mode: 'api-key' }, host, port, logger });
  const projects = await store.listProjects();
  const keys = (await Promise.all(projects.map((p) => store.listApiKeys(p.id)))).flat();
  const keyCount = keys.filter((k) => k.revokedAt === null).length;
  logger.info('SCOPE server listening', {
    url: server.url,
    storage: store.target.display,
    auth: 'api-key',
    dashboard: findWebRoot() !== null,
    activeKeys: keyCount,
  });
  if (keyCount === 0) {
    logger.warn('no API keys exist yet; every API request will be rejected', {
      hint: 'Create one: scope keys create --project <name> --name <label> --scope read --scope ingest',
    });
  }
  ctx.out.emitJson({ url: server.url, storage: store.target.display, auth: 'api-key' });
  await shutdown(ctx, server);
}
