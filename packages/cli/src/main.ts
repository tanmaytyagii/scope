/**
 * The `scope` command-line interface.
 */
import { SCOPE_VERSION } from '@scope-ai/core';
import { Command, CommanderError, Option } from 'commander';
import { baselineSaveCommand } from './commands/baseline.ts';
import { compareManyCommand } from './commands/compare.ts';
import { doctorCommand } from './commands/doctor.ts';
import { evaluateCommand } from './commands/evaluate.ts';
import { initCommand } from './commands/init.ts';
import { keysCreateCommand, keysListCommand, keysRevokeCommand } from './commands/keys.ts';
import { reportCommand } from './commands/report.ts';
import { runCommand } from './commands/run.ts';
import { runsCommand } from './commands/runs.ts';
import { DEFAULT_PORT, serverCommand, uiCommand } from './commands/serve.ts';
import { tracesCommand } from './commands/traces.ts';
import { validateCommand } from './commands/validate.ts';
import { CommandContext, type GlobalOptions } from './context.ts';
import { ExitCode, exitCodeFor, renderError } from './errors.ts';
import { Output } from './ui/output.ts';

type ContextRunner = <A extends unknown[]>(
  fn: (ctx: CommandContext, ...args: A) => Promise<void>,
) => (...args: unknown[]) => Promise<void>;

const collect = (value: string, previous: string[] = []) => [...previous, value];

const EXAMPLES = `
Examples:
  $ scope init my-project                      Create a project that runs offline
  $ scope run workflows/support.yaml           Run and evaluate a workflow
  $ scope run workflows/support.yaml --all-variants
  $ scope traces --run 12 --eval failed        Find failing traces in run #12
  $ scope compare 11 12                        Compare two runs case by case
  $ scope baseline save 12                     Make run #12 the regression reference
  $ scope ui --open                            Explore runs and traces in the dashboard

Exit codes:
  0 success · 1 gates failed · 2 usage or configuration error · 3 execution error · 130 interrupted

Docs: https://github.com/tanmaytyagii/scope/tree/main/docs`;

export interface MainOptions {
  env?: NodeJS.ProcessEnv;
}

export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const contexts: CommandContext[] = [];
  let failure: unknown = null;
  let lastContext: CommandContext | null = null;

  const program = new Command('scope');
  program
    .description(
      'SCOPE — see what your AI actually does.\nOpen-source tracing, evaluation and regression testing for AI workflows.',
    )
    .version(`scope ${SCOPE_VERSION}`, '-V, --version', 'show the version')
    .helpOption('-h, --help', 'show help for a command')
    .option('--cwd <dir>', 'run as if started in <dir>')
    .option('-c, --config <file>', 'path to scope.yaml (default: nearest scope.yaml)')
    .option('--json', 'print machine-readable JSON on stdout')
    .option('-q, --quiet', 'print only results and errors')
    .option('--verbose', 'print debug information')
    .option('--no-color', 'disable colored output')
    .addHelpText('after', EXAMPLES)
    .showSuggestionAfterError(true)
    .showHelpAfterError('(run `scope --help` to see available commands)')
    .exitOverride()
    .configureOutput({
      writeOut: (str) => process.stdout.write(str),
      writeErr: (str) => process.stderr.write(str),
    });

  const withContext: ContextRunner =
    <A extends unknown[]>(fn: (ctx: CommandContext, ...args: A) => Promise<void>) =>
    async (...args: unknown[]) => {
      const command = args[args.length - 1] as Command;
      const globals = command.optsWithGlobals<GlobalOptions & Record<string, unknown>>();
      const ctx = new CommandContext(
        {
          ...(globals.cwd !== undefined ? { cwd: globals.cwd } : {}),
          ...(globals.config !== undefined ? { config: globals.config } : {}),
          ...(globals.json !== undefined ? { json: globals.json } : {}),
          ...(globals.quiet !== undefined ? { quiet: globals.quiet } : {}),
          ...(globals.verbose !== undefined ? { verbose: globals.verbose } : {}),
          ...(globals.color !== undefined ? { color: globals.color } : {}),
        },
        env,
      );
      contexts.push(ctx);
      lastContext = ctx;
      await fn(ctx, ...(args.slice(0, -1) as A));
    };

  program.commandsGroup('Get started:');
  program
    .command('init')
    .argument('[dir]', 'directory to create the project in', '.')
    .description('create a SCOPE project with an example workflow that runs offline')
    .option('--name <name>', 'project name (default: directory name)')
    .option('--force', 'overwrite existing files')
    .action(
      withContext((ctx, dir: string, opts: { name?: string; force?: boolean }) =>
        initCommand(ctx, dir, opts),
      ),
    );

  program
    .command('run')
    .argument('[workflows...]', 'workflow files (default: the project’s workflows)')
    .description('run workflows over their datasets, evaluate every case and apply gates')
    .option(
      '--variant <name>',
      'run a variant (repeat for several; "base" for the defaults)',
      collect,
    )
    .option('--all-variants', 'run the defaults and every variant, then compare them')
    .option('--dataset <file>', 'use another dataset file')
    .option('-i, --input <key=value>', 'run a single case with these inputs (repeatable)', collect)
    .option('--input-json <json>', 'run a single case with inputs from a JSON object')
    .option('--case <id>', 'run only this case (repeatable)', collect)
    .option('--tag <tag>', 'run only cases with this tag (repeatable)', collect)
    .option('--limit <n>', 'run at most n cases')
    .option('--concurrency <n>', 'cases to run in parallel (default: 4)')
    .option('--bail', 'stop at the first case that does not pass')
    .option(
      '--baseline <file>',
      'baseline for regression gates (default: baselines/<workflow>.json if present)',
    )
    .option('--no-baseline', 'ignore any baseline')
    .option('--no-fail', 'exit 0 even when gates fail')
    .addOption(
      new Option(
        '--summary-file <file>',
        'append a Markdown report to this file (e.g. $GITHUB_STEP_SUMMARY)',
      ).env('SCOPE_SUMMARY_FILE'),
    )
    .option('--report-file <file>', 'write the JSON report to this file (as --json prints it)')
    .option('--junit-file <file>', 'write a JUnit XML report (GitLab, Jenkins, CircleCI, Azure)')
    .action(
      withContext((ctx, workflows: string[], opts) => runCommand(ctx, workflows, opts as never)),
    );

  program
    .command('validate')
    .argument('[workflows...]', 'workflow files (default: the project’s workflows)')
    .description('check configuration and workflows without running anything')
    .action(withContext((ctx, files: string[]) => validateCommand(ctx, files)));

  program.commandsGroup('Inspect results:');
  program
    .command('runs')
    .argument('[run]', 'run number or id to show in detail')
    .description('list recent runs, or show one run')
    .option('--workflow <name>', 'only runs of this workflow')
    .option('--limit <n>', 'number of runs to list', '20')
    .action(
      withContext((ctx, ref: string | undefined, opts) => runsCommand(ctx, ref, opts as never)),
    );

  program
    .command('traces')
    .alias('trace')
    .argument('[trace]', 'trace id (or unique prefix) to show as a tree')
    .description('list traces, or show one trace with its spans and evaluations')
    .option('--run <run>', 'only traces from this run')
    .option('--workflow <name>', 'only traces with this name')
    .option('--status <status>', 'ok or error')
    .option('--eval <outcome>', 'passed, failed, errored or none')
    .option('-s, --search <text>', 'search names, case ids, inputs and outputs')
    .option('--model <model>', 'only traces that called this model (provider:model)')
    .option('--limit <n>', 'number of traces to list', '25')
    .option('--full', 'show span inputs and outputs in full')
    .action(
      withContext((ctx, ref: string | undefined, opts) => tracesCommand(ctx, ref, opts as never)),
    );

  program
    .command('compare')
    .argument('<runs...>', 'two to four run numbers, run ids or baseline files')
    .description('compare two runs metric by metric and case by case, or up to four side by side')
    .action(withContext((ctx, runs: string[]) => compareManyCommand(ctx, runs)));

  program
    .command('report')
    .argument('[run]', 'run number or id (default: latest)')
    .description('render a run report as text, markdown or json')
    .option('-f, --format <format>', 'text, markdown, json or junit')
    .option('--baseline <file>', 'compare with this baseline')
    .option('-o, --output <file>', 'write the report to a file')
    .addOption(
      new Option('--dashboard-url <url>', 'link failing cases to a SCOPE dashboard').env(
        'SCOPE_DASHBOARD_URL',
      ),
    )
    .action(
      withContext((ctx, ref: string | undefined, opts) => reportCommand(ctx, ref, opts as never)),
    );

  program.commandsGroup('CI and regressions:');
  const baseline = program
    .command('baseline')
    .description('manage baseline files for regression gates');
  baseline
    .command('save')
    .argument('[run]', 'run number or id (default: latest)')
    .description('save a run as the baseline future runs are compared with')
    .option('-o, --output <file>', 'baseline file (default: baselines/<workflow>[.<variant>].json)')
    .option('--force', 'save even if the run failed its gates or covered part of the dataset')
    .action(
      withContext((ctx, ref: string | undefined, opts) =>
        baselineSaveCommand(ctx, ref, opts as never),
      ),
    );

  program
    .command('evaluate')
    .argument('<run>', 'run number or id')
    .description(
      're-score a stored run with the current evaluators, without re-running the workflow',
    )
    .option('--workflow <file>', 'workflow file (default: the file the run used)')
    .option('--no-fail', 'exit 0 even when gates fail')
    .action(withContext((ctx, ref: string, opts) => evaluateCommand(ctx, ref, opts as never)));

  program.commandsGroup('Dashboard and server:');
  program
    .command('ui')
    .description(
      'start the local dashboard for this project (no authentication, this machine only)',
    )
    .addOption(
      new Option('-p, --port <port>', `port to listen on (default: ${DEFAULT_PORT})`).env(
        'SCOPE_PORT',
      ),
    )
    .option('--host <host>', 'address to listen on (default: 127.0.0.1)')
    .option('--open', 'open the dashboard in a browser')
    .option(
      '--insecure-no-auth',
      'allow a non-loopback --host without authentication (anyone who can reach it can read every trace)',
    )
    .addHelpText(
      'after',
      '\nInstrumented apps send traces here with SCOPE_URL=http://127.0.0.1:4700 (the SDK default).',
    )
    .action(withContext((ctx, opts) => uiCommand(ctx, opts as never)));

  program
    .command('server')
    .description('start a shared server with API-key authentication, for teams and deployments')
    .addOption(
      new Option('-p, --port <port>', `port to listen on (default: ${DEFAULT_PORT})`).env(
        'SCOPE_PORT',
      ),
    )
    .addOption(
      new Option('--host <host>', 'address to listen on (default: 0.0.0.0)').env('SCOPE_HOST'),
    )
    .addHelpText(
      'after',
      `
Storage comes from SCOPE_DATABASE_URL (e.g. postgres://…) or scope.yaml. Every /api/v1 request
except /api/v1/info needs an API key: create one with \`scope keys create\`.
Logs are JSON lines on stderr (SCOPE_LOG_FORMAT=pretty for text, SCOPE_LOG_LEVEL to filter).`,
    )
    .action(withContext((ctx, opts) => serverCommand(ctx, opts as never)));

  const keys = program.command('keys').description('manage API keys for `scope server`');
  keys
    .command('create')
    .description('create an API key and print it once')
    .option('--name <name>', 'label for the key, e.g. "ci" or "dashboard"')
    .option(
      '--scope <scope>',
      'ingest (send traces) or read (dashboard, API); repeat for both (default: both)',
      collect,
    )
    .option('--project <name>', 'project the key belongs to (default: this project)')
    .action(withContext((ctx, opts) => keysCreateCommand(ctx, opts as never)));
  keys
    .command('list')
    .description('list the project’s API keys (never their secrets)')
    .option('--project <name>', 'project (default: this project)')
    .action(withContext((ctx, opts) => keysListCommand(ctx, opts as never)));
  keys
    .command('revoke')
    .argument('<key>', 'key id (or a unique prefix of it) from `scope keys list`')
    .description('revoke an API key; requests using it fail from then on')
    .option('--project <name>', 'project (default: this project)')
    .action(withContext((ctx, ref: string, opts) => keysRevokeCommand(ctx, ref, opts as never)));

  program.commandsGroup('Diagnostics:');
  program.helpCommand('help [command]', 'show help for a command');
  program
    .command('doctor')
    .description('check Node.js, configuration, datasets, baselines, storage and providers')
    .option('--network', 'also ask each provider in use for its models (read-only, no tokens)')
    .action(withContext((ctx, opts: { network?: boolean }) => doctorCommand(ctx, opts)));
  program
    .command('version')
    .description('show version information')
    .action(
      withContext(async (ctx) => {
        const info = {
          scope: SCOPE_VERSION,
          node: process.versions.node,
          platform: `${process.platform}-${process.arch}`,
        };
        ctx.out.emitJson(info);
        ctx.out.result(
          `scope ${info.scope} ${ctx.out.style.dim(`(node ${info.node}, ${info.platform})`)}`,
        );
      }),
    );

  try {
    if (argv.length === 0) {
      program.outputHelp();
      return ExitCode.ok;
    }
    await program.parseAsync(argv, { from: 'user' });
    return ExitCode.ok;
  } catch (error) {
    failure = error;
    if (error instanceof CommanderError) {
      if (
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version' ||
        error.code === 'commander.help'
      )
        return ExitCode.ok;
      return ExitCode.usage;
    }
    return exitCodeFor(error);
  } finally {
    if (failure && !(failure instanceof CommanderError)) {
      const ctx = lastContext as CommandContext | null;
      renderError(failure, ctx?.out ?? new Output({ json: argv.includes('--json') }));
    }
    for (const ctx of contexts) await ctx.close().catch(() => {});
  }
}
