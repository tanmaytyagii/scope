/**
 * Minimal file globbing for corpus paths: `*`, `**`, `?` and `{a,b}`. Directories expand to the
 * supported files inside them. Bounded, and never descends into node_modules or dot-directories.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const MAX_FILES = 10_000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.scope', 'dist']);

export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        const slash = pattern[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) out += '\\{';
      else {
        out += `(?:${pattern
          .slice(i + 1, close)
          .split(',')
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&'))
          .join('|')})`;
        i = close;
      }
    } else out += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (files.length >= MAX_FILES) return;
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile()) files.push(full);
  }
}

/** Static prefix of a pattern (the directory to start walking from). */
function baseOf(pattern: string): string {
  const parts = pattern.split('/');
  const fixed: string[] = [];
  for (const part of parts) {
    if (/[*?{]/.test(part)) break;
    fixed.push(part);
  }
  return fixed.join('/') || '.';
}

/** Expands one pattern relative to `cwd`. Returns absolute paths, sorted. */
export function expandGlob(pattern: string, cwd: string, extensions?: readonly string[]): string[] {
  const normalized = pattern.replace(/\\/g, '/');
  const direct = resolve(cwd, normalized);
  if (!/[*?{]/.test(normalized)) {
    if (!existsSync(direct)) return [];
    if (statSync(direct).isDirectory()) {
      const files: string[] = [];
      walk(direct, files);
      return files.filter((f) => !extensions || extensions.some((e) => f.endsWith(e))).sort();
    }
    return [direct];
  }
  const base = resolve(cwd, baseOf(normalized));
  if (!existsSync(base) || !statSync(base).isDirectory()) return [];
  const matcher = globToRegExp(relative(base, resolve(cwd, normalized)).split(sep).join('/'));
  const files: string[] = [];
  walk(base, files);
  return files.filter((f) => matcher.test(relative(base, f).split(sep).join('/'))).sort();
}
