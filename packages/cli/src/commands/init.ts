/**
 * scope init [dir] — create a project that runs and evaluates offline immediately.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { projectJsonSchema, slugify, workflowJsonSchema } from '@scope-ai/config';
import { ErrorCodes, ScopeError } from '@scope-ai/core';
import type { CommandContext } from '../context.ts';
import { GITIGNORE_ENTRY, starterTemplate } from '../templates.ts';

export interface InitOptions {
  force?: boolean;
  name?: string;
}

const DESCRIPTIONS: Record<string, string> = {
  'scope.yaml': 'project settings: storage, providers, privacy',
  'workflows/support.yaml': 'a retrieval-augmented support workflow with evaluators and gates',
  'datasets/support.jsonl': 'test cases with the facts each answer must contain',
  'docs/': 'the help center the workflow answers from',
};

export async function initCommand(
  ctx: CommandContext,
  dir: string | undefined,
  options: InitOptions,
): Promise<void> {
  const out = ctx.out;
  const s = out.style;
  const root = resolve(ctx.cwd, dir ?? '.');
  const name = slugify(options.name ?? basename(root));
  const files = starterTemplate(name);

  const conflicts = files.filter((f) => existsSync(join(root, f.path)));
  if (conflicts.length > 0 && !options.force) {
    throw new ScopeError(
      ErrorCodes.usage,
      `scope init would overwrite ${conflicts.length === 1 ? 'a file' : `${conflicts.length} files`}: ${conflicts.map((f) => f.path).join(', ')}`,
      {
        hint: 'Run it in an empty directory, pass a directory name (scope init my-project), or use --force to overwrite.',
      },
    );
  }

  for (const file of files) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }

  const gitignore = join(root, '.gitignore');
  const existing = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  if (
    !existing
      .split(/\r?\n/)
      .some((line) => line.trim() === GITIGNORE_ENTRY || line.trim() === '.scope')
  ) {
    appendFileSync(
      gitignore,
      `${existing && !existing.endsWith('\n') ? '\n' : ''}# SCOPE local data\n${GITIGNORE_ENTRY}\n`,
    );
  }

  const schemas = join(root, '.scope', 'schemas');
  mkdirSync(schemas, { recursive: true });
  writeFileSync(
    join(schemas, 'workflow.schema.json'),
    `${JSON.stringify(workflowJsonSchema(), null, 2)}\n`,
  );
  writeFileSync(
    join(schemas, 'project.schema.json'),
    `${JSON.stringify(projectJsonSchema(), null, 2)}\n`,
  );

  // Below the current directory: a relative path; anywhere else: the absolute one.
  const inside = relative(ctx.cwd, root);
  const where = inside === '' ? '.' : inside.startsWith('..') ? root : `./${inside}`;
  out.emitJson({ root, project: name, files: files.map((f) => f.path) });
  out.print('');
  out.print(
    `${s.green(out.sym.pass)} Created SCOPE project ${s.bold(name)} in ${s.bold(where === '.' ? 'the current directory' : where)}`,
  );
  out.print('');
  for (const [path, description] of Object.entries(DESCRIPTIONS)) {
    out.print(`  ${path.padEnd(24)} ${s.dim(description)}`);
  }
  out.print('');
  out.print(s.bold('Next'));
  if (where !== '.') out.print(`  cd ${/\s/.test(where) ? JSON.stringify(where) : where}`);
  out.print(
    `  scope run         ${s.dim('# run and evaluate the workflow — offline, no API key')}`,
  );
  out.print(`  scope ui --open   ${s.dim('# explore its traces and evaluations')}`);
  out.print('');
  out.print(
    s.dim(
      '  The workflow uses local:extractive, a deterministic offline stand-in. Change params.model',
    ),
  );
  out.print(
    s.dim(
      '  in workflows/support.yaml to anthropic:claude-opus-5 or openai:gpt-5 to evaluate a real model.',
    ),
  );
  out.print('');
}
