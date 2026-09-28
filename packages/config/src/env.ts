/**
 * `${env:NAME}` references in configuration, resolved at load time.
 *
 * `${env:NAME:-fallback}` supplies a default. Stored snapshots keep the reference text, never
 * the resolved value, so secrets do not reach the database.
 */

const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export interface EnvResolution {
  value: string;
  missing: string[];
}

export function resolveEnvRefs(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): EnvResolution {
  const missing: string[] = [];
  const value = text.replace(ENV_REF, (_match, name: string, fallback: string | undefined) => {
    const v = env[name];
    if (v !== undefined && v !== '') return v;
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return '';
  });
  return { value, missing };
}

export function hasEnvRef(text: string): boolean {
  ENV_REF.lastIndex = 0;
  const found = ENV_REF.test(text);
  ENV_REF.lastIndex = 0;
  return found;
}

/**
 * Resolves env references in every string of a structure. Missing variables are collected with
 * their paths rather than thrown, so the caller can decide whether they matter (an unused
 * provider's missing key should not block a run).
 */
export function resolveEnvDeep<T>(
  value: T,
  env: Readonly<Record<string, string | undefined>>,
  path: Array<string | number> = [],
  missing: Array<{ name: string; path: Array<string | number> }> = [],
): { value: T; missing: Array<{ name: string; path: Array<string | number> }> } {
  const walk = (v: unknown, p: Array<string | number>): unknown => {
    if (typeof v === 'string') {
      const r = resolveEnvRefs(v, env);
      for (const name of r.missing) missing.push({ name, path: p });
      return r.value;
    }
    if (Array.isArray(v)) return v.map((item, i) => walk(item, [...p, i]));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v)) out[k] = walk(item, [...p, k]);
      return out;
    }
    return v;
  };
  return { value: walk(value, path) as T, missing };
}
