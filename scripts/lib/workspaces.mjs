/**
 * The workspace packages, read from their manifests, in dependency order (dependencies first).
 * Shared by the release scripts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The repository the scripts work on: their own, or SCOPE_RELEASE_ROOT. The release workflow
 * sets it to publish an existing tag's sources with the current release scripts.
 */
export const ROOT = process.env.SCOPE_RELEASE_ROOT
  ? resolve(process.env.SCOPE_RELEASE_ROOT)
  : resolve(import.meta.dirname, '../..');

/** @returns {Array<{ name: string, dir: string, manifestPath: string, manifest: any }>} */
export function workspaces() {
  const found = [];
  for (const group of ['packages', 'apps']) {
    for (const entry of readdirSync(join(ROOT, group)).sort()) {
      const manifestPath = join(ROOT, group, entry, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      found.push({ name: manifest.name, dir: join(group, entry), manifestPath, manifest });
    }
  }
  return found;
}

/** Publishable packages, each after the workspace packages it depends on. */
export function publishOrder() {
  const all = workspaces().filter((w) => !w.manifest.private);
  const byName = new Map(all.map((w) => [w.name, w]));
  const ordered = [];
  const visiting = new Set();
  const visit = (w) => {
    if (ordered.includes(w)) return;
    if (visiting.has(w.name)) throw new Error(`dependency cycle through ${w.name}`);
    visiting.add(w.name);
    const deps = { ...w.manifest.dependencies, ...w.manifest.peerDependencies };
    for (const dep of Object.keys(deps)) {
      const inner = byName.get(dep);
      if (inner) visit(inner);
    }
    visiting.delete(w.name);
    ordered.push(w);
  };
  for (const w of all) visit(w);
  return ordered;
}

/** Names of workspace packages, for recognizing internal dependencies. */
export function internalNames() {
  return new Set(workspaces().map((w) => w.name));
}
