import assert from "node:assert/strict";
import test, { after } from "node:test";
import { useTempStore } from "./helpers/store";

/*
 * The Recreate queue API (src/app/api/recreate/jobs), called as route
 * handlers against a real (PGlite) database. The design agent's API is faked
 * as in recreateQueue.test.ts: a started build keeps running until the end of
 * the file, so a job added here stays queued or running.
 */

process.env.MANUS_API_KEY = "test-key";
process.env.MANUS_POLL_MS = "10";
process.env.MANUS_PROJECT_ID = "test-project";
process.env.MANUS_CONNECTORS = "";
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;

const store = await useTempStore("recreate-api");

/** While set, every agent task reports an error (ends the builds left running). */
let failAll = false;
let taskSeq = 0;
const realFetch = globalThis.fetch;

function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = url.pathname.replace("/v2/", "");
  const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
  if (method === "task.create") {
    taskSeq += 1;
    return json({ ok: true, task_id: `T-api-${taskSeq}`, task_url: null });
  }
  if (method === "task.listMessages") {
    const at = Date.now() + 60_000;
    if (failAll) {
      return json({
        ok: true,
        messages: [
          { id: `s${at}`, type: "status_update", timestamp: at, status_update: { agent_status: "error" } },
          { id: `e${at}`, type: "error_message", timestamp: at, error_message: { content: "agent broke" } },
        ],
      });
    }
    return json({
      ok: true,
      messages: [{ id: `s${at}`, type: "status_update", timestamp: at, status_update: { agent_status: "running" } }],
    });
  }
  if (method === "task.detail") {
    return json({ ok: true, task: { id: "x", status: "running", credit_usage: 0, has_running_background_jobs: false } });
  }
  void init;
  return json({ ok: true });
}
globalThis.fetch = fakeFetch as typeof fetch;

const { makeUser } = await import("./helpers/factories");
const { asUser, jsonRequest, readJson, routeParams } = await import("./helpers/routeRequest");
const { getCompetitor, getJob, getRecreateOnlyPagesByRun, saveCompetitor, saveJob } = await import("@/lib/db");
const { upsertMembership } = await import("@/lib/data/audit");
const { assignRunsToSpace, createProjectSpace } = await import("@/lib/data/spaces");
const jobsRepo = await import("@/lib/data/recreateJobs");
const { getDb } = await import("@/lib/data/client");
const { createRecreationVersion } = await import("@/lib/pipeline/landingRecreateBridge");
const jobsRoute = await import("../src/app/api/recreate/jobs/route");
const jobRoute = await import("../src/app/api/recreate/jobs/[id]/route");
import type { AppUser, CompetitorRecord, RecreatedPageLight, SearchJob } from "@/lib/types";
import type { RecreateListItem } from "@/lib/recreateList";

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

after(async () => {
  failAll = true;
  const until = Date.now() + 10_000;
  while ((await jobsRepo.listRunning()).length && Date.now() < until) await settle(25);
  await settle(100);
  globalThis.fetch = realFetch;
  await store.cleanup();
});

const BASE = "http://localhost/api/recreate/jobs";
let seq = 0;

async function makeRun(owner: AppUser, overrides: Partial<SearchJob> = {}): Promise<SearchJob> {
  seq += 1;
  const at = new Date().toISOString();
  const run: SearchJob = {
    id: `ra-run-${seq}`,
    keyword: "dentist",
    keywords: ["dentist"],
    platform: "facebook",
    geo: "AU",
    countries: ["AU"],
    status: "completed",
    progress: { stage: "done", scannedAds: 0, scannedPages: 0, accepted: 1, target: 10, rejected: 0, message: "" },
    competitorIds: [],
    businessUrl: "https://client.invalid",
    ownerUserId: owner.id,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
  assert.equal(await saveJob(run), true);
  return run;
}

/** A competitor of `runId`; analysed unless `analysed: false`. */
async function makeSource(runId: string, options: { analysed?: boolean; recreatedPage?: RecreatedPageLight } = {}) {
  seq += 1;
  const at = new Date().toISOString();
  const source = {
    id: `ra-src-${seq}`,
    runId,
    pageId: `ra-page-${seq}`,
    pageName: "Rival Clinic",
    country: "AU",
    platform: "facebook",
    activeAdsCount: 3,
    services: [],
    sampleAd: {
      adArchiveId: "a",
      title: "t",
      body: "b",
      daysRunning: 12,
      adLibraryUrl: "https://x.invalid",
      landingPageUrl: "https://rival.invalid/offer",
    },
    brand: {},
    pageAnalysis:
      options.analysed === false ? null : { status: "completed", analyzedUrl: "https://rival.invalid/offer", analyzedAt: at },
    recreatedPage: options.recreatedPage ?? null,
    createdAt: at,
  } as CompetitorRecord;
  assert.equal(await saveCompetitor(source), true);
  return source;
}

function post(user: AppUser, body: unknown) {
  return asUser(user, async () => readJson(await jobsRoute.POST(jsonRequest(BASE, "POST", body))));
}

function list(user: AppUser, query = "") {
  return asUser(user, async () => readJson(await jobsRoute.GET(jsonRequest(`${BASE}${query}`, "GET"))));
}

function remove(user: AppUser, id: string) {
  return asUser(user, async () =>
    readJson(await jobRoute.DELETE(jsonRequest(`${BASE}/${id}`, "DELETE"), routeParams({ id }))),
  );
}

async function versionsOf(runId: string): Promise<CompetitorRecord[]> {
  return (await getRecreateOnlyPagesByRun(runId)).filter((c) => c.recreateOnly?.variantOf);
}

test("POST by a viewer returns 403", async () => {
  const owner = await makeUser({ credits: 1000 });
  const viewer = await makeUser({ credits: 1000 });
  const run = await makeRun(owner);
  const source = await makeSource(run.id);
  await upsertMembership({
    projectKind: "search",
    projectId: run.id,
    userId: viewer.id,
    role: "viewer",
    grantedByUserId: owner.id,
  });

  const res = await post(viewer, { competitorId: source.id });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "forbidden");
  assert.deepEqual(await versionsOf(run.id), [], "no version made");
  assert.deepEqual(await jobsRepo.listJobs(viewer.id, null), [], "no job queued");

  const stranger = await makeUser({ credits: 1000 });
  assert.equal((await post(stranger, { competitorId: source.id })).status, 404);
  assert.equal((await post(stranger, { jobId: run.id, url: "https://rival.invalid/other" })).status, 404);
});

test("POST twice with identical details returns 409 the second time", async () => {
  const owner = await makeUser({ credits: 1000 });
  const run = await makeRun(owner);
  const source = await makeSource(run.id);
  const details = { competitorId: source.id, styleDirection: "soft", userFeedback: "  Warmer   colours " };

  const first = await post(owner, details);
  assert.equal(first.status, 202);
  const job = first.body.job as Record<string, unknown>;
  assert.equal(job.competitorId === source.id, false, "a new version, not the source itself");
  assert.ok(["queued", "running"].includes(String(job.status)));
  assert.equal(first.body.queuedAhead, 0);
  assert.equal("ownerUserId" in job, false);
  const version = await getCompetitor(String(job.competitorId));
  assert.equal(version?.recreateOnly?.variantOf, source.id);

  const again = await post(owner, { ...details, userFeedback: "Warmer colours", businessUrl: "client.invalid/" });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "already_in_progress");
  assert.match(String(again.body.error), /already in progress/i);

  // Adding from the version itself is the same source page.
  const viaVersion = await post(owner, { ...details, competitorId: version!.id });
  assert.equal(viaVersion.status, 409);

  // Different details are another version.
  const other = await post(owner, { competitorId: source.id, styleDirection: "minimal" });
  assert.equal(other.status, 202);
  assert.equal((await versionsOf(run.id)).length, 2);
});

test("adds past the limit wait in the queue and say how many are ahead", async () => {
  const owner = await makeUser({ credits: 1000 });
  const run = await makeRun(owner);
  const source = await makeSource(run.id);
  const results = [];
  for (let i = 1; i <= 5; i += 1) results.push(await post(owner, { competitorId: source.id, userFeedback: `version ${i}` }));
  assert.deepEqual(results.map((r) => r.status), [202, 202, 202, 202, 202]);
  assert.deepEqual(
    results.map((r) => (r.body.job as { status: string }).status),
    ["running", "running", "running", "queued", "queued"],
  );
  assert.deepEqual(results.map((r) => r.body.queuedAhead), [0, 0, 0, 0, 1]);
});

test("POST with a changed businessUrl saves it on the run", async () => {
  const owner = await makeUser({ credits: 1000 });
  const run = await makeRun(owner, { businessUrl: null });
  const source = await makeSource(run.id);

  const missing = await post(owner, { competitorId: source.id });
  assert.equal(missing.status, 400, "a queued job must never wait for a website");
  const invalid = await post(owner, { competitorId: source.id, businessUrl: "not a site" });
  assert.equal(invalid.status, 400);

  const res = await post(owner, { competitorId: source.id, businessUrl: "newclient.com.au/" });
  assert.equal(res.status, 202);
  assert.equal((await getJob(run.id))?.businessUrl, "https://newclient.com.au");
  const job = res.body.job as { options: { businessUrl: string } };
  assert.equal(job.options.businessUrl, "https://newclient.com.au");
});

test("POST validates the audience profile against the source's search", async () => {
  const owner = await makeUser({ credits: 1000 });
  const run = await makeRun(owner);
  const source = await makeSource(run.id);
  const res = await post(owner, { competitorId: source.id, icpId: "icp-from-elsewhere" });
  assert.equal(res.status, 400);
  assert.deepEqual(await versionsOf(run.id), []);
});

test("POST for an unanalysed page without credits returns 402 and queues nothing", async () => {
  const owner = await makeUser({ credits: 0 });
  const run = await makeRun(owner);
  const source = await makeSource(run.id, { analysed: false });

  const res = await post(owner, { competitorId: source.id });
  assert.equal(res.status, 402);
  const viaDashboard = await post(owner, { jobId: run.id, url: "https://rival.invalid/another-page" });
  assert.equal(viaDashboard.status, 402);
  assert.deepEqual(await versionsOf(run.id), [], "no version made");
  assert.deepEqual(await jobsRepo.listJobs(owner.id, null), [], "no job queued");
});

test("GET is scoped to the requested space", async () => {
  const owner = await makeUser({ credits: 1000 });
  const stranger = await makeUser({ credits: 1000 });
  const space = await createProjectSpace({ clientName: "Acme", ownerUserId: owner.id });
  const spaceRun = await makeRun(owner);
  await assignRunsToSpace(space.id, [{ kind: "search", id: spaceRun.id }]);
  const plainRun = await makeRun(owner);
  const legacyPage = {
    status: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    businessUrl: "https://client.invalid",
    keyword: "dentist",
    sourceCompetitorName: "Rival Clinic",
    sourceAnalyzedUrl: "https://rival.invalid/offer",
    brandColors: { primary: "#000", secondary: "#111", accent: "#222" },
    manus: { taskId: "T-hidden-task" },
    hasPage: true,
    pageBytes: 0,
    pageUpdatedAt: null,
  } as unknown as RecreatedPageLight;
  const legacy = await makeSource(plainRun.id, { recreatedPage: legacyPage });

  const inSpace = await post(owner, { competitorId: (await makeSource(spaceRun.id)).id });
  assert.equal(inSpace.status, 202);
  assert.equal((inSpace.body.job as { spaceId: string }).spaceId, space.id);
  const plainSource = await makeSource(plainRun.id);
  const plain = await post(owner, { competitorId: plainSource.id });
  assert.equal(plain.status, 202);

  const spaced = await list(owner, `?spaceId=${space.id}`);
  assert.equal(spaced.status, 200);
  assert.equal(spaced.body.limit, 3);
  const spacedItems = spaced.body.items as RecreateListItem[];
  assert.deepEqual(spacedItems.map((i) => i.jobId), [(inSpace.body.job as { id: string }).id]);

  const noSpace = await list(owner);
  const items = noSpace.body.items as RecreateListItem[];
  assert.deepEqual(
    items.map((i) => i.id),
    [(plain.body.job as { id: string }).id, legacy.id],
    "the space's job is left out; the legacy page is listed",
  );
  assert.equal(items[1].state, "legacy");
  assert.equal(items[0].daysRunning, 12);
  assert.equal(items[0].activeAds, 3);
  const text = JSON.stringify(noSpace.body);
  assert.equal(text.includes("T-hidden-task"), false, "the design agent's task stays on the server");
  assert.equal(text.includes("previousHtml"), false);
  assert.equal(text.includes("ownerUserId"), false);

  assert.deepEqual((await list(stranger)).body.items, [], "another user sees none of it");
  assert.deepEqual((await list(stranger, `?spaceId=${space.id}`)).body.items, []);
});

test("DELETE removes a queued job and its empty version; another user gets 404", async () => {
  const owner = await makeUser({ credits: 1000 });
  const stranger = await makeUser({ credits: 1000 });
  const run = await makeRun(owner);
  const source = await makeSource(run.id);
  // Queued directly (not dispatched), so it is still waiting when removed.
  const version = await createRecreationVersion(source);
  const job = await jobsRepo.insertJob({
    ownerUserId: owner.id,
    competitorId: version.id,
    runId: run.id,
    spaceId: null,
    options: { businessUrl: "https://client.invalid", styleDirection: null, userFeedback: null, targetIcp: null },
  });

  const refused = await remove(stranger, job.id);
  assert.equal(refused.status, 404);
  assert.equal((await jobsRepo.getRecreateJob(job.id))?.status, "queued");

  const res = await remove(owner, job.id);
  assert.equal(res.status, 200);
  assert.equal(await jobsRepo.getRecreateJob(job.id), null);
  assert.equal(await getCompetitor(version.id), null, "no version left behind");
  assert.equal((await remove(owner, job.id)).status, 404);
});

test("a failed job insert leaves no version behind and the run's website unchanged", async () => {
  const owner = await makeUser({ credits: 1000 });
  const run = await makeRun(owner);
  const source = await makeSource(run.id);
  // The queue table refuses this user's rows.
  await getDb().query(`
    create or replace function refuse_recreate_job() returns trigger language plpgsql as $$
    begin raise exception 'recreate_jobs unavailable'; end $$`);
  await getDb().query(
    `create trigger refuse_recreate_job before insert on recreate_jobs
       for each row when (new.owner_user_id = '${owner.id}') execute function refuse_recreate_job()`,
  );
  try {
    const res = await post(owner, { competitorId: source.id, businessUrl: "changed-client.invalid" });
    assert.equal(res.status, 500);
    assert.deepEqual(await versionsOf(run.id), [], "the version made for it is removed");
    assert.equal((await getJob(run.id))?.businessUrl, "https://client.invalid", "the run keeps its website");
  } finally {
    await getDb().query("drop trigger refuse_recreate_job on recreate_jobs");
  }
  // Once the table takes it again, the same request goes through.
  assert.equal((await post(owner, { competitorId: source.id, businessUrl: "changed-client.invalid" })).status, 202);
  assert.equal((await getJob(run.id))?.businessUrl, "https://changed-client.invalid");
});

test("a malformed body or landing page address is a 400, a missing search a 404", async () => {
  const owner = await makeUser({ credits: 1000 });
  const run = await makeRun(owner);
  const malformed = await asUser(owner, async () =>
    readJson(
      await jobsRoute.POST(
        new Request(BASE, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" }),
      ),
    ),
  );
  assert.equal(malformed.status, 400);
  assert.equal((await post(owner, ["not", "an", "object"])).status, 400);

  const badUrl = await post(owner, { jobId: run.id, url: "not a web address" });
  assert.equal(badUrl.status, 400);
  assert.match(String(badUrl.body.error), /address/i);
  assert.deepEqual(await getRecreateOnlyPagesByRun(run.id), [], "nothing held for it");

  // An unknown search is not found (404, so ids cannot be probed), never a server error.
  assert.equal((await post(owner, { jobId: "no-such-run", url: "https://rival.invalid/offer" })).status, 404);
});

test("an editor's recreation on the owner's run shows for the owner from its page, with nothing to stop", async () => {
  const owner = await makeUser({ credits: 1000 });
  const editor = await makeUser({ credits: 1000 });
  const run = await makeRun(owner);
  const source = await makeSource(run.id);
  await upsertMembership({
    projectKind: "search",
    projectId: run.id,
    userId: editor.id,
    role: "editor",
    grantedByUserId: owner.id,
  });
  const added = await post(editor, { competitorId: source.id });
  assert.equal(added.status, 202);
  const job = added.body.job as { id: string; competitorId: string };
  // The build has started: the version (the run owner's record) holds a page now.
  const until = Date.now() + 5_000;
  while (!(await getCompetitor(job.competitorId))?.recreatedPage && Date.now() < until) await settle(20);

  const mine = (await list(editor)).body.items as RecreateListItem[];
  assert.deepEqual(mine.map((i) => [i.jobId, i.state]), [[job.id, "running"]], "the editor can stop it");

  const owners = (await list(owner)).body.items as RecreateListItem[];
  assert.deepEqual(
    owners.map((i) => [i.competitorId, i.jobId, i.state]),
    [[job.competitorId, null, "running"]],
    "not a legacy page; no job of the owner's to stop",
  );
});
