import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { poolConfigFor, poolTestClient, setClient, type TestClient } from "../src/lib/data/client";
import type { DatabaseShape } from "../src/lib/types";

/*
 * Shared by the scripts (import-store, verify-import, backup-db, load-test):
 * env-file loading, argument parsing, read-only loading of store.json, and a
 * direct (session) connection.
 */

/**
 * Server-side bound on each script statement, set per transaction with
 * `SET LOCAL statement_timeout` (never as a startup parameter: the session
 * pooler may reject one). Generous on purpose: the biggest single statement
 * is the ~25 MB gzip bytea insert of the 46 MB page, over a home connection.
 */
export const STATEMENT_TIMEOUT_MS = 600_000;

/** The repository root (this file lives in scripts/). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Env files read at script start; the first file to set a variable wins (after the shell). */
const ENV_FILES = [".env.local", ".env"];

/**
 * Minimal .env parser, used only when Node lacks process.loadEnvFile (before
 * 20.12): KEY=value lines, optional `export `, `#` comment lines, matching
 * single or double quotes stripped. No multi-line values or escapes.
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

/**
 * Loads `.env.local`, then `.env`, from the repo root into process.env.
 * A variable that is already set (by the shell, or by an earlier file) is
 * never overridden, so the shell wins and `.env.local` wins over `.env`.
 * Prints the names of the files read, never a value. Returns those names.
 * Scripts call it first thing in main() (not on import: tests import these
 * modules and must not pick up a developer's .env.local).
 */
export function loadScriptEnv(opts: { root?: string; log?: (line: string) => void } = {}): string[] {
  const root = opts.root ?? REPO_ROOT;
  const log = opts.log ?? ((line: string) => console.log(line));
  const loadEnvFile = (process as { loadEnvFile?: (file: string) => void }).loadEnvFile;
  const loaded: string[] = [];
  for (const name of ENV_FILES) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    if (typeof loadEnvFile === "function") {
      // Node keeps variables that are already set.
      loadEnvFile.call(process, file);
    } else {
      for (const [key, value] of Object.entries(parseEnvText(readFileSync(file, "utf8")))) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
    }
    loaded.push(name);
  }
  log(
    loaded.length
      ? `env files loaded: ${loaded.join(", ")} (variables already set in this terminal win)`
      : "env files loaded: none (no .env.local or .env in the repo folder)",
  );
  return loaded;
}

export interface ScriptArgs {
  store: string;
  url: string | null;
  dryRun: boolean;
  archiveDays: number | null;
  allowExisting: boolean;
}

/** DATABASE_DIRECT_URL is the default URL (call loadScriptEnv first); `--url` wins. */
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

/** Project ref of a Supabase database URL (direct `db.<ref>.supabase.co`, or pooler user `postgres.<ref>`), else null. */
export function supabaseRefOfDbUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const direct = /^db\.([a-z0-9]+)\.supabase\.co$/i.exec(u.hostname);
    if (direct) return direct[1].toLowerCase();
    if (/\.pooler\.supabase\.com$/i.test(u.hostname)) {
      const user = /^[^.]+\.([a-z0-9]+)$/i.exec(decodeURIComponent(u.username));
      if (user) return user[1].toLowerCase();
    }
  } catch {
    // Not a URL: no ref.
  }
  return null;
}

/** Project ref of a Supabase project URL (`https://<ref>.supabase.co`), else null. */
export function supabaseRefOfProjectUrl(url: string): string | null {
  try {
    const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(new URL(url).hostname);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The import with --archive-days writes to Storage after the commit, so it
 * refuses up front (before the store is read or anything is written) when
 * Storage is not configured, or when SUPABASE_URL names another Supabase
 * project than the database URL (for example the scratch values of
 * .env.local while importing into production). A dry run is not refused.
 */
export function assertArchiveStorage(args: ScriptArgs, env: Record<string, string | undefined> = process.env): void {
  if (args.archiveDays === null || args.dryRun) return;
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new Error(
      `--archive-days needs Storage, but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set. ` +
        "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (export them in this terminal, or put them in .env.local). " +
        "Nothing was written.",
    );
  }
  const storageRef = supabaseRefOfProjectUrl(String(env.SUPABASE_URL));
  const dbRef = args.url ? supabaseRefOfDbUrl(args.url) : null;
  if (storageRef && dbRef && storageRef !== dbRef) {
    throw new Error(
      "--archive-days: SUPABASE_URL belongs to a different Supabase project than the database URL. " +
        "Does .env.local still hold the scratch project's values? Export the right SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY in this terminal (the terminal wins over .env.local). Nothing was written.",
    );
  }
}

/** Reads and parses store.json. The file is only read, never written. */
export async function loadStore(file: string): Promise<DatabaseShape> {
  const text = await readFile(file, "utf8");
  return JSON.parse(text) as DatabaseShape;
}

/**
 * A direct connection (not the transaction pooler), installed behind
 * getDb()/withTx so every repository uses it. Every transaction starts with
 * `SET LOCAL statement_timeout` of STATEMENT_TIMEOUT_MS; single statements
 * outside a transaction are bounded client-side (query_timeout).
 */
export function connectDirect(url: string): { client: TestClient; close(): Promise<void> } {
  if (isTransactionPooler(url)) {
    throw new Error(
      "this URL is the transaction pooler (port 6543 or pgbouncer=true): use the direct connection (DATABASE_DIRECT_URL) or the session pooler on port 5432",
    );
  }
  const pool = new Pool({
    ...poolConfigFor(url),
    max: 2,
    query_timeout: STATEMENT_TIMEOUT_MS + 30_000,
  });
  pool.on("error", (err) => console.error("[db] connection error:", err.message));
  const client = poolTestClient(pool, { statementTimeoutMs: STATEMENT_TIMEOUT_MS });
  setClient(client);
  return {
    client,
    async close() {
      setClient(null);
      await pool.end().catch(() => {});
    },
  };
}

/**
 * Supabase's transaction pooler (port 6543, also on *.pooler.supabase.com) or
 * any URL marked pgbouncer=true: it cannot hold a session. The session pooler
 * (pooler host, port 5432) is allowed.
 */
export function isTransactionPooler(url: string): boolean {
  try {
    const u = new URL(url);
    return u.port === "6543" || u.searchParams.get("pgbouncer")?.toLowerCase() === "true";
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
