/*
 * Database backups from a shell (see docs/POSTGRES_OPERATIONS.md).
 *
 *   npm run backup:run     -- [--url <direct url>] [--keep 3]
 *   npm run backup:pull    -- --out <dir> [--date <YYYY-MM-DDTHHmmZ>]
 *   npm run backup:restore -- --date <d> --into-url <direct url> [--allow-existing] [--from <dir>]
 *
 * run      backs the database up to Storage (bucket db-backups), like the
 *          nightly job. --url defaults to DATABASE_DIRECT_URL.
 * pull     downloads the newest complete backup (or --date), checking every
 *          file's sha-256 against the manifest, into <dir>/<date>/ on this
 *          machine: a copy OUTSIDE the Supabase project.
 * restore  restores a backup into the database at --into-url (migrated
 *          first). It refuses a database that has rows unless
 *          --allow-existing. --from <dir> reads a pulled copy (<dir>/<date>/)
 *          instead of Storage.
 *
 * Storage needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Database URLs
 * must be a direct or session-pooler (port 5432) connection, never the
 * transaction pooler (6543). Nothing secret is printed.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { BACKUP_TABLES, listBackups, pullBackup, restoreBackup, runBackup } from "../src/lib/data/backup";
import type { Queryable } from "../src/lib/data/client";
import { migrate } from "../src/lib/data/migrate";
import { getStorage, StorageNotFoundError, type StorageLike } from "../src/lib/data/storageClient";
import { connectDirect, describeUrl, elapsed } from "./storeScriptArgs";

interface Args {
  command: string;
  url: string | null;
  intoUrl: string | null;
  out: string | null;
  from: string | null;
  date: string | null;
  keep: number | null;
  allowExisting: boolean;
}

export function parseBackupArgs(argv: string[]): Args {
  const [command = "", ...rest] = argv;
  const args: Args = {
    command,
    url: process.env.DATABASE_DIRECT_URL || null,
    intoUrl: null,
    out: null,
    from: null,
    date: null,
    keep: null,
    allowExisting: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = () => {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    if (flag === "--url") args.url = value();
    else if (flag === "--into-url") args.intoUrl = value();
    else if (flag === "--out") args.out = value();
    else if (flag === "--from") args.from = value();
    else if (flag === "--date") args.date = value();
    else if (flag === "--allow-existing") args.allowExisting = true;
    else if (flag === "--keep") {
      const raw = value();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--keep must be a whole number from 1, got ${raw}`);
      args.keep = n;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

/** A read-only StorageLike over a pulled copy: `<root>/<date>/<file>` (the bucket is ignored). */
function directoryStorage(root: string): StorageLike {
  const resolve = (p: string) => {
    const base = path.resolve(root);
    const full = path.resolve(base, p);
    if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`path outside ${root}: ${p}`);
    return full;
  };
  const readOnly = () => Promise.reject(new Error("a pulled backup directory is read-only"));
  return {
    async getObject(bucket, p) {
      try {
        return await readFile(resolve(p));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new StorageNotFoundError(bucket, p);
        throw err;
      }
    },
    putObject: readOnly,
    deleteObject: readOnly,
    async list(_bucket, prefix) {
      const dir = resolve(prefix);
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      return entries.filter((e) => e.isFile()).map((e) => (prefix ? `${prefix}/${e.name}` : e.name));
    },
    async listFolders(_bucket, prefix) {
      const entries = await readdir(resolve(prefix), { withFileTypes: true }).catch(() => []);
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    },
  };
}

/** Rows in any app table (tables that do not exist yet count as empty). */
async function firstNonEmptyTable(db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'",
  );
  const present = new Set(rows.map((r) => r.table_name));
  for (const table of BACKUP_TABLES) {
    if (table === "schema_migrations" || !present.has(table)) continue;
    const found = await db.query(`select 1 from ${table} limit 1`);
    if (found.rows.length) return table;
  }
  return null;
}

async function run(args: Args, started: number): Promise<void> {
  if (!args.url) throw new Error("no database: pass --url or set DATABASE_DIRECT_URL");
  console.log(`source ${describeUrl(args.url)}`);
  const conn = connectDirect(args.url);
  try {
    const result = await runBackup(conn.client, getStorage(), args.keep ? { keep: args.keep } : {});
    console.log(
      `backup ${result.path}: ${result.tables} tables, ${result.rows} rows, ${(result.bytes / 1e6).toFixed(1)} MB in ${elapsed(started)}`,
    );
  } finally {
    await conn.close();
  }
}

async function pull(args: Args, started: number): Promise<void> {
  if (!args.out) throw new Error("pull needs --out <dir>");
  const out = path.resolve(args.out);
  const result = await pullBackup(
    getStorage(),
    async (objectPath, body) => {
      const file = path.resolve(out, objectPath);
      if (!file.startsWith(out + path.sep)) throw new Error(`object path outside --out: ${objectPath}`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body);
    },
    args.date ? { date: args.date } : {},
  );
  console.log(
    `pulled ${result.date}: ${result.objects} files, ${(result.bytes / 1e6).toFixed(1)} MB, sha-256 checked, into ${path.join(out, result.date)} in ${elapsed(started)}`,
  );
}

async function restore(args: Args, started: number): Promise<void> {
  if (!args.date) throw new Error("restore needs --date <YYYY-MM-DDTHHmmZ> (see `backup:pull` or GET /api/admin/backup)");
  if (!args.intoUrl) throw new Error("restore needs --into-url <direct url of the target database>");
  const storage = args.from ? directoryStorage(path.resolve(args.from)) : getStorage();
  console.log(`restore ${args.date} from ${args.from ? path.resolve(args.from) : "Storage db-backups"} into ${describeUrl(args.intoUrl)}`);
  const conn = connectDirect(args.intoUrl);
  try {
    // Before anything is written (migrations included).
    const busy = await firstNonEmptyTable(conn.client);
    if (busy && !args.allowExisting) {
      throw new Error(`target is not empty (table ${busy} has rows); pass --allow-existing to restore into it`);
    }
    const applied = await migrate(conn.client);
    console.log(applied.length ? `applied migrations: ${applied.join(", ")}` : "schema is current");
    const result = await restoreBackup(conn.client, storage, args.date, {
      into: args.allowExisting ? "allow-existing" : "empty",
    });
    console.log(
      `restored ${result.tables} tables: ${result.rows} rows read, ${result.inserted} inserted, ${result.skipped} skipped (already there or orphaned) in ${elapsed(started)}`,
    );
  } finally {
    await conn.close();
  }
}

async function main(): Promise<void> {
  const args = parseBackupArgs(process.argv.slice(2));
  const started = Date.now();
  if (args.command === "run") await run(args, started);
  else if (args.command === "pull") await pull(args, started);
  else if (args.command === "restore") await restore(args, started);
  else if (args.command === "list") {
    for (const b of await listBackups(getStorage())) {
      console.log(`${b.date}  ${b.tables} tables  ${b.rows} rows  ${(b.bytes / 1e6).toFixed(1)} MB`);
    }
  } else throw new Error("usage: backup-db.ts run | pull --out <dir> | restore --date <d> --into-url <url> | list");
}

main().catch((err: unknown) => {
  console.error(`backup-db failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
