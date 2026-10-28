import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GET as health } from "../src/app/api/health/route";
import { setClientForTests, type TestClient } from "../src/lib/data/client";
import { runStartup } from "../src/lib/data/startup";
import * as svc from "../src/lib/data/accountingService";
import * as runs from "../src/lib/data/runs";
import { creditsToSubunits } from "../src/lib/accounting/units";
import { createPgliteClient, type PgliteTestClient } from "./helpers/testDb";
import { makeUser } from "./helpers/factories";
import type { SearchJob } from "../src/lib/types";

let client: PgliteTestClient;

before(async () => {
  client = await createPgliteClient();
  setClientForTests(client);
});

after(async () => {
  setClientForTests(null);
  await client.close();
});

function job(id: string, status: SearchJob["status"]): SearchJob {
  const at = new Date().toISOString();
  return {
    id,
    keyword: id,
    keywords: [id],
    platform: "facebook",
    geo: "AU",
    countries: ["AU"],
    status,
    progress: { stage: status === "running" ? "searching_ads" : "done", scannedAds: 0, scannedPages: 0, accepted: 0, target: 1, rejected: 0, message: "x" },
    competitorIds: [],
    ownerUserId: null,
    createdAt: at,
    updatedAt: at,
  };
}

test("health: 200 db up when the database answers", async () => {
  await runStartup(); // schema first, so later tests share the same db
  const res = await health();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, "up");
  assert.equal(body.service, "adrival");
});

test("health: 503 db down with no connection string in the error", async () => {
  const broken: TestClient = {
    query: async () => {
      throw new Error("connect ECONNREFUSED postgres://user:secret@db.example.com:6543/postgres");
    },
    tx: async () => {
      throw new Error("no tx");
    },
  };
  setClientForTests(broken);
  try {
    const res = await health();
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.db, "down");
    assert.equal(typeof body.error, "string");
    assert.ok(!/postgres(ql)?:\/\//i.test(body.error), body.error);
    assert.ok(!body.error.includes("secret"), body.error);
    assert.equal(body.error, "database unreachable", "no detail for unauthenticated callers");
  } finally {
    setClientForTests(client);
  }
});

test("runStartup: migrates, recovers interrupted jobs and expired reservations; second call is a no-op", async () => {
  // The first test already migrated; use a fresh database for the first-run result.
  const fresh = await createPgliteClient();
  setClientForTests(fresh);
  try {
    const first = await runStartup();
    assert.deepEqual(first.migrated, ["001_init.sql", "002_indexes.sql", "003_provider_calls_idempotency.sql", "004_recreate_jobs.sql", "005_lookup_recreate_space.sql"]);
    assert.equal(first.interrupted, 0);

    const running = job("run-1", "running");
    const done = job("done-1", "completed");
    await runs.saveJob(running);
    await runs.saveJob(done);
    const user = await makeUser({ credits: 10 });
    await svc.reserveCredits({ userId: user.id, amountSubunits: creditsToSubunits(1), operation: "crash", ttlMs: -60_000 });

    const second = await runStartup();
    assert.deepEqual(second.migrated, []);
    assert.equal(second.interrupted, 1);
    assert.equal(second.swept, 1);
    assert.equal((await runs.getJob("run-1"))?.status, "failed");
    assert.equal((await runs.getJob("done-1"))?.status, "completed");

    const third = await runStartup();
    assert.deepEqual(third, { migrated: [], interrupted: 0, swept: 0 });
  } finally {
    setClientForTests(client);
    await fresh.close();
  }
});

test("runStartup rejects when a migration fails (the caller decides to exit)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adrival-startup-"));
  const fresh = await createPgliteClient();
  setClientForTests(fresh);
  try {
    writeFileSync(join(dir, "001_bad.sql"), "select * from no_such_table;");
    await assert.rejects(runStartup({ migrationsDir: dir }), /no_such_table/);
  } finally {
    setClientForTests(client);
    await fresh.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startSchedulers: archive and backup stay off without Supabase Storage settings; keep-alive runs", async () => {
  const { startSchedulers } = await import("../src/lib/data/startup");
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    assert.deepEqual(startSchedulers(), { archive: false, backup: false, keepAlive: true });
  } finally {
    if (saved.url !== undefined) process.env.SUPABASE_URL = saved.url;
    if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  }
});
