import { readFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";

import { poolConfigFor, poolTestClient, setClient, type TestClient } from "../src/lib/data/client";
import type { DatabaseShape } from "../src/lib/types";

/*
 * Shared by scripts/import-store.ts and scripts/verify-import.ts: argument
 * parsing, read-only loading of store.json, and a direct (session) connection.
 */

/** Long enough for the biggest single statement (the ~25 MB gzip bytea insert of the 46 MB page). */
export const STATEMENT_TIMEOUT_MS = 120_000;

export interface ScriptArgs {
  store: string;
  url: string | null;
  dryRun: boolean;
  archiveDays: number | null;
  allowExisting: boolean;
}

export function parseArgs(argv: string[]): ScriptArgs {
  const args: ScriptArgs = {
    store: path.join("data", "store.json"),
    url: process.env.DATABASE_DIRECT_URL || null,
    dryRun: false,
    archiveDays: null,
    allowExisting: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    if (flag === "--store") args.store = value();
    else if (flag === "--url") args.url = value();
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--allow-existing") args.allowExisting = true;
    else if (flag === "--archive-days") {
      const raw = value();
      const days = Number(raw);
      if (!Number.isFinite(days) || days < 0) throw new Error(`--archive-days must be a number of days, got ${raw}`);
      args.archiveDays = days;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

/** Reads and parses store.json. The file is only read, never written. */
export async function loadStore(file: string): Promise<DatabaseShape> {
  const text = await readFile(file, "utf8");
  return JSON.parse(text) as DatabaseShape;
}

/**
 * A direct connection (not the transaction pooler) with a 120 s statement
 * timeout, installed behind getDb()/withTx so every repository uses it.
 */
export function connectDirect(url: string): { client: TestClient; close(): Promise<void> } {
  if (isTransactionPooler(url)) {
    throw new Error(
      "this URL is the transaction pooler (port 6543): use the direct connection (DATABASE_DIRECT_URL, port 5432)",
    );
  }
  const pool = new Pool({
    ...poolConfigFor(url),
    max: 2,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS + 10_000,
  });
  pool.on("error", (err) => console.error("[db] connection error:", err.message));
  const client = poolTestClient(pool);
  setClient(client);
  return {
    client,
    async close() {
      setClient(null);
      await pool.end().catch(() => {});
    },
  };
}

/** Supabase's transaction pooler listens on 6543; it cannot hold a session or a 120 s statement timeout. */
function isTransactionPooler(url: string): boolean {
  try {
    return new URL(url).port === "6543";
  } catch {
    return false;
  }
}

/** Host and database name of a connection URL, without credentials (for logs). */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparsable url)";
  }
}

export function elapsed(started: number): string {
  return `${((Date.now() - started) / 1000).toFixed(1)}s`;
}
