/**
 * scope doctor — diagnose the environment, configuration, storage and providers.
 */
import { createServer } from 'node:net';
import { relative } from 'node:path';
import {
  ConfigError,
  isTemplate,
  loadWorkflow,
  renderTemplate,
  resolveParams,
} from '@scope-ai/config';
import { errorMessage, isScopeError, SCOPE_VERSION } from '@scope-ai/core';
import { Engine } from '@scope-ai/engine';
import { parseModelRef } from '@scope-ai/providers';
import type { CommandContext } from '../context.ts';
import { ExitCode, ExitError } from '../errors.ts';
import { collectGitInfo } from '../git.ts';
import { discoverWorkflows } from './validate.ts';

type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

interface Check {
  area: string;
  status: CheckStatus;
  message: string;
  hint?: string;
}

const MIN_NODE = [22, 16] as const;

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** Model references a workflow will use: static values and params across variants. */
function modelRefs(definition: import('@scope-ai/config').WorkflowFile): string[] {
  const refs = new Set<string>();
  const variants = [null, ...Object.keys(definition.variants ?? {})];
  for (const variant of variants) {
    const params = resolveParams(definition, variant);
    const candidates: unknown[] = [];
    for (const step of definition.steps) if (step.type === 'llm') candidates.push(step.with?.model);
    for (const e of definition.evaluators ?? []) candidates.push(e.with?.model);
    for (const value of candidates) {
      if (typeof value !== 'string') continue;
      try {
        const rendered = isTemplate(value) ? renderTemplate(value, { params, variant }) : value;
        if (typeof rendered === 'string' && !isTemplate(rendered)) refs.add(rendered);
      } catch {
        // references to inputs/steps cannot be known statically
      }
    }
  }
  return [...refs];
}

export async function doctorCommand(ctx: CommandContext): Promise<void> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) {
    const tsNote = major === 22 && minor < 18 ? ' (TypeScript function modules need 22.18+)' : '';
    add({
      area: 'Node.js',
      status: tsNote ? 'warn' : 'pass',
      message: `v${process.versions.node}${tsNote}`,
    });
  } else {
    add({
      area: 'Node.js',
      status: 'fail',
      message: `v${process.versions.node} is too old`,
      hint: `SCOPE needs Node.js ${MIN_NODE.join('.')} or newer.`,
    });
  }

  let projectOk = false;
  let modelsInUse: string[] = [];
  try {
    const project = ctx.project();
    projectOk = true;
    add({
      area: 'Project',
      status: 'pass',
      message: project.configPath
        ? `${project.name} (${relative(ctx.cwd, project.configPath) || project.configPath})`
        : `${project.name} (no scope.yaml — using defaults)`,
      ...(project.configPath
        ? {}
        : { hint: 'Run `scope init` to create a project with an example workflow.' }),
    });
    for (const d of project.diagnostics)
      add({
        area: 'Project',
        status: 'warn',
        message: d.message,
        ...(d.hint ? { hint: d.hint } : {}),
      });

    const files = discoverWorkflows(ctx);
    if (files.length === 0)
      add({
        area: 'Workflows',
        status: 'warn',
        message: 'no workflow files found',
        hint: `Looked for ${project.workflowGlobs.join(', ')}.`,
      });
    const engine = new Engine({ project, exporter: { export: () => {} }, env: ctx.env });
    let valid = 0;
    for (const file of files) {
      try {
        const loaded = loadWorkflow(file, { root: ctx.cwd, env: ctx.env });
        const diagnostics = engine.validate(loaded);
        const errors = diagnostics.filter((d) => d.severity === 'error');
        if (errors.length)
          add({
            area: 'Workflows',
            status: 'fail',
            message: `${file}: ${errors[0]?.message}`,
            hint: 'Run `scope validate` for details.',
          });
        else valid++;
        modelsInUse.push(...modelRefs(loaded.definition));
      } catch (error) {
        add({
          area: 'Workflows',
          status: 'fail',
          message: `${file}: ${error instanceof ConfigError ? error.diagnostics[0]?.message : errorMessage(error)}`,
          hint: 'Run `scope validate` for details.',
        });
      }
    }
    if (files.length)
      add({
        area: 'Workflows',
        status: valid === files.length ? 'pass' : 'warn',
        message: `${valid} of ${files.length} valid`,
      });
    modelsInUse = [...new Set(modelsInUse)];

    try {
      const store = await ctx.store();
      const state = await store.migrationState();
      const row = await ctx.projectRow();
      const stats = await store.projectStats(row.id);
      add({
        area: 'Storage',
        status: 'pass',
        message: `${store.dialect === 'sqlite' ? 'SQLite' : 'PostgreSQL'} ${store.dialect === 'sqlite' ? relative(ctx.cwd, store.target.location) || store.target.location : store.target.display} ${ctx.out.errStyle.dim(`(from ${project.storage.source})`)}`,
      });
      add({
        area: 'Storage',
        status: state.pending.length ? 'warn' : 'pass',
        message: state.pending.length
          ? `${state.pending.length} pending migrations`
          : `schema up to date (${state.applied.at(-1) ?? 'none'})`,
      });
      add({
        area: 'Storage',
        status: 'info',
        message: `${stats.runs} runs · ${stats.traces} traces · ${stats.evaluations} evaluations`,
      });
    } catch (error) {
      add({
        area: 'Storage',
        status: 'fail',
        message: errorMessage(error),
        ...(isScopeError(error) && error.hint ? { hint: error.hint } : {}),
      });
    }

    const registry = engine.providers;
    const providersInUse = new Set(modelsInUse.map((m) => parseModelRef(m).provider));
    for (const name of registry.names()) {
      const used = providersInUse.has(name);
      const d = registry.describe(name);
      const models = modelsInUse.filter((m) => m.startsWith(`${name}:`));
      const usage = used ? ` — used by ${models.join(', ')}` : '';
      if (d.credential.status === 'missing') {
        add({
          area: 'Providers',
          status: used ? 'fail' : 'info',
          message: `${name}: ${d.credential.variable ?? 'credentials'} not set${usage}`,
          ...(used
            ? {
                hint: `Export ${d.credential.variable}.${'note' in d.credential && d.credential.note ? ` ${d.credential.note}` : ''}`,
              }
            : {}),
        });
      } else {
        const source =
          d.credential.status === 'env'
            ? `${d.credential.variable} set`
            : d.credential.status === 'config'
              ? 'key in scope.yaml'
              : 'no credentials needed';
        add({
          area: 'Providers',
          status: used ? 'pass' : 'info',
          message: `${name}: ${source}${d.baseUrl ? ` · ${d.baseUrl}` : ''}${usage}`,
        });
      }
    }
  } catch (error) {
    if (!projectOk)
      add({
        area: 'Project',
        status: 'fail',
        message: errorMessage(error),
        ...(isScopeError(error) && error.hint ? { hint: error.hint } : {}),
      });
    else throw error;
  }

  const git = collectGitInfo(ctx.cwd, ctx.env);
  add({
    area: 'Git',
    status: git ? 'pass' : 'info',
    message: git
      ? `${git.branch ?? 'detached'} @ ${git.commit?.slice(0, 7)}${git.dirty ? ' (uncommitted changes)' : ''}`
      : 'not a git repository — runs will not record commits',
  });
  const port = Number(ctx.env.SCOPE_PORT ?? 4700);
  const free = await portFree(port);
  add({
    area: 'Dashboard',
    status: free ? 'pass' : 'warn',
    message: free ? `port ${port} is free for scope ui` : `port ${port} is in use`,
    ...(free
      ? {}
      : {
          hint: 'Use scope ui --port <n>, or stop the other process (it may be scope ui already).',
        }),
  });

  ctx.out.emitJson({ version: SCOPE_VERSION, checks });
  if (!ctx.out.json) {
    const s = ctx.out.style;
    const icon: Record<CheckStatus, string> = {
      pass: s.green(ctx.out.sym.pass),
      warn: s.yellow(ctx.out.sym.warn),
      fail: s.red(ctx.out.sym.fail),
      info: s.dim(ctx.out.sym.bullet),
    };
    ctx.out.print('');
    ctx.out.print(`${s.bold('scope doctor')} ${s.dim(`v${SCOPE_VERSION}`)}`);
    let area = '';
    for (const c of checks) {
      if (c.area !== area) {
        area = c.area;
        ctx.out.print('');
        ctx.out.print(s.bold(area));
      }
      ctx.out.print(`  ${icon[c.status]} ${c.message}`);
      if (c.hint) ctx.out.print(`    ${s.dim(c.hint)}`);
    }
    const failed = checks.filter((c) => c.status === 'fail').length;
    const warned = checks.filter((c) => c.status === 'warn').length;
    ctx.out.print('');
    ctx.out.result(
      failed
        ? s.red(`${failed} ${failed === 1 ? 'problem' : 'problems'} found`)
        : warned
          ? s.yellow(`No problems · ${warned} ${warned === 1 ? 'warning' : 'warnings'}`)
          : s.green('Everything looks good'),
    );
  }
  if (checks.some((c) => c.status === 'fail')) throw new ExitError(ExitCode.gatesFailed);
}
