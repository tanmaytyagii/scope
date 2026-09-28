/**
 * scope doctor — diagnose the environment, configuration, storage and providers.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { basename, dirname, relative } from 'node:path';
import {
  ConfigError,
  isTemplate,
  type LoadedWorkflow,
  loadWorkflow,
  renderTemplate,
  resolveParams,
} from '@scope-ai/config';
import { errorMessage, isScopeError, SCOPE_VERSION } from '@scope-ai/core';
import { Engine } from '@scope-ai/engine';
import {
  isAbortError,
  isModelListed,
  type ProviderRegistry,
  parseModelRef,
} from '@scope-ai/providers';
import { findWebRoot } from '@scope-ai/server';
import { checkBaselines, checkDataset, type Finding, unusedBaselines } from '../checks.ts';
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
const NETWORK_TIMEOUT_MS = 10_000;

const plural = (n: number, noun: string) => `${n} ${n === 1 ? noun : `${noun}s`}`;

/** Whether git ignores a path: null when the path is not inside a git work tree. */
function gitIgnores(path: string): boolean | null {
  const r = spawnSync('git', ['check-ignore', '-q', '--', basename(path)], {
    cwd: dirname(path),
    stdio: 'ignore',
    timeout: 3000,
  });
  return r.status === 0 ? true : r.status === 1 ? false : null;
}

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

/**
 * Asks a provider for its model list (read-only, no tokens): proves that it is reachable and
 * accepts the credentials, and that the models the workflows use exist for them.
 */
async function probeProvider(
  registry: ProviderRegistry,
  name: string,
  refs: string[],
): Promise<Check[]> {
  const provider = registry.get(name);
  if (!provider.listModels)
    return [{ area: 'Providers', status: 'info', message: `${name}: cannot be probed` }];
  const started = performance.now();
  try {
    const listed = await provider.listModels({ signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
    const ms = Math.round(performance.now() - started);
    const checks: Check[] = [
      {
        area: 'Providers',
        status: 'pass',
        message: `${name}: reachable, credentials accepted (${plural(listed.length, 'model')}, ${ms} ms)`,
      },
    ];
    for (const ref of refs) {
      const { model } = parseModelRef(ref);
      if (!isModelListed(model, listed))
        checks.push({
          area: 'Providers',
          status: 'warn',
          message: `${name}: ${model} is not among the models these credentials can use`,
          hint: 'Check the model name and your account’s access to it.',
        });
    }
    return checks;
  } catch (error) {
    const timedOut = (error as { name?: string })?.name === 'TimeoutError' || isAbortError(error);
    return [
      {
        area: 'Providers',
        status: 'fail',
        // Provider errors name the provider already.
        message: timedOut
          ? `${name}: no answer within ${NETWORK_TIMEOUT_MS / 1000} s`
          : errorMessage(error),
        ...(isScopeError(error) && error.hint ? { hint: error.hint } : {}),
      },
    ];
  }
}

export interface DoctorOptions {
  /** Contact each provider in use (read-only model list requests). */
  network?: boolean;
}

export async function doctorCommand(
  ctx: CommandContext,
  options: DoctorOptions = {},
): Promise<void> {
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
  let sqlitePath: string | null = null;
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
    const workflows: LoadedWorkflow[] = [];
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
        else {
          valid++;
          workflows.push(loaded);
        }
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

    const baselineFindings: Finding[] = [];
    const baselinePaths = new Set<string>();
    for (const loaded of workflows) {
      const name = loaded.definition.name;
      const data = checkDataset(loaded, project);
      if (!data) {
        add({
          area: 'Datasets',
          status: 'info',
          message: `${name}: no dataset — runs need --dataset or --input`,
        });
      } else {
        const error = data.diagnostics.find((d) => d.severity === 'error');
        const warning = data.diagnostics.find((d) => d.severity === 'warning');
        const where = data.dataset?.source ?? 'inline';
        if (error || !data.dataset)
          add({
            area: 'Datasets',
            status: 'fail',
            message: `${name}: ${error?.file ? `${error.file}: ` : ''}${error?.message ?? 'the dataset cannot be read'}`,
            hint: error?.hint ?? 'Run `scope validate` for details.',
          });
        else
          add({
            area: 'Datasets',
            status: warning ? 'warn' : 'pass',
            message: `${name}: ${where} · ${data.dataset.cases.length} cases${warning ? ` · ${warning.message}` : ''}`,
          });
      }
      const baselines = checkBaselines(loaded, data?.dataset ?? null, project, ctx.cwd);
      baselineFindings.push(...baselines.findings);
      for (const path of baselines.paths) baselinePaths.add(path);
    }
    for (const f of baselineFindings) add({ area: 'Baselines', ...f });
    // Only when every workflow loaded: otherwise their baselines would look unused.
    if (workflows.length === files.length) {
      for (const path of unusedBaselines(project, baselinePaths))
        add({
          area: 'Baselines',
          status: 'warn',
          message: `${relative(ctx.cwd, path) || path} belongs to no workflow or variant`,
          hint: 'Baselines are named <workflow>.json or <workflow>.<variant>.json. Rename or delete it.',
        });
    }

    try {
      const store = await ctx.store();
      const state = await store.migrationState();
      const row = await ctx.projectRow();
      const stats = await store.projectStats(row.id);
      if (store.dialect === 'sqlite') sqlitePath = store.target.location;
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
        message: [
          plural(stats.runs, 'run'),
          plural(stats.traces, 'trace'),
          plural(stats.evaluations, 'evaluation'),
        ].join(' · '),
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
        if (options.network && used && d.type !== 'local')
          for (const c of await probeProvider(registry, name, models)) add(c);
      }
    }
    if (!options.network && [...providersInUse].some((p) => registry.typeOf(p) !== 'local'))
      add({
        area: 'Providers',
        status: 'info',
        message: 'credentials were not tried; scope doctor --network asks each provider in use',
      });
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
  if (git && sqlitePath && gitIgnores(sqlitePath) === false) {
    const display = relative(ctx.cwd, sqlitePath) || sqlitePath;
    add({
      area: 'Git',
      status: 'warn',
      message: `the local database ${display} is not ignored by git`,
      hint: 'It holds prompts and outputs of every run. Add `.scope/` to .gitignore (scope init does).',
    });
  }
  const webRoot = findWebRoot();
  add({
    area: 'Dashboard',
    status: webRoot ? 'pass' : 'warn',
    message: webRoot ? 'dashboard assets are built' : 'dashboard assets are not built',
    ...(webRoot
      ? {}
      : {
          hint: 'scope ui will serve the API only. In a source checkout, run npm run build -w @scope-ai/web.',
        }),
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
