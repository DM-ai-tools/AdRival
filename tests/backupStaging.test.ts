import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";

import { Pool } from "pg";

import { BACKUP_BUCKET, BACKUP_LOCK_KEY, BackupBusyError, type BackupManifest, runBackup } from "../src/lib/data/backup";
import { getDb, poolConfigFor, withTx } from "../src/lib/data/client";
import { importStore } from "../src/lib/data/importStore";
import { createMemoryStorage, type StorageLike } from "../src/lib/data/storageClient";
import { fixtureStore } from "./helpers/storeFixture";
import { hasStagingDb, useStagingSchema } from "./helpers/testDb";

/*
 * The backup snapshot on a real Postgres with separate connections (PGlite
 * has one connection, so a write cannot commit while the backup's
 * transaction is open there). Skipped unless DATABASE_TEST_URL is set.
 */

const skip = hasStagingDb() ? false : "DATABASE_TEST_URL is not set";

let cleanup: () => Promise<void> = async () => {};

before(async () => {
  if (skip) return;
  ({ cleanup } = await useStagingSchema("backup-snapshot"));
  await importStore(getDb(), fixtureStore());
});

after(async () => {
  await cleanup();
});

function rows<T>(storage: ReturnType<typeof createMemoryStorage>, date: string, table: string): T[] {
  const manifest = JSON.parse(storage.objects.get(`${BACKUP_BUCKET}/${date}/manifest.json`)!.toString("utf8")) as BackupManifest;
  return manifest.tables
    .find((t) => t.name === table)!
    .parts.flatMap((part) =>
      gunzipSync(storage.objects.get(`${BACKUP_BUCKET}/${part.path}`)!)
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T),
    );
}

test("a credit change committed on another connection mid-backup is not in the snapshot", { skip }, async () => {
  const storage = createMemoryStorage();
  let wrote = false;
  const hooked: StorageLike = {
    ...storage,
    putObject: async (bucket, path, body) => {
      if (path.includes("/credit_periods") && !wrote) {
        wrote = true;
        // Commits for real (another pooled connection) between the period read and the ledger read.
        await withTx(async (tx) => {
          await tx.query("update credit_periods set reserved = reserved + 100 where id = 'p-alice'");
          await tx.query(
            `insert into credit_ledger (id, user_id, period_id, data)
             values ('l-snap', 'u-alice', 'p-alice', '{"type":"reservation_hold"}'::jsonb)`,
          );
        });
      }
      await storage.putObject(bucket, path, body);
    },
  };
  const { date } = await runBackup(getDb(), hooked);
  assert.ok(wrote);
  const period = rows<{ id: string; reserved: number }>(storage, date, "credit_periods").find((r) => r.id === "p-alice")!;
  assert.equal(Number(period.reserved), 200, "the snapshot predates the write");
  assert.ok(!rows<{ id: string }>(storage, date, "credit_ledger").some((r) => r.id === "l-snap"), "and so does the ledger");
});

test("a second backup while one holds the backup lock reports busy", { skip }, async () => {
  const other = new Pool({ ...poolConfigFor(process.env.DATABASE_TEST_URL!), max: 1 });
  const conn = await other.connect();
  try {
    await conn.query("begin");
    await conn.query("select pg_advisory_xact_lock($1)", [BACKUP_LOCK_KEY]);
    await assert.rejects(runBackup(getDb(), createMemoryStorage()), BackupBusyError);
    await conn.query("rollback");
  } finally {
    conn.release();
    await other.end();
  }
});
