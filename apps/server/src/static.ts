/**
 * Serves the dashboard: static files from the web build, with the SPA's index.html for any
 * other GET path outside /api. Hashed assets are cached forever; index.html never is.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import type { Hono } from 'hono';
import type { AppEnv } from './types.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Finds the built dashboard shipped by @scope-ai/web, or null when it is not installed/built. */
export function findWebRoot(): string | null {
  try {
    const manifest = createRequire(import.meta.url).resolve('@scope-ai/web/package.json');
    const dist = join(dirname(manifest), 'dist');
    return existsSync(join(dist, 'index.html')) ? dist : null;
  } catch {
    return null;
  }
}

const NOT_BUILT = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>SCOPE</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"></head>
<body>
<h1>The SCOPE API is running</h1>
<p>The dashboard has not been built in this checkout, so only the API is available.</p>
<p>Build it with <code>npm run build -w @scope-ai/web</code>, or run <code>npm run dev -w @scope-ai/web</code> for a development server.</p>
<p>API: <a href="/api/v1/info">/api/v1/info</a> · <a href="/api/v1/openapi.json">/api/v1/openapi.json</a></p>
</body>
</html>
`;

function fileIn(root: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const full = resolve(root, `.${normalize(`/${decoded}`)}`);
  if (full !== root && !full.startsWith(root + sep)) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

export function registerDashboard(app: Hono<AppEnv>, webRoot: string | null): void {
  const root = webRoot ? resolve(webRoot) : null;

  app.get('*', (c) => {
    const path = c.req.path;
    if (path.startsWith('/api/')) return c.notFound();
    // Read per request (it is small) so a rebuilt dashboard is picked up without a restart.
    const index = root ? fileIn(root, '/index.html') : null;
    if (!root || !index) return c.html(NOT_BUILT);

    const file = path === '/' ? null : fileIn(root, path);
    if (file) {
      const body = readFileSync(file);
      const immutable = path.startsWith('/assets/');
      return c.body(body, 200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
    }
    // A missing hashed asset is a 404, not the app shell.
    if (path.startsWith('/assets/') || extname(path) !== '') return c.notFound();
    return c.body(readFileSync(index), 200, {
      'content-type': TYPES['.html'] as string,
      'cache-control': 'no-cache',
    });
  });
}
