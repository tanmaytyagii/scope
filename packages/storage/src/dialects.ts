/**
 * Database connections: SQLite through Node's built-in `node:sqlite` (no native addon) and
 * PostgreSQL through `pg` (docs/decisions/0002).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ErrorCodes, ScopeError } from '@scope-ai/core';
import {
  type Dialect,
  PostgresDialect,
  type SqliteDatabase,
  SqliteDialect,
  type SqliteStatement,
} from 'kysely';

export type DialectName = 'sqlite' | 'postgres';

export interface StorageTarget {
  dialect: DialectName;
  /** File path (SQLite) or connection string (PostgreSQL). */
  location: string;
  /** Location safe to print (password removed). */
  display: string;
}

export function parseStorageUrl(url: string): StorageTarget {
  if (url.startsWith('sqlite:')) {
    const location = url.slice('sqlite:'.length).replace(/^\/\/(?=\/)/, '') || ':memory:';
    return { dialect: 'sqlite', location, display: `sqlite:${location}` };
  }
  if (/^postgres(?:ql)?:\/\//.test(url)) {
    let display = url;
    try {
      const u = new URL(url);
      if (u.password) u.password = '***';
      display = u.toString();
    } catch {
      display = 'postgres://(unparseable url)';
    }
    return { dialect: 'postgres', location: url, display };
  }
  throw new ScopeError(
    ErrorCodes.storageUnsupported,
    `Unsupported storage URL "${url.split(':')[0]}:…"`,
    {
      hint: 'Use sqlite:<path> (e.g. sqlite:.scope/scope.db) or postgres://user:pass@host:5432/db.',
    },
  );
}

type NodeSqlite = typeof import('node:sqlite');

let nodeSqlite: Promise<NodeSqlite> | null = null;

/**
 * Loads `node:sqlite`, suppressing exactly one warning: Node's ExperimentalWarning for SQLite.
 * Every other warning is passed through unchanged.
 */
export function loadNodeSqlite(): Promise<NodeSqlite> {
  nodeSqlite ??= (async () => {
    const original = process.emitWarning;
    process.emitWarning = function (
      this: NodeJS.Process,
      warning: string | Error,
      ...args: unknown[]
    ) {
      const message = typeof warning === 'string' ? warning : warning?.message;
      const first = args[0] as string | { type?: string } | undefined;
      const type =
        typeof first === 'string'
          ? first
          : (first?.type ?? (typeof warning === 'string' ? undefined : warning?.name));
      if (type === 'ExperimentalWarning' && /SQLite/i.test(message ?? '')) return;
      return (original as (...a: unknown[]) => void).call(process, warning, ...args);
    } as typeof process.emitWarning;
    try {
      return await import('node:sqlite');
    } catch (error) {
      throw new ScopeError(
        ErrorCodes.storageUnavailable,
        'This Node.js version does not provide node:sqlite',
        {
          hint: 'SCOPE needs Node.js 22.16 or newer for local storage. Upgrade Node, or use PostgreSQL via SCOPE_DATABASE_URL.',
          cause: error,
        },
      );
    } finally {
      process.emitWarning = original;
    }
  })();
  return nodeSqlite;
}

function toSqliteValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/** Adapts `node:sqlite` to the interface Kysely's SqliteDialect expects. */
export async function openSqlite(path: string): Promise<SqliteDatabase> {
  const { DatabaseSync } = await loadNodeSqlite();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = NORMAL');
  } catch (error) {
    throw new ScopeError(
      ErrorCodes.storageUnavailable,
      `Unable to open the SQLite database at ${path}: ${(error as Error).message}`,
      {
        hint: 'Check that the directory is writable and the file is not locked by another program. Run `scope doctor` for details.',
        cause: error,
      },
    );
  }
  return {
    close: () => db.close(),
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(sql);
      const params = (p: ReadonlyArray<unknown>) =>
        p.map(toSqliteValue) as Array<string | number | bigint | null | Uint8Array>;
      return {
        reader: stmt.columns().length > 0,
        all: (p) => stmt.all(...params(p)),
        run: (p) => {
          const r = stmt.run(...params(p));
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
        },
        iterate: (p) => stmt.iterate(...params(p)) as IterableIterator<unknown>,
      };
    },
  };
}

// PostgreSQL returns int8/numeric as strings by default. SCOPE's values (epoch ms, counts,
// sums) fit comfortably in a double, so parse them as numbers.
const INT8_OID = 20;
const NUMERIC_OID = 1700;
// JSON columns are returned as raw text, exactly as SQLite returns them, so one code path parses
// both. (Letting pg parse jsonb makes a JSON string value indistinguishable from JSON text.)
const JSON_OID = 114;
const JSONB_OID = 3802;

export async function createDialect(target: StorageTarget): Promise<Dialect> {
  if (target.dialect === 'sqlite') {
    const database = await openSqlite(target.location);
    return new SqliteDialect({ database });
  }
  const pg = await import('pg');
  const { Pool, types } = pg.default ?? pg;
  const pool = new Pool({
    connectionString: target.location,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    types: {
      getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
        if (oid === INT8_OID || oid === NUMERIC_OID)
          return (value: string) => (value === null ? null : Number(value));
        if (oid === JSON_OID || oid === JSONB_OID) return (value: string) => value;
        return types.getTypeParser(oid, format as 'text');
      }) as typeof types.getTypeParser,
    },
  });
  return new PostgresDialect({ pool });
}
