import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { getDb } from "../src/lib/data/client";
import * as history from "../src/lib/data/importHistory";
import * as identity from "../src/lib/data/identity";
import * as svc from "../src/lib/data/accountingService";
import * as audit from "../src/lib/data/audit";
import * as settings from "../src/lib/data/settings";
import * as runs from "../src/lib/data/runs";
import * as competitors from "../src/lib/data/competitors";
import * as lookups from "../src/lib/data/lookups";
import * as icps from "../src/lib/data/icps";
import { getRecreatedPage } from "../src/lib/data/recreatedPages";
import type {
  AppUser,
  CompetitorRecord,
  DatabaseShape,
  IcpRecord,
  LookupAdRecord,
  LookupJob,
  SearchCompetitorAdRecord,
  SearchJob,
} from "../src/lib/types";
import { useTestDb } from "./helpers/testDb";

let cleanup: () => Promise<void> = async () => {};
let alice: AppUser;
let boss: AppUser;

before(async () => {
  ({ cleanup } = await useTestDb("import-history"));
  alice = await identity.createUser({ username: "alice", displayName: "Alice", passwordHash: "x" });
  boss = await identity.createUser({ username: "boss", displayName: "Boss", passwordHash: "x", role: "admin" });
  await svc.initializeUserCredits(alice.id, { allowanceSubunits: 1000, resetCadence: "none", reason: "seed" });
  await svc.addCredits({ userId: alice.id, actorUserId: boss.id, reason: "top up", amountSubunits: 500 });
  await audit.recordAudit({ actorUserId: boss.id, actorUsername: "boss", action: "admin.test", details: {} });
  await settings.updateAppSettings({ maxConcurrentRunsPerUser: 7 }, boss.id);
});

after(async () => {
  await cleanup();
});

const AT = "2026-02-01T00:00:00.000Z";

function job(id: string, ownerUserId: string | null, overrides: Partial<SearchJob> = {}): SearchJob {
  return {
    id,
    keyword: id,
    keywords: [id],
    status: "completed",
    progress: { stage: "done", message: "Done" },
    competitorIds: [],
    ownerUserId,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  } as unknown as SearchJob;
}

function lookup(id: string, ownerUserId: string | null): LookupJob {
  return {
    id,
    queryName: id,
    status: "completed",
    progress: { stage: "done", message: "Done" },
    candidates: [],
    adIds: [],
    ownerUserId,
    createdAt: AT,
    updatedAt: AT,
  } as unknown as LookupJob;
}

function competitor(id: string, runId: string, extra: Partial<CompetitorRecord> = {}): CompetitorRecord {
  return {
    id,
    runId,
    pageId: `page-${id}`,
    pageName: id,
    createdAt: AT,
    ...extra,
  } as unknown as CompetitorRecord;
}

function lookupAd(id: string, lookupId: string): LookupAdRecord {
  return { id, lookupId, createdAt: AT } as unknown as LookupAdRecord;
}

function searchAd(id: string, runId: string, competitorId: string): SearchCompetitorAdRecord {
  return { id, runId, competitorId, createdAt: AT } as unknown as SearchCompetitorAdRecord;
}

function icp(id: string, kind: "search" | "lookup", sourceId: string, createdAt = AT): IcpRecord {
  return { id, source: { kind, id: sourceId }, stage: "problem_aware", createdAt } as unknown as IcpRecord;
}

/** Everything import must leave alone. */
async function preserved() {
  return {
    users: (await identity.listUsers({ includeDeleted: true })).map((u) => u.id).sort(),
    ledger: (await svc.queryLedger({})).map((e) => e.id).sort(),
    periods: (await svc.listPeriods(alice.id)).map((p) => `${p.id}:${p.allowanceSubunits}`),
    audit: (await audit.queryAudit({ limit: 100 })).map((e) => e.id).sort(),
    maxRuns: (await settings.getAppSettings()).maxConcurrentRunsPerUser,
  };
}

/** Foreign accounts, credits and settings in an import file: all must be ignored. */
const FOREIGN: Partial<DatabaseShape> = {
  users: [
    { id: "local-alice", username: "alice" },
    { id: "local-ghost", username: "ghost" },
  ] as never,
  creditLedger: [{ id: "foreign-ledger", userId: "local-alice", seq: 1 }] as never,
  creditPeriods: [{ id: "foreign-period", userId: "local-alice", status: "current" }] as never,
  auditLogs: [{ id: "foreign-audit", seq: 1 }] as never,
  appSettings: { maxConcurrentRunsPerUser: 99 } as never,
  loginAttempts: [{ key: "alice", attempts: 8, firstAttemptAt: AT, lockedUntil: AT }],
};

test("replaceStore takes only history from the import and keeps accounts, credits, audit and settings", async () => {
  // Live history that the replace removes.
  assert.equal(await runs.saveJob(job("old-run", alice.id)), true);
  assert.equal(await competitors.saveCompetitor(competitor("old-comp", "old-run")), true);
  const keep = await preserved();

  const result = await history.replaceStore(
    {
      ...FOREIGN,
      jobs: [
        job("a", "local-alice", { competitorIds: ["comp-a"] }),
        job("b", "local-ghost"),
        job("c", null),
        job("d", alice.id),
      ],
      competitors: [
        competitor("comp-a", "a", {
          recreatedPage: { status: "ready", html: "<p>imported</p>", previousHtml: "<p>older</p>" } as never,
        }),
      ],
      seenPageIds: ["page-comp-a"],
      lookupJobs: [lookup("l1", "local-alice")],
      lookupAds: [lookupAd("ad-1", "l1")],
      searchCompetitorAds: [searchAd("sad-1", "a", "comp-a")],
      icps: [icp("icp-old", "search", "a", "2026-01-01T00:00:00.000Z"), icp("icp-new", "search", "a")],
      deletedRunIds: ["gone-elsewhere"],
    },
    { fallbackOwnerUserId: boss.id },
  );

  assert.deepEqual(result.owners, { kept: 1, matchedByUsername: 2, assignedToFallback: 2, unresolved: 0 });
  assert.equal(result.before.jobs, 1);
  assert.equal(result.before.competitors, 1);
  assert.deepEqual(result.after, {
    jobs: 4,
    competitors: 1,
    lookupJobs: 1,
    lookupAds: 1,
    searchCompetitorAds: 1,
    seenPageIds: 1,
  });
  assert.deepEqual(await history.getStoreStats(), result.after);

  assert.equal((await runs.getJob("a"))?.ownerUserId, alice.id, "matched by username");
  assert.equal((await runs.getJob("b"))?.ownerUserId, boss.id, "unknown owner goes to the fallback");
  assert.equal((await runs.getJob("c"))?.ownerUserId, boss.id, "unowned goes to the fallback");
  assert.equal((await runs.getJob("d"))?.ownerUserId, alice.id, "an owner that exists here is kept");
  assert.equal((await runs.getLookupJob("l1"))?.ownerUserId, alice.id);

  // The replaced run is gone for good: it is tombstoned, so a late write cannot bring it back.
  assert.equal(await runs.getJob("old-run"), null);
  assert.equal(await competitors.getCompetitor("old-comp"), null);
  assert.equal(await runs.saveJob(job("old-run", alice.id)), false);
  assert.equal(await runs.runWasDeleted(getDb(), "gone-elsewhere"), true, "the import's tombstones are kept");

  // Page content goes to recreated_pages; the competitor row keeps a light page.
  const stored = await competitors.getCompetitor("comp-a");
  assert.equal(stored?.recreatedPage?.hasPage, true);
  assert.equal((stored?.recreatedPage as Record<string, unknown> | undefined)?.html, undefined);
  const { rows } = await getDb().query<{ owner: string | null }>(
    "select owner_user_id as owner from competitors where id = 'comp-a'",
  );
  assert.equal(rows[0]?.owner, alice.id, "competitor owner copied from the remapped run");
  assert.deepEqual(await getRecreatedPage("comp-a"), { html: "<p>imported</p>", previousHtml: "<p>older</p>" });

  assert.deepEqual(
    (await icps.getIcps("search", "a")).map((i) => i.id),
    ["icp-new"],
    "duplicate ICPs for one source and stage collapse to the newest",
  );
  assert.equal((await lookups.getLookupAds("l1")).length, 1);
  assert.equal((await lookups.getSearchCompetitorAdsByRun("a")).length, 1);
  assert.deepEqual([...(await runs.getSeenPageIds())], ["page-comp-a"]);

  assert.deepEqual(await preserved(), keep, "accounts, ledger, periods, audit and settings untouched");
  const { rows: attempts } = await getDb().query("select 1 from login_attempts");
  assert.equal(attempts.length, 0, "login attempts are not imported");
});

test("mergeStore keeps live rows, lets incoming rows win by id, and does not revive deleted runs", async () => {
  const keep = await preserved();
  await runs.deleteHistoryRun("d");
  const before = await history.getStoreStats();

  const result = await history.mergeStore({
    ...FOREIGN,
    jobs: [job("a", alice.id, { keyword: "renamed", competitorIds: ["comp-a"] }), job("e", alice.id), job("d", alice.id)],
    competitors: [competitor("comp-e", "e"), competitor("comp-d", "d")],
    seenPageIds: ["page-comp-e"],
    lookupJobs: [lookup("l2", alice.id)],
    lookupAds: [lookupAd("ad-2", "l2")],
    deletedRunIds: ["also-gone"],
  });

  assert.deepEqual(result.before, before);
  assert.equal(result.owners?.kept, 4);
  assert.equal((await runs.getJob("a"))?.keyword, "renamed", "incoming wins on id conflict");
  assert.ok(await runs.getJob("b"), "live rows not in the import are kept");
  assert.ok(await runs.getJob("e"));
  assert.equal(await runs.getJob("d"), null, "a run deleted here is not brought back");
  assert.equal(await competitors.getCompetitor("comp-d"), null, "nor are its competitors");
  assert.ok(await competitors.getCompetitor("comp-a"), "live competitors are kept");
  assert.ok(await competitors.getCompetitor("comp-e"));
  assert.deepEqual([...(await runs.getSeenPageIds())].sort(), ["page-comp-a", "page-comp-e"]);
  assert.equal((await lookups.getLookupAds("l1")).length, 1);
  assert.equal((await lookups.getLookupAds("l2")).length, 1);
  assert.equal(await runs.runWasDeleted(getDb(), "also-gone"), true);
  assert.equal(await runs.runWasDeleted(getDb(), "gone-elsewhere"), true);
  assert.deepEqual(result.after, await history.getStoreStats());
  assert.equal(result.after.jobs, 4, "a, b, c, e");

  assert.deepEqual(await preserved(), keep);
});

test("replaceStore upserts: a re-imported light page keeps its stored content; a run deleted here comes back", async () => {
  const comp = await competitors.getCompetitor("comp-a");
  assert.equal(comp?.recreatedPage?.hasPage, true);
  assert.equal(await runs.runWasDeleted(getDb(), "d"), true, "deleted by the merge test");

  await history.replaceStore({
    jobs: [job("a", alice.id), job("d", alice.id)],
    // A light page (an export of this database) carries no content.
    competitors: [competitor("comp-a", "a", { recreatedPage: comp?.recreatedPage })],
    seenPageIds: [],
  });

  assert.deepEqual(await getRecreatedPage("comp-a"), { html: "<p>imported</p>", previousHtml: "<p>older</p>" });
  assert.equal((await competitors.getCompetitor("comp-a"))?.recreatedPage?.hasPage, true);
  assert.ok(await runs.getJob("d"), "the import is the whole history: its runs are live");
  assert.equal(await runs.runWasDeleted(getDb(), "d"), false);
  assert.equal(await runs.runWasDeleted(getDb(), "e"), true, "a run the replace removed is tombstoned");
  assert.equal(await runs.runWasDeleted(getDb(), "also-gone"), false, "old tombstones are replaced");
  assert.equal(await competitors.getCompetitor("comp-e"), null);
  assert.deepEqual((await history.getStoreStats()).jobs, 2);
});
