import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";

/**
 * The one query surface every repository uses. Both the production `pg` pool
 * and the in-process PGlite test database implement it.
 */
export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
}

/** A test database: a Queryable that can also run a callback in one transaction. */
export type TestClient = Queryable & {
  tx<T>(fn: (t: Queryable) => Promise<T>): Promise<T>;
};

/**
 * Ceiling for any one query. `query_timeout` is enforced client-side by pg.
 * The `statement_timeout` config option is deliberately not used: pg sends it
 * as a startup parameter, which the Supabase transaction pooler (pgbouncer
 * style) may reject or ignore, failing connections or giving false safety.
 */
const QUERY_TIMEOUT_MS = 30_000;
const POOL_MAX = 10;

let pool: Pool | null = null;
let poolDb: Queryable | null = null;
let testClient: TestClient | null = null;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * pg lets `sslmode` in the URL override the `ssl` object we pass, and
 * `sslmode=require` now means full verification, which the Supabase pooler's
 * certificate chain fails. So the URL's sslmode is read and stripped here and
 * the TLS decision is made in one place: off for localhost or sslmode=disable,
 * otherwise on without CA verification.
 */
export function poolConfigFor(connectionString: string): PoolConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL is not a valid postgres connection URL");
  }
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");
  const local = LOCAL_HOSTS.has(url.hostname);
  const ssl = sslmode === "disable" || (local && sslmode === null)
    ? false
    : { rejectUnauthorized: false };
  return {
    connectionString: url.toString(),
    max: POOL_MAX,
    query_timeout: QUERY_TIMEOUT_MS,
    ssl,
  };
}

function toResult<R>(result: { rows: unknown[]; rowCount: number | null }): {
  rows: R[];
  rowCount: number;
} {
  return { rows: result.rows as R[], rowCount: result.rowCount ?? result.rows.length };
}

function wrapClient(client: Pool | PoolClient): Queryable {
  return {
    async query<R = Record<string, unknown>>(text: string, params?: unknown[]) {
      const result: QueryResult<QueryResultRow> | QueryResult<QueryResultRow>[] =
        await client.query<QueryResultRow>(text, params);
      // Multi-statement text (no params) resolves to one result per statement;
      // callers get the last one, as with PGlite's exec.
      const last = Array.isArray(result) ? result[result.length - 1] : result;
      return toResult<R>(last ?? { rows: [], rowCount: 0 });
    },
  };
}

/** BEGIN/COMMIT on one pooled connection, ROLLBACK when `fn` throws. */
async function poolTx<T>(target: Pool, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await target.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    try {
      const value = await fn(wrapClient(client));
      await client.query("COMMIT");
      return value;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw err;
    }
  } finally {
    client.release(broken);
  }
}

/** Wraps any `pg` pool as a test client (used by the staging-schema helper). */
export function poolTestClient(target: Pool): TestClient {
  const base = wrapClient(target);
  return {
    query: base.query,
    tx: (fn) => poolTx(target, fn),
  };
}

function ensurePool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const created = new Pool(poolConfigFor(url));
  created.on("error", (err) => {
    // An idle client lost its connection. The pool drops it and opens a new
    // one on demand; without this listener the error would crash the process.
    console.error("[db] idle client error:", err.message);
  });
  pool = created;
  poolDb = wrapClient(created);
  return created;
}

/** The shared database: the test client when set, else the lazily built pool. */
export function getDb(): Queryable {
  if (testClient) return testClient;
  ensurePool();
  return poolDb as Queryable;
}

/** Runs `fn` in one transaction on one connection; rolls back when it throws. */
export async function withTx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  if (testClient) return testClient.tx(fn);
  return poolTx(ensurePool(), fn);
}

/** Points getDb/withTx at a test database, or back at the pool with null. */
export function setClientForTests(c: TestClient | null): void {
  testClient = c;
}

/** Ends the pool (if one was built). The next getDb() builds a fresh one. */
export async function closeDb(): Promise<void> {
  const current = pool;
  pool = null;
  poolDb = null;
  if (current) await current.end();
}
