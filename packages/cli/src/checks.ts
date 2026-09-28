/**
 * Checks of a project's datasets and baselines, shared by `scope validate` and `scope doctor`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  baselineFileName,
  ConfigError,
  type Dataset,
  type Diagnostic,
  type LoadedWorkflow,
  loadDataset,
  prepareCases,
  type ResolvedProject,
  readBaseline,
} from '@scope-ai/config';
import { errorMessage, formatRelativeTime, isScopeError } from '@scope-ai/core';

export interface Finding {
  status: 'pass' | 'warn' | 'fail' | 'info';
  message: string;
  hint?: string;
}

/**
 * Loads a workflow's dataset and checks every case against the declared inputs. Null when the
 * workflow has no dataset (it runs with --input or --dataset).
 */
export function checkDataset(
  loaded: LoadedWorkflow,
  project: ResolvedProject,
): { dataset: Dataset | null; diagnostics: Diagnostic[] } | null {
  const ref = loaded.definition.dataset;
  if (!ref) return null;
  try {
    const dataset = loadDataset(ref, {
      baseDir: resolve(loaded.path, '..'),
      root: project.root,
      workflowName: loaded.definition.name,
    });
    const { warnings } = prepareCases(dataset, loaded.definition.inputs);
    return { dataset, diagnostics: warnings };
  } catch (error) {
    if (error instanceof ConfigError) return { dataset: null, diagnostics: error.diagnostics };
    throw error;
  }
}

const REGRESSION_CONDITIONS = [
  'max_decrease',
  'max_increase',
  'max_decrease_pct',
  'max_increase_pct',
];

/**
 * The baselines a workflow and its variants would be compared with, and whether they still fit:
 * readable, for this workflow, saved from the current dataset. Returns the paths it looked at, so
 * the caller can find baseline files that nothing uses.
 */
export function checkBaselines(
  loaded: LoadedWorkflow,
  dataset: Dataset | null,
  project: ResolvedProject,
  cwd: string,
): { findings: Finding[]; paths: string[] } {
  const wf = loaded.definition;
  const findings: Finding[] = [];
  const paths: string[] = [];
  const hasRegressionGates = (wf.gates ?? []).some((g) =>
    REGRESSION_CONDITIONS.some((k) => (g as Record<string, unknown>)[k] !== undefined),
  );
  for (const variant of [null, ...Object.keys(wf.variants ?? {})]) {
    const path = join(project.baselinesDir, baselineFileName(wf.name, variant));
    const display = relative(cwd, path) || path;
    paths.push(path);
    if (!existsSync(path)) {
      // A missing variant baseline is normal; a missing workflow baseline is worth knowing.
      if (variant === null)
        findings.push({
          status: hasRegressionGates ? 'warn' : 'info',
          message: `${wf.name}: no baseline${hasRegressionGates ? ', so its regression gates are skipped' : ''}`,
          hint: `Save one from a run you trust: scope run ${loaded.displayPath}, then scope baseline save.`,
        });
      continue;
    }
    try {
      const baseline = readBaseline(path, display);
      if (baseline.workflow !== wf.name) {
        findings.push({
          status: 'fail',
          message: `${display} is a baseline of workflow "${baseline.workflow}", not "${wf.name}"`,
          hint: `Rename it to ${baselineFileName(baseline.workflow, null)}, or save a new one with scope baseline save.`,
        });
      } else if (dataset && baseline.dataset && baseline.dataset.hash !== dataset.hash) {
        findings.push({
          status: 'warn',
          message: `${display}: the dataset changed since it was saved (${baseline.dataset.caseCount} → ${dataset.cases.length} cases)`,
          hint: 'Cases added, changed or removed since then are not compared. Save a new baseline once a run looks right.',
        });
      } else {
        findings.push({
          status: 'pass',
          message: `${display} — run #${baseline.source.runNumber}, saved ${formatRelativeTime(Date.parse(baseline.createdAt))}`,
        });
      }
    } catch (error) {
      findings.push({
        status: 'fail',
        message: errorMessage(error),
        ...(isScopeError(error) && error.hint ? { hint: error.hint } : {}),
      });
    }
  }
  return { findings, paths };
}

/** Baseline files that no workflow or variant would be compared with. */
export function unusedBaselines(project: ResolvedProject, used: ReadonlySet<string>): string[] {
  if (!existsSync(project.baselinesDir)) return [];
  return readdirSync(project.baselinesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(project.baselinesDir, f))
    .filter((p) => !used.has(p))
    .sort();
}
