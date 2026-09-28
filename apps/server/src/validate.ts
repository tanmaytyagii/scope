/** Request parsing with the protocol's schemas; failures become 400s naming each field. */
import type { z } from 'zod';
import { notFound, validationError } from './errors.ts';
import type { AppContext, Deps } from './types.ts';

export function parseQuery<S extends z.ZodType>(c: AppContext, schema: S): z.output<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw validationError('query', result.error.issues);
  return result.data;
}

export function isoToMs(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Date.parse(value);
}

/** Resolves a run id or number to a run of the request's project, or throws 404. */
export async function resolveRun(c: AppContext, deps: Deps, ref: string) {
  const project = c.get('project');
  // Path and query parameters arrive decoded; decoding again would corrupt or reject them.
  const run = await deps.store.getRun(project.id, ref);
  if (!run) {
    throw notFound(
      /^#?\d+$/.test(ref) ? `Run #${ref.replace('#', '')}` : `Run "${ref}"`,
      `No such run in project "${project.slug}". List runs with GET /api/v1/runs.`,
    );
  }
  return run;
}
