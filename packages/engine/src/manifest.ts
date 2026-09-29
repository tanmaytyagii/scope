/**
 * What produced a run, as far as the workflow's own files go: the code of `function` steps, of
 * custom evaluators, and the documents retrieval searches. Each is fingerprinted with SHA-256
 * when the run starts, so a comparison can say "the retrieval corpus changed" instead of leaving
 * a moved score unexplained.
 *
 * Only the files the workflow names are hashed — not what those modules import, and not
 * arguments decided per case (templates over inputs or earlier steps).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { ManifestFile, RunManifest } from '@scope-ai/core';
import { JUDGE_PROMPT_VERSION } from '@scope-ai/evaluators';
import { CORPUS_EXTENSIONS } from './corpus.ts';
import type { PreparedWorkflow } from './engine.ts';
import { expandGlob } from './glob.ts';
import { isModulePath } from './modules.ts';
import { renderStatic } from './validate.ts';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function fileHash(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

/** The files a prepared workflow names, fingerprinted. Unreadable or dynamic ones are skipped. */
export function workflowFiles(prepared: PreparedWorkflow): ManifestFile[] {
  const scope = { params: prepared.params, variant: prepared.variant };
  const files: ManifestFile[] = [];
  const seen = new Set<string>();
  const add = (file: ManifestFile) => {
    const key = `${file.kind} ${file.ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };
  for (const step of prepared.definition.steps) {
    const rendered = renderStatic(step.with ?? {}, scope);
    const args = rendered.value as Record<string, unknown>;
    if (
      step.type === 'function' &&
      typeof args.module === 'string' &&
      !args.module.includes('{{')
    ) {
      const hash = fileHash(resolve(prepared.baseDir, args.module));
      if (hash) add({ kind: 'module', ref: args.module, sha256: hash });
    }
    if (step.type === 'retrieve') {
      const patterns =
        typeof args.corpus === 'string'
          ? [args.corpus]
          : Array.isArray(args.corpus)
            ? args.corpus
            : [];
      for (const pattern of patterns) {
        if (typeof pattern !== 'string' || pattern.includes('{{')) continue;
        const matched = [
          ...new Set(expandGlob(pattern, prepared.baseDir, CORPUS_EXTENSIONS)),
        ].sort();
        if (matched.length === 0) continue;
        // Paths (relative, so the same corpus hashes the same on any machine) and contents.
        const digest = createHash('sha256');
        for (const path of matched) {
          digest.update(relative(prepared.baseDir, path));
          digest.update('\0');
          digest.update(fileHash(path) ?? 'unreadable');
          digest.update('\0');
        }
        add({ kind: 'corpus', ref: pattern, sha256: digest.digest('hex'), files: matched.length });
      }
    }
  }
  for (const evaluator of prepared.evaluators) {
    if (!isModulePath(evaluator.config.type)) continue;
    const hash = fileHash(resolve(prepared.baseDir, evaluator.config.type));
    if (hash) add({ kind: 'evaluator', ref: evaluator.config.type, sha256: hash });
  }
  return files;
}

/** The manifest of a run about to start; `models` is filled in when it ends. */
export function runManifest(prepared: PreparedWorkflow, scopeVersion: string): RunManifest {
  return {
    scope: scopeVersion,
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    files: workflowFiles(prepared),
    evaluators: prepared.evaluators.map((e) => {
      const args = (e.config.with ?? {}) as Record<string, unknown>;
      const model =
        e.definition.kind === 'model' && typeof args.model === 'string' ? args.model : null;
      return {
        name: e.name,
        type: e.config.type,
        kind: e.definition.kind,
        ...(model ? { judgeModel: model } : {}),
        ...(e.definition.type === 'llm_judge' ? { promptVersion: JUDGE_PROMPT_VERSION } : {}),
      };
    }),
    models: [],
  };
}
