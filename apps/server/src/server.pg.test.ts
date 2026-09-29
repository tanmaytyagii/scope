/**
 * The API contract on PostgreSQL. Runs when SCOPE_TEST_DATABASE_URL is set (CI provides one).
 *
 * The storage suite covers the queries on both dialects; this checks everything above them —
 * number and JSON handling of pg results, the DTO mapping and pagination — with real runs.
 * It uses its own schema, because the storage suite resets `public` concurrently.
 */
import { API_BASE, ROUTES, type TracePage } from '@scope-ai/protocol';
import { type Run, Store } from '@scope-ai/storage';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWorkflow, writeProject } from './__tests__/seed.ts';
import { createApp } from './app.ts';

const url = process.env.SCOPE_TEST_DATABASE_URL;
const SCHEMA = 'scope_server_test';

function withSearchPath(connection: string, schema: string): string {
  const u = new URL(connection);
  u.searchParams.set('options', `-c search_path=${schema}`);
  return u.toString();
}

describe.runIf(url)('API on PostgreSQL', () => {
  let store: Store;
  let app: ReturnType<typeof createApp>['app'];
  let runs: Run[];

  beforeAll(async () => {
    const admin = await Store.open(url as string, { autoMigrate: false });
    await sql`drop schema if exists ${sql.id(SCHEMA)} cascade`.execute(admin.db);
    await sql`create schema ${sql.id(SCHEMA)}`.execute(admin.db);
    await admin.close();

    store = await Store.open(withSearchPath(url as string, SCHEMA));
    const project = await store.ensureProject('demo');
    const root = writeProject();
    const first = await runWorkflow(store, project, root);
    runs = [first, await runWorkflow(store, project, root, 'terse', first)];
    ({ app } = createApp({ store, auth: { mode: 'none', defaultProject: project } }));
  });

  afterAll(async () => {
    await store?.close();
  });

  it('stores into its own schema', async () => {
    const tables = await sql<{ table_schema: string }>`
      select distinct table_schema from information_schema.tables where table_name = 'traces'
        and table_schema = ${SCHEMA}`.execute(store.db);
    expect(tables.rows).toHaveLength(1);
  });

  it('serves every route with a body that matches its schema', async () => {
    const [first, second] = runs as [Run, Run];
    const list = (await (await app.request(`${API_BASE}/traces?limit=1`)).json()) as TracePage;
    const concrete: Record<string, string> = {
      '/runs/{run}': `/runs/${first.number}`,
      '/runs/{run}/cases': `/runs/${first.id}/cases`,
      '/runs/{run}/baseline-comparison': `/runs/${second.number}/baseline-comparison`,
      '/comparisons': `/comparisons?base=${first.number}&head=${second.number}`,
      '/comparisons/matrix': `/comparisons/matrix?runs=${first.number},${second.number}`,
      '/traces/{trace}': `/traces/${list.items[0]?.id}`,
      '/workflows/{workflow}': '/workflows/support',
    };
    for (const route of ROUTES.filter((r) => r.method === 'get')) {
      const path = `${API_BASE}${concrete[route.path] ?? route.path}`;
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      const parsed = route.response.safeParse(await res.json());
      expect(parsed.error?.issues ?? [], path).toEqual([]);
    }
  });

  it('returns numbers, not strings, for counts and aggregates', async () => {
    const overview = (await (await app.request(`${API_BASE}/overview?window=24h`)).json()) as {
      traces: { total: unknown; totalTokens: unknown };
      runs: { total: unknown };
    };
    expect(overview.traces.total).toBe(10);
    expect(typeof overview.traces.totalTokens).toBe('number');
    expect(overview.runs.total).toBe(2);
  });

  it('paginates traces without overlap', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const q: string = `${API_BASE}/traces?limit=3&sort=slowest${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await (await app.request(q)).json()) as TracePage;
      for (const t of page.items) {
        expect(seen.has(t.id)).toBe(false);
        seen.add(t.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(10);
  });
});
