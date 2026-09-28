/**
 * scope keys — API keys for `scope server`. A key belongs to one project and carries scopes:
 * `ingest` (send traces from an SDK) and `read` (the dashboard and the read API).
 */
import { ErrorCodes, formatRelativeTime, ScopeError } from '@scope-ai/core';
import type { ApiKey, ApiKeyScope, Project } from '@scope-ai/storage';
import type { CommandContext } from '../context.ts';
import { renderTable } from '../ui/table.ts';

const SCOPES: readonly ApiKeyScope[] = ['ingest', 'read'];
const PROJECT_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface KeysOptions {
  project?: string;
}

export interface CreateKeyOptions extends KeysOptions {
  name?: string;
  scope?: string[];
}

async function targetProject(
  ctx: CommandContext,
  slug: string | undefined,
  create: boolean,
): Promise<Project> {
  const store = await ctx.store();
  if (!slug) return ctx.projectRow();
  if (!PROJECT_SLUG.test(slug)) {
    throw new ScopeError(ErrorCodes.usage, `"${slug}" is not a valid project name`, {
      hint: 'Use lowercase letters, digits, ".", "_" and "-".',
    });
  }
  const existing = await store.getProjectBySlug(slug);
  if (existing) return existing;
  if (create) return store.ensureProject(slug);
  throw new ScopeError(ErrorCodes.notFound, `Project "${slug}" not found`, {
    hint: 'Projects are created by `scope run` or when a key is created for them.',
  });
}

function parseScopes(values: string[] | undefined): ApiKeyScope[] {
  const scopes = (values?.length ? values : [...SCOPES]).flatMap((v) => v.split(','));
  for (const scope of scopes) {
    if (!SCOPES.includes(scope as ApiKeyScope)) {
      throw new ScopeError(ErrorCodes.usage, `Unknown scope "${scope}"`, {
        hint: 'Scopes are "ingest" (send traces) and "read" (dashboard and read API).',
      });
    }
  }
  return [...new Set(scopes)] as ApiKeyScope[];
}

export async function keysCreateCommand(
  ctx: CommandContext,
  options: CreateKeyOptions,
): Promise<void> {
  const store = await ctx.store();
  const project = await targetProject(ctx, options.project, true);
  const scopes = parseScopes(options.scope);
  const name = options.name?.trim() || scopes.join('+');
  const { key, secret } = await store.createApiKey(project.id, name, scopes);

  ctx.out.emitJson({
    id: key.id,
    name: key.name,
    project: project.slug,
    scopes: key.scopes,
    prefix: key.prefix,
    secret,
  });
  const s = ctx.out.style;
  ctx.out.print('');
  ctx.out.print(
    `${s.green(ctx.out.sym.pass)} Created API key ${s.bold(name)} for project ${s.bold(project.slug)} ${s.dim(`(scopes: ${key.scopes.join(', ')})`)}`,
  );
  ctx.out.print('');
  ctx.out.result(`  ${secret}`);
  ctx.out.print('');
  ctx.out.print(`  ${s.yellow('This is the only time the key is shown.')} Store it as a secret.`);
  if (key.scopes.includes('ingest'))
    ctx.out.print(`  ${s.dim('SDK:')}       SCOPE_URL=<server url> SCOPE_API_KEY=<this key>`);
  if (key.scopes.includes('read'))
    ctx.out.print(`  ${s.dim('Dashboard:')} paste the key when the dashboard asks for it`);
  ctx.out.print('');
}

function status(key: ApiKey): string {
  return key.revokedAt === null ? 'active' : `revoked ${formatRelativeTime(key.revokedAt)}`;
}

export async function keysListCommand(ctx: CommandContext, options: KeysOptions): Promise<void> {
  const store = await ctx.store();
  const project = await targetProject(ctx, options.project, false);
  const keys = await store.listApiKeys(project.id);
  ctx.out.emitJson({
    project: project.slug,
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      createdAt: new Date(k.createdAt).toISOString(),
      lastUsedAt: k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : null,
      revokedAt: k.revokedAt ? new Date(k.revokedAt).toISOString() : null,
    })),
  });
  if (ctx.out.json) return;
  if (keys.length === 0) {
    ctx.out.result(
      `No API keys for project ${project.slug}. Create one with ${ctx.out.style.bold('scope keys create')}.`,
    );
    return;
  }
  const s = ctx.out.style;
  ctx.out.result(
    renderTable(
      keys,
      [
        { header: 'Id', value: (k) => k.id },
        { header: 'Name', value: (k) => k.name, max: 32 },
        { header: 'Key', value: (k) => `${k.prefix}…` },
        { header: 'Scopes', value: (k) => k.scopes.join(', ') },
        { header: 'Created', value: (k) => formatRelativeTime(k.createdAt) },
        {
          header: 'Last used',
          value: (k) => (k.lastUsedAt ? formatRelativeTime(k.lastUsedAt) : 'never'),
        },
        {
          header: 'Status',
          value: (k) => (k.revokedAt === null ? s.green(status(k)) : s.dim(status(k))),
        },
      ],
      s.dim,
    ),
  );
}

export async function keysRevokeCommand(
  ctx: CommandContext,
  ref: string,
  options: KeysOptions,
): Promise<void> {
  const store = await ctx.store();
  const project = await targetProject(ctx, options.project, false);
  const keys = await store.listApiKeys(project.id);
  const matches = keys.filter(
    (k) => k.id === ref || k.id.toLowerCase().startsWith(ref.toLowerCase()) || k.prefix === ref,
  );
  if (matches.length === 0) {
    throw new ScopeError(
      ErrorCodes.notFound,
      `No API key matches "${ref}" in project ${project.slug}`,
      {
        hint: 'List keys with `scope keys list`.',
      },
    );
  }
  if (matches.length > 1) {
    throw new ScopeError(ErrorCodes.usage, `"${ref}" matches ${matches.length} keys`, {
      hint: 'Use the full key id from `scope keys list`.',
    });
  }
  const key = matches[0] as ApiKey;
  const revoked = await store.revokeApiKey(project.id, key.id);
  ctx.out.emitJson({ id: key.id, name: key.name, revoked });
  ctx.out.result(
    revoked
      ? `${ctx.out.style.green(ctx.out.sym.pass)} Revoked ${key.name} (${key.id}). Requests with it now fail with 401.`
      : `${key.name} (${key.id}) was already revoked.`,
  );
}
