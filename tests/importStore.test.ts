import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";

import { getDb } from "../src/lib/data/client";
import { assertEmptyTarget, CUTOVER_MESSAGE, importStore } from "../src/lib/data/importStore";
import { verifyImport } from "../src/lib/data/verifyImport";
import { SCHEMA_VERSION } from "../src/lib/data/legacyStore";
import { seedConversionRuleSet } from "../src/lib/accounting/conversion";
import * as svc from "../src/lib/data/accountingService";
import { getActiveConversionRuleSet, recordAudit } from "../src/lib/data/audit";
import { getRecreatedPage } from "../src/lib/data/recreatedPages";
import { createMemoryStorage, setStorageForTests } from "../src/lib/data/storageClient";
import { getCompetitor, getCompetitorsByRun } from "../src/lib/data/competitors";
import { countActiveAdmins, getUserById } from "../src/lib/data/identity";
import { getJob, getLookupJob, getSeenPageIds } from "../src/lib/data/runs";
import { getLookupAds } from "../src/lib/data/lookups";
import { listProjects, setProjectOwner } from "../src/lib/data/spaces";
import { HttpError, listVisibleProjects, resolveProjectAccess } from "../src/lib/authz";
import type { DatabaseShape } from "../src/lib/types";
import { useTempStore } from "./helpers/store";
import { createPgliteClient } from "./helpers/testDb";
import { HTML, SOURCE_HTML, T0, T1, T2, fixtureStore, ledger, providerCall } from "./helpers/storeFixture";
import { archiveOldPages } from "../src/lib/data/archive";
import { mergeStore, replaceStore } from "../src/lib/data/importHistory";
import { isTransactionPooler } from "../scripts/storeScriptArgs";

/*
 * store.json → Postgres import (importStore) and its check (verifyImport).
 * Each group imports into its own fresh PGlite database.
 */

let current: { cleanup(): Promise<void> } | null = null;

async function freshDb(label: string): Promise<void> {
  if (current) await current.cleanup();
  current = await useTempStore(label);
}

after(async () => {
  if (current) await current.cleanup();
});

const TABLES = [
  "organizations",
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
  "login_attempts",
  "jobs",
  "lookup_jobs",
  "competitors",
  "recreated_pages",
  "lookup_ads",
  "search_competitor_ads",
  "icps",
  "seen_page_ids",
  "deleted_run_ids",
] as const;

async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLES) {
    const { rows } = await getDb().query<{ n: number }>(`select count(*)::int as n from ${table}`);
    out[table] = rows[0].n;
  }
  return out;
}

describe("full store import", () => {
  test("every collection lands with the right counts and verifyImport is ok", async () => {
    await freshDb("import-store-full");
    const report = await importStore(getDb(), fixtureStore());
    assert.deepEqual(await tableCounts(), {
      organizations: 1,
      users: 2,
      app_settings: 1,
      conversion_rule_sets: 1,
      credit_periods: 3,
      credit_ledger: 5,
      credit_reservations: 1,
      provider_calls: 2,
      project_memberships: 1,
      project_spaces: 1,
      space_memberships: 1,
      audit_logs: 2,
      admin_alerts: 1,
      login_attempts: 1,
      jobs: 2,
      lookup_jobs: 2,
      competitors: 3,
      recreated_pages: 1,
      lookup_ads: 1,
      search_competitor_ads: 1,
      icps: 1,
      seen_page_ids: 3,
      deleted_run_ids: 1,
    });
    assert.equal(report.counts.jobs, 2);
    assert.equal(report.counts.creditLedger, 5);
    assert.equal(report.counts.recreatedPages, 1);
    assert.equal(report.interruptedJobs, 2);
    assert.ok(report.pageBytes > 3_000_000, `pageBytes ${report.pageBytes}`);
    assert.deepEqual(report.warnings, [
      'note: run job-running was running; imported as failed ("Interrupted by cutover")',
      'note: run lk-running was running; imported as failed ("Interrupted by cutover")',
    ]);

    const result = await verifyImport(getDb(), fixtureStore());
    assert.deepEqual(result.mismatches, []);
    assert.equal(result.ok, true);
  });

  test("the big page round-trips byte for byte and keeps its own timestamp", async () => {
    const page = await getRecreatedPage("c-1");
    assert.ok(page);
    assert.equal(page.html, HTML);
    assert.equal(page.previousHtml, "<html>older</html>");
    assert.deepEqual(page.sourceArchive, { html: SOURCE_HTML, url: "https://big.invalid" });
    const light = (await getCompetitor("c-1"))?.recreatedPage;
    assert.ok(light);
    assert.equal(light.hasPage, true);
    assert.equal(light.pageUpdatedAt, T1);
    assert.equal(light.canUndo, true);
    assert.ok(!("html" in light), "the competitor row keeps no html");
    const { rows } = await getDb().query<{ updated_at: string }>(
      "select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') as updated_at from recreated_pages where competitor_id = 'c-1'",
    );
    assert.equal(rows[0].updated_at, "2026-01-11T00:00:00", "archiving age comes from the page, not the import time");
    // The page without content keeps its light fields and no content row.
    const pending = (await getCompetitor("c-3"))?.recreatedPage;
    assert.equal(pending?.hasPage, false);
    assert.equal(pending?.error, "boom");
    assert.equal(await getRecreatedPage("c-3"), null);
  });

  test("running jobs and lookups become failed with the cutover message", async () => {
    const job = await getJob("job-running");
    assert.equal(job?.status, "failed");
    assert.equal(job?.progress.stage, "failed");
    assert.equal(job?.progress.message, CUTOVER_MESSAGE);
    assert.equal(CUTOVER_MESSAGE, "Interrupted by cutover");
    const lookup = await getLookupJob("lk-running");
    assert.equal(lookup?.status, "failed");
    assert.equal(lookup?.progress.stage, "failed");
    assert.equal(lookup?.progress.message, CUTOVER_MESSAGE);
    assert.equal(lookup?.progress.offersPhase, "failed", "an offers phase in flight is ended like a restart ends it");
    // Finished runs are untouched.
    assert.equal((await getJob("job-1"))?.status, "completed");
  });

  test("users keep their password hash, role and org; credit columns mirror the records", async () => {
    const alice = await getUserById("u-alice");
    assert.equal(alice?.passwordHash, "scrypt$1$u-alice$hash");
    assert.equal(alice?.orgId, "org-1");
    assert.equal((await getUserById("u-admin"))?.role, "admin");
    const { rows } = await getDb().query<{ allowance: string; consumed: string; reserved: string; status: string }>(
      "select allowance::text, consumed::text, reserved::text, status from credit_periods where id = 'p-alice'",
    );
    assert.deepEqual(rows[0], { allowance: "10000", consumed: "1500", reserved: "200", status: "current" });
    const alerts = await getDb().query<{ at: string }>(
      "select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as at from admin_alerts where id = 'al-1'",
    );
    assert.equal(alerts.rows[0].at, "2026-01-11", "alert dedupe reads created_at, so it is the record's time");
  });

  test("ledger and audit sequences continue after the imported numbers", async () => {
    const period = await svc.addCredits({ userId: "u-alice", actorUserId: "u-admin", reason: "after import", amountSubunits: 1 });
    assert.equal(period.id, "p-alice", "the imported current period is used, not a new one");
    const { rows } = await getDb().query<{ seq: string }>("select max(seq)::text as seq from credit_ledger");
    assert.ok(Number(rows[0].seq) > 7, `new ledger seq ${rows[0].seq} must be past the stored ledgerSeq 7`);
    const entry = await recordAudit({ actorUserId: "u-admin", actorUsername: "boss", action: "after.import" });
    assert.ok(entry.seq > 2, `new audit seq ${entry.seq}`);
  });

  test("importing the same file twice leaves identical counts and no duplicate ledger rows", async () => {
    await freshDb("import-store-twice");
    await importStore(getDb(), fixtureStore());
    const first = await tableCounts();
    const second = await importStore(getDb(), fixtureStore());
    assert.deepEqual(await tableCounts(), first);
    assert.equal(second.counts.creditLedger, 5);
    const { rows } = await getDb().query<{ n: number; ids: number }>(
      "select count(*)::int as n, count(distinct id)::int as ids from credit_ledger",
    );
    assert.deepEqual(rows[0], { n: 5, ids: 5 });
    const result = await verifyImport(getDb(), fixtureStore());
    assert.deepEqual(result.mismatches, []);
  });

  test("verifyImport reports an altered page and an altered credit period, by id", async () => {
    const { rows } = await getDb().query<{ content: Buffer }>(
      "select content from recreated_pages where competitor_id = 'c-1'",
    );
    const heavy = JSON.parse(gunzipSync(rows[0].content).toString("utf8")) as { html: string };
    heavy.html = heavy.html.replace("Section 7 ", "Section X ");
    await getDb().query("update recreated_pages set content = $2 where competitor_id = $1", [
      "c-1",
      gzipSync(JSON.stringify(heavy)),
    ]);
    const altered = await verifyImport(getDb(), fixtureStore());
    assert.equal(altered.ok, false);
    assert.ok(altered.mismatches.some((m) => m.includes("c-1")), altered.mismatches.join("\n"));

    // A re-import repairs it.
    await importStore(getDb(), fixtureStore());
    assert.deepEqual((await verifyImport(getDb(), fixtureStore())).mismatches, []);

    await getDb().query("update credit_periods set consumed = consumed + 1 where id = 'p-alice'");
    const credit = await verifyImport(getDb(), fixtureStore());
    assert.equal(credit.ok, false);
    assert.ok(credit.mismatches.some((m) => m.includes("p-alice")), credit.mismatches.join("\n"));
  });
});

describe("store quirks", () => {
  function quirkyStore(): DatabaseShape {
    const store = fixtureStore() as unknown as Record<string, unknown[]> & DatabaseShape;
    // Two ICPs for the same source + stage: the newest wins.
    store.icps = [
      { id: "icp-old", source: { kind: "search", id: "job-1" }, stage: "problem_aware", createdAt: T0, summary: "old" },
      { id: "icp-new", source: { kind: "search", id: "job-1" }, stage: "problem_aware", createdAt: T2, summary: "new" },
      { id: "icp-mid", source: { kind: "search", id: "job-1" }, stage: "problem_aware", createdAt: T1, summary: "mid" },
    ] as unknown as DatabaseShape["icps"];
    // A retried settlement written twice: the first one is kept.
    store.providerCalls = [
      providerCall("pc-1", "key-1"),
      providerCall("pc-dup", "key-1"),
      providerCall("pc-2", "key-2"),
    ] as unknown as DatabaseShape["providerCalls"];
    // Legacy ledger rows without seq: numbered after the others, in file order.
    store.creditLedger = [
      ledger(1, "l-1", "u-alice", 10_000, "allowance_set"),
      ledger(undefined, "l-legacy-a", "u-alice", -10),
      ledger(2, "l-2", "u-alice", -1_000, "charge"),
      ledger(undefined, "l-legacy-b", "u-alice", -20),
    ] as unknown as DatabaseShape["creditLedger"];
    store.ledgerSeq = 2;
    return store;
  }

  test("duplicate ICPs collapse to the newest, duplicate provider-call keys keep the first, seqless ledger rows get seqs", async () => {
    await freshDb("import-store-quirks");
    const report = await importStore(getDb(), quirkyStore());

    const icps = await getDb().query<{ id: string }>("select id from icps");
    assert.deepEqual(icps.rows.map((r) => r.id), ["icp-new"]);

    const calls = await getDb().query<{ id: string }>("select id from provider_calls order by id");
    assert.deepEqual(calls.rows.map((r) => r.id), ["pc-1", "pc-2"]);
    assert.ok(report.warnings.some((w) => w.includes("pc-dup")), report.warnings.join("\n"));

    const seqs = await getDb().query<{ id: string; seq: string; data_seq: string }>(
      "select id, seq::text, (data->>'seq') as data_seq from credit_ledger order by seq",
    );
    assert.deepEqual(
      seqs.rows.map((r) => [r.id, r.seq, r.data_seq]),
      [
        ["l-1", "1", "1"],
        ["l-2", "2", "2"],
        ["l-legacy-a", "3", "3"],
        ["l-legacy-b", "4", "4"],
      ],
    );
    const entry = await svc.addCredits({ userId: "u-alice", actorUserId: "u-admin", reason: "next", amountSubunits: 1 });
    assert.ok(entry);
    const max = await getDb().query<{ seq: string }>("select max(seq)::text as seq from credit_ledger");
    assert.ok(Number(max.rows[0].seq) > 4);

    // Re-importing keeps the same numbers (no duplicates, no renumbering).
    await getDb().query("delete from credit_ledger where data->>'reason' = 'next'");
    await importStore(getDb(), quirkyStore());
    const again = await getDb().query<{ id: string; seq: string }>("select id, seq::text from credit_ledger order by seq");
    assert.deepEqual(again.rows.map((r) => [r.id, r.seq]), seqs.rows.map((r) => [r.id, r.seq]));
    assert.deepEqual((await verifyImport(getDb(), quirkyStore())).mismatches, []);
  });

  test("a record the database cannot hold is skipped with a warning naming it, and verify reports the gap", async () => {
    await freshDb("import-store-malformed");
    const store = fixtureStore() as unknown as Record<string, unknown>;
    (store.jobs as Record<string, unknown>[]).push({ id: "job-broken", keyword: "x", createdAt: T0 }); // no status
    (store.lookupAds as Record<string, unknown>[]).push({ id: "la-orphan", pageId: "1", createdAt: T0 }); // no lookupId
    const report = await importStore(getDb(), store as unknown as DatabaseShape);
    assert.ok(report.warnings.some((w) => w.includes("job-broken")), report.warnings.join("\n"));
    assert.ok(report.warnings.some((w) => w.includes("la-orphan")), report.warnings.join("\n"));
    assert.equal(await getJob("job-broken"), null);
    // The orphan ad is kept (an empty lookup id is storable).
    const ad = await getDb().query("select 1 from lookup_ads where id = 'la-orphan'");
    assert.equal(ad.rowCount, 1);

    const result = await verifyImport(getDb(), store as unknown as DatabaseShape);
    assert.equal(result.ok, false);
    assert.ok(result.mismatches.some((m) => m.includes("jobs")), result.mismatches.join("\n"));
  });

  test("archiving after the import moves old content to Storage and verify reads it back", async () => {
    await freshDb("import-store-archive");
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    try {
      const report = await importStore(getDb(), fixtureStore(), { archiveOlderThanDays: 1 });
      assert.deepEqual(report.archive, { archived: 1, failed: 0, leftInDatabase: 0 });
      assert.equal(storage.objects.size, 1);
      const page = await getRecreatedPage("c-1");
      assert.equal(page?.html, HTML);
      assert.deepEqual((await verifyImport(getDb(), fixtureStore())).mismatches, []);
    } finally {
      setStorageForTests(null);
    }
  });

  test("assertEmptyTarget refuses a database that already has users unless allowed", async () => {
    await freshDb("import-store-target");
    await assertEmptyTarget(getDb(), false);
    await importStore(getDb(), fixtureStore());
    await assert.rejects(() => assertEmptyTarget(getDb(), false), /already has 2 user/);
    await assertEmptyTarget(getDb(), true);
  });
});

describe("verifyImport catches tampering", () => {
  /** Applies `tamper`, expects a mismatch line containing every `needles`, then re-imports and expects ok again. */
  async function expectCaught(tamper: () => Promise<void>, needles: string[]): Promise<void> {
    await tamper();
    const result = await verifyImport(getDb(), fixtureStore());
    assert.equal(result.ok, false, `not caught: ${needles.join(" ")}`);
    assert.ok(
      result.mismatches.some((m) => needles.every((n) => m.includes(n))),
      `no mismatch with ${JSON.stringify(needles)}:\n${result.mismatches.join("\n")}`,
    );
    await importStore(getDb(), fixtureStore());
    assert.deepEqual((await verifyImport(getDb(), fixtureStore())).mismatches, []);
  }

  test("one byte of a password hash, a ledger delta, the settings, a provider call's user, a space's org", async () => {
    await freshDb("import-store-tamper");
    await importStore(getDb(), fixtureStore());
    assert.deepEqual((await verifyImport(getDb(), fixtureStore())).mismatches, []);

    await expectCaught(
      () => getDb().query(`update users set data = jsonb_set(data, '{passwordHash}', '"scrypt$1$u-alice$hasH"') where id = 'u-alice'`).then(() => {}),
      ["users", "u-alice"],
    );
    await expectCaught(
      () => getDb().query(`update credit_ledger set data = jsonb_set(data, '{deltaSubunits}', '-999') where id = 'l-2'`).then(() => {}),
      ["creditLedger", "l-2"],
    );
    await expectCaught(
      () => getDb().query(`update app_settings set data = jsonb_set(data, '{maxConcurrentRunsPerUser}', '6')`).then(() => {}),
      ["appSettings"],
    );
    await expectCaught(
      () => getDb().query(`update provider_calls set user_id = 'u-admin' where id = 'pc-1'`).then(() => {}),
      ["providerCalls.user_id", "pc-1"],
    );
    await expectCaught(
      () => getDb().query(`update project_spaces set org_id = 'org-other' where id = 's-1'`).then(() => {}),
      ["projectSpaces.org_id", "s-1"],
    );
    await expectCaught(
      () => getDb().query(`update jobs set owner_user_id = 'u-admin' where id = 'job-1'`).then(() => {}),
      ["jobs.owner_user_id", "job-1"],
    );
    await expectCaught(
      () => getDb().query(`update competitors set data = data #- '{recreatedPage}' where id = 'c-1'`).then(() => {}),
      ["competitors", "c-1"],
    );
    await expectCaught(
      () => getDb().query(`update conversion_rule_sets set data = jsonb_set(data, '{note}', '"edited"')`).then(() => {}),
      ["conversionRuleSets"],
    );
  });

  test("one byte of an archived page in Storage", async () => {
    await freshDb("import-store-tamper-archive");
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    try {
      await importStore(getDb(), fixtureStore(), { archiveOlderThanDays: 1 });
      assert.equal(storage.objects.size, 1);
      const [key, gz] = [...storage.objects][0];
      const text = gunzipSync(gz).toString("utf8").replace("Section 9 ", "Section Q ");
      storage.objects.set(key, gzipSync(text));
      const result = await verifyImport(getDb(), fixtureStore());
      assert.equal(result.ok, false);
      assert.ok(result.mismatches.some((m) => m.includes("recreatedPages c-1")), result.mismatches.join("\n"));

      // A re-import brings the content back into the database and removes the stale object.
      await importStore(getDb(), fixtureStore());
      assert.equal(storage.objects.size, 0, "the stale archive object was deleted");
      const { rows } = await getDb().query<{ archive_path: string | null }>(
        "select archive_path from recreated_pages where competitor_id = 'c-1'",
      );
      assert.equal(rows[0].archive_path, null);
      assert.deepEqual((await verifyImport(getDb(), fixtureStore())).mismatches, []);
    } finally {
      setStorageForTests(null);
    }
  });
});

describe("records the import leaves out", () => {
  test("two ledger rows sharing a seq: the second gets a new one", async () => {
    await freshDb("import-store-dup-seq");
    const store = fixtureStore();
    store.creditLedger = [
      ledger(1, "l-1", "u-alice", 10_000, "allowance_set"),
      ledger(1, "l-twin", "u-alice", -5),
      ledger(2, "l-2", "u-alice", -1_000, "charge"),
    ] as unknown as DatabaseShape["creditLedger"];
    store.ledgerSeq = 2;
    const report = await importStore(getDb(), store);
    assert.ok(report.warnings.some((w) => w.includes("l-twin") && w.includes("assigned seq 3")), report.warnings.join("\n"));
    const { rows } = await getDb().query<{ id: string; seq: string }>("select id, seq::text from credit_ledger order by seq");
    assert.deepEqual(rows.map((r) => [r.id, r.seq]), [["l-1", "1"], ["l-2", "2"], ["l-twin", "3"]]);
    const verify = fixtureStore();
    verify.creditLedger = store.creditLedger;
    verify.ledgerSeq = 2;
    assert.deepEqual((await verifyImport(getDb(), verify)).mismatches, []);
  });

  test("a duplicate id keeps the first copy; verify lists it as skipped, not as a mismatch", async () => {
    await freshDb("import-store-dup-id");
    const make = () => {
      const store = fixtureStore() as unknown as Record<string, unknown[]>;
      const first = store.jobs[0] as Record<string, unknown>;
      store.jobs.push({ ...first, keyword: "the later copy" });
      store.seenPageIds = ["111", 111, "111", "", "222"];
      return store as unknown as DatabaseShape;
    };
    const report = await importStore(getDb(), make());
    assert.equal((await getJob("job-1"))?.keyword, "plumber", "the first copy is the one imported");
    assert.ok(report.warnings.some((w) => w.includes("job-1") && w.includes("first copy")), report.warnings.join("\n"));
    assert.ok(report.warnings.some((w) => w.includes("number 111")), "a numeric id is stringified with a warning");
    assert.deepEqual([...(await getSeenPageIds())].sort(), ["111", "222"]);
    const result = await verifyImport(getDb(), make());
    assert.deepEqual(result.mismatches, []);
    assert.equal(result.ok, true);
    assert.ok(result.skipped.some((s) => s.startsWith("jobs job-1")), result.skipped.join("\n"));
    assert.equal(result.skipped.filter((s) => s.startsWith("seenPageIds")).length, 3, result.skipped.join("\n"));
  });

  test("a record without an id is lost data: verify fails and names it", async () => {
    await freshDb("import-store-no-id");
    const make = () => {
      const store = fixtureStore() as unknown as Record<string, unknown[]>;
      store.creditReservations.push({ userId: "u-alice", periodId: "p-alice", status: "open", expiresAt: T2 });
      return store as unknown as DatabaseShape;
    };
    const report = await importStore(getDb(), make());
    assert.ok(report.drops.some((d) => d.collection === "creditReservations" && d.lost), JSON.stringify(report.drops));
    const result = await verifyImport(getDb(), make());
    assert.equal(result.ok, false);
    assert.ok(result.mismatches.some((m) => m.startsWith("lost (not imported): creditReservations [1]")), result.mismatches.join("\n"));
  });
});

describe("page content shapes", () => {
  function storeWithPages(): DatabaseShape {
    const store = fixtureStore();
    const base = (store.competitors[0] as unknown as { recreatedPage: Record<string, unknown> }).recreatedPage;
    const page = (extra: Record<string, unknown>) => {
      const p: Record<string, unknown> = { ...base, ...extra };
      for (const key of ["html", "sourceArchive", "generatedImages", "previousHtml", "canUndo"]) {
        if (!(key in extra)) delete p[key];
      }
      return p;
    };
    store.competitors.push(...([
      // Only an Undo copy and images: no html key at all.
      { id: "c-partial", runId: "job-1", pageId: "501", createdAt: T0, recreatedPage: page({ previousHtml: "<p>undo</p>", generatedImages: [{ id: "i" }] }) },
      // Empty html (kept as "", not null) next to a source archive.
      { id: "c-empty-html", runId: "job-1", pageId: "502", createdAt: T0, recreatedPage: page({ html: "", sourceArchive: { html: "<p>src</p>" } }) },
      // An offset timestamp is stored as UTC; an invalid one falls back to createdAt.
      { id: "c-offset", runId: "job-1", pageId: "503", createdAt: T0, recreatedPage: page({ html: "<p>x</p>", updatedAt: "2026-01-11T05:30:00+05:30" }) },
      { id: "c-bad-time", runId: "job-1", pageId: "504", createdAt: T0, recreatedPage: page({ html: "<p>y</p>", updatedAt: "not a date", createdAt: T2 }) },
    ] as unknown as DatabaseShape["competitors"]));
    return store;
  }

  test("partial heavy keys, empty html and page times round-trip, and verify is ok", async () => {
    await freshDb("import-store-page-shapes");
    await importStore(getDb(), storeWithPages());
    const partial = await getRecreatedPage("c-partial");
    assert.deepEqual(partial, { previousHtml: "<p>undo</p>", generatedImages: [{ id: "i" }], html: null });
    const empty = await getRecreatedPage("c-empty-html");
    assert.equal(empty?.html, "");
    assert.deepEqual(empty?.sourceArchive, { html: "<p>src</p>" });
    assert.equal((await getCompetitor("c-offset"))?.recreatedPage?.pageUpdatedAt, "2026-01-11T00:00:00.000Z");
    assert.equal((await getCompetitor("c-bad-time"))?.recreatedPage?.pageUpdatedAt, T2);
    assert.deepEqual((await verifyImport(getDb(), storeWithPages())).mismatches, []);
  });
});

describe("history import and archived pages", () => {
  test("replace removes the Storage objects of competitors it deletes; merge removes those it rewrites", async () => {
    await freshDb("import-history-archive");
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    try {
      const page = (html: string) => ({
        status: "completed",
        createdAt: T0,
        updatedAt: T0,
        businessUrl: "https://x.invalid",
        keyword: "k",
        sourceCompetitorName: "n",
        sourceAnalyzedUrl: "https://y.invalid",
        brandColors: {},
        html,
      });
      const job = { id: "h-job", keyword: "k", keywords: ["k"], status: "completed", progress: { stage: "done", message: "Done" }, competitorIds: ["h-1", "h-2"], createdAt: T0, updatedAt: T0 };
      const payload = (competitors: unknown[]) => ({ jobs: [job], competitors, seenPageIds: [] }) as unknown as Partial<DatabaseShape>;
      await replaceStore(payload([
        { id: "h-1", runId: "h-job", pageId: "1", createdAt: T0, recreatedPage: page("<p>one</p>") },
        { id: "h-2", runId: "h-job", pageId: "2", createdAt: T0, recreatedPage: page("<p>two</p>") },
      ]));
      // History imports stamp content with the import time: archive everything up to now.
      assert.equal((await archiveOldPages({ olderThanDays: 0 })).archived, 2);
      assert.equal(storage.objects.size, 2);

      // h-2 is gone from the replacing import: its archive object goes too.
      await replaceStore(payload([{ id: "h-1", runId: "h-job", pageId: "1", createdAt: T0 }]));
      assert.deepEqual([...storage.objects.keys()].map((k) => k.split("/").pop()), ["h-1.json.gz"]);

      // A merge that brings h-1's content back into the database makes its object stale.
      await mergeStore(payload([{ id: "h-1", runId: "h-job", pageId: "1", createdAt: T0, recreatedPage: page("<p>new</p>") }]));
      assert.equal(storage.objects.size, 0);
      assert.equal((await getRecreatedPage("h-1"))?.html, "<p>new</p>");
    } finally {
      setStorageForTests(null);
    }
  });
});

describe("script guards", () => {
  test("assertEmptyTarget treats a database without the users table as empty", async () => {
    const bare = await createPgliteClient();
    try {
      await assertEmptyTarget(bare, false);
    } finally {
      await bare.close();
    }
  });

  test("the transaction pooler is refused; the session pooler and direct host are not", () => {
    assert.equal(isTransactionPooler("postgresql://u:p@aws-0-us-west-1.pooler.supabase.com:6543/postgres"), true);
    assert.equal(isTransactionPooler("postgresql://u:p@db.example.supabase.co:5432/postgres?pgbouncer=true"), true);
    assert.equal(isTransactionPooler("postgresql://u:p@aws-0-us-west-1.pooler.supabase.com:5432/postgres"), false);
    assert.equal(isTransactionPooler("postgresql://u:p@db.example.supabase.co:5432/postgres"), false);
  });
});

/** The v1 store of the old tests/migration.test.ts: no schemaVersion, a pre-roles user. */
function legacyStore(): DatabaseShape {
  return {
    jobs: [
      {
        id: "legacy-search-1",
        keyword: "plumber melbourne",
        keywords: ["plumber melbourne"],
        platform: "facebook",
        geo: "AU",
        countries: ["AU"],
        status: "completed",
        progress: { stage: "done", scannedAds: 120, scannedPages: 8, accepted: 5, target: 5, rejected: 3, message: "Done" },
        competitorIds: ["legacy-competitor-1"],
        createdAt: "2025-01-05T00:00:00.000Z",
        updatedAt: "2025-01-05T01:00:00.000Z",
      },
    ],
    competitors: [
      {
        id: "legacy-competitor-1",
        runId: "legacy-search-1",
        pageId: "111",
        pageName: "Legacy Plumbing Co",
        country: "AU",
        platform: "facebook",
        activeAdsCount: 42,
        services: [],
        sampleAd: {
          adArchiveId: "900",
          title: "Blocked drain?",
          body: "24/7 emergency plumbing",
          daysRunning: 31,
          adLibraryUrl: "https://example.invalid/ad/900",
        },
        brand: { website: "https://legacyplumbing.invalid" },
        createdAt: "2025-01-05T00:30:00.000Z",
      },
    ],
    seenPageIds: ["111", "222"],
    lookupJobs: [
      {
        id: "legacy-lookup-1",
        queryName: "Legacy Brand",
        platform: "facebook",
        status: "completed",
        progress: { stage: "done", message: "Done" },
        candidates: [],
        adIds: ["legacy-ad-1"],
        createdAt: "2025-01-06T00:00:00.000Z",
        updatedAt: "2025-01-06T00:10:00.000Z",
      },
    ],
    lookupAds: [
      {
        id: "legacy-ad-1",
        lookupId: "legacy-lookup-1",
        pageId: "333",
        pageName: "Legacy Brand",
        platform: "facebook",
        createdAt: "2025-01-06T00:05:00.000Z",
        updatedAt: "2025-01-06T00:05:00.000Z",
      },
    ],
    searchCompetitorAds: [],
    users: [
      {
        id: "legacy-user-1",
        username: "earlyadopter",
        displayName: "Early Adopter",
        passwordHash: "scrypt$1$abc$def",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ],
  } as unknown as DatabaseShape;
}

describe("v1 store import (the old migration.test.ts cases)", () => {
  test("existing jobs, competitors and history survive untouched", async () => {
    await freshDb("import-store-legacy");
    const report = await importStore(getDb(), legacyStore());
    assert.deepEqual(report.warnings, []);

    const job = await getJob("legacy-search-1");
    assert.ok(job, "the legacy search run is still present");
    assert.equal(job.keyword, "plumber melbourne");
    assert.equal(job.progress.accepted, 5);
    assert.equal(job.createdAt, "2025-01-05T00:00:00.000Z");

    const competitors = await getCompetitorsByRun("legacy-search-1");
    assert.equal(competitors.length, 1);
    assert.equal(competitors[0].pageName, "Legacy Plumbing Co");
    assert.equal(competitors[0].activeAdsCount, 42);
    assert.equal(competitors[0].sampleAd.adArchiveId, "900");

    const lookup = await getLookupJob("legacy-lookup-1");
    assert.equal(lookup?.queryName, "Legacy Brand");
    assert.equal((await getLookupAds("legacy-lookup-1")).length, 1);

    const seen = await getSeenPageIds();
    assert.ok(seen.has("111"));
    assert.ok(seen.has("222"));
    assert.deepEqual((await verifyImport(getDb(), legacyStore())).mismatches, []);
  });

  test("the store is migrated to the current schema before import", async () => {
    const raw = legacyStore();
    assert.equal(raw.schemaVersion, undefined);
    await importStore(getDb(), raw);
    // migrateDb stamps the version on the store it normalizes (the file itself is never written).
    assert.equal(raw.schemaVersion, SCHEMA_VERSION);
  });

  test("the accounting collections are seeded", async () => {
    // The old test expected version 1; it was already failing ("2 !== 1") before
    // this work because the seed rule set is now version 2 (SEED_RULE_VERSION).
    // What it protects: exactly the seeded rule set is stored and is the active one.
    const sets = await getDb().query<{ version: number }>("select version from conversion_rule_sets order by version");
    assert.deepEqual(sets.rows.map((r) => r.version), [seedConversionRuleSet().version], "one seeded rule set");
    const settings = await getDb().query<{
      data: { publicSignupEnabled: boolean; defaultAllowanceSubunits: number; activeConversionRuleVersion: number };
    }>("select data from app_settings");
    assert.equal(settings.rows.length, 1);
    // A v1 store's settings name version 1 (defaultAppSettings, unchanged by
    // migrateDb); the app resolves a missing active version to the stored set.
    assert.equal((await getActiveConversionRuleSet()).version, sets.rows[0].version, "the seeded set is the one in use");
    assert.equal(settings.rows[0].data.publicSignupEnabled, false, "signup is closed until an admin opens it");
    assert.equal(settings.rows[0].data.defaultAllowanceSubunits, 0, "new users start with zero credits by default");
    for (const table of ["credit_periods", "credit_ledger", "credit_reservations", "provider_calls", "project_memberships", "audit_logs"]) {
      const { rows } = await getDb().query<{ n: number }>(`select count(*)::int as n from ${table}`);
      assert.equal(rows[0].n, 0, `${table} exists and is empty`);
    }
  });

  test("a pre-roles account becomes a regular active user, never an admin", async () => {
    const legacy = await getUserById("legacy-user-1");
    assert.ok(legacy);
    assert.equal(legacy.role, "user");
    assert.equal(legacy.status, "active");
    assert.equal(legacy.mustChangePassword, false);
    assert.equal(typeof legacy.sessionEpoch, "number");
    assert.equal(legacy.passwordHash, "scrypt$1$abc$def", "the existing password hash is preserved");
    assert.equal(await countActiveAdmins(), 0, "the import never invents an admin");
  });

  test("legacy projects have no owner and stay restricted", async () => {
    const job = await getJob("legacy-search-1");
    assert.ok(job && (job.ownerUserId === undefined || job.ownerUserId === null), "ownership was not guessed");
    const legacy = (await getUserById("legacy-user-1"))!;
    assert.deepEqual(await listVisibleProjects(legacy), []);
    await assert.rejects(
      () => resolveProjectAccess("search", "legacy-search-1", legacy, "view"),
      (err: unknown) => err instanceof HttpError && err.status === 404,
    );
    const unassigned = await listProjects({ unassignedOnly: true });
    assert.deepEqual(unassigned.map((p) => p.id).sort(), ["legacy-lookup-1", "legacy-search-1"]);
  });

  test("assignment makes a legacy project visible to exactly one owner", async () => {
    const legacy = (await getUserById("legacy-user-1"))!;
    assert.equal(await setProjectOwner("search", "legacy-search-1", "legacy-user-1"), true);
    const visible = await listVisibleProjects(legacy);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, "legacy-search-1");
    assert.equal(visible[0].accessRole, "owner");
    assert.equal((await resolveProjectAccess("search", "legacy-search-1", legacy, "run")).role, "owner");
    assert.deepEqual((await listProjects({ unassignedOnly: true })).map((p) => p.id), ["legacy-lookup-1"]);
  });

  test("importing the same v1 file again is a no-op", async () => {
    await freshDb("import-store-legacy-twice");
    await importStore(getDb(), legacyStore());
    const before = await tableCounts();
    await importStore(getDb(), legacyStore());
    assert.deepEqual(await tableCounts(), before);
    assert.equal(before.jobs, 1);
    assert.equal(before.users, 1);
    const sets = await getDb().query<{ n: number }>("select count(*)::int as n from conversion_rule_sets");
    assert.equal(sets.rows[0].n, before.conversion_rule_sets);
  });
});
