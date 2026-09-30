/**
 * Per-invocation context shared by commands: output, project configuration and storage, each
 * loaded lazily so that e.g. `scope version` never touches the database.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  loadProject,
  projectJsonSchema,
  type ResolvedProject,
  workflowJsonSchema,
} from '@scope-ai/config';
import { createLogger, type Logger, silentLogger } from '@scope-ai/core';
import { type OpenStoreOptions, type Project, Store } from '@scope-ai/storage';
import { Output } from './ui/output.ts';

export interface GlobalOptions {
  cwd?: string;
  config?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
}

export class CommandContext {
  readonly out: Output;
  readonly cwd: string;
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
  #project: ResolvedProject | null = null;
  #store: Store | null = null;
  #projectRow: Project | null = null;

  constructor(options: GlobalOptions, env: NodeJS.ProcessEnv = process.env, out?: Output) {
    this.options = options;
    this.env = env;
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.out =
      out ??
      new Output({
        ...(options.json !== undefined ? { json: options.json } : {}),
        ...(options.quiet !== undefined ? { quiet: options.quiet } : {}),
        ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
        ...(options.color !== undefined ? { color: options.color } : {}),
      });
  }

  get logger(): Logger {
    if (!this.options.verbose) return silentLogger;
    return createLogger({
      level: 'debug',
      format: 'pretty',
      write: (line) => this.out.stderr.write(`${this.out.errStyle.dim(line)}\n`),
    });
  }

  project(): ResolvedProject {
    if (!this.#project) {
      this.#project = loadProject({
        cwd: this.cwd,
        ...(this.options.config ? { configPath: this.options.config } : {}),
        env: this.env,
      });
      for (const d of this.#project.diagnostics) {
        this.out.warn(
          `${d.file ? `${d.file}${d.line ? `:${d.line}` : ''}: ` : ''}${d.message}${d.hint ? ` ${this.out.errStyle.dim(d.hint)}` : ''}`,
        );
      }
      this.out.debug(
        `project root ${this.#project.root} (${this.#project.configPath ?? 'no scope.yaml, using defaults'})`,
      );
    }
    return this.#project;
  }

  /**
   * The project's store, opened on first use. The options apply only if this call opens it:
   * `onQuery` (`scope server`'s slow-query warnings), `migrate: false` to leave the schema as it
   * is (`scope db status`, `scope db backup`).
   */
  async store(
    options: {
      onQuery?: OpenStoreOptions['onQuery'];
      migrate?: boolean;
      allowNewerSchema?: boolean;
    } = {},
  ): Promise<Store> {
    if (!this.#store) {
      const project = this.project();
      this.out.debug(
        `storage ${project.storage.url.replace(/:[^:@/]*@/, ':***@')} (${project.storage.source})`,
      );
      this.#store = await Store.open(project.storage.url, {
        logger: this.logger,
        autoMigrate: options.migrate ?? this.env.SCOPE_AUTO_MIGRATE !== 'false',
        ...(options.onQuery ? { onQuery: options.onQuery } : {}),
        ...(options.allowNewerSchema ? { allowNewerSchema: true } : {}),
      });
    }
    return this.#store;
  }

  /** The project's database row, created on first use. */
  async projectRow(): Promise<Project> {
    if (!this.#projectRow) {
      const store = await this.store();
      const project = this.project();
      this.#projectRow = await store.ensureProject(project.name);
    }
    return this.#projectRow;
  }

  /** Writes JSON Schemas for editor autocompletion into .scope/schemas (gitignored). */
  writeSchemas(): void {
    const dir = join(this.project().root, '.scope', 'schemas');
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'workflow.schema.json'),
        `${JSON.stringify(workflowJsonSchema(), null, 2)}\n`,
      );
      writeFileSync(
        join(dir, 'project.schema.json'),
        `${JSON.stringify(projectJsonSchema(), null, 2)}\n`,
      );
    } catch (error) {
      this.out.debug(`could not write editor schemas: ${(error as Error).message}`);
    }
  }

  async close(): Promise<void> {
    await this.#store?.close();
    this.#store = null;
  }
}
