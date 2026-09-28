/**
 * Workflow loading and structural/semantic validation.
 *
 * Step and evaluator *types* (and their `with:` arguments) are validated by the engine, which
 * owns the registries; this module validates everything that does not depend on plugins.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  describeMetric,
  ErrorCodes,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  parseEvaluatorMetric,
  suggest,
} from '@scope-ai/core';
import { ConfigError, type Diagnostic, hasErrors, type PathSegment } from './diagnostics.ts';
import { resolveEnvDeep } from './env.ts';
import type { Env } from './project.ts';
import { type WorkflowFile, WorkflowSchema } from './schema.ts';
import { parseYaml, positioned, type SourceFile } from './source.ts';
import { forEachString, TemplateError, templateReferences } from './template.ts';
import { issuesToDiagnostics } from './validate.ts';

export interface LoadedWorkflow {
  /** Absolute path of the workflow file. */
  path: string;
  /** Path relative to the project root, for display. */
  displayPath: string;
  definition: WorkflowFile;
  /** Raw file text, as committed (environment references unresolved). */
  text: string;
  /** SHA-256 of the raw text; identifies a workflow version. */
  hash: string;
  source: SourceFile;
  diagnostics: Diagnostic[];
}

/** Template roots available in each part of a workflow. */
const ROOTS = {
  step: ['inputs', 'params', 'steps', 'case', 'variant'],
  output: ['inputs', 'params', 'steps', 'case', 'variant'],
  evaluator: ['inputs', 'params', 'steps', 'outputs', 'expected', 'case', 'variant', 'trace'],
} as const;

const STEP_FIELDS = ['output', 'status', 'duration_ms', 'error'];

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function evaluatorName(e: { name?: string | undefined; type: string }): string {
  return (
    e.name ??
    e.type
      .replace(/^.*[/\\]/, '')
      .replace(/\.[a-z]+$/, '')
      .replace(/[^a-z0-9_-]/gi, '_')
      .toLowerCase()
  );
}

export interface LoadWorkflowOptions {
  root: string;
  env?: Env;
}

export function loadWorkflow(file: string, options: LoadWorkflowOptions): LoadedWorkflow {
  const path = resolve(options.root, file);
  const displayPath = relative(options.root, path) || path;
  if (!existsSync(path)) {
    throw new ConfigError(
      [
        {
          severity: 'error',
          message: `Workflow file not found: ${displayPath}`,
          hint: 'Check the path. Workflow files are YAML, usually under workflows/. Run `scope init` to create an example.',
        },
      ],
      {},
      ErrorCodes.configNotFound,
    );
  }
  const text = readFileSync(path, 'utf8');
  return parseWorkflow(text, { path, displayPath, env: options.env ?? process.env });
}

export function parseWorkflow(
  text: string,
  options: { path: string; displayPath?: string; env?: Env },
): LoadedWorkflow {
  const displayPath = options.displayPath ?? options.path;
  const parsed = parseYaml(text, displayPath);
  const source = parsed.source;
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];
  const sources = { [displayPath]: text };
  if (hasErrors(diagnostics)) throw new ConfigError(diagnostics, sources);

  if (!isJsonObject(parsed.data as JsonValue)) {
    throw new ConfigError(
      [
        {
          severity: 'error',
          file: displayPath,
          line: 1,
          column: 1,
          message: 'a workflow file must be a YAML mapping',
          hint: 'Start with `version: 1` and `name: my-workflow`. Run `scope init` for a complete example.',
        },
      ],
      sources,
    );
  }

  const result = WorkflowSchema.safeParse(parsed.data);
  if (!result.success) {
    const found = issuesToDiagnostics(result.error.issues, {
      source,
      schema: WorkflowSchema,
      data: parsed.data,
    });
    for (const d of found) {
      // An unknown key directly on a step or evaluator is almost always a misplaced argument.
      const owner = /^(steps|evaluators)\[\d+\]$/.exec(d.path ?? '')?.[1];
      if (owner && d.message.startsWith('unknown key') && !d.hint?.startsWith('Did you mean')) {
        const key = /"([^"]+)"/.exec(d.message)?.[1] ?? 'key';
        d.hint =
          `${owner === 'steps' ? 'Step' : 'Evaluator'} arguments go under \`with:\`, e.g. \`with: { ${key}: … }\`. ${d.hint ?? ''}`.trim();
      }
    }
    diagnostics.push(...found);
    throw new ConfigError(diagnostics, sources);
  }

  const { value: definition, missing } = resolveEnvDeep(result.data, options.env ?? process.env);
  for (const m of missing) {
    diagnostics.push(
      positioned(source, m.path, {
        severity: 'error',
        path: m.path.join('.'),
        message: `environment variable ${m.name} is not set`,
        hint: `Export ${m.name}, or give a default with \${env:${m.name}:-value}.`,
      }),
    );
  }

  diagnostics.push(...checkSemantics(definition, source));
  if (hasErrors(diagnostics)) throw new ConfigError(diagnostics, sources);

  return {
    path: options.path,
    displayPath,
    definition,
    text,
    hash: hashText(text),
    source,
    diagnostics,
  };
}

function checkSemantics(wf: WorkflowFile, source: SourceFile): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (path: PathSegment[], message: string, hint?: string, key = false) =>
    out.push(
      positioned(source, path, { severity: 'error', path: pathText(path), message, hint }, { key }),
    );
  const warn = (path: PathSegment[], message: string, hint?: string) =>
    out.push(
      positioned(source, path, { severity: 'warning', path: pathText(path), message, hint }),
    );

  // Unique step ids.
  const stepIndex = new Map<string, number>();
  wf.steps.forEach((step, i) => {
    if (stepIndex.has(step.id)) {
      err(
        ['steps', i, 'id'],
        `duplicate step id "${step.id}"`,
        `Step ids must be unique; "${step.id}" is already used by steps[${stepIndex.get(step.id)}].`,
      );
    } else stepIndex.set(step.id, i);
  });

  // Unique evaluator names.
  const evaluatorNames = new Map<string, number>();
  (wf.evaluators ?? []).forEach((e, i) => {
    const name = evaluatorName(e);
    if (evaluatorNames.has(name)) {
      err(
        ['evaluators', i, e.name ? 'name' : 'type'],
        `duplicate evaluator name "${name}"`,
        'Give each evaluator a unique `name:`; it identifies the evaluator in reports and gates.',
      );
    } else evaluatorNames.set(name, i);
  });

  // Variants may only override declared params.
  const paramNames = Object.keys(wf.params ?? {});
  for (const [variant, overrides] of Object.entries(wf.variants ?? {})) {
    for (const key of Object.keys(overrides)) {
      if (!paramNames.includes(key)) {
        const guess = suggest(key, paramNames);
        err(
          ['variants', variant, key],
          `variant "${variant}" overrides "${key}", which is not declared in params`,
          guess
            ? `Did you mean "${guess}"?`
            : `Declare it under params: with a default value first.`,
          true,
        );
      }
    }
  }

  const inputNames = wf.inputs ? Object.keys(wf.inputs) : null;
  const outputNames = Object.keys(wf.outputs ?? {});
  const stepIds = wf.steps.map((s) => s.id);

  const checkTemplates = (
    value: unknown,
    basePath: PathSegment[],
    context: keyof typeof ROOTS,
    stepPosition: number | null,
  ) => {
    forEachString(value, (text, rel) => {
      const path = [...basePath, ...rel];
      let refs: ReturnType<typeof templateReferences>;
      try {
        refs = templateReferences(text);
      } catch (error) {
        if (error instanceof TemplateError) {
          err(path, error.message, error.hint);
          return;
        }
        throw error;
      }
      for (const ref of refs) {
        const [root, name, field] = ref.segments;
        const allowed: readonly string[] = ROOTS[context];
        if (typeof root !== 'string' || !allowed.includes(root)) {
          const guess = typeof root === 'string' ? suggest(root, allowed) : undefined;
          err(
            path,
            `{{ ${ref.expression} }}: "${String(root)}" is not available here`,
            guess
              ? `Did you mean "${guess}"? Available: ${allowed.join(', ')}.`
              : `Available: ${allowed.join(', ')}.`,
          );
          continue;
        }
        if (ref.optional || typeof name !== 'string') continue;
        if (root === 'inputs' && inputNames && !inputNames.includes(name)) {
          const guess = suggest(name, inputNames);
          err(
            path,
            `{{ ${ref.expression} }}: no input named "${name}"`,
            guess
              ? `Did you mean "${guess}"?`
              : `Declared inputs: ${inputNames.join(', ') || '(none)'}.`,
          );
        }
        if (root === 'params' && !paramNames.includes(name)) {
          const guess = suggest(name, paramNames);
          err(
            path,
            `{{ ${ref.expression} }}: no param named "${name}"`,
            guess ? `Did you mean "${guess}"?` : 'Declare it under params:.',
          );
        }
        if (root === 'outputs' && !outputNames.includes(name)) {
          const guess = suggest(name, outputNames);
          err(
            path,
            `{{ ${ref.expression} }}: no output named "${name}"`,
            guess
              ? `Did you mean "${guess}"?`
              : `Declared outputs: ${outputNames.join(', ') || '(none)'}.`,
          );
        }
        if (root === 'steps') {
          const index = stepIndex.get(name);
          if (index === undefined) {
            const guess = suggest(name, stepIds);
            err(
              path,
              `{{ ${ref.expression} }}: no step with id "${name}"`,
              guess ? `Did you mean "${guess}"?` : `Step ids: ${stepIds.join(', ')}.`,
            );
          } else if (stepPosition !== null && index >= stepPosition) {
            err(
              path,
              `{{ ${ref.expression} }}: step "${name}" has not run yet at this point`,
              'A step can only read the outputs of steps listed before it.',
            );
          } else if (typeof field === 'string' && !STEP_FIELDS.includes(field)) {
            const guess = suggest(field, STEP_FIELDS);
            err(
              path,
              `{{ ${ref.expression} }}: steps have no field "${field}"`,
              guess ? `Did you mean "${guess}"?` : `Step fields: ${STEP_FIELDS.join(', ')}.`,
            );
          }
        }
      }
    });
  };

  wf.steps.forEach((step, i) => {
    checkTemplates(step.with ?? {}, ['steps', i, 'with'], 'step', i);
  });
  checkTemplates(wf.outputs ?? {}, ['outputs'], 'output', null);
  (wf.evaluators ?? []).forEach((e, i) => {
    checkTemplates(e.with ?? {}, ['evaluators', i, 'with'], 'evaluator', null);
  });

  // Gates must name real metrics and configured evaluators.
  (wf.gates ?? []).forEach((gate, i) => {
    const ev = parseEvaluatorMetric(gate.metric);
    if (ev) {
      if (!evaluatorNames.has(ev.evaluator)) {
        const guess = suggest(ev.evaluator, [...evaluatorNames.keys()]);
        err(
          ['gates', i, 'metric'],
          `gate refers to evaluator "${ev.evaluator}", which is not configured`,
          guess
            ? `Did you mean "evaluator.${guess}.${ev.field}"?`
            : `Configured evaluators: ${[...evaluatorNames.keys()].join(', ') || '(none)'}.`,
        );
      }
    } else if (!describeMetric(gate.metric)) {
      const known = [
        'pass_rate',
        'error_rate',
        'latency.p50_ms',
        'latency.p95_ms',
        'latency.mean_ms',
        'latency.max_ms',
        'tokens.total',
        'tokens.mean_per_case',
        'cost.total_usd',
        'cost.mean_per_case_usd',
      ];
      const guess = suggest(gate.metric, known);
      err(
        ['gates', i, 'metric'],
        `unknown metric "${gate.metric}"`,
        guess
          ? `Did you mean "${guess}"?`
          : `Metrics: ${known.join(', ')}, evaluator.<name>.pass_rate, evaluator.<name>.mean_score.`,
      );
    }
  });

  if (!wf.dataset) {
    const required = Object.entries(wf.inputs ?? {}).filter(
      ([, spec]) => spec.required !== false && spec.default === undefined,
    );
    if (required.length > 0) {
      warn(
        [],
        'no dataset is configured',
        `Add \`dataset: datasets/${wf.name}.jsonl\`, or pass inputs with --input ${required[0]?.[0]}=...`,
      );
    }
  }
  return out;
}

function pathText(path: PathSegment[]): string {
  let out = '';
  for (const seg of path) out += typeof seg === 'number' ? `[${seg}]` : out ? `.${seg}` : seg;
  return out || '(root)';
}

/** Params for a run: workflow params with the variant's overrides applied. */
export function resolveParams(wf: WorkflowFile, variant: string | null | undefined): JsonObject {
  const base = (wf.params ?? {}) as JsonObject;
  if (!variant) return { ...base };
  const variants = wf.variants ?? {};
  const overrides = variants[variant];
  if (!overrides) {
    const names = Object.keys(variants);
    const guess = suggest(variant, names);
    throw new ConfigError([
      {
        severity: 'error',
        message: `workflow "${wf.name}" has no variant "${variant}"`,
        hint: guess
          ? `Did you mean "${guess}"?`
          : names.length
            ? `Variants: ${names.join(', ')}.`
            : 'This workflow defines no variants.',
      },
    ]);
  }
  return { ...base, ...(overrides as JsonObject) };
}
