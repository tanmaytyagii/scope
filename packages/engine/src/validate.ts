/**
 * Plugin-aware workflow validation: step and evaluator types, their arguments, model references,
 * and referenced files. Runs before any step executes (and in `scope validate`).
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type Diagnostic,
  forEachString,
  issuesToDiagnostics,
  isTemplate,
  knownKeysAt,
  type LoadedWorkflow,
  type PathSegment,
  positioned,
  renderTemplate,
  resolveParams,
  templateReferences,
} from '@scope-ai/config';
import { suggest } from '@scope-ai/core';
import { type EvaluatorRegistry, RESERVED_ARGS } from '@scope-ai/evaluators';
import { type ProviderRegistry, parseModelRef } from '@scope-ai/providers';
import { CORPUS_EXTENSIONS } from './corpus.ts';
import { expandGlob } from './glob.ts';
import { isModulePath } from './modules.ts';
import type { StepRegistry } from './steps.ts';

export interface ValidationContext {
  steps: StepRegistry;
  evaluators: EvaluatorRegistry;
  providers: ProviderRegistry;
  /** Validate only this variant; by default the base params and every variant are checked. */
  variant?: string | null;
}

const STATIC_ROOTS = new Set(['params', 'variant']);

/** Renders templates that only depend on params/variant; returns whether templates remain. */
function renderStatic(
  value: unknown,
  scope: Record<string, unknown>,
): { value: unknown; dynamic: boolean } {
  let dynamic = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (!isTemplate(v)) return v;
      try {
        const refs = templateReferences(v);
        if (
          refs.every((r) => typeof r.segments[0] === 'string' && STATIC_ROOTS.has(r.segments[0]))
        ) {
          return renderTemplate(v, scope);
        }
      } catch {
        // Template errors are reported by the config package.
      }
      dynamic = true;
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v)) out[k] = walk(item);
      return out;
    }
    return v;
  };
  return { value: walk(value), dynamic };
}

export function validateWorkflow(loaded: LoadedWorkflow, ctx: ValidationContext): Diagnostic[] {
  const wf = loaded.definition;
  const source = loaded.source;
  const baseDir = dirname(loaded.path);
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const push = (d: Diagnostic) => {
    const key = `${d.line}:${d.column}:${d.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(d);
    }
  };
  const err = (path: PathSegment[], message: string, hint?: string, key = false) =>
    push(positioned(source, path, { severity: 'error', path: fmt(path), message, hint }, { key }));
  const warn = (path: PathSegment[], message: string, hint?: string) =>
    push(positioned(source, path, { severity: 'warning', path: fmt(path), message, hint }));

  const variants: Array<string | null> =
    ctx.variant !== undefined ? [ctx.variant] : [null, ...Object.keys(wf.variants ?? {})];
  const scopes = variants.map((variant) => ({ params: resolveParams(wf, variant), variant }));

  const checkModel = (path: PathSegment[], ref: unknown, params: { temperature?: unknown }) => {
    if (typeof ref !== 'string' || isTemplate(ref)) return;
    let parsed: { provider: string; model: string };
    try {
      parsed = parseModelRef(ref);
    } catch {
      err(
        path,
        `"${ref}" is not a model reference`,
        'Use provider:model, e.g. openai:gpt-5, anthropic:claude-opus-5 or local:extractive.',
      );
      return;
    }
    if (!ctx.providers.has(parsed.provider)) {
      const guess = suggest(parsed.provider, ctx.providers.names());
      err(
        path,
        `unknown model provider "${parsed.provider}"`,
        guess
          ? `Did you mean "${guess}:${parsed.model}"?`
          : `Providers: ${ctx.providers.names().join(', ')}.`,
      );
      return;
    }
    if (params.temperature !== undefined) {
      const type = ctx.providers.typeOf(parsed.provider);
      const ignored =
        type === 'local'
          ? ['temperature']
          : type === 'anthropic' &&
              /^claude-(?:opus-4-[7-9]|opus-[5-9]|sonnet-[5-9]|fable|mythos)/.test(parsed.model)
            ? ['temperature']
            : type === 'openai' && /^(?:o\d|gpt-5)/.test(parsed.model)
              ? ['temperature']
              : [];
      if (ignored.length) {
        warn(
          path,
          `${ref} does not accept temperature; it will be omitted`,
          'Remove `temperature` for this model, or keep it to document intent — the value is not sent.',
        );
      }
    }
  };

  wf.steps.forEach((step, i) => {
    if (!ctx.steps.has(step.type)) {
      const guess = suggest(
        step.type,
        ctx.steps.list().map((s) => s.type),
      );
      err(
        ['steps', i, 'type'],
        `unknown step type "${step.type}"`,
        guess
          ? `Did you mean "${guess}"?`
          : `Step types: ${ctx.steps
              .list()
              .map((s) => s.type)
              .join(', ')}.`,
      );
      return;
    }
    const stepType = ctx.steps.get(step.type);
    const args = step.with ?? {};
    const known = knownKeysAt(stepType.argsSchema, []);
    for (const key of Object.keys(args)) {
      if (!known.includes(key)) {
        const guess = suggest(key, known);
        err(
          ['steps', i, 'with', key],
          `the ${step.type} step has no argument "${key}"`,
          guess ? `Did you mean "${guess}"?` : `Arguments: ${known.join(', ')}.`,
          true,
        );
      }
    }
    for (const scope of scopes) {
      const rendered = renderStatic(args, scope);
      const staticArgs = rendered.value as Record<string, unknown>;
      if (!rendered.dynamic) {
        const result = stepType.argsSchema.safeParse(staticArgs);
        if (!result.success) {
          for (const d of issuesToDiagnostics(result.error.issues, {
            source,
            schema: stepType.argsSchema,
            data: staticArgs,
            basePath: ['steps', i, 'with'],
          })) {
            if (!d.message.startsWith('unknown key')) push(d);
          }
        }
      }
      if (step.type === 'llm') {
        checkModel(['steps', i, 'with', 'model'], staticArgs.model, {
          temperature: staticArgs.temperature,
        });
        const options = staticArgs.provider_options;
        if (options && typeof options === 'object' && !Array.isArray(options)) {
          const providerNames = [...ctx.providers.names(), 'openai-compatible'];
          for (const key of Object.keys(options)) {
            if (!providerNames.includes(key)) {
              const guess = suggest(key, providerNames);
              err(
                ['steps', i, 'with', 'provider_options', key],
                `provider_options keys are provider names; "${key}" is not a provider`,
                guess
                  ? `Did you mean "${guess}"?`
                  : `Nest options under the provider they are for, e.g. provider_options: { openai: { ${key}: … } }.`,
                true,
              );
            }
          }
        }
      }
      if (step.type === 'retrieve') {
        const corpus = staticArgs.corpus;
        const patterns =
          typeof corpus === 'string' ? [corpus] : Array.isArray(corpus) ? corpus : [];
        for (const pattern of patterns) {
          if (
            typeof pattern === 'string' &&
            !isTemplate(pattern) &&
            expandGlob(pattern, baseDir, CORPUS_EXTENSIONS).length === 0
          ) {
            err(
              ['steps', i, 'with', 'corpus'],
              `no files match corpus "${pattern}"`,
              `Paths are relative to the workflow file. Supported: ${CORPUS_EXTENSIONS.join(', ')}.`,
            );
          }
        }
      }
      if (
        step.type === 'function' &&
        typeof staticArgs.module === 'string' &&
        !isTemplate(staticArgs.module)
      ) {
        if (!existsSync(resolve(baseDir, staticArgs.module))) {
          err(
            ['steps', i, 'with', 'module'],
            `module not found: ${staticArgs.module}`,
            'Paths are relative to the workflow file.',
          );
        }
      }
    }
  });

  const hasRetrieval = wf.steps.some((s) => s.type === 'retrieve' || s.type === 'function');
  (wf.evaluators ?? []).forEach((evaluator, i) => {
    const args = evaluator.with ?? {};
    if (isModulePath(evaluator.type)) {
      if (!existsSync(resolve(baseDir, evaluator.type))) {
        err(
          ['evaluators', i, 'type'],
          `custom evaluator not found: ${evaluator.type}`,
          'Paths are relative to the workflow file.',
        );
      }
      return;
    }
    if (!ctx.evaluators.has(evaluator.type)) {
      const types = ctx.evaluators.list().map((d) => d.type);
      const guess = suggest(evaluator.type, types);
      err(
        ['evaluators', i, 'type'],
        `unknown evaluator type "${evaluator.type}"`,
        guess
          ? `Did you mean "${guess}"?`
          : `Evaluators: ${types.join(', ')}. Custom evaluators are file paths.`,
      );
      return;
    }
    const def = ctx.evaluators.get(evaluator.type);
    const known = [...knownKeysAt(def.argsSchema, []), ...RESERVED_ARGS];
    for (const key of Object.keys(args)) {
      if (!known.includes(key)) {
        const guess = suggest(key, known);
        err(
          ['evaluators', i, 'with', key],
          `the ${evaluator.type} evaluator has no argument "${key}"`,
          guess ? `Did you mean "${guess}"?` : `Arguments: ${known.join(', ')}.`,
          true,
        );
      }
    }
    for (const scope of scopes) {
      const rendered = renderStatic(args, scope);
      const staticArgs = { ...(rendered.value as Record<string, unknown>) };
      for (const r of RESERVED_ARGS) delete staticArgs[r];
      let dynamic = false;
      forEachString(staticArgs, (text) => {
        if (isTemplate(text)) dynamic = true;
      });
      if (!dynamic) {
        const result = def.argsSchema.safeParse(staticArgs);
        if (!result.success) {
          for (const d of issuesToDiagnostics(result.error.issues, {
            source,
            schema: def.argsSchema,
            data: staticArgs,
            basePath: ['evaluators', i, 'with'],
          })) {
            if (!d.message.startsWith('unknown key')) push(d);
          }
        }
      }
      if (def.requires?.includes('model'))
        checkModel(['evaluators', i, 'with', 'model'], staticArgs.model, {});
    }
    if (def.requires?.includes('context') && args.context === undefined && !hasRetrieval) {
      warn(
        ['evaluators', i],
        `${evaluator.type} needs context, and this workflow has no retrieve step`,
        'Set `with.context` to the reference text, or the evaluator will be skipped.',
      );
    }
    if (evaluator.threshold !== undefined && def.kind === 'deterministic') {
      warn(
        ['evaluators', i, 'threshold'],
        `threshold has no effect on the deterministic ${evaluator.type} evaluator`,
        'Deterministic evaluators pass or fail on their rule; remove `threshold`.',
      );
    }
  });
  return out;
}

function fmt(path: PathSegment[]): string {
  let out = '';
  for (const seg of path) out += typeof seg === 'number' ? `[${seg}]` : out ? `.${seg}` : seg;
  return out || '(root)';
}
