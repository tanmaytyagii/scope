/**
 * Access control for /api/v1: resolves the project a request acts on and checks API key scopes.
 */
import { ErrorCodes, ScopeError } from '@scope-ai/core';
import type { RouteAccess } from '@scope-ai/protocol';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Deps } from './types.ts';

export const PROJECT_HEADER = 'x-scope-project';

const KEY_HINT = 'Send `Authorization: Bearer scope_…`. Create a key with `scope keys create`.';

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? (match[1] as string) : null;
}

export function requireAccess(deps: Deps, access: RouteAccess): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (access === 'public') return next();

    if (deps.auth.mode === 'none') {
      const slug = c.req.header(PROJECT_HEADER);
      let project = deps.auth.defaultProject;
      if (slug && slug !== project.slug) {
        const named = await deps.store.getProjectBySlug(slug);
        if (!named && access !== 'ingest') {
          throw new ScopeError(ErrorCodes.notFound, `Project "${slug}" not found`, {
            hint: `This server serves project "${project.slug}". Remove the ${PROJECT_HEADER} header or check the name.`,
          });
        }
        // Ingestion creates the named project on demand (see the ingest handler).
        if (named) project = named;
      }
      c.set('project', project);
      c.set('apiKey', null);
      return next();
    }

    const secret = bearer(c.req.header('authorization'));
    if (!secret) {
      throw new ScopeError(ErrorCodes.unauthorized, 'This server requires an API key', {
        hint: KEY_HINT,
      });
    }
    const key = await deps.store.authenticateApiKey(secret);
    if (!key) {
      throw new ScopeError(ErrorCodes.unauthorized, 'The API key is invalid or has been revoked', {
        hint: KEY_HINT,
      });
    }
    // Known from here on, so the request log names the key even when it is refused.
    c.set('apiKey', key);
    if (!key.scopes.includes(access)) {
      throw new ScopeError(
        ErrorCodes.forbidden,
        `The API key "${key.name}" does not have the "${access}" scope`,
        {
          hint: `Create a key with --scope ${access}. This key has: ${key.scopes.join(', ') || 'no scopes'}.`,
        },
      );
    }
    const project = await deps.store.getProject(key.projectId);
    if (!project) {
      throw new ScopeError(ErrorCodes.unauthorized, 'The API key’s project no longer exists', {
        hint: KEY_HINT,
      });
    }
    c.set('project', project);
    c.set('apiKey', key);
    return next();
  };
}
