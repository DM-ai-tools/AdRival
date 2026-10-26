import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { getDb, setClientForTests } from "../src/lib/data/client";
import { migrate } from "../src/lib/data/migrate";
import * as competitors from "../src/lib/data/competitors";
import * as identity from "../src/lib/data/identity";
import * as audit from "../src/lib/data/audit";
import * as runs from "../src/lib/data/runs";
import * as spaces from "../src/lib/data/spaces";
import { initializeUserCredits } from "../src/lib/data/accountingService";
import type { AppUser, CompetitorRecord, RecreatedPageLight, SearchJob } from "../src/lib/types";
import { asUser, jsonRequest, readJson } from "./helpers/routeRequest";
import { createPgliteClient, type PgliteTestClient } from "./helpers/testDb";

/*
 * Stop, history, export and page-open routes, called as route handlers
 * against a real (PGlite) database. Every authorization and stop helper is
 * async now; one that is not awaited silently skips the check or the stop
 * (a Promise is always truthy), which these tests would catch.
 */

process.env.SESSION_SECRET = "route-stop-authz-test-secret";

const stopRoute = await import("../src/app/api/stop/route");
const searchStopRoute = await import("../src/app/api/search/stop/route");
const historyRoute = await import("../src/app/api/history/route");
const unifiedHistoryRoute = await import("../src/app/api/history/unified/route");
const lookupHistoryRoute = await import("../src/app/api/lookup/history/route");
const statusRoute = await import("../src/app/api/search/status/route");
const exportFullRoute = await import("../src/app/api/export/full/route");
const exportRoute = await import("../src/app/api/export/route");
const recreatePageRoute = await import("../src/app/api/competitors/recreate-page/route");

const BASE = "http://localhost/api";

let client: PgliteTestClient;

before(async () => {
  client = await createPgliteClient();
  await migrate(client);
  setClientForTests(client);
});

after(async () => {
  setClientForTests(null);
  await client.close();
});

let seq = 0;

async function makeUser(username: string): Promise<AppUser> {
  const user = await identity.createUser({
    username: `${username}${++seq}`,
    displayName: username,
    passwordHash: "x",
    role: "user",
    orgId: null,
  });
  await initializeUserCredits(user.id, { allowanceSubunits: 0, resetCadence: "none", reason: "test" });
  return user;
}

function searchJob(owner: AppUser, overrides: Partial<SearchJob> = {}): SearchJob {
  seq += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  return {
    id: `run-${seq}-${Date.now()}`,
    keyword: `keyword ${seq}`,
    keywords: [`keyword ${seq}`],
    platform: "facebook",
    geo: "AU",
    countries: ["AU"],
    status: "completed",
    progress: {
      stage: "done",
      scannedAds: 0,
      scannedPages: 0,
      accepted: 0,
      target: 0,
      rejected: 0,
      message: "done",
    },
    competitorIds: [],
    ownerUserId: owner.id,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/** A search that is still working (searching for competitors). */
function runningJob(owner: AppUser): SearchJob {
  const job = searchJob(owner, { status: "running" });
  job.progress = { ...job.progress, stage: "searching_ads", message: "Searching" };
  return job;
}

async function saveRun(job: SearchJob): Promise<SearchJob> {
  assert.equal(await runs.saveJob(job), true);
  return job;
}

const PAGE_HTML = "<html><body><h1>Recreated page</h1></body></html>";

/** A competitor of `runId` whose recreated page content is stored in the database. */
async function competitorWithPage(runId: string, content = { html: PAGE_HTML, previousHtml: "<p>before</p>" }) {
  seq += 1;
  const page = {
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    businessUrl: "https://client.invalid",
    keyword: "plumber",
    sourceCompetitorName: "Rival",
    sourceAnalyzedUrl: "https://rival.invalid",
    brandColors: { primary: "#000", secondary: "#111", accent: "#222", background: "#fff", text: "#000" },
    differentiationNotes: "notes",
  } as unknown as RecreatedPageLight;
  const competitor = {
    id: `comp-${seq}-${Date.now()}`,
    runId,
    pageId: `page-${seq}`,
    pageName: `Competitor ${seq}`,
    country: "AU",
    platform: "facebook",
    activeAdsCount: 12,
    services: [],
    sampleAd: { adArchiveId: `ad-${seq}`, title: "t", body: "b", daysRunning: 10, adLibraryUrl: "https://x.invalid/ad" },
    brand: { website: "https://x.invalid" },
    createdAt: new Date().toISOString(),
    recreatedPage: page,
  } as unknown as CompetitorRecord;
  assert.equal(await competitors.saveCompetitor({ ...competitor, recreatedPageHeavy: content }), true);
  return competitor;
}

function post(route: { POST(r: Request): Promise<Response> }, user: AppUser | null, path: string, body: unknown) {
  return asUser(user, async () => readJson(await route.POST(jsonRequest(`${BASE}${path}`, "POST", body))));
}

function get(route: { GET(r: Request): Promise<Response> }, user: AppUser | null, path: string) {
  return asUser(user, async () => readJson(await route.GET(jsonRequest(`${BASE}${path}`, "GET"))));
}

/* ── stop ── */

test("POST /api/stop stops the owner's running search; the stop sticks", async () => {
  const owner = await makeUser("owner");
  const job = await saveRun(runningJob(owner));

  const res = await post(stopRoute, owner, "/stop", { jobId: job.id });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.searchJobIds, [job.id]);

  const stored = await runs.getJob(job.id);
  assert.equal(stored?.progress.stopRequested, true);
  assert.equal(stored?.status, "failed", "a run with no competitors yet ends failed");
  assert.equal(await runs.isSearchJobSuppressed(job.id), true);
  // The pipeline's next save must not bring the run back.
  assert.equal(await runs.saveJob({ ...job, updatedAt: new Date().toISOString() }), false);
  assert.equal((await runs.getJob(job.id))?.progress.stopRequested, true);
});

test("POST /api/stop for another user's run is refused and the run keeps going", async () => {
  const owner = await makeUser("owner");
  const stranger = await makeUser("stranger");
  const job = await saveRun(runningJob(owner));

  const res = await post(stopRoute, stranger, "/stop", { jobId: job.id });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "not_found");
  const stored = await runs.getJob(job.id);
  assert.equal(stored?.status, "running");
  assert.notEqual(stored?.progress.stopRequested, true);
  assert.equal(await runs.isSearchJobSuppressed(job.id), false);
});

test("POST /api/stop with no ids stops only the caller's own running searches", async () => {
  const owner = await makeUser("owner");
  const other = await makeUser("other");
  const mine = await saveRun(runningJob(owner));
  const finished = await saveRun(searchJob(owner));
  const theirs = await saveRun(runningJob(other));

  const res = await post(stopRoute, owner, "/stop", {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.searchJobIds, [mine.id]);
  assert.equal((await runs.getJob(mine.id))?.progress.stopRequested, true);
  // A finished run gets no stop flag (it would block its offers report later).
  assert.notEqual((await runs.getJob(finished.id))?.progress.stopRequested, true);
  assert.equal((await runs.getJob(theirs.id))?.status, "running");
  assert.notEqual((await runs.getJob(theirs.id))?.progress.stopRequested, true);
});

test("POST /api/search/stop needs edit access: 404 for a stranger, 403 for a viewer, stops for the owner", async () => {
  const owner = await makeUser("owner");
  const stranger = await makeUser("stranger");
  const viewer = await makeUser("viewer");
  const job = await saveRun(runningJob(owner));
  await audit.upsertMembership({
    projectKind: "search",
    projectId: job.id,
    userId: viewer.id,
    role: "viewer",
    grantedByUserId: owner.id,
  });

  const byStranger = await post(searchStopRoute, stranger, "/search/stop", { jobId: job.id });
  assert.equal(byStranger.status, 404);
  const byViewer = await post(searchStopRoute, viewer, "/search/stop", { jobId: job.id });
  assert.equal(byViewer.status, 403);
  assert.equal(byViewer.body.code, "forbidden");
  assert.equal((await runs.getJob(job.id))?.status, "running", "not stopped by the refused calls");

  const byOwner = await post(searchStopRoute, owner, "/search/stop", { jobId: job.id });
  assert.equal(byOwner.status, 200);
  assert.equal((byOwner.body.job as SearchJob).progress.stopRequested, true);
  assert.equal((await runs.getJob(job.id))?.progress.stopRequested, true);
});

test("POST /api/search/stop with stopAll stops the caller's running searches only", async () => {
  const owner = await makeUser("owner");
  const other = await makeUser("other");
  const mine = await saveRun(runningJob(owner));
  const theirs = await saveRun(runningJob(other));

  const res = await post(searchStopRoute, owner, "/search/stop", { stopAll: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.stopped, 1);
  assert.deepEqual(res.body.jobIds, [mine.id]);
  assert.equal((await runs.getJob(theirs.id))?.status, "running");
});

/* ── history ── */

test("GET /api/history lists only the caller's runs, also behind many newer runs of others", async () => {
  const owner = await makeUser("owner");
  const other = await makeUser("other");
  const shared = await makeUser("shared");
  const oldest = await saveRun(searchJob(owner, { createdAt: "2020-01-01T00:00:00.000Z" }));
  const recent = await saveRun(searchJob(owner));
  for (let i = 0; i < 5; i += 1) await saveRun(searchJob(other));
  const sharedRun = await saveRun(searchJob(shared));
  await audit.upsertMembership({
    projectKind: "search",
    projectId: sharedRun.id,
    userId: owner.id,
    role: "viewer",
    grantedByUserId: shared.id,
  });

  const res = await get(historyRoute, owner, "/history");
  assert.equal(res.status, 200);
  const ids = (res.body.runs as SearchJob[]).map((r) => r.id);
  assert.deepEqual(new Set(ids), new Set([oldest.id, recent.id, sharedRun.id]));
  assert.equal(ids.at(-1), oldest.id, "newest first");

  const unified = await get(unifiedHistoryRoute, owner, "/history/unified");
  assert.equal(unified.status, 200);
  assert.deepEqual(
    new Set((unified.body.runs as Array<{ id: string }>).map((r) => r.id)),
    new Set([oldest.id, recent.id, sharedRun.id]),
  );

  const lookups = await get(lookupHistoryRoute, owner, "/lookup/history");
  assert.equal(lookups.status, 200);
  assert.deepEqual(lookups.body.runs, []);
});

test("history lists runs of a client space shared with the caller", async () => {
  const owner = await makeUser("owner");
  const member = await makeUser("member");
  const space = await spaces.createProjectSpace({ clientName: "Acme", ownerUserId: owner.id });
  const run = await saveRun(searchJob(owner));
  await spaces.assignRunsToSpace(space.id, [{ kind: "search", id: run.id }]);
  await spaces.upsertSpaceMembership({ spaceId: space.id, userId: member.id, role: "viewer", grantedByUserId: owner.id });

  const res = await get(historyRoute, member, "/history");
  assert.deepEqual((res.body.runs as SearchJob[]).map((r) => r.id), [run.id]);
  const unified = await get(unifiedHistoryRoute, member, "/history/unified");
  const item = (unified.body.runs as Array<{ id: string; clientName: string | null; accessRole: string }>)[0];
  assert.equal(item.id, run.id);
  assert.equal(item.clientName, "Acme");
  assert.equal(item.accessRole, "viewer");
});

test("GET /api/history?runId= sends light competitor rows (no page content) and refuses others", async () => {
  const owner = await makeUser("owner");
  const stranger = await makeUser("stranger");
  const job = await saveRun(searchJob(owner));
  const competitor = await competitorWithPage(job.id);

  const res = await get(historyRoute, owner, `/history?runId=${job.id}`);
  assert.equal(res.status, 200);
  const rows = res.body.competitors as Array<{ id: string; recreatedPage?: Record<string, unknown> }>;
  assert.deepEqual(rows.map((r) => r.id), [competitor.id]);
  const page = rows[0].recreatedPage!;
  assert.equal(page.status, "completed");
  assert.equal(page.hasPage, true);
  for (const heavy of ["html", "previousHtml", "sourceArchive", "generatedImages"]) {
    assert.equal(heavy in page, false, `${heavy} must not be sent in a list`);
  }
  assert.equal(JSON.stringify(res.body).includes("Recreated page"), false);

  const unified = await get(unifiedHistoryRoute, owner, `/history/unified?runId=${job.id}&kind=search`);
  assert.equal(unified.status, 200);
  assert.equal(JSON.stringify(unified.body).includes("Recreated page"), false);
  assert.equal(typeof (unified.body.credits as { runCreditsCharged: unknown }).runCreditsCharged, "number");

  assert.equal((await get(historyRoute, stranger, `/history?runId=${job.id}`)).status, 404);
  assert.equal((await get(unifiedHistoryRoute, stranger, `/history/unified?runId=${job.id}&kind=search`)).status, 404);
});

test("DELETE /api/history needs edit access and removes only the caller's runs with all=1", async () => {
  const owner = await makeUser("owner");
  const stranger = await makeUser("stranger");
  const job = await saveRun(searchJob(owner));
  const theirs = await saveRun(searchJob(stranger));

  const refused = await asUser(stranger, async () =>
    readJson(await historyRoute.DELETE(jsonRequest(`${BASE}/history?runId=${job.id}`, "DELETE"))),
  );
  assert.equal(refused.status, 404);
  assert.ok(await runs.getJob(job.id), "still there");

  const all = await asUser(owner, async () =>
    readJson(await historyRoute.DELETE(jsonRequest(`${BASE}/history?all=1`, "DELETE"))),
  );
  assert.equal(all.status, 200);
  assert.equal(all.body.removedRuns, 1);
  assert.equal(await runs.getJob(job.id), null);
  assert.ok(await runs.getJob(theirs.id), "another user's run is untouched");
});

/* ── status ── */

test("GET /api/search/status is light and scoped to the caller", async () => {
  const owner = await makeUser("owner");
  const stranger = await makeUser("stranger");
  const job = await saveRun(searchJob(owner));
  await competitorWithPage(job.id);

  const res = await get(statusRoute, owner, `/search/status?jobId=${job.id}`);
  assert.equal(res.status, 200);
  assert.equal((res.body.job as SearchJob).id, job.id);
  assert.equal(JSON.stringify(res.body).includes("Recreated page"), false);
  const credits = res.body.credits as Record<string, unknown>;
  assert.equal(typeof credits.availableSubunits, "number");
  assert.equal(typeof credits.lowCredit, "boolean");
  assert.deepEqual(res.body.access, { role: "owner", ownerIsSelf: true });

  assert.equal((await get(statusRoute, stranger, `/search/status?jobId=${job.id}`)).status, 404);
});

/* ── exports ── */

test("GET /api/export/full works for the owner and 404s for anyone else", async () => {
  const owner = await makeUser("owner");
  const stranger = await makeUser("stranger");
  const job = await saveRun(searchJob(owner));
  await competitorWithPage(job.id);

  const ok = await asUser(owner, () => exportFullRoute.GET(jsonRequest(`${BASE}/export/full?jobId=${job.id}`, "GET")));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") || "", /spreadsheetml/);
  assert.ok((await ok.arrayBuffer()).byteLength > 1000);

  const refused = await get(exportFullRoute, stranger, `/export/full?jobId=${job.id}`);
  assert.equal(refused.status, 404);
  assert.equal(refused.body.code, "not_found");
  assert.equal((await get(exportFullRoute, owner, "/export/full?jobId=missing-run")).status, 404);
  assert.equal((await get(exportFullRoute, null, `/export/full?jobId=${job.id}`)).status, 401);

  const plain = await asUser(owner, () => exportRoute.GET(jsonRequest(`${BASE}/export?jobId=${job.id}`, "GET")));
  assert.equal(plain.status, 200);
  assert.equal((await get(exportRoute, stranger, `/export?jobId=${job.id}`)).status, 404);
});

/* ── opening a recreated page ── */

test("GET /api/competitors/recreate-page sends the stored HTML; light=1 does not read it", async () => {
  const owner = await makeUser("owner");
  const stranger = await makeUser("stranger");
  const job = await saveRun(searchJob(owner));
  const competitor = await competitorWithPage(job.id);

  const open = await get(recreatePageRoute, owner, `/competitors/recreate-page?competitorId=${competitor.id}`);
  assert.equal(open.status, 200);
  const page = open.body.recreatedPage as Record<string, unknown>;
  assert.equal(page.html, PAGE_HTML);
  assert.equal(page.canUndo, true);
  assert.equal("previousHtml" in page, false, "the Undo copy stays on the server");
  assert.equal((open.body.competitor as { recreatedPage: { html: string } }).recreatedPage.html, PAGE_HTML);

  const poll = await get(recreatePageRoute, owner, `/competitors/recreate-page?competitorId=${competitor.id}&light=1`);
  assert.equal(poll.status, 200);
  const light = poll.body.recreatedPage as Record<string, unknown>;
  assert.equal(light.status, "completed");
  assert.equal("html" in light, false);
  assert.equal("canUndo" in light, false, "the poll leaves the browser's Undo flag alone");

  const refused = await get(recreatePageRoute, stranger, `/competitors/recreate-page?competitorId=${competitor.id}`);
  assert.equal(refused.status, 404);
  assert.equal(JSON.stringify(refused.body).includes("Recreated page"), false);
});

test("GET /api/competitors/recreate-page answers 503 with a clear message when the archived page cannot be read", async () => {
  const owner = await makeUser("owner");
  const job = await saveRun(searchJob(owner));
  const competitor = await competitorWithPage(job.id);
  // Archived to Storage, which is not reachable here.
  await getDb().query(
    "update recreated_pages set content = null, archive_path = 'pages/gone.gz', archived_at = now() where competitor_id = $1",
    [competitor.id],
  );

  const res = await get(recreatePageRoute, owner, `/competitors/recreate-page?competitorId=${competitor.id}`);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "This archived page could not be loaded, try again");

  // Polling the build status never reads the archive, so it keeps working.
  const poll = await get(recreatePageRoute, owner, `/competitors/recreate-page?competitorId=${competitor.id}&light=1`);
  assert.equal(poll.status, 200);
});

/* ── data: the history list reads only the runs asked for ── */

test("listHistoryRuns / listLookupHistory with ids read only those runs", async () => {
  const owner = await makeUser("owner");
  const a = await saveRun(searchJob(owner));
  const b = await saveRun(searchJob(owner));
  assert.deepEqual((await runs.listHistoryRuns(10, { ids: [a.id] })).map((r) => r.id), [a.id]);
  assert.deepEqual((await runs.listHistoryRuns(10, { ids: [] })), []);
  assert.deepEqual((await runs.listHistoryRuns(1, { ids: [a.id, b.id] })).map((r) => r.id), [b.id]);
  assert.deepEqual(await runs.listLookupHistory(10, { ids: [] }), []);
  assert.deepEqual(await spaces.listProjects({ spaceIds: [] }), []);
});
