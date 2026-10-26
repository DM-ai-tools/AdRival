import { createHash } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { constants as zlibConstants, createGunzip, createGzip, type Gzip } from "node:zlib";

import { getDb, withTx, type Queryable, type TestClient, type TxOptions } from "./client";
import { jsonText } from "./jsonText";
import { latestBackupFailure, recordBackupFailure } from "./settings";
import { safeMessage } from "./health";
import {
  getStorage,
  StorageNotConfiguredError,
  StorageNotFoundError,
  storageConfigured,
  type StorageLike,
} from "./storageClient";

/*
 * Nightly database backup into Supabase Storage (the free plan has no backups
 * or point-in-time recovery). No pg_dump: every table is read in primary-key
 * order, in batches, and streamed as gzip NDJSON (one JSON object per row, the
 * row as `to_jsonb`) to bucket `db-backups`:
 *
 *   db-backups/<YYYY-MM-DDTHHmmZ>/<table>.ndjson.gz        (a table that fits one part)
 *   db-backups/<YYYY-MM-DDTHHmmZ>/<table>.<n>.ndjson.gz    (a table split into parts)
 *   db-backups/<YYYY-MM-DDTHHmmZ>/manifest.json            (written LAST)
 *
 * Memory stays bounded: one compressed part (at most ~partBytes) and one
 * batch of rows are held at a time. bytea columns (recreated_pages.content)
 * are written as base64 strings (null stays null).
 *
 * A folder without manifest.json is an incomplete backup: it never counts for
 * retention, is never restored, and is deleted once it is a day old.
 *
 * Not in the backup: archived page content. Rows of recreated_pages that were
 * archived carry only archive_path; the files live in the
 * `recreated-pages-archive` bucket and are not copied here (see
 * docs/POSTGRES_OPERATIONS.md).
 *
 * One consistent snapshot: every read (migration list and every table) runs
 * in ONE `REPEATABLE READ, READ ONLY` transaction, so credit counters, ledger
 * and reservations, runs and their competitors, users and memberships all
 * come from the same moment, and no row moves between batches. The table
 * objects are uploaded from inside that transaction, one part at a time, so
 * memory stays bounded by one part (~40 MB) instead of the whole database;
 * the cost is one pooled connection and an open read-only snapshot for the
 * backup's duration (no row locks are taken; idle_in_transaction_session_
 * timeout of 10 min bounds a stuck upload). The manifest is written after
 * COMMIT and retention runs after it. A transaction-level advisory lock taken
 * first makes a second backup (another instance, an overlapping deploy)
 * report "already running" instead of running twice.
 */

export const BACKUP_BUCKET = "db-backups";

/** Every table of the app schema, in FK-safe restore order (competitors before recreated_pages). */
export const BACKUP_TABLES = [
  "schema_migrations",
  "organizations",
  "users",
  "project_spaces",
  "project_memberships",
  "space_memberships",
  "jobs",
  "lookup_jobs",
  "competitors",
  "recreated_pages",
  "lookup_ads",
  "search_competitor_ads",
  "icps",
  "credit_periods",
  "credit_ledger",
  "credit_reservations",
  "provider_calls",
  "audit_logs",
  "conversion_rule_sets",
  "app_settings",
  "admin_alerts",
  "login_attempts",
  "deleted_run_ids",
  "seen_page_ids",
] as const;

const MANIFEST = "manifest.json";
const DEFAULT_KEEP = 3;
/** Below the 50 MB per-file upload limit of the Supabase free plan, with room for gzip lag. */
const DEFAULT_PART_BYTES = 40 * 1024 * 1024;
const BATCH_ROWS = 2000;
/** Tables with bytea columns (page content, up to ~25 MB a row) are read a few rows at a time. */
const BYTEA_BATCH_ROWS = 1;
const INSERT_BATCH_ROWS = 500;
const INSERT_BATCH_BYTES = 8 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60_000;
const IDENT = /^[a-z_][a-z0-9_]*$/;
const FOLDER = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})Z(?:-(\d+))?$/;
/** pg_try_advisory_xact_lock key of the backup (any constant shared by every instance). */
export const BACKUP_LOCK_KEY = 7_302_010;
/** The snapshot transaction: one consistent read-only view, 5 min per statement, 10 min idle (uploads). */
const SNAPSHOT_TX: TxOptions = { snapshot: true, statementTimeoutMs: 5 * 60_000, idleTimeoutMs: 10 * 60_000 };

/** Restore skips rows whose parent is not in the target (only FK in the schema). */
const PARENT_FILTER: Record<string, string> = {
  recreated_pages: "exists (select 1 from competitors c where c.id = r.competitor_id)",
};

export interface BackupPart {
  /** Object path inside the bucket (`<date>/<file>`). */
  path: string;
  rows: number;
  bytes: number;
  sha256: string;
}

export interface BackupTable {
  name: string;
  primaryKey: string;
  columns: string[];
  /** Written as base64 strings. */
  byteaColumns: string[];
  rows: number;
  bytes: number;
  parts: BackupPart[];
}

export interface BackupManifest {
  format: "adrival-db-backup";
  version: 1;
  date: string;
  createdAt: string;
  migrations: string[];
  tables: BackupTable[];
  rows: number;
  bytes: number;
  note: string;
}

export interface BackupResult {
  date: string;
  /** `db-backups/<date>` */
  path: string;
  tables: number;
  rows: number;
  /** Compressed bytes of the table objects (the manifest not counted). */
  bytes: number;
}

export interface BackupSummary {
  date: string;
  createdAt: string;
  tables: number;
  rows: number;
  bytes: number;
}

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unexpected identifier: ${name}`);
  return `"${name}"`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `YYYY-MM-DDTHHmmZ` (UTC). */
export function backupFolderName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}Z`;
}

/** The time a folder name stands for, or null for a name that is not a backup folder. */
function folderTime(name: string): number | null {
  const m = FOLDER.exec(name);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

/* ── table metadata ── */

interface TableInfo {
  name: string;
  primaryKey: string;
  pkType: string;
  columns: string[];
  byteaColumns: string[];
}

async function baseTables(db: Queryable): Promise<Set<string>> {
  const { rows } = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = current_schema() and table_type = 'BASE TABLE'`,
  );
  return new Set(rows.map((r) => r.table_name));
}

async function tableInfo(db: Queryable, table: string): Promise<TableInfo> {
  ident(table);
  const cols = await db.query<{ column_name: string; data_type: string }>(
    `select column_name, data_type from information_schema.columns
      where table_schema = current_schema() and table_name = $1
      order by ordinal_position`,
    [table],
  );
  const pk = await db.query<{ attname: string; type: string }>(
    `select a.attname, format_type(a.atttypid, a.atttypmod) as type
       from pg_index i
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = $1::regclass and i.indisprimary`,
    [table],
  );
  if (pk.rows.length !== 1) throw new Error(`table ${table} needs a one-column primary key to be backed up`);
  const pkType = pk.rows[0].type;
  if (!/^[a-z ]+$/.test(pkType)) throw new Error(`table ${table}: unexpected primary key type ${pkType}`);
  const columns = cols.rows.map((c) => c.column_name);
  columns.forEach(ident);
  return {
    name: table,
    primaryKey: pk.rows[0].attname,
    pkType,
    columns,
    byteaColumns: cols.rows.filter((c) => c.data_type === "bytea").map((c) => c.column_name),
  };
}

/** BACKUP_TABLES, then any other table of the schema (logged: add it to BACKUP_TABLES). */
async function tablesToBackUp(db: Queryable): Promise<string[]> {
  const present = await baseTables(db);
  const known = BACKUP_TABLES.filter((t) => present.has(t));
  const listed = new Set<string>(BACKUP_TABLES);
  const extra = [...present].filter((t) => !listed.has(t) && IDENT.test(t)).sort();
  if (extra.length) console.warn(`[backup] tables not in BACKUP_TABLES are backed up too: ${extra.join(", ")}`);
  return [...known, ...extra];
}

/* ── writing ── */

/** One gzip object being built in memory. */
class PartWriter {
  private readonly gz: Gzip = createGzip();
  private readonly chunks: Buffer[] = [];
  private failure: Error | null = null;
  compressed = 0;
  /** Raw bytes written since the last flush: compressed output not yet counted is at most this much. */
  private pending = 0;
  rows = 0;

  constructor() {
    this.gz.on("data", (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.compressed += chunk.length;
    });
    this.gz.on("error", (err) => {
      this.failure = err;
    });
  }

  /** An upper bound of the object size if it were closed now. */
  bound(): number {
    return this.compressed + this.pending + 64;
  }

  async write(line: string, bytes: number): Promise<void> {
    if (this.failure) throw this.failure;
    this.rows += 1;
    this.pending += bytes;
    if (!this.gz.write(line)) await once(this.gz, "drain");
  }

  async flush(): Promise<void> {
    await new Promise<void>((resolve) => this.gz.flush(zlibConstants.Z_SYNC_FLUSH, () => resolve()));
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.pending = 0;
  }

  async finish(): Promise<Buffer> {
    const ended = once(this.gz, "end");
    this.gz.end();
    await ended;
    if (this.failure) throw this.failure;
    return Buffer.concat(this.chunks);
  }
}

interface WriteOptions {
  storage: StorageLike;
  bucket: string;
  folder: string;
  partBytes: number;
  batchRows: number;
}

async function backUpTable(db: Queryable, info: TableInfo, o: WriteOptions): Promise<BackupTable> {
  const t = ident(info.name);
  const pk = ident(info.primaryKey);
  const minus = info.byteaColumns.length
    ? ` - array[${info.byteaColumns.map((c) => `'${c}'`).join(", ")}]::text[]`
    : "";
  const bytea = info.byteaColumns.map((c, i) => `, t.${ident(c)} as b${i}`).join("");
  const select = `select t.${pk}::text as k, (to_jsonb(t)${minus})::text as j${bytea} from ${t} t`;
  const limit = info.byteaColumns.length ? Math.min(o.batchRows, BYTEA_BATCH_ROWS) : o.batchRows;

  const parts: BackupPart[] = [];
  let writer = new PartWriter();
  let rows = 0;

  let partFirstKey = "";
  const upload = async (body: Buffer, file: string, partRows: number, firstKey: string) => {
    if (partRows === 1 && body.length > o.partBytes) {
      // Retrying cannot help: say which row, so it can be dealt with (Storage refuses files over its limit).
      throw new Error(
        `${info.name} row ${firstKey} is ${(body.length / 1e6).toFixed(1)} MB compressed, over the ` +
          `${(o.partBytes / 1e6).toFixed(1)} MB part limit; it cannot be backed up`,
      );
    }
    const path = `${o.folder}/${file}`;
    await o.storage.putObject(o.bucket, path, body);
    parts.push({ path, rows: partRows, bytes: body.length, sha256: sha256(body) });
  };
  const partFile = (n: number) => `${info.name}.${n}.ndjson.gz`;

  let last: string | null = null;
  for (;;) {
    const batch: { rows: Array<Record<string, unknown> & { k: string; j: string }> } =
      last === null
        ? await db.query(`${select} order by t.${pk} limit $1`, [limit])
        : await db.query(`${select} where t.${pk} > $1::${info.pkType} order by t.${pk} limit $2`, [last, limit]);
    for (const row of batch.rows) {
      let line: string;
      if (info.byteaColumns.length) {
        // The row text without its bytea columns, with each spliced in last as
        // base64 (never JSON.parse/stringify the row: `data` stays as Postgres wrote it).
        const tail = info.byteaColumns
          .map((c, i) => {
            const value = row[`b${i}`] as Buffer | Uint8Array | null | undefined;
            return `,"${c}":${value ? `"${Buffer.from(value).toString("base64")}"` : "null"}`;
          })
          .join("");
        line = `${row.j.slice(0, -1)}${tail}}\n`;
      } else {
        line = `${row.j}\n`;
      }
      const bytes = Buffer.byteLength(line);
      if (writer.rows > 0 && writer.bound() + bytes > o.partBytes) {
        await writer.flush();
        if (writer.compressed + bytes > o.partBytes) {
          // Another row follows, so this table has parts: number them.
          const done = writer;
          const doneKey = partFirstKey;
          writer = new PartWriter();
          await upload(await done.finish(), partFile(parts.length + 1), done.rows, doneKey);
        }
      }
      if (writer.rows === 0) partFirstKey = row.k;
      await writer.write(line, bytes);
      rows += 1;
    }
    if (batch.rows.length < limit) break;
    last = batch.rows[batch.rows.length - 1].k;
  }
  const body = await writer.finish();
  await upload(body, parts.length === 0 ? `${info.name}.ndjson.gz` : partFile(parts.length + 1), writer.rows, partFirstKey);

  return {
    name: info.name,
    primaryKey: info.primaryKey,
    columns: info.columns,
    byteaColumns: info.byteaColumns,
    rows,
    bytes: parts.reduce((n, p) => n + p.bytes, 0),
    parts,
  };
}

/** Runs `fn` in the snapshot transaction on `db` (a client with tx, or the app database). */
function snapshotRunner(db: Queryable): <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T> {
  const own = (db as Partial<TestClient>).tx;
  if (typeof own === "function") return <T>(fn: (tx: Queryable) => Promise<T>) => own.call(db, fn, SNAPSHOT_TX) as Promise<T>;
  if (db === getDb()) return (fn) => withTx(fn, SNAPSHOT_TX);
  throw new Error("runBackup needs the app database or a client that can open a transaction");
}

/** A folder name for `now` that no object uses yet. */
async function freeFolder(storage: StorageLike, bucket: string, now: Date): Promise<string> {
  const base = backupFolderName(now);
  for (let n = 1; n < 100; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    if ((await storage.list(bucket, name)).length === 0) return name;
  }
  throw new Error(`too many backups named ${base}`);
}

/**
 * Backs up every table to `bucket` (default db-backups) from one consistent
 * snapshot, writes the manifest after the snapshot transaction committed,
 * then applies retention (keep the newest `keep`, default 3, complete
 * backups; a retention failure is logged, the backup still counts).
 */
export async function runBackup(
  db: Queryable,
  storage: StorageLike,
  opts: { keep?: number; now?: Date; bucket?: string; partBytes?: number; batchRows?: number } = {},
): Promise<BackupResult> {
  const bucket = opts.bucket ?? BACKUP_BUCKET;
  const now = opts.now ?? new Date();
  const folder = await freeFolder(storage, bucket, now);
  const write: WriteOptions = {
    storage,
    bucket,
    folder,
    partBytes: opts.partBytes ?? DEFAULT_PART_BYTES,
    batchRows: opts.batchRows ?? BATCH_ROWS,
  };

  const { migrations, tables } = await snapshotRunner(db)(async (tx) => {
    // First statement: one backup at a time across every instance.
    const lock = await tx.query<{ ok: boolean }>("select pg_try_advisory_xact_lock($1) as ok", [BACKUP_LOCK_KEY]);
    if (!lock.rows[0]?.ok) throw new BackupBusyError();
    const names = (await tx.query<{ name: string }>("select name from schema_migrations order by name")).rows.map(
      (r) => r.name,
    );
    const done: BackupTable[] = [];
    for (const name of await tablesToBackUp(tx)) done.push(await backUpTable(tx, await tableInfo(tx, name), write));
    return { migrations: names, tables: done };
  });

  const manifest: BackupManifest = {
    format: "adrival-db-backup",
    version: 1,
    date: folder,
    createdAt: now.toISOString(),
    migrations,
    tables,
    rows: tables.reduce((n, t) => n + t.rows, 0),
    bytes: tables.reduce((n, t) => n + t.bytes, 0),
    note:
      "Archived recreated page content lives in the recreated-pages-archive bucket and is not part of this backup; " +
      "recreated_pages rows carry archive_path only.",
  };
  await storage.putObject(bucket, `${folder}/${MANIFEST}`, Buffer.from(JSON.stringify(manifest, null, 2)));

  try {
    await applyRetention(storage, { keep: opts.keep ?? DEFAULT_KEEP, now, bucket });
  } catch (err) {
    console.warn(`[backup] retention failed (the backup itself is complete): ${safeMessage(err)}`);
  }

  return { date: folder, path: `${bucket}/${folder}`, tables: tables.length, rows: manifest.rows, bytes: manifest.bytes };
}

/* ── manifests and retention ── */

function isManifest(value: unknown): value is BackupManifest {
  const m = value as Partial<BackupManifest> | null;
  return Boolean(
    m && m.format === "adrival-db-backup" && m.version === 1 && Array.isArray(m.tables) && typeof m.createdAt === "string",
  );
}

/** The manifest of a backup folder; null when it has none (incomplete) or it is unreadable as a manifest. */
export async function readManifest(
  storage: StorageLike,
  date: string,
  bucket: string = BACKUP_BUCKET,
): Promise<BackupManifest | null> {
  if (!FOLDER.test(date)) throw new Error(`not a backup date: ${date}`);
  let raw: Buffer;
  try {
    raw = await storage.getObject(bucket, `${date}/${MANIFEST}`);
  } catch (err) {
    if (err instanceof StorageNotFoundError) return null;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function deleteFolder(storage: StorageLike, bucket: string, folder: string): Promise<void> {
  const objects = await storage.list(bucket, folder);
  const manifest = `${folder}/${MANIFEST}`;
  // Manifest first: a half-deleted folder is then "incomplete", never a complete backup with parts missing.
  if (objects.includes(manifest)) await storage.deleteObject(bucket, manifest);
  for (const path of objects) if (path !== manifest) await storage.deleteObject(bucket, path);
}

async function scanFolders(
  storage: StorageLike,
  bucket: string,
): Promise<{ complete: Array<{ folder: string; manifest: BackupManifest }>; incomplete: Array<{ folder: string; at: number }> }> {
  const complete: Array<{ folder: string; manifest: BackupManifest }> = [];
  const incomplete: Array<{ folder: string; at: number }> = [];
  for (const folder of await storage.listFolders(bucket, "")) {
    const at = folderTime(folder);
    if (at === null) continue; // not ours: never touched
    const manifest = await readManifest(storage, folder, bucket);
    if (manifest) complete.push({ folder, manifest });
    else incomplete.push({ folder, at });
  }
  complete.sort((a, b) =>
    a.manifest.createdAt === b.manifest.createdAt
      ? b.folder.localeCompare(a.folder)
      : b.manifest.createdAt.localeCompare(a.manifest.createdAt),
  );
  return { complete, incomplete };
}

/**
 * Keeps the newest `keep` complete backups (at least one: the newest complete
 * backup is never deleted) and deletes the older ones; deletes incomplete
 * folders older than a day. Returns the deleted folder names.
 */
export async function applyRetention(
  storage: StorageLike,
  opts: { keep?: number; now?: Date; bucket?: string } = {},
): Promise<string[]> {
  const bucket = opts.bucket ?? BACKUP_BUCKET;
  const now = (opts.now ?? new Date()).getTime();
  const keep = Math.max(1, Math.floor(opts.keep ?? DEFAULT_KEEP));
  const { complete, incomplete } = await scanFolders(storage, bucket);
  const deleted: string[] = [];
  for (const { folder } of complete.slice(keep)) {
    await deleteFolder(storage, bucket, folder);
    deleted.push(folder);
  }
  for (const { folder, at } of incomplete) {
    if (now - at <= DAY_MS) continue; // may still be uploading
    await deleteFolder(storage, bucket, folder);
    deleted.push(folder);
  }
  return deleted;
}

/** Complete backups, newest first. */
export async function listBackups(storage: StorageLike, opts: { bucket?: string } = {}): Promise<BackupSummary[]> {
  const { complete } = await scanFolders(storage, opts.bucket ?? BACKUP_BUCKET);
  return complete.map(({ folder, manifest }) => ({
    date: folder,
    createdAt: manifest.createdAt,
    tables: manifest.tables.length,
    rows: manifest.rows,
    bytes: manifest.bytes,
  }));
}

/** The manifest of `date`; throws when the backup is missing or incomplete, or a part path is outside it. */
async function completeManifest(storage: StorageLike, date: string, bucket: string): Promise<BackupManifest> {
  const manifest = await readManifest(storage, date, bucket);
  if (!manifest) throw new Error(`backup ${date} is missing or incomplete (no manifest)`);
  for (const table of manifest.tables) {
    ident(table.name);
    table.columns.forEach(ident);
    for (const part of table.parts) {
      if (!part.path.startsWith(`${date}/`) || part.path.includes("..")) {
        throw new Error(`backup ${date}: object path ${part.path} is outside the backup`);
      }
    }
  }
  return manifest;
}

async function verifiedObject(storage: StorageLike, bucket: string, part: BackupPart): Promise<Buffer> {
  const body = await storage.getObject(bucket, part.path);
  if (body.length !== part.bytes || sha256(body) !== part.sha256) {
    throw new Error(`backup object ${part.path} failed its sha-256 check: it was changed or damaged`);
  }
  return body;
}

/**
 * Downloads a complete backup (the newest when `date` is omitted), checking
 * every object against the manifest's sha-256, and hands each to `save`
 * (path relative to the bucket), the manifest last.
 */
export async function pullBackup(
  storage: StorageLike,
  save: (path: string, body: Buffer) => Promise<void>,
  opts: { date?: string; bucket?: string } = {},
): Promise<{ date: string; objects: number; bytes: number }> {
  const bucket = opts.bucket ?? BACKUP_BUCKET;
  const date = opts.date ?? (await listBackups(storage, { bucket }))[0]?.date;
  if (!date) throw new Error(`no complete backup in bucket ${bucket}`);
  const manifest = await completeManifest(storage, date, bucket);
  let objects = 0;
  let bytes = 0;
  for (const table of manifest.tables) {
    for (const part of table.parts) {
      const body = await verifiedObject(storage, bucket, part);
      await save(part.path, body);
      objects += 1;
      bytes += body.length;
    }
  }
  await save(`${date}/${MANIFEST}`, Buffer.from(JSON.stringify(manifest, null, 2)));
  return { date, objects: objects + 1, bytes };
}

/* ── restore ── */

/** Every line of a gzip NDJSON object, streamed (the uncompressed text is never held whole). */
async function* ndjsonLines(body: Buffer): AsyncGenerator<string> {
  const gunzip = createGunzip();
  const input = Readable.from([body]).pipe(gunzip);
  let failure: Error | null = null;
  gunzip.on("error", (err) => {
    failure = err;
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line) yield line;
  }
  if (failure) throw failure;
}

async function insertJsonBatch(db: Queryable, table: BackupTable, lines: string[]): Promise<number> {
  const t = ident(table.name);
  const cols = table.columns.map(ident).join(", ");
  const filter = PARENT_FILTER[table.name] ? ` where ${PARENT_FILTER[table.name]}` : "";
  const { rowCount } = await db.query(
    `insert into ${t} (${cols})
     select ${table.columns.map((c) => `r.${ident(c)}`).join(", ")}
       from jsonb_populate_recordset(null::${t}, $1::jsonb) r${filter}
     on conflict do nothing`,
    [`[${lines.join(",")}]`],
  );
  return rowCount;
}

/** The row text without its spliced bytea tail, and each bytea value (see backUpTable). */
export function splitByteaLine(line: string, byteaColumns: string[]): { json: string; values: Array<Buffer | null> } {
  const tail = byteaColumns.map((c) => `,"${c}":(null|"([A-Za-z0-9+/=]*)")`).join("");
  const m = new RegExp(`${tail}\\}$`).exec(line);
  if (m) {
    const values = byteaColumns.map((_, i) => (m[2 * i + 1] === "null" ? null : Buffer.from(m[2 * i + 2], "base64")));
    return { json: `${line.slice(0, m.index)}}`, values };
  }
  // Not in the spliced layout (hand-edited file): parse it.
  const obj = JSON.parse(line) as Record<string, unknown>;
  const values = byteaColumns.map((c) => {
    const value = obj[c];
    delete obj[c];
    return typeof value === "string" ? Buffer.from(value, "base64") : null;
  });
  return { json: jsonText(obj), values };
}

async function insertByteaRow(db: Queryable, table: BackupTable, line: string): Promise<number> {
  const t = ident(table.name);
  const { json, values } = splitByteaLine(line, table.byteaColumns);
  const params: unknown[] = [json, ...values];
  const select = table.columns.map((c) => {
    const i = table.byteaColumns.indexOf(c);
    return i >= 0 ? `$${i + 2}::bytea` : `r.${ident(c)}`;
  });
  const filter = PARENT_FILTER[table.name] ? ` where ${PARENT_FILTER[table.name]}` : "";
  const { rowCount } = await db.query(
    `insert into ${t} (${table.columns.map(ident).join(", ")})
     select ${select.join(", ")} from jsonb_populate_record(null::${t}, $1::jsonb) r${filter}
     on conflict do nothing`,
    params,
  );
  return rowCount;
}

/** Moves owned sequences (ledger_seq, audit_seq) past the restored values; never backwards. */
async function resetSequences(db: Queryable, table: BackupTable): Promise<void> {
  for (const column of table.columns) {
    const { rows } = await db.query<{ s: string | null }>("select pg_get_serial_sequence($1, $2) as s", [
      table.name,
      column,
    ]);
    const seq = rows[0]?.s;
    if (!seq) continue;
    const max = await db.query<{ m: string | null }>(`select max(${ident(column)})::text as m from ${ident(table.name)}`);
    // The name comes from the catalog (already quoted where needed); checked anyway.
    if (!/^[A-Za-z0-9_."]+$/.test(seq)) throw new Error(`unexpected sequence name: ${seq}`);
    const state = await db.query<{ last: string; called: boolean }>(
      `select last_value::text as last, is_called as called from ${seq}`,
    );
    const restored = BigInt(max.rows[0]?.m ?? "0");
    const current = state.rows[0]?.called ? BigInt(state.rows[0].last) : BigInt(0);
    const value = restored > current ? restored : current;
    if (value < BigInt(1)) continue;
    await db.query("select setval($1::regclass, $2::bigint, true)", [seq, value.toString()]);
  }
}

/**
 * Restores backup `date` into `db` (schema migrated already). Before anything
 * is inserted: the manifest must exist, every object must match its sha-256,
 * the target must have every migration and column the backup has, and (unless
 * `into: 'allow-existing'`) every table must be empty. Inserts in FK-safe
 * order with `on conflict do nothing`, so a re-run adds nothing; then moves
 * the sequences past the restored rows.
 */
export async function restoreBackup(
  db: Queryable,
  storage: StorageLike,
  date: string,
  opts: { into?: "empty" | "allow-existing"; bucket?: string } = {},
): Promise<{ tables: number; rows: number; inserted: number; skipped: number }> {
  // skipped: rows of the backup not inserted (schema_migrations, which the migrations fill first, not counted).
  const bucket = opts.bucket ?? BACKUP_BUCKET;
  const manifest = await completeManifest(storage, date, bucket);

  // Target checks.
  const present = await baseTables(db);
  for (const table of manifest.tables) {
    if (!present.has(table.name)) throw new Error(`restore target has no table ${table.name}: run the migrations first`);
    const info = await tableInfo(db, table.name);
    const missing = table.columns.filter((c) => !info.columns.includes(c));
    if (missing.length) {
      throw new Error(`restore target table ${table.name} lacks column(s) ${missing.join(", ")}: run the migrations first`);
    }
  }
  const applied = new Set(
    (await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name),
  );
  const lacking = manifest.migrations.filter((m) => !applied.has(m));
  if (lacking.length) throw new Error(`restore target lacks migration(s) ${lacking.join(", ")}: run the migrations first`);
  if (opts.into !== "allow-existing") {
    for (const table of manifest.tables) {
      if (table.name === "schema_migrations") continue;
      const { rows } = await db.query(`select 1 from ${ident(table.name)} limit 1`);
      if (rows.length) {
        throw new Error(`restore target is not empty (table ${table.name} has rows); pass allow-existing to restore into it`);
      }
    }
  }

  // Every object checked before the first insert.
  for (const table of manifest.tables) {
    for (const part of table.parts) await verifiedObject(storage, bucket, part);
  }

  const order = (name: string) => {
    const i = (BACKUP_TABLES as readonly string[]).indexOf(name);
    return i < 0 ? BACKUP_TABLES.length : i;
  };
  const tables = [...manifest.tables].sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));

  let rows = 0;
  let inserted = 0;
  let skipped = 0;
  const differences: string[] = [];
  for (const table of tables) {
    let tableInserted = 0;
    let tableRead = 0;
    for (const part of table.parts) {
      const body = await verifiedObject(storage, bucket, part);
      let batch: string[] = [];
      let batchBytes = 0;
      const flush = async () => {
        if (batch.length) tableInserted += await insertJsonBatch(db, table, batch);
        batch = [];
        batchBytes = 0;
      };
      for await (const line of ndjsonLines(body)) {
        tableRead += 1;
        if (table.byteaColumns.length) {
          tableInserted += await insertByteaRow(db, table, line);
          continue;
        }
        batch.push(line);
        batchBytes += line.length;
        if (batch.length >= INSERT_BATCH_ROWS || batchBytes >= INSERT_BATCH_BYTES) await flush();
      }
      await flush();
    }
    await resetSequences(db, table);
    rows += tableRead;
    inserted += tableInserted;
    if (table.name !== "schema_migrations") skipped += tableRead - tableInserted;
    // schema_migrations is filled by the migrations the target ran first.
    if (table.name !== "schema_migrations" && (tableInserted !== table.rows || tableRead !== table.rows)) {
      differences.push(`${table.name}: ${table.rows} in the backup, ${tableInserted} restored`);
    }
  }
  if (opts.into !== "allow-existing" && differences.length) {
    // Into an empty database every row must land: a drop (unique conflict, missing parent, bad count) is an error.
    throw new Error(
      `restore incomplete: ${differences.join("; ")}. The database now holds a partial restore: ` +
        "drop and recreate it, or re-run with allow-existing after fixing the cause.",
    );
  }
  if (skipped > 0) {
    console.warn(`[backup] restore of ${date}: ${skipped} row(s) not inserted (already there, or a missing parent page)`);
  }
  return { tables: tables.length, rows, inserted, skipped };
}

/* ── scheduler and keep-alive ── */

export class BackupBusyError extends Error {
  constructor() {
    super("a backup is already running");
    this.name = "BackupBusyError";
  }
}

let running = false;
let lastTickError: string | null = null;

/** One backup of the app database to Storage now (one at a time per process). */
export async function runBackupNow(opts: { keep?: number } = {}): Promise<BackupResult> {
  if (!storageConfigured()) throw new StorageNotConfiguredError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  if (running) throw new BackupBusyError();
  running = true;
  try {
    return await runBackup(getDb(), getStorage(), opts);
  } finally {
    running = false;
  }
}

export type TickOutcome = "ok" | "failed" | "busy" | "skipped";

/** One scheduled backup: logs one line (never a secret) and reports how it went. */
export async function backupTick(): Promise<TickOutcome> {
  if (!storageConfigured()) {
    console.log("[backup] skipped: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    return "skipped";
  }
  const started = Date.now();
  try {
    const r = await runBackupNow();
    console.log(
      `[backup] ${r.path}: ${r.tables} tables, ${r.rows} rows, ${(r.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
    return "ok";
  } catch (err) {
    if (err instanceof BackupBusyError) {
      console.log("[backup] skipped: a backup is already running");
      return "busy";
    }
    lastTickError = safeMessage(err);
    console.error(`[backup] failed: ${lastTickError}`);
    return "failed";
  }
}

const RUN_HOUR = 2;
const RETRY_MS = 15 * 60_000;

/** Milliseconds from `now` to the next `hour`:00 server local time (tomorrow when it has passed). */
export function msUntilNextRun(now: Date, hour: number = RUN_HOUR): number {
  const next = new Date(now.getTime());
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export interface BackupSchedulerDeps {
  run: () => Promise<TickOutcome>;
  now: () => Date;
  setTimer: (fn: () => void, ms: number) => void;
  /** Called once when the retry failed too (raise an admin alert). */
  onRetryFailed?: () => void | Promise<void>;
}

/** Nightly at 02:00; a failed run is retried once after 15 minutes, then the nightly schedule resumes. */
export function createBackupScheduler(deps: BackupSchedulerDeps): { start(): void } {
  const nightly = () => deps.setTimer(() => void fire(false), msUntilNextRun(deps.now()));
  const fire = async (retry: boolean) => {
    let outcome: TickOutcome;
    try {
      outcome = await deps.run();
    } catch {
      outcome = "failed";
    }
    if (outcome === "failed" && !retry) {
      deps.setTimer(() => void fire(true), RETRY_MS);
      return;
    }
    if (outcome === "failed" && deps.onRetryFailed) {
      try {
        await deps.onRetryFailed();
      } catch (err) {
        console.error(`[backup] could not record the failure alert: ${safeMessage(err)}`);
      }
    }
    nightly();
  };
  return { start: nightly };
}

let schedulerStarted = false;

/** Starts the nightly backup; off (one log line, false) when Storage is not configured. Timers are unref'd. */
export function startBackupScheduler(): boolean {
  if (schedulerStarted) return true;
  if (!storageConfigured()) {
    console.log("[backup] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: nightly database backup is off");
    return false;
  }
  schedulerStarted = true;
  createBackupScheduler({
    run: backupTick,
    now: () => new Date(),
    setTimer: (fn, ms) => {
      setTimeout(fn, ms).unref();
    },
    onRetryFailed: () => recordBackupFailureAlert(lastTickError ?? "unknown error"),
  }).start();
  return true;
}

const KEEP_ALIVE_MS = 12 * 60 * 60_000;
let keepAliveStarted = false;

/** `select 1`; logs (without secrets) only when it fails. */
export async function keepAlivePing(): Promise<boolean> {
  try {
    await getDb().query("select 1");
    return true;
  } catch (err) {
    console.error(`[keep-alive] database ping failed: ${safeMessage(err)}`);
    return false;
  }
}

/** Pings the database every 12 h so an idle free-plan project is not paused. Unref'd. */
export function startKeepAlive(): boolean {
  if (keepAliveStarted) return true;
  keepAliveStarted = true;
  setInterval(() => void keepAlivePing(), KEEP_ALIVE_MS).unref();
  return true;
}

/** An admin alert (Alerts panel) that the nightly backup failed twice in a row. */
export function recordBackupFailureAlert(message: string): Promise<void> {
  return recordBackupFailure(safeMessage(message));
}

/** The newest backup-failure alert, for GET /api/admin/backup. */
export async function lastBackupFailure(): Promise<{ at: string; message: string } | null> {
  const alert = await latestBackupFailure();
  return alert ? { at: alert.createdAt, message: alert.message } : null;
}
