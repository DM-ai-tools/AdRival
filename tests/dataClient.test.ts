import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pool } from "pg";

import { getDb, poolConfigFor, poolTestClient, withTx, type Queryable } from "../src/lib/data/client";
import { MIGRATION_QUERY_TIMEOUT_MS, migrationPoolConfig } from "../src/lib/data/startup";
import { migrate } from "../src/lib/data/migrate";
import { createPgliteClient, useTestDb } from "./helpers/testDb";

let cleanup: () => Promise<void> = async () => {};

before(async () => {
  ({ cleanup } = await useTestDb("client"));
});

after(async () => {
  await cleanup();
});

test("migrate applies every migration once and is idempotent", async () => {
  const fresh = await createPgliteClient();
  try {
    assert.deepEqual(await migrate(fresh), ["001_init.sql", "002_indexes.sql", "003_provider_calls_idempotency.sql"]);
    assert.deepEqual(await migrate(fresh), []);
    const { rows } = await fresh.query<{ name: string }>(
      "select name from schema_migrations order by name",
    );
    assert.deepEqual(
      rows.map((r) => r.name),
      ["001_init.sql", "002_indexes.sql", "003_provider_calls_idempotency.sql"],
    );
  } finally {
    await fresh.close();
  }
});

test("a failing migration file applies nothing and is not recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adrival-migrate-"));
  const fresh = await createPgliteClient();
  try {
    writeFileSync(join(dir, "001_ok.sql"), "create table ok_table (id text primary key);");
    writeFileSync(
      join(dir, "002_bad.sql"),
      "create table half_table (id text primary key);\nselect * from no_such_table;",
    );
    await assert.rejects(migrate(fresh, dir), /no_such_table/);
    const { rows } = await fresh.query<{ name: string }>("select name from schema_migrations");
    assert.deepEqual(
      rows.map((r) => r.name),
      ["001_ok.sql"],
    );
    const half = await fresh.query<{ n: string }>(
      "select count(*)::text as n from information_schema.tables where table_name = 'half_table'",
    );
    assert.equal(half.rows[0].n, "0");
  } finally {
    await fresh.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PGlite returns int8 as string and bytea as Buffer, like node-postgres", async () => {
  const { rows } = await getDb().query<{ n: unknown; b: unknown }>(
    "select 9007199254740993::int8 as n, '\\x616263'::bytea as b",
  );
  assert.equal(rows[0].n, "9007199254740993");
  assert.ok(Buffer.isBuffer(rows[0].b));
  assert.equal((rows[0].b as Buffer).toString(), "abc");
});

test("production pool config: max 10, 30 s statement timeout, TLS off only for localhost", () => {
  const remote = poolConfigFor(
    "postgresql://u:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require",
  );
  assert.equal(remote.max, 10);
  assert.equal(remote.query_timeout, 30_000);
  assert.equal(remote.statement_timeout, undefined, "startup param would be rejected by the transaction pooler");
  assert.deepEqual(remote.ssl, { rejectUnauthorized: false });
  assert.ok(!String(remote.connectionString).includes("sslmode"));

  assert.equal(poolConfigFor("postgres://u:p@localhost:5432/db").ssl, false);
  assert.equal(poolConfigFor("postgres://u:p@db.example.com/db?sslmode=disable").ssl, false);
});

test("useTestDb leaves the shared client fully migrated", async () => {
  assert.deepEqual(await migrate(getDb()), []);
});

test("every DatabaseShape collection has a table", async () => {
  const { rows } = await getDb().query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = current_schema()",
  );
  const names = new Set(rows.map((r) => r.table_name));
  for (const table of [
    "jobs",
    "competitors",
    "recreated_pages",
    "seen_page_ids",
    "lookup_jobs",
    "lookup_ads",
    "search_competitor_ads",
    "deleted_run_ids",
    "users",
    "app_settings",
    "conversion_rule_sets",
    "credit_periods",
    "credit_ledger",
    "credit_reservations",
    "provider_calls",
    "project_memberships",
    "project_spaces",
    "space_memberships",
    "audit_logs",
    "admin_alerts",
    "organizations",
    "login_attempts",
    "icps",
    "schema_migrations",
  ]) {
    assert.ok(names.has(table), `missing table ${table}`);
  }
  const seqs = await getDb().query<{ ledger: string; audit: string }>(
    "select nextval('ledger_seq')::text as ledger, nextval('audit_seq')::text as audit",
  );
  assert.equal(seqs.rows[0].ledger, "1");
  assert.equal(seqs.rows[0].audit, "1");
});

test("withTx commits on success", async () => {
  await withTx(async (tx) => {
    await tx.query("insert into seen_page_ids (id) values ($1)", ["committed"]);
  });
  const { rows } = await getDb().query<{ n: string }>(
    "select count(*)::text as n from seen_page_ids where id = $1",
    ["committed"],
  );
  assert.equal(rows[0].n, "1");
  await getDb().query("delete from seen_page_ids");
});

test("withTx rolls back an insert when the callback throws", async () => {
  await assert.rejects(
    withTx(async (tx) => {
      await tx.query("insert into seen_page_ids (id) values ($1)", ["page-1"]);
      throw new Error("boom");
    }),
    /boom/,
  );
  const { rows } = await getDb().query<{ n: string }>(
    "select count(*)::text as n from seen_page_ids",
  );
  assert.equal(rows[0].n, "0");
});

const TX_MISUSE = /use the tx handle passed to withTx, not getDb\(\), inside a transaction/;

test("inside withTx, getDb() and nested withTx throw; the tx handle works", async () => {
  await withTx(async (tx) => {
    await assert.rejects(getDb().query("select 1"), TX_MISUSE);
    await assert.rejects(
      withTx(async () => {}),
      TX_MISUSE,
    );
    await tx.query("insert into seen_page_ids (id) values ($1)", ["via-handle"]);
  });
  const { rows } = await getDb().query<{ n: string }>(
    "select count(*)::text as n from seen_page_ids where id = $1",
    ["via-handle"],
  );
  assert.equal(rows[0].n, "1");
  await getDb().query("delete from seen_page_ids");
});

test("work leaked past COMMIT goes through the mutex and a finished tx handle throws", async () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let handle: Queryable | null = null;
  let leaked: Promise<{ rows: { n: string }[] }> | null = null;
  await withTx(async (tx) => {
    handle = tx;
    // Deliberately not awaited: it outlives the transaction.
    leaked = (async () => {
      await wait(20);
      return getDb().query<{ n: string }>("select count(*)::text as n from seen_page_ids");
    })();
  });
  // A second transaction holds the connection while the leaked query fires,
  // then rolls back. Bypassing the mutex would read its uncommitted row.
  await assert.rejects(
    withTx(async (tx) => {
      await tx.query("insert into seen_page_ids (id) values ($1)", ["uncommitted"]);
      await wait(60);
      throw new Error("rollback on purpose");
    }),
    /rollback on purpose/,
  );
  assert.ok(leaked && handle);
  const result = await (leaked as Promise<{ rows: { n: string }[] }>);
  assert.equal(result.rows[0].n, "0");
  await assert.rejects((handle as Queryable).query("select 1"), /transaction is finished/);
});

test("concurrent migrators: one applies, the other skips without error", async () => {
  const fresh = await createPgliteClient();
  try {
    const [a, b] = await Promise.all([migrate(fresh), migrate(fresh)]);
    assert.deepEqual([...a, ...b].sort(), ["001_init.sql", "002_indexes.sql", "003_provider_calls_idempotency.sql"]);
    const { rows } = await fresh.query<{ n: string }>(
      "select count(*)::text as n from schema_migrations",
    );
    assert.equal(rows[0].n, "3");
  } finally {
    await fresh.close();
  }
});

test("concurrent withTx calls serialize on the single PGlite connection", async () => {
  const order: string[] = [];
  await Promise.all(
    ["a", "b", "c"].map((id) =>
      withTx(async (tx) => {
        order.push(`start-${id}`);
        await tx.query("insert into seen_page_ids (id) values ($1)", [id]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end-${id}`);
      }),
    ),
  );
  assert.deepEqual(order, ["start-a", "end-a", "start-b", "end-b", "start-c", "end-c"]);
  const { rows } = await getDb().query<{ n: string }>(
    "select count(*)::text as n from seen_page_ids",
  );
  assert.equal(rows[0].n, "3");
  await getDb().query("delete from seen_page_ids");
});

test("partial unique index allows only one current credit period per user", async () => {
  const insert =
    "insert into credit_periods (id, user_id, status, allowance, consumed, reserved, data) values ($1, $2, $3, 0, 0, 0, $4)";
  await getDb().query(insert, ["p1", "u1", "current", JSON.stringify({ id: "p1" })]);
  await getDb().query(insert, ["p0", "u1", "closed", JSON.stringify({ id: "p0" })]);
  await getDb().query(insert, ["p2", "u2", "current", JSON.stringify({ id: "p2" })]);
  await assert.rejects(
    getDb().query(insert, ["p3", "u1", "current", JSON.stringify({ id: "p3" })]),
    /duplicate key|unique/i,
  );
});

test("recreated_pages requires exactly one of content or archive_path", async () => {
  await getDb().query(
    "insert into competitors (id, run_id, data) values ($1, $2, $3)",
    ["c1", "r1", JSON.stringify({ id: "c1" })],
  );
  await assert.rejects(
    getDb().query("insert into recreated_pages (competitor_id, bytes) values ($1, 0)", ["c1"]),
    /check/i,
  );
  await getDb().query(
    "insert into recreated_pages (competitor_id, content, bytes) values ($1, $2, 3)",
    ["c1", Buffer.from("abc")],
  );
  const { rows } = await getDb().query<{ content: Uint8Array }>(
    "select content from recreated_pages where competitor_id = $1",
    ["c1"],
  );
  assert.equal(Buffer.from(rows[0].content).toString(), "abc");
});

test("ledger and audit rows take seq from their sequences", async () => {
  const ledger = await getDb().query<{ seq: string }>(
    "insert into credit_ledger (id, user_id, data) values ($1, $2, $3) returning seq::text",
    ["l1", "u1", JSON.stringify({ id: "l1" })],
  );
  assert.match(ledger.rows[0].seq, /^\d+$/);
  const audit = await getDb().query<{ seq: string }>(
    "insert into audit_logs (id, data) values ($1, $2) returning seq::text",
    ["a1", JSON.stringify({ id: "a1" })],
  );
  assert.match(audit.rows[0].seq, /^\d+$/);
});

/** A pg Pool stand-in that records the statements sent on its one connection. */
function recordingPool(sent: string[]): Pool {
  const conn = {
    query: (text: string) => {
      sent.push(text);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: () => {},
  };
  return { connect: () => Promise.resolve(conn) } as unknown as Pool;
}

test("pool transactions bound every statement server-side with SET LOCAL statement_timeout first", async () => {
  const sent: string[] = [];
  await poolTestClient(recordingPool(sent)).tx(async (tx) => {
    await tx.query("select 1");
  });
  assert.deepEqual(sent, ["BEGIN", "SET LOCAL statement_timeout = '30000ms'", "select 1", "COMMIT"]);

  const scripted: string[] = [];
  await poolTestClient(recordingPool(scripted), { statementTimeoutMs: 120_000 }).tx(async () => {});
  assert.deepEqual(scripted, ["BEGIN", "SET LOCAL statement_timeout = '120000ms'", "COMMIT"]);

  const none: string[] = [];
  await poolTestClient(recordingPool(none), { statementTimeoutMs: null }).tx(async () => {});
  assert.deepEqual(none, ["BEGIN", "COMMIT"]);
});

test("the migration pool gets a 10 minute query timeout and one connection", () => {
  const config = migrationPoolConfig("postgresql://u:p@db.example.supabase.co:5432/postgres");
  assert.equal(config.query_timeout, MIGRATION_QUERY_TIMEOUT_MS);
  assert.equal(MIGRATION_QUERY_TIMEOUT_MS, 600_000);
  assert.equal(config.max, 1);
});
