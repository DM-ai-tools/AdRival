import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { getDb, setClientForTests, type Queryable, type TestClient, type TxOptions } from "../src/lib/data/client";
import { migrate } from "../src/lib/data/migrate";
import {
  BACKUP_BUCKET,
  BACKUP_TABLES,
  type BackupManifest,
  backupTick,
  recordBackupFailureAlert,
  createBackupScheduler,
  keepAlivePing,
  listBackups,
  msUntilNextRun,
  restoreBackup,
  runBackup,
  startBackupScheduler,
} from "../src/lib/data/backup";
import { ARCHIVE_BUCKET } from "../src/lib/data/archive";
import { importStore } from "../src/lib/data/importStore";
import * as competitors from "../src/lib/data/competitors";
import * as identity from "../src/lib/data/identity";
import {
  createMemoryStorage,
  createSupabaseStorage,
  setStorageForTests,
  type StorageLike,
} from "../src/lib/data/storageClient";
import type { AppUser } from "../src/lib/types";
import { asUser, readJson } from "./helpers/routeRequest";
import { fixtureStore } from "./helpers/storeFixture";
import { createPgliteClient, type PgliteTestClient } from "./helpers/testDb";

/*
 * Nightly database backup to Storage (in-memory here), restore, retention, the
 * scheduler, the admin route, and two hardening items (Storage list paging;
 * updateCompetitorWith fetching archived content outside its transaction).
 */

process.env.SESSION_SECRET = "backup-test-secret";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const backupRoute = await import("../src/app/api/admin/backup/route");

let source: PgliteTestClient;
let storage: ReturnType<typeof createMemoryStorage>;
const extra: PgliteTestClient[] = [];

beforeEach(async () => {
  source = await createPgliteClient();
  await migrate(source);
  setClientForTests(source);
  storage = createMemoryStorage();
  setStorageForTests(storage);
});

afterEach(async () => {
  setStorageForTests(null);
  setClientForTests(null);
  await source.close();
  while (extra.length) await extra.pop()!.close();
});

async function freshTarget(): Promise<PgliteTestClient> {
  const db = await createPgliteClient();
  await migrate(db);
  extra.push(db);
  return db;
}

/** Every collection filled (fixture import) and one page archived to Storage. */
async function seed(): Promise<void> {
  await importStore(getDb(), fixtureStore());
  await getDb().query("update recreated_pages set updated_at = now() - interval '30 days' where competitor_id = 'c-1'");
  const { archiveOldPages } = await import("../src/lib/data/archive");
  assert.deepEqual(await archiveOldPages({ olderThanDays: 1 }), { archived: 1, failed: 0 });
  // A second page left in the database, so both content shapes are backed up.
  assert.equal(
    await competitors.saveCompetitor({
      id: "c-db",
      runId: "job-1",
      pageId: "db-page",
      pageName: "Db Page",
      activeAdsCount: 1,
      createdAt: new Date().toISOString(),
      recreatedPageHeavy: { html: `<html>${randomBytes(3000).toString("hex")}</html>` },
    } as Parameters<typeof competitors.saveCompetitor>[0]),
    true,
  );
}

async function primaryKey(db: Queryable, table: string): Promise<string> {
  const { rows } = await db.query<{ attname: string }>(
    `select a.attname from pg_index i
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = $1::regclass and i.indisprimary`,
    [table],
  );
  return rows[0].attname;
}

/** Row count and sha-256 of the canonical rows of every table (schema_migrations by name only). */
async function fingerprint(db: Queryable): Promise<Record<string, { rows: number; sha: string }>> {
  const out: Record<string, { rows: number; sha: string }> = {};
  for (const table of BACKUP_TABLES) {
    const pk = await primaryKey(db, table);
    const projection = table === "schema_migrations" ? "name" : "to_jsonb(t)::text";
    const { rows } = await db.query<{ j: string }>(`select ${projection} as j from ${table} t order by ${pk}`);
    const hash = createHash("sha256");
    for (const r of rows) hash.update(`${r.j}\n`);
    out[table] = { rows: rows.length, sha: hash.digest("hex") };
  }
  return out;
}

function manifestOf(date: string): BackupManifest {
  const raw = storage.objects.get(`${BACKUP_BUCKET}/${date}/manifest.json`);
  assert.ok(raw, `manifest of ${date}`);
  return JSON.parse(raw.toString("utf8")) as BackupManifest;
}

/** Storage that records the order of uploads. */
function recording(inner: StorageLike, puts: string[]): StorageLike {
  return {
    ...inner,
    putObject: async (bucket, path, body) => {
      puts.push(`${bucket}/${path}`);
      await inner.putObject(bucket, path, body);
    },
  };
}

/* ── tables ── */

test("BACKUP_TABLES names every table the migrations create, plus schema_migrations", () => {
  const dir = join(process.cwd(), "db", "migrations");
  const created = new Set<string>(["schema_migrations"]);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(dir, file), "utf8");
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) {
      created.add(m[1].toLowerCase());
    }
  }
  assert.deepEqual([...BACKUP_TABLES].sort(), [...created].sort());
});

/* ── backup ── */

test("a backup writes one or more objects per table, then the manifest last", async () => {
  await seed();
  const puts: string[] = [];
  const result = await runBackup(getDb(), recording(storage, puts), { now: new Date("2026-10-26T02:00:07Z") });

  assert.equal(result.date, "2026-10-26T0200Z");
  assert.equal(result.path, `${BACKUP_BUCKET}/2026-10-26T0200Z`);
  assert.equal(result.tables, BACKUP_TABLES.length);
  assert.ok(result.rows > 0);
  assert.equal(puts[puts.length - 1], `${BACKUP_BUCKET}/2026-10-26T0200Z/manifest.json`, "manifest is written last");

  const manifest = manifestOf(result.date);
  assert.deepEqual(manifest.migrations, [
    "001_init.sql",
    "002_indexes.sql",
    "003_provider_calls_idempotency.sql",
    "004_recreate_jobs.sql",
    "005_lookup_recreate_space.sql",
  ]);
  assert.equal(manifest.tables.length, BACKUP_TABLES.length);
  let rows = 0;
  let bytes = 0;
  for (const table of manifest.tables) {
    assert.ok(table.parts.length >= 1, `${table.name} has an object`);
    for (const part of table.parts) {
      const body = storage.objects.get(`${BACKUP_BUCKET}/${part.path}`);
      assert.ok(body, part.path);
      assert.equal(createHash("sha256").update(body).digest("hex"), part.sha256);
      assert.equal(body.length, part.bytes);
      const lines = gunzipSync(body).toString("utf8").split("\n").filter(Boolean);
      assert.equal(lines.length, part.rows);
    }
    rows += table.rows;
    bytes += table.bytes;
  }
  assert.equal(result.rows, rows);
  assert.equal(result.bytes, bytes);
  const counts = Object.fromEntries(manifest.tables.map((t) => [t.name, t.rows]));
  assert.equal(counts.recreated_pages, 2);
  assert.equal(counts.users, 2);
  assert.equal(counts.schema_migrations, 5);

  // Archived content stays in the archive bucket: the row carries only its path.
  const pagesPart = manifest.tables.find((t) => t.name === "recreated_pages")!.parts[0];
  const pageRows = gunzipSync(storage.objects.get(`${BACKUP_BUCKET}/${pagesPart.path}`)!)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { competitor_id: string; content: string | null; archive_path: string | null });
  const archived = pageRows.find((r) => r.competitor_id === "c-1")!;
  assert.equal(archived.content, null);
  assert.equal(archived.archive_path, `${ARCHIVE_BUCKET}/c-1.json.gz`);
  const inDb = pageRows.find((r) => r.competitor_id === "c-db")!;
  assert.equal(typeof inDb.content, "string", "content is base64");
});

test("restore into a fresh database reproduces every table, row for row", async () => {
  await seed();
  const { date } = await runBackup(getDb(), storage);
  const target = await freshTarget();

  const restored = await restoreBackup(target, storage, date);
  assert.equal(restored.tables, BACKUP_TABLES.length);

  const want = await fingerprint(source);
  const got = await fingerprint(target);
  assert.deepEqual(got, want);

  // Sequences continue after the restored rows.
  const max = await target.query<{ ledger: string; audit: string }>(
    "select (select max(seq) from credit_ledger)::text as ledger, (select max(seq) from audit_logs)::text as audit",
  );
  const next = await target.query<{ ledger: string; audit: string }>(
    "select nextval('ledger_seq')::text as ledger, nextval('audit_seq')::text as audit",
  );
  assert.ok(Number(next.rows[0].ledger) > Number(max.rows[0].ledger));
  assert.ok(Number(next.rows[0].audit) > Number(max.rows[0].audit));
});

test("restore refuses a non-empty target unless allow-existing; a re-run changes nothing", async () => {
  await seed();
  const { date } = await runBackup(getDb(), storage);
  const target = await freshTarget();
  await restoreBackup(target, storage, date);
  const once = await fingerprint(target);

  await assert.rejects(restoreBackup(target, storage, date), /not empty/);
  await restoreBackup(target, storage, date, { into: "allow-existing" });
  assert.deepEqual(await fingerprint(target), once);
});

test("restore refuses a target that lacks a migration the backup has", async () => {
  await seed();
  const { date } = await runBackup(getDb(), storage);
  const target = await freshTarget();
  await target.query("delete from schema_migrations where name = '003_provider_calls_idempotency.sql'");
  await assert.rejects(restoreBackup(target, storage, date), /003_provider_calls_idempotency\.sql/);
});

test("an object changed in Storage makes restore refuse before inserting anything", async () => {
  await seed();
  const { date } = await runBackup(getDb(), storage);
  const manifest = manifestOf(date);
  // Tamper with the LAST table, so a restore that inserted as it verified would already have written rows.
  const last = manifest.tables[manifest.tables.length - 1].parts[0];
  const key = `${BACKUP_BUCKET}/${last.path}`;
  const body = Buffer.from(storage.objects.get(key)!);
  body[body.length - 1] ^= 0xff;
  storage.objects.set(key, body);

  const target = await freshTarget();
  await assert.rejects(restoreBackup(target, storage, date), /sha-256/);
  const counts = await fingerprint(target);
  for (const table of BACKUP_TABLES) {
    if (table === "schema_migrations") continue;
    assert.equal(counts[table].rows, 0, `${table} untouched`);
  }
});

test("a table bigger than the part size is split into numbered parts and restored", async () => {
  await seed();
  for (let i = 0; i < 40; i += 1) {
    await getDb().query("insert into seen_page_ids (id, data) values ($1, $2::jsonb)", [
      `big-${i}`,
      JSON.stringify({ blob: randomBytes(12_000).toString("base64") }),
    ]);
  }
  const { date } = await runBackup(getDb(), storage, { partBytes: 100_000 });
  const manifest = manifestOf(date);
  const seen = manifest.tables.find((t) => t.name === "seen_page_ids")!;
  assert.ok(seen.parts.length >= 3, `parts: ${seen.parts.length}`);
  assert.deepEqual(
    seen.parts.map((p) => p.path),
    seen.parts.map((_, i) => `${date}/seen_page_ids.${i + 1}.ndjson.gz`),
  );
  for (const part of seen.parts) assert.ok(part.bytes < 100_000 + 20_000, `${part.path} ${part.bytes}`);
  assert.equal(seen.parts.reduce((n, p) => n + p.rows, 0), seen.rows);
  // A table that fits keeps the plain name.
  assert.deepEqual(manifest.tables.find((t) => t.name === "users")!.parts.map((p) => p.path), [`${date}/users.ndjson.gz`]);

  const target = await freshTarget();
  await restoreBackup(target, storage, date);
  assert.deepEqual(await fingerprint(target), await fingerprint(source));
});

/* ── retention ── */

test("retention keeps the newest 3 complete backups and cleans old incomplete folders", async () => {
  await seed();
  const day = (d: number, h = 2) => new Date(Date.UTC(2026, 9, d, h, 0, 0));
  for (const d of [20, 21, 22]) await runBackup(getDb(), storage, { now: day(d) });
  // An incomplete folder from a crashed run 2 days before the next backup, and a fresh one (an upload in progress).
  await storage.putObject(BACKUP_BUCKET, "2026-10-21T1200Z/users.ndjson.gz", Buffer.from("x"));
  await storage.putObject(BACKUP_BUCKET, "2026-10-23T0130Z/users.ndjson.gz", Buffer.from("x"));

  await runBackup(getDb(), storage, { now: day(23) });

  const folders = new Set(
    [...storage.objects.keys()].filter((k) => k.startsWith(`${BACKUP_BUCKET}/`)).map((k) => k.split("/")[1]),
  );
  assert.deepEqual([...folders].sort(), ["2026-10-21T0200Z", "2026-10-22T0200Z", "2026-10-23T0130Z", "2026-10-23T0200Z"]);
  assert.deepEqual(
    (await listBackups(storage)).map((b) => b.date),
    ["2026-10-23T0200Z", "2026-10-22T0200Z", "2026-10-21T0200Z"],
  );
});

test("retention never deletes the newest complete backup, even with keep 0", async () => {
  await seed();
  await runBackup(getDb(), storage, { now: new Date("2026-10-20T02:00:00Z") });
  await runBackup(getDb(), storage, { now: new Date("2026-10-21T02:00:00Z"), keep: 0 });
  assert.deepEqual((await listBackups(storage)).map((b) => b.date), ["2026-10-21T0200Z"]);
});

test("two backups in the same minute get separate folders", async () => {
  await seed();
  const now = new Date("2026-10-20T02:00:00Z");
  const a = await runBackup(getDb(), storage, { now });
  const b = await runBackup(getDb(), storage, { now });
  assert.notEqual(a.date, b.date);
  assert.equal((await listBackups(storage)).length, 2);
});

test("listBackups reports date, tables, rows and bytes of complete backups only", async () => {
  await seed();
  const result = await runBackup(getDb(), storage, { now: new Date("2026-10-20T02:00:00Z") });
  await storage.putObject(BACKUP_BUCKET, "2026-10-26T0200Z/users.ndjson.gz", Buffer.from("x"));
  const list = await listBackups(storage);
  assert.equal(list.length, 1);
  assert.equal(list[0].date, result.date);
  assert.equal(list[0].tables, result.tables);
  assert.equal(list[0].rows, result.rows);
  assert.equal(list[0].bytes, result.bytes);
});

/* ── scheduler and keep-alive ── */

test("next run is 02:00 server time: later today, or tomorrow once past", () => {
  const before = new Date(2026, 9, 26, 1, 30, 0);
  assert.equal(msUntilNextRun(before), 30 * 60_000);
  const after = new Date(2026, 9, 26, 2, 0, 0);
  assert.equal(msUntilNextRun(after), 24 * 60 * 60_000);
  const evening = new Date(2026, 9, 26, 23, 0, 0);
  assert.equal(msUntilNextRun(evening), 3 * 60 * 60_000);
});

test("the scheduler re-arms for the next night, and retries a failed run once after 15 minutes", async () => {
  const timers: number[] = [];
  const pending: Array<() => void> = [];
  const outcomes = ["failed", "failed", "ok"] as const;
  let calls = 0;
  const scheduler = createBackupScheduler({
    run: () => Promise.resolve(outcomes[calls++] ?? "ok"),
    now: () => new Date(2026, 9, 26, 1, 0, 0),
    setTimer: (fn, ms) => {
      timers.push(ms);
      pending.push(fn);
    },
  });
  scheduler.start();
  assert.deepEqual(timers, [60 * 60_000], "first run at 02:00");
  const step = async () => {
    pending.shift()!();
    await new Promise((r) => setImmediate(r));
  };
  await step(); // nightly: failed
  assert.deepEqual(timers.slice(1), [15 * 60_000], "one retry after 15 min");
  await step(); // retry: failed again -> back to the nightly schedule, no second retry
  assert.deepEqual(timers.slice(2), [60 * 60_000]);
  await step(); // ok
  assert.deepEqual(timers.slice(3), [60 * 60_000]);
  assert.equal(calls, 3);
});

test("the backup scheduler stays off without Storage; a tick never overlaps another", async () => {
  setStorageForTests(null);
  assert.equal(startBackupScheduler(), false);
  assert.equal(await backupTick(), "skipped");

  setStorageForTests(storage);
  await seed();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  setStorageForTests({
    ...storage,
    putObject: async (bucket, path, body) => {
      await gate;
      await storage.putObject(bucket, path, body);
    },
  });
  const first = backupTick();
  assert.equal(await backupTick(), "busy");
  release();
  assert.equal(await first, "ok");
});

test("keep-alive pings the database and only logs on failure", async () => {
  assert.equal(await keepAlivePing(), true);
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  setClientForTests({
    query: () => Promise.reject(new Error("connect ECONNREFUSED postgres://u:secret@db.example.com:5432/postgres")),
    tx: () => Promise.reject(new Error("down")),
  });
  try {
    assert.equal(await keepAlivePing(), false);
  } finally {
    console.error = realError;
    setClientForTests(source);
  }
  assert.equal(errors.length, 1);
  assert.ok(!errors.flat().join(" ").includes("secret"));
});

/* ── route ── */

async function makeUser(username: string, role: "admin" | "user", orgId: string | null = null): Promise<AppUser> {
  return identity.createUser({ username, displayName: username, passwordHash: "x", role, orgId });
}

function postBackup(user: AppUser | null) {
  return asUser(user, async () => readJson(await backupRoute.POST()));
}

function getBackups(user: AppUser | null) {
  return asUser(user, async () => readJson(await backupRoute.GET()));
}

test("the backup route is for platform admins only", async () => {
  await makeUser("root", "admin");
  const org = await identity.createOrganization({ name: "Acme", createdByUserId: null });
  const orgAdmin = await makeUser("acme-admin", "admin", org.id);
  const plain = await makeUser("plain", "user");

  assert.equal((await postBackup(plain)).status, 403);
  assert.equal((await postBackup(orgAdmin)).status, 403);
  assert.equal((await postBackup(null)).status, 401);
  assert.equal((await getBackups(orgAdmin)).status, 403);
  assert.equal(storage.objects.size, 0, "nothing written by a refused call");
});

test("a platform admin backs up now (audited) and lists complete backups; no Storage is a 503", async () => {
  const root = await makeUser("root", "admin");
  const res = await postBackup(root);
  assert.equal(res.status, 200);
  assert.equal(res.body.tables, BACKUP_TABLES.length);
  assert.equal(typeof res.body.date, "string");

  const list = await getBackups(root);
  assert.equal(list.status, 200);
  const backups = list.body.backups as Array<{ date: string; tables: number; rows: number; bytes: number }>;
  assert.equal(backups.length, 1);
  assert.equal(backups[0].date, res.body.date);

  const { rows } = await getDb().query<{ data: { details: Record<string, unknown> } }>(
    "select data from audit_logs where data->>'action' = 'admin.backup'",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.details.date, res.body.date);

  setStorageForTests(null);
  const off = await postBackup(root);
  assert.equal(off.status, 503);
  assert.equal(off.body.code, "storage_not_configured");
  assert.equal((await getBackups(root)).status, 503);
});

/* ── hardening: Storage list paging ── */

test("REST list pages until an empty page, even when the server returns fewer rows than asked", async () => {
  const names = Array.from({ length: 2300 }, (_, i) => `obj-${String(i).padStart(5, "0")}.gz`);
  const entries = [
    ...names.map((name, i) => ({ name, id: `id-${i}` })),
    { name: "2026-10-20T0200Z", id: null },
    { name: "2026-10-21T0200Z", id: null },
  ];
  const offsets: number[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { offset: number; limit: number };
    offsets.push(body.offset);
    assert.equal(body.limit, 1000);
    // The server caps a page at 500 whatever the limit says.
    return new Response(JSON.stringify(entries.slice(body.offset, body.offset + 500)), { status: 200 });
  }) as typeof fetch;
  try {
    const s = createSupabaseStorage({ url: "https://proj.supabase.co", serviceRoleKey: "k", retryDelayMs: 1 });
    const listed = await s.list("b1", "");
    assert.equal(listed.length, 2300);
    assert.deepEqual(listed.slice(0, 2), ["obj-00000.gz", "obj-00001.gz"]);
    assert.deepEqual(offsets, [0, 500, 1000, 1500, 2000, 2302]);
    offsets.length = 0;
    assert.deepEqual(await s.listFolders("b1", ""), ["2026-10-20T0200Z", "2026-10-21T0200Z"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ── hardening: archived content fetched outside the write transaction ── */

test("updateCompetitorWith({withContent}) fetches an archived page before opening its transaction", async () => {
  await seed(); // c-1 is archived
  const fetchedInTx: boolean[] = [];
  setStorageForTests({
    ...storage,
    getObject: async (bucket, path) => {
      fetchedInTx.push(source.inTransaction());
      return storage.getObject(bucket, path);
    },
  });
  let seenHtml = "";
  const next = await competitors.updateCompetitorWith(
    "c-1",
    (_stored, content) => {
      seenHtml = content?.html ?? "";
      return { activeAdsCount: 9 };
    },
    { withContent: true },
  );
  assert.equal(next?.activeAdsCount, 9);
  assert.ok(seenHtml.length > 1000, "the updater got the archived content");
  assert.deepEqual(fetchedInTx, [false], "one fetch, outside the transaction");
});

test("updateCompetitorWith re-reads when the page changed between the prefetch and the lock", async () => {
  await seed();
  const { setRecreatedPage } = await import("../src/lib/data/recreatedPages");
  let first = true;
  setStorageForTests({
    ...storage,
    getObject: async (bucket, path) => {
      const body = await storage.getObject(bucket, path);
      if (first) {
        first = false;
        // An edit lands after the prefetch: content is back in the database.
        assert.equal(await setRecreatedPage("c-1", { html: "<html>edited</html>" }), true);
      }
      return body;
    },
  });
  let seenHtml = "";
  await competitors.updateCompetitorWith(
    "c-1",
    (_stored, content) => {
      seenHtml = content?.html ?? "";
      return null;
    },
    { withContent: true },
  );
  assert.equal(seenHtml, "<html>edited</html>");
});

/* ── review fixes: one snapshot, loud restore, alerts ── */

function partRows<T>(date: string, table: string): T[] {
  const entry = manifestOf(date).tables.find((t) => t.name === table)!;
  return entry.parts.flatMap((part) =>
    gunzipSync(storage.objects.get(`${BACKUP_BUCKET}/${part.path}`)!)
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T),
  );
}

test("every read of a backup runs in ONE repeatable-read, read-only transaction, isolation set before the first read", async () => {
  await seed();
  const seen: { outside: string[]; inside: string[]; iso?: string; ro?: string; opts?: TxOptions } = {
    outside: [],
    inside: [],
  };
  const wrapped: TestClient = {
    query: (text, params) => {
      seen.outside.push(text);
      return source.query(text, params);
    },
    tx: (fn, opts) => {
      seen.opts = opts;
      return source.tx(async (handle) => {
        const probe = await handle.query<{ iso: string; ro: string }>(
          "select current_setting('transaction_isolation') as iso, current_setting('transaction_read_only') as ro",
        );
        seen.iso = probe.rows[0].iso;
        seen.ro = probe.rows[0].ro;
        return fn({
          query: (text, params) => {
            seen.inside.push(text);
            return handle.query(text, params);
          },
        });
      }, opts);
    },
  };
  await runBackup(wrapped, storage);
  assert.deepEqual(seen.outside, [], "no read outside the snapshot");
  assert.equal(seen.opts?.snapshot, true);
  assert.equal(seen.iso, "repeatable read");
  assert.equal(seen.ro, "on");
  assert.match(seen.inside[0], /pg_try_advisory_xact_lock/, "the backup lock is the first statement");
  assert.ok(seen.inside.some((q) => /from "credit_ledger"/.test(q)));
});

test("a credit change committed while the backup runs is either wholly in it or wholly out", async () => {
  await importStore(getDb(), fixtureStore());
  const writes: Promise<void>[] = [];
  const hooked: StorageLike = {
    ...storage,
    putObject: async (bucket, path, body) => {
      if (path.includes("/credit_periods") && writes.length === 0) {
        // Another connection reserves 100 more, with the matching ledger and reservation rows, between two table reads.
        writes.push(source.detached(() =>
          source.tx(async (tx) => {
            await tx.query("update credit_periods set reserved = reserved + 100 where id = 'p-alice'");
            await tx.query(
              `insert into credit_reservations (id, user_id, period_id, status, expires_at, data)
               values ('r-snap', 'u-alice', 'p-alice', 'open', now() + interval '1 hour', '{}'::jsonb)`,
            );
            await tx.query(
              `insert into credit_ledger (id, user_id, period_id, data)
               values ('l-snap', 'u-alice', 'p-alice', '{"type":"reservation_hold"}'::jsonb)`,
            );
          }),
        ));
      }
      await storage.putObject(bucket, path, body);
    },
  };
  const { date } = await runBackup(getDb(), hooked);
  assert.equal(writes.length, 1, "the concurrent write was started during the backup");
  await Promise.all(writes);

  const period = partRows<{ id: string; reserved: number | string }>(date, "credit_periods").find((r) => r.id === "p-alice")!;
  const hasLedger = partRows<{ id: string }>(date, "credit_ledger").some((r) => r.id === "l-snap");
  const hasReservation = partRows<{ id: string }>(date, "credit_reservations").some((r) => r.id === "r-snap");
  const counted = Number(period.reserved) === 300;
  assert.equal(hasLedger, counted, "ledger row and period counter agree");
  assert.equal(hasReservation, counted, "reservation and period counter agree");
  const after = await getDb().query<{ reserved: string }>("select reserved::text as reserved from credit_periods where id = 'p-alice'");
  assert.equal(after.rows[0].reserved, "300", "the write itself committed");
});

test("restore into an empty database fails, naming the table, when the manifest's row count does not match", async () => {
  await seed();
  const { date } = await runBackup(getDb(), storage);
  const manifest = manifestOf(date);
  manifest.tables.find((t) => t.name === "users")!.rows += 1;
  storage.objects.set(`${BACKUP_BUCKET}/${date}/manifest.json`, Buffer.from(JSON.stringify(manifest)));
  const target = await freshTarget();
  await assert.rejects(restoreBackup(target, storage, date), /users: 3 in the backup, 2 restored/);
});

test("restore into an empty database fails when a row is dropped by a unique conflict; allow-existing reports it", async () => {
  await seed();
  const { date } = await runBackup(getDb(), storage);
  const manifest = manifestOf(date);
  const users = manifest.tables.find((t) => t.name === "users")!;
  const part = users.parts[0];
  const lines = gunzipSync(storage.objects.get(`${BACKUP_BUCKET}/${part.path}`)!)
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  const twin = JSON.parse(lines[0]) as Record<string, unknown>;
  twin.id = "u-twin"; // same username: users_username_lower_key rejects it
  lines.push(JSON.stringify(twin));
  const body = gzipSync(`${lines.join("\n")}\n`);
  storage.objects.set(`${BACKUP_BUCKET}/${part.path}`, body);
  Object.assign(part, { rows: lines.length, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
  users.rows = lines.length;
  storage.objects.set(`${BACKUP_BUCKET}/${date}/manifest.json`, Buffer.from(JSON.stringify(manifest)));

  await assert.rejects(restoreBackup(await freshTarget(), storage, date), /users: 3 in the backup, 2 restored/);
  const result = await restoreBackup(await freshTarget(), storage, date, { into: "allow-existing" });
  assert.equal(result.skipped, 1);
});

test("page rows keep their data object; content is spliced in last as base64", async () => {
  await seed();
  await getDb().query(`update recreated_pages set data = '{"note":"kept","n":1}'::jsonb where competitor_id = 'c-db'`);
  const { date } = await runBackup(getDb(), storage);
  const part = manifestOf(date).tables.find((t) => t.name === "recreated_pages")!.parts[0];
  const lines = gunzipSync(storage.objects.get(`${BACKUP_BUCKET}/${part.path}`)!)
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.match(line, /,"content":(null|"[A-Za-z0-9+/=]*")\}$/);
  const target = await freshTarget();
  await restoreBackup(target, storage, date);
  assert.deepEqual(await fingerprint(target), await fingerprint(source));
});

test("a single page row bigger than the part limit fails the backup with a message naming the competitor", async () => {
  await seed();
  // ~20 KB of incompressible content; every other row compresses far below 10 KB.
  await getDb().query("update recreated_pages set content = $1 where competitor_id = 'c-db'", [randomBytes(20_000)]);
  await assert.rejects(runBackup(getDb(), storage, { partBytes: 10_000 }), /recreated_pages row c-db/);
  assert.equal((await listBackups(storage)).length, 0, "no manifest: not a backup");
});

test("a failed retry raises an admin alert; GET shows the last success and the last failure", async () => {
  const alerts: number[] = [];
  const pending: Array<() => void> = [];
  let calls = 0;
  createBackupScheduler({
    run: () => {
      calls += 1;
      return Promise.resolve("failed");
    },
    now: () => new Date(2026, 9, 26, 1, 0, 0),
    setTimer: (fn) => {
      pending.push(fn);
    },
    onRetryFailed: () => {
      alerts.push(calls);
    },
  }).start();
  const step = async () => {
    pending.shift()!();
    await new Promise((r) => setImmediate(r));
  };
  await step();
  assert.deepEqual(alerts, [], "no alert after the first failure");
  await step();
  assert.deepEqual(alerts, [2], "one alert once the retry failed too");

  const root = await makeUser("root", "admin");
  assert.equal((await postBackup(root)).status, 200);
  await recordBackupFailureAlert("Storage upload failed: HTTP 500");
  const list = await getBackups(root);
  const body = list.body as { lastSuccess: { date: string } | null; lastFailure: { at: string; message: string } | null };
  assert.ok(body.lastSuccess?.date);
  assert.equal(body.lastFailure?.message, "Storage upload failed: HTTP 500");
  const { rows } = await getDb().query<{ data: { kind: string } }>("select data from admin_alerts");
  assert.deepEqual(rows.map((r) => r.data.kind), ["backup_failed"]);
});
