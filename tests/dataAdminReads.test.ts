import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { withTx } from "../src/lib/data/client";
import * as identity from "../src/lib/data/identity";
import * as svc from "../src/lib/data/accountingService";
import * as spaces from "../src/lib/data/spaces";
import * as runs from "../src/lib/data/runs";
import { insertProviderCall, insertReservation } from "../src/lib/data/credits";
import type { AppUser, CreditReservation, LookupJob, ProviderCallRecord, SearchJob } from "../src/lib/types";
import { useTestDb } from "./helpers/testDb";

let cleanup: () => Promise<void> = async () => {};
let alice: AppUser;
let bob: AppUser;

before(async () => {
  ({ cleanup } = await useTestDb("admin-reads"));
  alice = await identity.createUser({ username: "alice", displayName: "Alice", passwordHash: "x", role: "admin" });
  bob = await identity.createUser({ username: "bob", displayName: "Bob", passwordHash: "x" });
  await identity.createUser({ username: "gone", displayName: "Gone", passwordHash: "x", status: "deleted" });
});

after(async () => {
  await cleanup();
});

function at(n: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
}

function job(id: string, n: number, extra: Partial<SearchJob> = {}): SearchJob {
  return {
    id,
    keyword: `kw ${id}`,
    platform: "facebook",
    status: "done",
    progress: { stage: "done", message: "Done" },
    competitorIds: ["c1", "c2"],
    ownerUserId: alice.id,
    createdAt: at(n),
    updatedAt: at(n),
    ...extra,
  } as unknown as SearchJob;
}

function lookup(id: string, n: number, extra: Partial<LookupJob> = {}): LookupJob {
  return {
    id,
    queryName: `brand ${id}`,
    status: "done",
    progress: { stage: "done", message: "Done" },
    candidates: [],
    adIds: ["a1"],
    ownerUserId: bob.id,
    createdAt: at(n),
    updatedAt: at(n),
    ...extra,
  } as unknown as LookupJob;
}

function call(id: string, userId: string, runId: string | null, credits: number, extra: Partial<ProviderCallRecord> = {}) {
  return {
    id,
    chargedUserId: userId,
    initiatedByUserId: userId,
    runId,
    provider: "manus",
    providerRequestId: null,
    idempotencyKey: id,
    creditsCharged: credits,
    usage: {},
    startedAt: at(1),
    completedAt: at(2),
    ...extra,
  } as unknown as ProviderCallRecord;
}

test("getUsersByIds and countUsers", async () => {
  const found = await identity.getUsersByIds([alice.id, bob.id, "missing", null, alice.id]);
  assert.deepEqual([...found.keys()].sort(), [alice.id, bob.id].sort());
  assert.equal(found.get(bob.id)?.username, "bob");
  assert.equal((await identity.getUsersByIds([])).size, 0);

  assert.deepEqual(await identity.countUsers(), { total: 2, active: 2, suspended: 0, deleted: 1, admins: 1 });
  assert.deepEqual(await identity.countUsers(new Set([bob.id])), {
    total: 1,
    active: 1,
    suspended: 0,
    deleted: 0,
    admins: 0,
  });
});

test("listRunOverview filters, sorts newest first and counts before the limit", async () => {
  await runs.saveJob(job("s1", 1));
  await runs.saveJob(job("s2", 3, { keyword: "", archivedAt: at(9) }));
  await runs.saveLookupJob(lookup("l1", 2));
  await runs.saveLookupJob(lookup("l-internal", 4, { internalOnly: true }));
  await runs.saveLookupJob(lookup("search-offers:s1", 5));

  const all = await spaces.listRunOverview();
  assert.deepEqual(all.rows.map((r) => r.id), ["search-offers:s1", "l-internal", "s2", "l1", "s1"]);
  assert.equal(all.total, 5);

  const visible = await spaces.listRunOverview({ excludeInternal: true, limit: 2 });
  assert.deepEqual(visible.rows.map((r) => r.id), ["s2", "l1"]);
  assert.equal(visible.total, 3, "total counts every match, not just the page");
  const s2 = visible.rows[0];
  assert.equal(s2.title, "Keyword search");
  assert.equal(s2.kind, "search");
  assert.equal(s2.results, 2);
  assert.equal(s2.platform, "facebook");
  assert.equal(s2.stage, "done");
  assert.equal(s2.archivedAt, at(9));
  assert.equal(s2.createdAt, at(3));

  assert.deepEqual((await spaces.listRunOverview({ activeOnly: true, excludeInternal: true })).rows.map((r) => r.id), ["l1", "s1"]);
  assert.deepEqual((await spaces.listRunOverview({ ownerUserIds: new Set([bob.id]), excludeInternal: true })).rows.map((r) => r.id), ["l1"]);
  assert.deepEqual((await spaces.listRunOverview({ kind: "search", titleContains: "KW S" })).rows.map((r) => r.id), ["s1"]);
  assert.deepEqual((await spaces.listRunOverview({ ownerUserId: alice.id, status: "done" })).rows.map((r) => r.id), ["s2", "s1"]);
  assert.deepEqual(await spaces.listRunOverview({ status: "nothing" }), { rows: [], total: 0 });
});

test("getProjectSpacesByIds", async () => {
  const space = await spaces.createProjectSpace({ clientName: "Acme", ownerUserId: alice.id });
  const found = await spaces.getProjectSpacesByIds([space.id, "missing", null]);
  assert.deepEqual([...found.keys()], [space.id]);
  assert.equal(found.get(space.id)?.clientName, "Acme");
});

test("credit aggregates: creditsByRun, sumProviderRequestUsage, currentPeriodTotals, listRunReservations", async () => {
  await withTx(async (tx) => {
    await insertProviderCall(tx, call("p1", alice.id, "s1", 5));
    await insertProviderCall(tx, call("p2", bob.id, "s1", 2.5));
    await insertProviderCall(tx, call("p3", bob.id, "l1", 1));
    await insertProviderCall(tx, call("p4", bob.id, null, 9));
    await insertProviderCall(tx, call("m1", bob.id, null, 0, { providerRequestId: "task-1", usage: { requests: 1.25 } }));
    await insertProviderCall(tx, call("m2", bob.id, null, 0, { providerRequestId: "task-1", usage: { requests: 2 } }));
    await insertProviderCall(tx, call("m3", bob.id, null, 0, { providerRequestId: "task-2", usage: { requests: 7 } }));
  });
  const byRun = await svc.creditsByRun(["s1", "l1", "none"]);
  assert.deepEqual([...byRun.entries()].sort(), [["l1", 1], ["s1", 7.5]]);
  assert.equal((await svc.creditsByRun([])).size, 0);

  assert.equal(await svc.sumProviderRequestUsage("manus", "task-1"), 3.25);
  assert.equal(await svc.sumProviderRequestUsage("manus", "task-none"), 0);
  assert.equal(await svc.sumProviderRequestUsage("openai", "task-2"), 0);

  await svc.initializeUserCredits(alice.id, { allowanceSubunits: 100, resetCadence: "none", reason: "seed" });
  await svc.initializeUserCredits(bob.id, { allowanceSubunits: 40, resetCadence: "none", reason: "seed" });
  const reserved = await svc.reserveCredits({
    userId: bob.id,
    amountSubunits: 10,
    operation: "search",
    projectKind: "search",
    projectId: "s1",
    runId: "s1",
  });
  assert.equal(reserved.ok, true);
  assert.deepEqual(await svc.currentPeriodTotals(), { allocatedSubunits: 140, consumedSubunits: 0, reservedSubunits: 10 });
  assert.deepEqual(await svc.currentPeriodTotals(new Set([alice.id])), {
    allocatedSubunits: 100,
    consumedSubunits: 0,
    reservedSubunits: 0,
  });

  const period = (await svc.listPeriods(alice.id))[0];
  await withTx((tx) =>
    insertReservation(tx, {
      id: "r-other",
      userId: alice.id,
      periodId: period.id,
      runId: "s9",
      status: "open",
      amountSubunits: 1,
      settledSubunits: 0,
      createdAt: at(1),
      updatedAt: at(1),
      expiresAt: at(100000),
    } as unknown as CreditReservation),
  );
  assert.equal((await svc.listRunReservations("s1")).length, 1);
  assert.equal((await svc.listRunReservations("s1", new Set([bob.id]))).length, 1);
  assert.equal((await svc.listRunReservations("s1", new Set([alice.id]))).length, 0);
  assert.equal((await svc.listRunReservations("s9"))[0]?.id, "r-other");
});
