/**
 * scope validate [workflows...] — check configuration without executing anything.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { ConfigError, type Diagnostic, loadWorkflow, renderDiagnostic } from '@scope-ai/config';
import { ErrorCodes, ScopeError } from '@scope-ai/core';
import { Engine, expandGlob } from '@scope-ai/engine';
import type { CommandContext } from '../context.ts';
import { ExitCode, ExitError } from '../errors.ts';

export function discoverWorkflows(ctx: CommandContext): string[] {
  const project = ctx.project();
  const files = [
    ...new Set(
      project.workflowGlobs.flatMap((g) => expandGlob(g, project.root, ['.yaml', '.yml'])),
    ),
  ];
  return files.map((f) => relative(ctx.cwd, f) || f);
}

export async function validateCommand(ctx: CommandContext, files: string[]): Promise<void> {
  const out = ctx.out;
  const s = out.errStyle;
  const project = ctx.project();
  ctx.writeSchemas();
  const targets = files.length ? files : discoverWorkflows(ctx);
  if (targets.length === 0) {
    throw new ScopeError(ErrorCodes.usage, 'No workflow files found', {
      hint: `Looked for ${project.workflowGlobs.join(', ')} under ${relative(ctx.cwd, project.root) || '.'}. Pass a path, or run \`scope init\`.`,
    });
  }
  const engine = new Engine({ project, exporter: { export: () => {} }, env: ctx.env });
  const results: Array<{
    path: string;
    name: string | null;
    valid: boolean;
    diagnostics: Diagnostic[];
    details: string | null;
  }> = [];
  const styler = { error: s.red, warning: s.yellow, dim: s.dim, bold: s.bold, accent: s.cyan };

  for (const file of targets) {
    let diagnostics: Diagnostic[] = [];
    let name: string | null = null;
    let details: string | null = null;
    let sourceText: string | undefined;
    try {
      const loaded = loadWorkflow(file, { root: ctx.cwd, env: ctx.env });
      sourceText = loaded.text;
      name = loaded.definition.name;
      diagnostics = [...loaded.diagnostics, ...engine.validate(loaded)];
      const wf = loaded.definition;
      const variants = Object.keys(wf.variants ?? {}).length;
      details = [
        `${wf.steps.length} ${wf.steps.length === 1 ? 'step' : 'steps'}`,
        `${wf.evaluators?.length ?? 0} evaluators`,
        `${wf.gates?.length ?? 0} gates`,
        variants ? `${variants} ${variants === 1 ? 'variant' : 'variants'}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      diagnostics = error.diagnostics;
      sourceText = Object.values(error.sources)[0];
    }
    const valid = !diagnostics.some((d) => d.severity === 'error');
    results.push({ path: file, name, valid, diagnostics, details });
    if (!out.json) {
      out.stderr.write(
        `${valid ? s.green(out.sym.pass) : s.red(out.sym.fail)} ${s.bold(file)}${name ? s.dim(`  ${name}`) : ''}${details ? s.dim(` · ${details}`) : ''}\n`,
      );
      for (const d of diagnostics) {
        let text = sourceText;
        if (!text && d.file) {
          try {
            text = readFileSync(d.file, 'utf8');
          } catch {
            text = undefined;
          }
        }
        out.stderr.write(`\n${renderDiagnostic(d, text, styler)}\n\n`);
      }
    }
  }

  const errors = results.reduce(
    (n, r) => n + r.diagnostics.filter((d) => d.severity === 'error').length,
    0,
  );
  const warnings = results.reduce(
    (n, r) => n + r.diagnostics.filter((d) => d.severity === 'warning').length,
    0,
  );
  out.emitJson({ valid: errors === 0, errors, warnings, workflows: results });
  if (!out.json) {
    const summary = `${results.length} ${results.length === 1 ? 'workflow' : 'workflows'} · ${errors} ${errors === 1 ? 'error' : 'errors'} · ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`;
    out.stderr.write(
      `\n${errors ? s.red(summary) : warnings ? s.yellow(summary) : s.green(summary)}\n`,
    );
  }
  if (errors > 0) throw new ExitError(ExitCode.usage);
}
