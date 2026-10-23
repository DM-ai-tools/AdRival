import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";

import {
  poolConfigFor,
  poolTestClient,
  setClientForTests,
  type Queryable,
  type TestClient,
} from "../../src/lib/data/client";
import { migrate } from "../../src/lib/data/migrate";

/** pg type oids whose PGlite parsing differs from node-postgres defaults. */
const INT8_OID = 20;
const NUMERIC_OID = 1700;
const BYTEA_OID = 17;

/**
 * Match node-postgres so tests see what production sees: int8 and numeric come
 * back as strings, bytea as a Buffer.
 */
const PG_COMPATIBLE_PARSERS = {
  [INT8_OID]: (value: string) => value,
  [NUMERIC_OID]: (value: string) => value,
  [BYTEA_OID]: (value: string) =>
    value.startsWith("\\x") ? Buffer.from(value.slice(2), "hex") : Buffer.from(value, "binary"),
};

export type PgliteTestClient = TestClient & { close(): Promise<void> };

/** A tiny FIFO async mutex. */
function createMutex() {
  let tail: Promise<void> = Promise.resolve();
  return async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

const TX_MISUSE =
  "use the tx handle passed to withTx, not getDb(), inside a transaction " +
  "(with the real pool this would run on another connection outside the transaction, " +
  "or deadlock waiting for a row the transaction has locked)";

/** One open transaction; `open` flips to false at COMMIT/ROLLBACK. */
interface TxState {
  open: boolean;
}

/**
 * Wraps an in-process PGlite database as a TestClient. PGlite has a single
 * connection, so every statement and every transaction takes one mutex: a
 * transaction's BEGIN..COMMIT never interleaves with other work.
 *
 * It fails loudly where the production pool would deadlock or diverge:
 * - `getDb().query` or a nested `withTx` while a transaction is open throws;
 *   only the handle passed to the callback may be used.
 * - The handle throws once its transaction has finished, and work that
 *   outlives the transaction goes back through the mutex like any caller.
 */
export async function createPgliteClient(): Promise<PgliteTestClient> {
  const pg = new PGlite({ parsers: PG_COMPATIBLE_PARSERS });
  await pg.waitReady;
  const runExclusive = createMutex();
  const inTx = new AsyncLocalStorage<TxState>();

  const insideOpenTx = () => inTx.getStore()?.open === true;

  const raw: Queryable = {
    async query<R = Record<string, unknown>>(text: string, params?: unknown[]) {
      if (params && params.length > 0) {
        const result = await pg.query<R>(text, params);
        return { rows: result.rows, rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length };
      }
      // No params: simple protocol, which also runs multi-statement text (migrations).
      const results = await pg.exec(text);
      const last = results[results.length - 1];
      const rows = (last?.rows ?? []) as R[];
      return { rows, rowCount: last?.rowCount ?? last?.affectedRows ?? rows.length };
    },
  };

  return {
    async query<R = Record<string, unknown>>(text: string, params?: unknown[]) {
      if (insideOpenTx()) throw new Error(TX_MISUSE);
      return runExclusive(() => raw.query<R>(text, params));
    },
    async tx<T>(fn: (t: Queryable) => Promise<T>): Promise<T> {
      if (insideOpenTx()) throw new Error(TX_MISUSE);
      return runExclusive(() => {
        const state: TxState = { open: true };
        const handle: Queryable = {
          async query<R = Record<string, unknown>>(text: string, params?: unknown[]) {
            if (!state.open) {
              throw new Error("this transaction is finished; its tx handle can no longer be used");
            }
            return raw.query<R>(text, params);
          },
        };
        return inTx.run(state, async () => {
          await pg.exec("BEGIN");
          try {
            const value = await fn(handle);
            state.open = false;
            await pg.exec("COMMIT");
            return value;
          } catch (err) {
            state.open = false;
            try {
              await pg.exec("ROLLBACK");
            } catch {
              // Keep the error that caused the rollback; it is the useful one.
            }
            throw err;
          }
        });
      });
    },
    close: () => pg.close(),
  };
}

/**
 * Fresh in-memory Postgres (PGlite) for one test file: migrated and installed
 * as the client behind getDb()/withTx(). Call cleanup() in `after`.
 */
export async function useTestDb(label: string): Promise<{ cleanup(): Promise<void> }> {
  let client: PgliteTestClient;
  try {
    client = await createPgliteClient();
    await migrate(client);
  } catch (err) {
    throw new Error(`useTestDb(${label}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  setClientForTests(client);
  return {
    async cleanup() {
      setClientForTests(null);
      await client.close();
    },
  };
}

/** True when a real Postgres for concurrency tests is configured. */
export function hasStagingDb(): boolean {
  return Boolean(process.env.DATABASE_TEST_URL);
}

/**
 * Real Postgres (DATABASE_TEST_URL) isolated in a throwaway schema `t_<random>`:
 * every pooled connection gets that search_path, the schema is migrated and
 * installed behind getDb()/withTx(), and cleanup() drops it. Only for tests
 * that need true concurrent connections.
 */
export async function useStagingSchema(label: string): Promise<{ cleanup(): Promise<void> }> {
  const url = process.env.DATABASE_TEST_URL;
  if (!url) throw new Error(`useStagingSchema(${label}): DATABASE_TEST_URL is not set`);
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const config = poolConfigFor(url);

  const admin = new Pool({ ...config, max: 1 });
  await admin.query(`create schema ${schema}`);

  const pool = new Pool(config);
  pool.on("connect", (conn) => {
    conn.query(`set search_path to ${schema}`).catch((err: unknown) => {
      console.error(`[testDb] search_path for ${schema} failed:`, err);
    });
  });
  pool.on("error", (err) => {
    console.error(`[testDb] idle client error (${label}):`, err.message);
  });

  const client = poolTestClient(pool);
  try {
    await migrate(client);
  } catch (err) {
    await pool.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
    throw err;
  }
  setClientForTests(client);

  return {
    async cleanup() {
      setClientForTests(null);
      await pool.end();
      try {
        await admin.query(`drop schema if exists ${schema} cascade`);
      } finally {
        await admin.end();
      }
    },
  };
}
