import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { getDb } from "../src/lib/data/client";
import * as runs from "../src/lib/data/runs";
import type { LookupJob, SearchJob } from "../src/lib/types";
import { useTestDb } from "./helpers/testDb";

let cleanup: () => Promise<void> = async () => {};

before(async () => {
  ({ cleanup } = await useTestDb("runs"));
});

after(async () => {
  await cleanup();
});

let seq = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeJob(overrides: Partial<SearchJob> = {}): SearchJob {
  seq += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  return {
    id: `job-${seq}-${Date.now()}`,
    keyword: `keyword ${seq}`,
    keywords: [`keyword ${seq}`],
    platform: "facebook",
    geo: "AU",
    countries: ["AU"],
    status: "running",
    progress: {
      stage: "searching_ads",
      scannedAds: 0,
      scannedPages: 0,
      accepted: 0,
      target: 10,
      rejected: 0,
      message: "Starting",
    },
    competitorIds: [],
    ownerUserId: "owner-1",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function makeLookup(overrides: Partial<LookupJob> = {}): LookupJob {
  seq += 1;
  const at = new Date(Date.UTC(2026, 0, 2, 0, 0, seq)).toISOString();
  return {
    id: `lookup-${seq}-${Date.now()}`,
    queryName: `Brand ${seq}`,
    platform: "facebook",
    status: "running",
    progress: {
      stage: "fetching_ads",
      message: "Fetching",
      candidatesFound: 0,
      adsFetched: 0,
      pagesScanned: 0,
    },
    candidates: [],
    adIds: [],
    ownerUserId: "owner-1",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

async function rowCount(table: string, id: string): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(
    `select count(*)::int as n from ${table} where id = $1`,
    [id],
  );
  return rows[0].n;
}

async function insertCompetitor(id: string, runId: string, pageId: string, extra: Record<string, unknown> = {}) {
  await getDb().query(
    "insert into competitors (id, run_id, data) values ($1, $2, $3::jsonb)",
    [id, runId, JSON.stringify({ id, runId, pageId, ...extra })],
  );
}

/* ── search jobs ── */

test("saveJob then getJob returns an equal job", async () => {
  const job = makeJob({ spaceId: "space-1", businessUrl: "https://example.com" });
  assert.equal(await runs.saveJob(job), true);
  assert.deepEqual(await runs.getJob(job.id), job);
  assert.equal(await runs.getJob("no-such-job"), null);
});

test("saveJob keeps competitorIds and ownership already on the row", async () => {
  const job = makeJob({ competitorIds: ["c1"], spaceId: "space-9" });
  await runs.saveJob(job);
  const { ownerUserId: _owner, spaceId: _space, ...pipelineCopy } = job;
  await runs.saveJob({ ...pipelineCopy, competitorIds: ["c2"], status: "completed" } as SearchJob);
  const saved = await runs.getJob(job.id);
  assert.deepEqual(saved?.competitorIds, ["c1", "c2"]);
  assert.equal(saved?.ownerUserId, "owner-1");
  assert.equal(saved?.spaceId, "space-9");
  assert.equal(saved?.status, "completed");
});

test("saveJob returns false and does not re-create a deleted run", async () => {
  const job = makeJob();
  await runs.saveJob(job);
  const result = await runs.deleteHistoryRun(job.id);
  assert.deepEqual(result, { ok: true, removedCompetitors: 0 });
  // Drop the in-process tombstone so only the durable one is left.
  assert.equal(await runs.clearSearchJobSuppression(job.id), null);
  assert.equal(await runs.saveJob({ ...job, status: "completed" }), false);
  assert.equal(await runs.getJob(job.id), null);
  assert.equal(await rowCount("jobs", job.id), 0);
  assert.equal(await runs.isSearchJobSuppressed(job.id), true);
});

test("saves racing a delete never leave the deleted run behind", async () => {
  const job = makeJob();
  await runs.saveJob(job);
  const results = await Promise.all([
    runs.saveJob({ ...job, progress: { ...job.progress, message: "a" } }),
    runs.deleteHistoryRun(job.id),
    runs.saveJob({ ...job, progress: { ...job.progress, message: "b" } }),
    runs.updateJob(job.id, { status: "completed" }),
  ]);
  assert.deepEqual(results[1], { ok: true, removedCompetitors: 0 });
  assert.equal(await rowCount("jobs", job.id), 0);
});

test("a job with progress.stopRequested is not overwritten by a later saveJob", async () => {
  const job = makeJob();
  // Written as another process would: the stop flag is only in the database.
  await getDb().query(
    "insert into jobs (id, owner_user_id, status, created_at, data) values ($1, $2, $3, $4, $5::jsonb)",
    [
      job.id,
      job.ownerUserId,
      "partial",
      job.createdAt,
      JSON.stringify({ ...job, status: "partial", progress: { ...job.progress, stopRequested: true } }),
    ],
  );
  assert.equal(await runs.saveJob({ ...job, status: "completed" }), false);
  const kept = await runs.getJob(job.id);
  assert.equal(kept?.status, "partial");
  assert.equal(kept?.progress.stopRequested, true);
  assert.equal(await runs.updateJob(job.id, { status: "completed" }), null);
});

test("stopSearchJob stops the run and its offers lookups; later saves are refused", async () => {
  const job = makeJob({ competitorIds: ["c1"] });
  await runs.saveJob(job);
  const offers = makeLookup({ id: `search-offers:${job.id}`, internalOnly: true, adIds: [] });
  await runs.saveLookupJob(offers);

  const stopped = await runs.stopSearchJob(job.id);
  assert.equal(stopped?.status, "partial");
  assert.equal(stopped?.progress.stopRequested, true);
  assert.equal(stopped?.progress.stage, "done");

  const lookup = await runs.getLookupJob(offers.id);
  assert.equal(lookup?.status, "failed");
  assert.equal(lookup?.progress.stopRequested, true);

  assert.equal(await runs.saveJob({ ...job, status: "completed" }), false);
  assert.equal((await runs.getJob(job.id))?.status, "partial");
  assert.equal(await runs.isSearchJobSuppressed(job.id), true);

  const cleared = await runs.clearSearchJobSuppression(job.id);
  assert.equal(cleared?.progress.stopRequested, false);
  assert.equal(await runs.saveJob({ ...job, status: "completed" }), true);
  assert.equal(await runs.isSearchJobSuppressed(job.id), false);
});

test("updateJob merges a patch and stamps updatedAt", async () => {
  const job = makeJob();
  await runs.saveJob(job);
  const updated = await runs.updateJob(job.id, { status: "completed", error: null });
  assert.equal(updated?.status, "completed");
  assert.equal(updated?.keyword, job.keyword);
  assert.notEqual(updated?.updatedAt, job.updatedAt);
  assert.deepEqual(await runs.getJob(job.id), updated);
  assert.equal(await runs.updateJob("missing-job", { status: "failed" }), null);
});

test("listHistoryRuns returns newest first, respects limit and counts competitors", async () => {
  const older = makeJob({ createdAt: "2030-01-01T00:00:00.000Z", competitorIds: ["x"] });
  const newer = makeJob({ createdAt: "2030-01-02T00:00:00.000Z" });
  await runs.saveJob(older);
  await runs.saveJob(newer);
  await insertCompetitor(`comp-a-${newer.id}`, newer.id, "page-a");
  await insertCompetitor(`comp-b-${newer.id}`, newer.id, "page-b");
  await insertCompetitor(`comp-r-${newer.id}`, newer.id, "page-r", { recreateOnly: true });

  const top = await runs.listHistoryRuns(2);
  assert.equal(top.length, 2);
  assert.deepEqual(
    top.map((r) => r.id),
    [newer.id, older.id],
  );
  assert.equal(top[0].competitorCount, 2);
  assert.equal(top[1].competitorCount, 1);

  const one = await runs.listHistoryRuns(1);
  assert.deepEqual(
    one.map((r) => r.id),
    [newer.id],
  );
  assert.deepEqual(
    (await runs.listJobs(1)).map((j) => j.id),
    [newer.id],
  );
});

test("deleteHistoryRun removes competitors, their ads and frees unused page ids", async () => {
  const job = makeJob();
  const other = makeJob();
  await runs.saveJob(job);
  await runs.saveJob(other);
  await insertCompetitor(`del-a-${job.id}`, job.id, "shared-page");
  await insertCompetitor(`del-b-${job.id}`, job.id, "only-page");
  await insertCompetitor(`keep-${other.id}`, other.id, "shared-page");
  await getDb().query(
    "insert into recreated_pages (competitor_id, content, data) values ($1, $2, '{}'::jsonb)",
    [`del-a-${job.id}`, Buffer.from("x")],
  );
  await getDb().query(
    "insert into search_competitor_ads (id, run_id, competitor_id, data) values ($1, $2, $3, '{}'::jsonb)",
    [`ad-${job.id}`, job.id, `del-a-${job.id}`],
  );
  await runs.markPageSeen("shared-page");
  await runs.markPageSeen("only-page");
  await runs.markPageSeen("only-page");

  const result = await runs.deleteHistoryRun(job.id);
  assert.deepEqual(result, { ok: true, removedCompetitors: 2 });
  assert.equal(await runs.getJob(job.id), null);
  const seen = await runs.getSeenPageIds();
  assert.equal(seen.has("shared-page"), true);
  assert.equal(seen.has("only-page"), false);
  const left = await getDb().query<{ n: number }>(
    "select (select count(*) from competitors where run_id = $1)::int + (select count(*) from search_competitor_ads where run_id = $1)::int + (select count(*) from recreated_pages where competitor_id like 'del-%')::int as n",
    [job.id],
  );
  assert.equal(left.rows[0].n, 0);
  assert.equal(await rowCount("competitors", `keep-${other.id}`), 1);
});

test("saveJobProgress throttles routine progress and lets a final save win", async () => {
  const job = makeJob();
  await runs.saveJob(job);

  await runs.saveJobProgress({ ...job, progress: { ...job.progress, message: "one" } });
  assert.equal((await runs.getJob(job.id))?.progress.message, "one");

  await runs.saveJobProgress({ ...job, progress: { ...job.progress, message: "two" } });
  assert.equal((await runs.getJob(job.id))?.progress.message, "one", "held back within the window");

  await runs.saveJob({ ...job, status: "completed", progress: { ...job.progress, message: "final" } });
  await wait(runs.PROGRESS_WRITE_MS + 300);
  const saved = await runs.getJob(job.id);
  assert.equal(saved?.status, "completed");
  assert.equal(saved?.progress.message, "final");
});

test("isSearchWorkInFlight and stopAllInFlightWork stop only running work", async () => {
  const running = makeJob();
  const done = makeJob({ status: "completed", progress: { ...makeJob().progress, stage: "done" } });
  await runs.saveJob(running);
  await runs.saveJob(done);
  assert.equal(await runs.isSearchWorkInFlight(running), true);
  assert.equal(await runs.isSearchWorkInFlight(done), false);

  const result = await runs.stopAllInFlightWork("Stopped by admin");
  assert.ok(result.searchJobIds.includes(running.id));
  assert.ok(!result.searchJobIds.includes(done.id));
  assert.equal((await runs.getJob(running.id))?.progress.stopRequested, true);
  assert.equal((await runs.getJob(done.id))?.progress.stopRequested, undefined);
});

/* ── lookup jobs ── */

test("lookup jobs round-trip, merge adIds and keep resolvedIdentity", async () => {
  const lookup = makeLookup({ adIds: ["a1"] });
  assert.equal(await runs.saveLookupJob(lookup), true);
  assert.deepEqual(await runs.getLookupJob(lookup.id), lookup);
  await runs.saveLookupJob({ ...lookup, adIds: ["a2"], status: "completed" });
  const saved = await runs.getLookupJob(lookup.id);
  assert.deepEqual(saved?.adIds, ["a1", "a2"]);
  assert.equal(saved?.status, "completed");
});

test("a new lookup job that is already stopped is not created", async () => {
  const lookup = makeLookup({ progress: { ...makeLookup().progress, stopRequested: true } });
  assert.equal(await runs.saveLookupJob(lookup), false);
  assert.equal(await runs.getLookupJob(lookup.id), null);
});

test("deleteLookupHistoryRun removes ads and blocks a later save", async () => {
  const lookup = makeLookup({ adIds: ["ad-1", "ad-2"] });
  await runs.saveLookupJob(lookup);
  for (const adId of lookup.adIds) {
    await getDb().query("insert into lookup_ads (id, lookup_id, data) values ($1, $2, '{}'::jsonb)", [
      `${lookup.id}-${adId}`,
      lookup.id,
    ]);
  }
  assert.equal((await runs.listLookupHistory(500)).find((h) => h.id === lookup.id)?.adCount, 2);

  assert.deepEqual(await runs.deleteLookupHistoryRun(lookup.id), { ok: true, removedAds: 2 });
  assert.equal(await runs.clearLookupJobSuppression(lookup.id), null);
  assert.equal(await runs.saveLookupJob({ ...lookup, status: "completed" }), false);
  assert.equal(await rowCount("lookup_jobs", lookup.id), 0);
  assert.equal(await runs.isLookupJobSuppressed(lookup.id), true);
});

test("stopLookupJob marks the lookup stopped and updateLookupJob is refused", async () => {
  const lookup = makeLookup();
  await runs.saveLookupJob(lookup);
  const stopped = await runs.stopLookupJob(lookup.id, "Halt");
  assert.equal(stopped?.status, "failed");
  assert.equal(stopped?.error, "Halt");
  assert.equal(await runs.updateLookupJob(lookup.id, { status: "completed" }), null);
  assert.equal(await runs.isLookupWorkInFlight(lookup), false);
});

test("listLookupHistory hides internal rows", async () => {
  const hidden = makeLookup({ internalOnly: true });
  await runs.saveLookupJob(hidden);
  const history = await runs.listLookupHistory(500);
  assert.equal(
    history.some((h) => h.id === hidden.id),
    false,
  );
  assert.equal(
    (await runs.listLookupJobs(500)).some((j) => j.id === hidden.id),
    true,
  );
});

/* ── restart ── */

test("markInterruptedJobs fails one running job and leaves finished jobs untouched", async () => {
  // Earlier tests left running rows; start from a clean slate for the count.
  await runs.clearAllHistory();
  await runs.clearAllLookupHistory();
  const running = makeJob();
  const finished = makeJob({ status: "completed", progress: { ...makeJob().progress, stage: "done" } });
  await runs.saveJob(running);
  await runs.saveJob(finished);

  assert.equal(await runs.markInterruptedJobs(), 1);
  const failed = await runs.getJob(running.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.progress.message, "Interrupted by restart");
  assert.equal(failed?.progress.stage, "failed");
  assert.equal(await runs.isSearchWorkInFlight(failed!), false, "an interrupted job is not in flight");
  assert.deepEqual(await runs.getJob(finished.id), finished);
  assert.equal(await runs.markInterruptedJobs(), 0);
});

test("markInterruptedJobs ends offers analysis and copes with a null progress", async () => {
  const inOffers = makeJob({
    competitorIds: ["c1"],
    progress: { ...makeJob().progress, stage: "analyzing_offers", offersPhase: "landing_pages", offersCurrentName: "Acme" },
  });
  await runs.saveJob(inOffers);
  const nullProgress = makeLookup();
  await getDb().query(
    "insert into lookup_jobs (id, status, created_at, data) values ($1, 'running', $2, $3::jsonb)",
    [nullProgress.id, nullProgress.createdAt, JSON.stringify({ ...nullProgress, progress: null })],
  );

  assert.equal(await runs.markInterruptedJobs(), 2);

  const job = await runs.getJob(inOffers.id);
  assert.equal(job?.status, "failed");
  assert.equal(job?.progress.stage, "failed");
  assert.equal(job?.progress.offersPhase, "failed");
  assert.equal(job?.progress.offersCurrentName, null);
  assert.equal(job?.offersReport?.status, "failed");
  assert.equal(await runs.isSearchWorkInFlight(job!), false);

  const lookup = await runs.getLookupJob(nullProgress.id);
  assert.equal(lookup?.status, "failed");
  assert.equal(lookup?.progress.stage, "failed");
  assert.equal(lookup?.progress.message, "Interrupted by restart");
  assert.equal(await runs.isLookupWorkInFlight(lookup!), false);
});

test("markInterruptedJobs also covers lookup jobs", async () => {
  const lookup = makeLookup();
  await runs.saveLookupJob(lookup);
  assert.equal(await runs.markInterruptedJobs(), 1);
  const failed = await runs.getLookupJob(lookup.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.progress.message, "Interrupted by restart");
});

test("clearAllHistory removes every run and blocks their later saves", async () => {
  await runs.clearAllHistory();
  const job = makeJob();
  await runs.saveJob(job);
  await insertCompetitor(`clear-${job.id}`, job.id, "clear-page");
  await runs.markPageSeen("clear-page");
  const result = await runs.clearAllHistory();
  assert.deepEqual(result, { removedRuns: 1, removedCompetitors: 1 });
  assert.equal((await runs.getSeenPageIds()).size, 0);
  await runs.clearSearchJobSuppression(job.id);
  assert.equal(await runs.saveJob(job), false);
});
