/**
 * Project discovery and `scope.yaml` loading.
 *
 * A project is the nearest directory (walking up from the working directory) that contains
 * `scope.yaml`. Without one, the working directory is the project and defaults apply, so
 * `scope run workflow.yaml` works in any directory.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { ErrorCodes, type ModelPrice, type PrivacyOptions } from '@scope-ai/core';
import { ConfigError, type Diagnostic, hasErrors } from './diagnostics.ts';
import { resolveEnvDeep } from './env.ts';
import { type ProjectConfigFile, ProjectConfigSchema, type ProviderSettings } from './schema.ts';
import { parseYaml, positioned, type SourceFile } from './source.ts';
import { issuesToDiagnostics } from './validate.ts';

export const PROJECT_FILENAMES = ['scope.yaml', 'scope.yml'] as const;
export const DEFAULT_STORAGE_URL = 'sqlite:.scope/scope.db';
export const DEFAULT_CONCURRENCY = 4;

export type Env = Readonly<Record<string, string | undefined>>;

export interface ResolvedProvider extends ProviderSettings {
  name: string;
  /** Environment variables referenced by this provider's settings that are not set. */
  missingEnv: string[];
}

export interface ResolvedProject {
  root: string;
  configPath: string | null;
  name: string;
  storage: { url: string; source: 'env' | 'config' | 'default' };
  providers: Record<string, ResolvedProvider>;
  pricing: Record<string, ModelPrice>;
  privacy: PrivacyOptions;
  defaults: { concurrency: number; timeoutMs: number | null };
  workflowGlobs: string[];
  baselinesDir: string;
  source: SourceFile | null;
  diagnostics: Diagnostic[];
}

export function findProjectRoot(start: string): { root: string; configPath: string | null } {
  let dir = resolve(start);
  for (;;) {
    for (const name of PROJECT_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return { root: dir, configPath: candidate };
    }
    const parent = dirname(dir);
    if (parent === dir) return { root: resolve(start), configPath: null };
    dir = parent;
  }
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
  return slug || 'default';
}

/** Makes relative SQLite paths absolute against the project root. */
export function resolveStorageUrl(url: string, root: string): string {
  if (url.startsWith('sqlite:')) {
    const path = url.slice('sqlite:'.length).replace(/^\/\/(?=\/)/, '');
    if (path === ':memory:') return url;
    return `sqlite:${isAbsolute(path) ? path : resolve(root, path)}`;
  }
  return url;
}

export interface LoadProjectOptions {
  cwd: string;
  /** Explicit path to scope.yaml (overrides discovery). */
  configPath?: string;
  env?: Env;
}

export function loadProject(options: LoadProjectOptions): ResolvedProject {
  const env = options.env ?? process.env;
  let root: string;
  let configPath: string | null;
  if (options.configPath) {
    configPath = resolve(options.cwd, options.configPath);
    if (!existsSync(configPath)) {
      throw new ConfigError(
        [
          {
            severity: 'error',
            message: `Project configuration not found: ${options.configPath}`,
            hint: 'Check the --config path, or run `scope init` to create scope.yaml.',
          },
        ],
        {},
        ErrorCodes.configNotFound,
      );
    }
    root = dirname(configPath);
  } else {
    ({ root, configPath } = findProjectRoot(options.cwd));
  }

  let file: ProjectConfigFile | null = null;
  let source: SourceFile | null = null;
  const diagnostics: Diagnostic[] = [];

  if (configPath) {
    const text = readFileSync(configPath, 'utf8');
    const parsed = parseYaml(text, configPath);
    source = parsed.source;
    diagnostics.push(...parsed.diagnostics);
    if (!hasErrors(parsed.diagnostics)) {
      const result = ProjectConfigSchema.safeParse(parsed.data ?? {});
      if (result.success) file = result.data;
      else {
        diagnostics.push(
          ...issuesToDiagnostics(result.error.issues, {
            source,
            schema: ProjectConfigSchema,
            data: parsed.data,
          }),
        );
      }
    }
    if (hasErrors(diagnostics)) throw new ConfigError(diagnostics, { [configPath]: text });
  }

  const providers: Record<string, ResolvedProvider> = {};
  for (const [name, settings] of Object.entries(file?.providers ?? {})) {
    const resolved = resolveEnvDeep(settings, env, ['providers', name]);
    providers[name] = { ...resolved.value, name, missingEnv: resolved.missing.map((m) => m.name) };
    if (source) {
      for (const m of resolved.missing) {
        diagnostics.push(
          positioned(source, m.path, {
            severity: 'warning',
            path: m.path.join('.'),
            message: `environment variable ${m.name} is not set`,
            hint: `Provider "${name}" will fail if it is used. Export ${m.name} or remove the reference.`,
          }),
        );
      }
    }
  }

  const pricing: Record<string, ModelPrice> = {};
  for (const [key, p] of Object.entries(file?.pricing ?? {})) {
    const price: ModelPrice = {
      input: p.input,
      output: p.output,
      asOf: p.as_of ?? 'project override',
      source: p.source ?? configPath ?? 'scope.yaml',
    };
    if (p.cache_read !== undefined) price.cacheRead = p.cache_read;
    if (p.cache_write !== undefined) price.cacheWrite = p.cache_write;
    pricing[key] = price;
  }

  const privacy: PrivacyOptions = {};
  const privacyFile = file?.privacy;
  if (privacyFile?.capture_content !== undefined)
    privacy.captureContent = privacyFile.capture_content;
  if (privacyFile?.max_payload_bytes !== undefined)
    privacy.maxPayloadBytes = privacyFile.max_payload_bytes;
  if (privacyFile?.redact) privacy.redact = privacyFile.redact;
  if (privacyFile?.patterns) privacy.patterns = privacyFile.patterns;
  if (privacyFile?.sensitive_keys) privacy.sensitiveKeys = privacyFile.sensitive_keys;
  const captureEnv = env.SCOPE_CAPTURE_CONTENT;
  if (captureEnv !== undefined && captureEnv !== '') {
    privacy.captureContent = !['0', 'false', 'no', 'off'].includes(captureEnv.toLowerCase());
  }
  for (const p of privacy.patterns ?? []) {
    try {
      new RegExp(p.pattern);
    } catch (error) {
      throw new ConfigError(
        [
          {
            severity: 'error',
            message: `privacy pattern "${p.name}" is not a valid regular expression: ${(error as Error).message}`,
            file: configPath ?? undefined,
          },
        ],
        {},
      );
    }
  }

  let storage: ResolvedProject['storage'];
  const envUrl = env.SCOPE_DATABASE_URL;
  if (envUrl) storage = { url: resolveStorageUrl(envUrl, root), source: 'env' };
  else if (file?.storage?.url) {
    const r = resolveEnvDeep(file.storage.url, env);
    storage = { url: resolveStorageUrl(r.value, root), source: 'config' };
  } else storage = { url: resolveStorageUrl(DEFAULT_STORAGE_URL, root), source: 'default' };

  return {
    root,
    configPath,
    name: file?.project ?? slugify(basename(root)),
    storage,
    providers,
    pricing,
    privacy,
    defaults: {
      concurrency: file?.defaults?.concurrency ?? DEFAULT_CONCURRENCY,
      timeoutMs: file?.defaults?.timeout_ms ?? null,
    },
    workflowGlobs: file?.workflows ?? ['workflows/*.yaml', 'workflows/*.yml'],
    baselinesDir: resolve(root, file?.baselines?.dir ?? 'baselines'),
    source,
    diagnostics,
  };
}
