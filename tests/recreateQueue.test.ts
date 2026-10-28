import assert from "node:assert/strict";
import test, { after } from "node:test";
import { useTempStore } from "./helpers/store";

/*
 * The server-side recreate queue (src/lib/pipeline/recreateQueue.ts). The
 * Manus API is faked (as in manusRunAsync.test.ts): each created task runs
 * until the test marks it done or failed; no provider is reached.
 */

process.env.MANUS_API_KEY = "test-key";
process.env.MANUS_POLL_MS = "10";
process.env.MANUS_PROJECT_ID = "test-project";
process.env.MANUS_CONNECTORS = "";
process.env.RECREATE_QUEUE_WATCH_MS = "20";
process.env.RECREATE_QUEUE_RETRY_MS = "50";
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;

const store = await useTempStore("recreate-queue");

type TaskState = "running" | "error" | "done";
const taskState = new Map<string, TaskState>();
/** While set, every task reports an error (used to end the runs a test left going). */
let failAll = false;
let taskSeq = 0;
/** While set, creating a task waits for it (a build held just before it reaches the agent). */
let holdCreate: Promise<void> | null = null;
/** While set, continuing a task fails (it can no longer be continued). */
let failSend = false;
const calls: Array<{ method: string; taskId: string }> = [];
/** The payload of every task created, in order. */
const created: Array<{ taskId: string; body: Record<string, unknown> }> = [];
const realFetch = globalThis.fetch;

const PAGE_HTML = "<!doctype html><html><body><h1>Bright Smiles dentist</h1><p>Book today</p></body></html>";

function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === "files.invalid") {
    return Promise.resolve(new Response(PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } }));
  }
  const method = url.pathname.replace("/v2/", "");
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  const taskId = String(body?.task_id ?? url.searchParams.get("task_id") ?? "");
  calls.push({ method, taskId });
  const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
  if (method === "task.create") {
    if (holdCreate) {
      calls.pop(); // recorded again when the held call goes through
      return holdCreate.then(() => fakeFetch(input, init));
    }
    taskSeq += 1;
    const id = `T-${taskSeq}`;
    taskState.set(id, "running");
    created.push({ taskId: id, body: body ?? {} });
    return json({ ok: true, task_id: id, task_url: null });
  }
  if (method === "task.listMessages") {
    const at = Date.now() + 60_000;
    const state = failAll ? "error" : taskState.get(taskId) ?? "running";
    if (state === "error") {
      return json({
        ok: true,
        messages: [
          { id: `s${at}`, type: "status_update", timestamp: at, status_update: { agent_status: "error" } },
          { id: `e${at}`, type: "error_message", timestamp: at, error_message: { content: "agent broke" } },
        ],
      });
    }
    if (state === "done") {
      return json({
        ok: true,
        messages: [
          { id: `s${at}`, type: "status_update", timestamp: at, status_update: { agent_status: "stopped" } },
          {
            id: `m${at}`,
            type: "assistant_message",
            timestamp: at,
            assistant_message: {
              content: "Here is the page.",
              attachments: [{ filename: "index.html", url: `https://files.invalid/${taskId}.html`, content_type: "text/html" }],
            },
          },
        ],
      });
    }
    return json({
      ok: true,
      messages: [{ id: `s${at}`, type: "status_update", timestamp: at, status_update: { agent_status: "running" } }],
    });
  }
  if (method === "task.sendMessage" && failSend) {
    return Promise.resolve(new Response(JSON.stringify({ ok: false, error: { message: "task gone" } }), { status: 400 }));
  }
  if (method === "task.detail") {
    return json({ ok: true, task: { id: taskId, status: "running", credit_usage: 0, has_running_background_jobs: false } });
  }
  return json({ ok: true });
}
globalThis.fetch = fakeFetch as typeof fetch;

const { makeUser } = await import("./helpers/factories");
const { saveCompetitor, saveJob, getCompetitor, updateCompetitor } = await import("@/lib/db");
const { createRecreationVersion } = await import("@/lib/pipeline/landingRecreateBridge");
const { deleteCompetitor } = await import("@/lib/data/competitors");
const jobsRepo = await import("@/lib/data/recreateJobs");
const { getDb } = await import("@/lib/data/client");
const { reserveCredits, releaseReservation } = await import("@/lib/accounting/service");
const { creditsToSubunits } = await import("@/lib/accounting/units");
const { RECREATE_BUILD_OPERATION } = await import("@/lib/accounting/scope");
const { LOW_CREDIT_MESSAGE } = await import("@/lib/accounting/errors");
const { RECREATE_QUEUE_STATE_KEY, dispatchRecreateQueue, resumedBuildStaleMs, stopRecreateJob, sweepRecreateQueue } =
  await import("@/lib/pipeline/recreateQueue");
const { resumeManusRecreation, editManusRecreation } = await import("@/lib/pipeline/manus/run");
const { getJob } = await import("@/lib/db");
const { sameWebsite, setBusinessProfileAnalyzerForTests } = await import("@/lib/pipeline/businessProfile");
const { InsufficientCreditsError } = await import("@/lib/accounting/errors");
const { saveRunBusinessUrl } = await import("@/lib/runBusinessUrl");
import type { BusinessProfile, CompetitorRecord, RecreatedLandingPage, RecreatedPageLight, SearchJob } from "@/lib/types";
import type { RecreateJob } from "@/lib/data/recreateJobs";

/*
 * The website analysis a build runs for a website other than its search's own
 * (analyzeBusinessProfile) is faked: every call is recorded, and a test can
 * set what it returns or throws.
 */
const analyzed: string[] = [];
let analyzeWith: ((url: string) => Promise<BusinessProfile>) | null = null;

function profileOf(url: string, name: string, primary: string): BusinessProfile {
  return {
    url,
    businessName: name,
    industry: "dental",
    description: `${name} dental clinic`,
    offerings: [`${name} check-ups`],
    competitorKeywords: ["dentist"],
    positioningSummary: `${name} positioning`,
    brandColors: { primary, secondary: "#203040", accent: "#405060", background: "#FFFFFF", text: "#0A0A0A" },
    brandAssets: {
      finalUrl: url,
      siteName: name,
      logoUrl: `${url}/logo.png`,
      faviconUrl: null,
      ogImageUrl: null,
      navLinks: [],
      footerLinks: [],
      socialLinks: [],
      images: [],
      emails: [],
      phones: [],
    },
  };
}

setBusinessProfileAnalyzerForTests(async (url) => {
  analyzed.push(url);
  if (analyzeWith) return analyzeWith(url);
  return profileOf(url, `Biz ${new URL(url).hostname.split(".")[0]}`, "#5A5A5A");
});

/** The search's own business: its brief names it and uses its colours. */
const ORIGINAL = profileOf("https://client.invalid", "Original Dental", "#111111");

after(async () => {
  failAll = true;
  // Let every run still going see the error and end before the database closes.
  await waitFor(async () => ((await jobsRepo.listRunning()).length === 0 ? true : null), "all runs ended", 10_000).catch(
    () => undefined,
  );
  await settle(100);
  globalThis.fetch = realFetch;
  setBusinessProfileAnalyzerForTests(null);
  await store.cleanup();
});

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 8_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() > until) throw new Error(`Timed out waiting for: ${label}`);
    await settle(15);
  }
}

let seq = 0;

/** A user with `credits`, a search run with a business website, an analysed page and `count` queued versions. */
async function setup(options: { credits?: number; count?: number; profile?: BusinessProfile } = {}) {
  seq += 1;
  const user = await makeUser({ credits: options.credits ?? 1000 });
  const at = new Date().toISOString();
  const run: SearchJob = {
    id: `rq-run-${seq}`,
    keyword: "dentist",
    keywords: ["dentist"],
    platform: "facebook",
    geo: "AU",
    countries: ["AU"],
    status: "completed",
    progress: { stage: "done", scannedAds: 0, scannedPages: 0, accepted: 1, target: 10, rejected: 0, message: "" },
    competitorIds: [],
    businessUrl: "https://client.invalid",
    ...(options.profile ? { businessProfile: structuredClone(options.profile) } : {}),
    ownerUserId: user.id,
    createdAt: at,
    updatedAt: at,
  };
  await saveJob(run);
  const source = {
    id: `rq-src-${seq}`,
    runId: run.id,
    pageId: `rq-page-${seq}`,
    pageName: "Rival Clinic",
    country: "AU",
    platform: "facebook",
    activeAdsCount: 3,
    services: [],
    sampleAd: { adArchiveId: "a", title: "t", body: "b", daysRunning: 3, adLibraryUrl: "https://x.invalid" },
    brand: {},
    pageAnalysis: { status: "completed", analyzedUrl: "https://rival.invalid/offer", analyzedAt: at },
    createdAt: at,
  } as CompetitorRecord;
  assert.equal(await saveCompetitor(source), true);
  const jobs: RecreateJob[] = [];
  for (let i = 0; i < (options.count ?? 4); i += 1) {
    const version = await createRecreationVersion(source);
    jobs.push(
      await jobsRepo.insertJob({
        ownerUserId: user.id,
        competitorId: version.id,
        runId: run.id,
        spaceId: null,
        options: { businessUrl: "https://client.invalid", styleDirection: null, userFeedback: null, targetIcp: null },
      }),
    );
  }
  return { user, run, source, jobs };
}

async function jobsOf(userId: string): Promise<RecreateJob[]> {
  return jobsRepo.listJobs(userId, null);
}

async function jobById(userId: string, id: string): Promise<RecreateJob | undefined> {
  return (await jobsOf(userId)).find((j) => j.id === id);
}

function withStatus(userId: string, status: RecreateJob["status"], count: number) {
  return waitFor(async () => {
    const found = (await jobsOf(userId)).filter((j) => j.status === status);
    return found.length === count ? found : null;
  }, `${count} ${status} job(s)`);
}

/** The design agent task of a version, once its build has created one. */
function taskOf(competitorId: string): Promise<string> {
  return waitFor(async () => (await getCompetitor(competitorId))?.recreatedPage?.manus?.taskId, `a task for ${competitorId}`);
}

/** Ends every run of this user (their tasks fail) and waits until nothing is running or queued. */
async function drain(userId: string): Promise<void> {
  failAll = true;
  try {
    await waitFor(async () => {
      const open = (await jobsOf(userId)).filter((j) => j.status === "running" || j.status === "queued");
      return open.length === 0;
    }, "the user's jobs to end", 10_000);
    await settle(50);
  } finally {
    failAll = false;
  }
}

test("a fourth job stays queued and starts when one finishes", async () => {
  const { user } = await setup();
  await dispatchRecreateQueue(user.id);
  const running = await withStatus(user.id, "running", 3);
  const [queued] = await withStatus(user.id, "queued", 1);
  await settle(150);
  assert.equal((await jobById(user.id, queued.id))?.status, "queued");
  assert.equal((await getCompetitor(queued.competitorId))?.recreatedPage ?? null, null, "a queued job builds nothing");

  const first = running[0];
  taskState.set(await taskOf(first.competitorId), "done");
  await waitFor(async () => (await jobById(user.id, first.id))?.status === "finished", "the first job to finish");
  assert.equal((await getCompetitor(first.competitorId))?.recreatedPage?.status, "completed");
  assert.ok((await jobById(user.id, first.id))?.finishedAt);

  await taskOf(queued.competitorId);
  assert.equal((await jobById(user.id, queued.id))?.status, "running");
  await drain(user.id);
});

test("a failed job frees its slot and the next starts", async () => {
  const { user } = await setup();
  await dispatchRecreateQueue(user.id);
  const running = await withStatus(user.id, "running", 3);
  const [queued] = await withStatus(user.id, "queued", 1);

  const first = running[0];
  taskState.set(await taskOf(first.competitorId), "error");
  const failed = await waitFor(async () => {
    const j = await jobById(user.id, first.id);
    return j?.status === "failed" ? j : null;
  }, "the first job to fail");
  assert.match(failed.error || "", /agent broke/);

  await taskOf(queued.competitorId);
  assert.equal((await jobById(user.id, queued.id))?.status, "running");
  await drain(user.id);
});

test("a job for a user without credits fails with a message and the next still starts", async () => {
  const { user, jobs } = await setup({ credits: 0 });
  const createdBefore = calls.filter((c) => c.method === "task.create").length;
  await dispatchRecreateQueue(user.id);
  // Three fail at once; the fourth is started after them and fails the same way.
  const failed = await withStatus(user.id, "failed", 4);
  for (const j of failed) assert.equal(j.error, LOW_CREDIT_MESSAGE);
  assert.equal(calls.filter((c) => c.method === "task.create").length, createdBefore, "no design agent task without credits");
  for (const j of jobs) assert.equal((await getCompetitor(j.competitorId))?.recreatedPage ?? null, null);
});

test("stopping a running job starts the next queued one", async () => {
  const { user } = await setup();
  await dispatchRecreateQueue(user.id);
  const running = await withStatus(user.id, "running", 3);
  const [queued] = await withStatus(user.id, "queued", 1);

  const first = running[0];
  const taskId = await taskOf(first.competitorId);
  await stopRecreateJob(first.id, user.id);
  assert.equal((await jobById(user.id, first.id))?.status, "stopped");
  assert.ok(calls.some((c) => c.method === "task.stop" && c.taskId === taskId), "the agent task is stopped");

  await taskOf(queued.competitorId);
  assert.equal((await jobById(user.id, queued.id))?.status, "running");
  await settle(150);
  // The stopped run settling later never overwrites the stop.
  const stopped = await jobById(user.id, first.id);
  assert.equal(stopped?.status, "stopped");
  assert.equal((await getCompetitor(first.competitorId))?.recreatedPage?.status, "failed");
  await drain(user.id);
});

/** What a created task was sent: the request and its brief.md attachment, decoded. */
function sentWith(taskId: string): string {
  const body = created.find((c) => c.taskId === taskId)?.body ?? {};
  const parts = (body.message as { content?: Array<{ filename?: string; file_data?: string }> } | undefined)?.content ?? [];
  const data = String(parts.find((p) => p.filename === "brief.md")?.file_data ?? "");
  const brief = Buffer.from(data.split(",")[1] ?? "", "base64").toString("utf8");
  assert.ok(brief.length > 0, "the brief went with the task");
  return `${JSON.stringify(body)}\n${brief}`;
}

test("each job builds for its own business website, not the one the run holds now", async () => {
  const { user, run, source } = await setup({ count: 0 });
  const add = async (businessUrl: string) => {
    const version = await createRecreationVersion(source);
    return jobsRepo.insertJob({
      ownerUserId: user.id,
      competitorId: version.id,
      runId: run.id,
      spaceId: null,
      options: { businessUrl, styleDirection: null, userFeedback: null, targetIcp: null },
    });
  };
  const first = await add("https://first-client.invalid");
  const second = await add("https://second-client.invalid");
  // A job without its own website (added before the field was used) builds for the run's, as before.
  const plain = await add("");
  await dispatchRecreateQueue(user.id);

  const expected: Array<[RecreateJob, string, RegExp[]]> = [
    [first, "https://first-client.invalid", [/second-client\.invalid/, /\/\/client\.invalid/]],
    [second, "https://second-client.invalid", [/first-client\.invalid/, /\/\/client\.invalid/]],
    [plain, "https://client.invalid", [/first-client\.invalid/, /second-client\.invalid/]],
  ];
  for (const [job, url, others] of expected) {
    const sent = sentWith(await taskOf(job.competitorId));
    assert.ok(sent.includes(url), `the task for ${url} names it`);
    for (const other of others) assert.doesNotMatch(sent, other);
    assert.equal((await getCompetitor(job.competitorId))?.recreatedPage?.businessUrl, url);
  }
  await drain(user.id);
});

/** The brief.md a created task was sent, decoded. */
function briefOf(taskId: string): string {
  const body = created.find((c) => c.taskId === taskId)?.body ?? {};
  const parts = (body.message as { content?: Array<{ filename?: string; file_data?: string }> } | undefined)?.content ?? [];
  const data = String(parts.find((p) => p.filename === "brief.md")?.file_data ?? "");
  return Buffer.from(data.split(",")[1] ?? "", "base64").toString("utf8");
}

function createCount(): number {
  return calls.filter((c) => c.method === "task.create").length;
}

/** A queued job for `businessUrl`: on a new version of `source`, or on the version `competitorId`. */
async function addJob(
  ctx: { user: { id: string }; run: SearchJob; source: CompetitorRecord },
  businessUrl: string,
  competitorId?: string,
): Promise<RecreateJob> {
  const id = competitorId ?? (await createRecreationVersion(ctx.source)).id;
  return jobsRepo.insertJob({
    ownerUserId: ctx.user.id,
    competitorId: id,
    runId: ctx.run.id,
    spaceId: null,
    options: { businessUrl, styleDirection: null, userFeedback: null, targetIcp: null },
  });
}

function jobEnded(userId: string, jobId: string, status: RecreateJob["status"]) {
  return waitFor(async () => {
    const j = await jobById(userId, jobId);
    return j?.status === status ? j : null;
  }, `job ${jobId} to be ${status}`);
}

test("sameWebsite ignores scheme, www., a trailing slash, query and fragment, but not the host or path", () => {
  assert.ok(sameWebsite("https://client.invalid", "http://www.CLIENT.invalid/"));
  assert.ok(sameWebsite("client.invalid/about/", "https://www.client.invalid/about?x=1#top"));
  assert.ok(!sameWebsite("https://client.invalid", "https://first-client.invalid"));
  assert.ok(!sameWebsite("https://client.invalid/a", "https://client.invalid/b"));
  assert.ok(!sameWebsite("", ""));
});

test("a job for another website builds with that website's own business, analysed once and reused", async () => {
  const ctx = await setup({ count: 0, profile: ORIGINAL });
  const before = analyzed.length;
  analyzeWith = async (url) => profileOf(url, "Newco Smiles", "#ABCDEF");
  try {
    const job = await addJob(ctx, "https://newco.invalid");
    await dispatchRecreateQueue(ctx.user.id);
    const first = await taskOf(job.competitorId);
    assert.deepEqual(analyzed.slice(before), ["https://newco.invalid"], "the website is analysed once");

    const sent = sentWith(first);
    assert.match(sent, /Newco Smiles/, "the brief names the new business");
    assert.match(sent, /#ABCDEF/, "with its colours");
    assert.match(sent, /Newco Smiles check-ups/, "and its services");
    assert.match(sent, /newco\.invalid\/logo\.png/, "and its logo");
    assert.doesNotMatch(sent, /Original Dental/);
    assert.doesNotMatch(sent, /#111111/);

    const version = await getCompetitor(job.competitorId);
    assert.equal(version?.recreateOnly?.businessProfile?.businessName, "Newco Smiles", "the profile is saved on the version");
    assert.equal(version?.recreatedPage?.businessName, "Newco Smiles");
    assert.equal(version?.recreatedPage?.brandColors.primary, "#ABCDEF");
    const search = await getJob(ctx.run.id);
    assert.equal(search?.businessProfile?.businessName, "Original Dental", "the search's business is untouched");
    assert.equal(search?.businessProfile?.brandColors?.primary, "#111111");

    taskState.set(first, "done");
    await jobEnded(ctx.user.id, job.id, "finished");

    // A second build of the same version (a retry) uses the saved profile and pays for no new analysis.
    const retry = await addJob(ctx, "http://www.newco.invalid/", job.competitorId);
    await dispatchRecreateQueue(ctx.user.id);
    const second = await waitFor(async () => {
      const id = (await getCompetitor(job.competitorId))?.recreatedPage?.manus?.taskId;
      return id && id !== first ? id : null;
    }, "the rebuild's task");
    assert.equal(analyzed.length - before, 1, "no second analysis");
    assert.match(briefOf(second), /Newco Smiles/);
    assert.doesNotMatch(briefOf(second), /Original Dental/);
    taskState.set(second, "done");
    await jobEnded(ctx.user.id, retry.id, "finished");
  } finally {
    analyzeWith = null;
  }
  await drain(ctx.user.id);
});

test("a job for the search's own website (any spelling) builds as before, with no website analysis", async () => {
  const ctx = await setup({ count: 0, profile: ORIGINAL });
  const before = analyzed.length;
  // "" is a job without its own website: it builds for the run's, exactly as before.
  const plain = await addJob(ctx, "");
  const same = await addJob(ctx, "https://client.invalid");
  const variant = await addJob(ctx, "http://www.Client.invalid/?utm_source=x#top");
  await dispatchRecreateQueue(ctx.user.id);
  const [plainTask, sameTask, variantTask] = [
    await taskOf(plain.competitorId),
    await taskOf(same.competitorId),
    await taskOf(variant.competitorId),
  ];
  assert.equal(analyzed.length, before, "nothing is analysed");
  assert.equal(briefOf(sameTask), briefOf(plainTask), "the brief is the one built today");
  for (const taskId of [plainTask, sameTask, variantTask]) {
    const brief = briefOf(taskId);
    assert.match(brief, /Original Dental/);
    assert.match(brief, /#111111/);
  }
  for (const job of [plain, same, variant]) {
    assert.equal((await getCompetitor(job.competitorId))?.recreateOnly?.businessProfile ?? null, null, "no profile is saved");
  }
  await drain(ctx.user.id);
});

test("a website that cannot be read fails the job with a clear message and builds nothing", async () => {
  const ctx = await setup({ count: 0, profile: ORIGINAL });
  const createsBefore = createCount();
  analyzeWith = async () => {
    throw new Error("Perplexity request failed: upstream exploded");
  };
  try {
    const job = await addJob(ctx, "https://www.broken.invalid/");
    await dispatchRecreateQueue(ctx.user.id);
    const failed = await jobEnded(ctx.user.id, job.id, "failed");
    assert.equal(failed.error, "Could not read the website broken.invalid. Check the address and try again.");
    assert.equal(createCount(), createsBefore, "no design agent task");
    const version = await getCompetitor(job.competitorId);
    assert.equal(version?.recreatedPage ?? null, null, "no page is written");
    assert.equal(version?.recreateOnly?.businessProfile ?? null, null);
    const search = await getJob(ctx.run.id);
    assert.equal(search?.businessProfile?.businessName, "Original Dental", "the search's business is untouched");
    assert.equal(search?.businessProfile?.url, "https://client.invalid");
  } finally {
    analyzeWith = null;
  }
  await drain(ctx.user.id);
});

test("running out of credits while reading the website fails the job as a credit error", async () => {
  const ctx = await setup({ count: 0, profile: ORIGINAL });
  const createsBefore = createCount();
  analyzeWith = async () => {
    throw new InsufficientCreditsError(100, 0);
  };
  try {
    const job = await addJob(ctx, "https://newco.invalid");
    await dispatchRecreateQueue(ctx.user.id);
    const failed = await jobEnded(ctx.user.id, job.id, "failed");
    assert.equal(failed.error, LOW_CREDIT_MESSAGE);
    assert.equal(createCount(), createsBefore);
    assert.equal((await getCompetitor(job.competitorId))?.recreatedPage ?? null, null);
  } finally {
    analyzeWith = null;
  }
  await drain(ctx.user.id);
});

test("a job stopped while its website is being read builds nothing", async () => {
  const ctx = await setup({ count: 0, profile: ORIGINAL });
  const createsBefore = createCount();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  analyzeWith = async (url) => {
    await gate;
    return profileOf(url, "Newco Smiles", "#ABCDEF");
  };
  try {
    const job = await addJob(ctx, "https://newco.invalid");
    const before = analyzed.length;
    await dispatchRecreateQueue(ctx.user.id);
    await waitFor(async () => analyzed.length > before, "the website analysis to start");
    await stopRecreateJob(job.id, ctx.user.id);
    release();
    await settle(300);
    assert.equal((await jobById(ctx.user.id, job.id))?.status, "stopped");
    assert.equal(createCount(), createsBefore, "no design agent task after the stop");
    assert.equal((await getCompetitor(job.competitorId))?.recreatedPage ?? null, null);
  } finally {
    release();
    analyzeWith = null;
  }
  await drain(ctx.user.id);
});

/** Sets the run's website as POST /api/recreate/jobs does when a job is added (the profile's own url is kept). */
async function addedWebsite(runId: string, website: string): Promise<void> {
  assert.equal(await saveRunBusinessUrl(runId, website, { fillProfileUrl: false }), true);
}

test("a run without a business profile: every job's website is analysed, whatever website the run holds now", async () => {
  const ctx = await setup({ count: 0 });
  const before = analyzed.length;
  // Adding a job saves its website on the run before the job starts.
  await addedWebsite(ctx.run.id, "https://site-a.invalid");
  const a = await addJob(ctx, "https://site-a.invalid");
  await dispatchRecreateQueue(ctx.user.id);
  const taskA = await taskOf(a.competitorId);
  assert.deepEqual(analyzed.slice(before), ["https://site-a.invalid"], "the first job's website is analysed");
  assert.match(briefOf(taskA), /Biz site-a/);

  await addedWebsite(ctx.run.id, "https://site-b.invalid");
  const b = await addJob(ctx, "https://site-b.invalid");
  await dispatchRecreateQueue(ctx.user.id);
  const taskB = await taskOf(b.competitorId);
  assert.deepEqual(analyzed.slice(before), ["https://site-a.invalid", "https://site-b.invalid"]);
  assert.match(briefOf(taskB), /Biz site-b/);
  assert.doesNotMatch(briefOf(taskB), /Biz site-a/);
  await drain(ctx.user.id);
});

test("a run whose business profile has no website: the job's website is analysed and the profile keeps no website", async () => {
  const ctx = await setup({ count: 0, profile: { ...ORIGINAL, url: "" } });
  const before = analyzed.length;
  await addedWebsite(ctx.run.id, "https://site-a.invalid");
  assert.equal((await getJob(ctx.run.id))?.businessProfile?.url, "", "the search's profile is not given the job's website");
  const a = await addJob(ctx, "https://site-a.invalid");
  await dispatchRecreateQueue(ctx.user.id);
  const brief = briefOf(await taskOf(a.competitorId));
  assert.deepEqual(analyzed.slice(before), ["https://site-a.invalid"]);
  assert.match(brief, /Biz site-a/);
  assert.doesNotMatch(brief, /Original Dental/);
  await drain(ctx.user.id);
});

test("saveRunBusinessUrl fills a profile without a website unless told not to", async () => {
  const ctx = await setup({ count: 0, profile: { ...ORIGINAL, url: "" } });
  await saveRunBusinessUrl(ctx.run.id, "https://site-a.invalid", { fillProfileUrl: false });
  assert.equal((await getJob(ctx.run.id))?.businessProfile?.url, "");
  assert.equal((await getJob(ctx.run.id))?.businessUrl, "https://site-a.invalid");
  await saveRunBusinessUrl(ctx.run.id, "https://site-b.invalid");
  assert.equal((await getJob(ctx.run.id))?.businessProfile?.url, "https://site-b.invalid", "the set_business_url action keeps filling it");
});

test("a website whose brand colours cannot be read fails the job and saves no profile", async () => {
  const ctx = await setup({ count: 0, profile: ORIGINAL });
  const createsBefore = createCount();
  analyzeWith = async (url) => ({ ...profileOf(url, "Newco Smiles", "#ABCDEF"), brandColors: null, brandAssets: null });
  try {
    const job = await addJob(ctx, "https://newco.invalid");
    await dispatchRecreateQueue(ctx.user.id);
    const failed = await jobEnded(ctx.user.id, job.id, "failed");
    assert.equal(failed.error, "Could not read the brand colours of the website newco.invalid. Check the address and try again.");
    assert.equal(createCount(), createsBefore, "no design agent task");
    const version = await getCompetitor(job.competitorId);
    assert.equal(version?.recreatedPage ?? null, null);
    assert.equal(version?.recreateOnly?.businessProfile ?? null, null, "a profile without colours is not kept");
  } finally {
    analyzeWith = null;
  }
  await drain(ctx.user.id);
});

test("a setup problem with the analysis shows its own message, not 'could not read the website'", async () => {
  const ctx = await setup({ count: 0, profile: ORIGINAL });
  analyzeWith = async () => {
    throw new Error("OPENROUTER_API_KEY is not set");
  };
  try {
    const job = await addJob(ctx, "https://newco.invalid");
    await dispatchRecreateQueue(ctx.user.id);
    const failed = await jobEnded(ctx.user.id, job.id, "failed");
    assert.equal(failed.error, "URL analysis is not configured. Please contact support.");
  } finally {
    analyzeWith = null;
  }
  await drain(ctx.user.id);
});

test("a rebuild of a version for the search's own website drops the version's other business", async () => {
  const ctx = await setup({ count: 0, profile: ORIGINAL });
  analyzeWith = async (url) => profileOf(url, "Newco Smiles", "#ABCDEF");
  try {
    const job = await addJob(ctx, "https://newco.invalid");
    await dispatchRecreateQueue(ctx.user.id);
    const first = await taskOf(job.competitorId);
    taskState.set(first, "done");
    await jobEnded(ctx.user.id, job.id, "finished");

    const before = analyzed.length;
    const own = await addJob(ctx, "https://client.invalid", job.competitorId);
    await dispatchRecreateQueue(ctx.user.id);
    const second = await waitFor(async () => {
      const id = (await getCompetitor(job.competitorId))?.recreatedPage?.manus?.taskId;
      return id && id !== first ? id : null;
    }, "the rebuild's task");
    assert.equal(analyzed.length, before);
    assert.match(briefOf(second), /Original Dental/);
    assert.equal((await getCompetitor(job.competitorId))?.recreateOnly?.businessProfile ?? null, null, "the other business is dropped");
    taskState.set(second, "done");
    await jobEnded(ctx.user.id, own.id, "finished");

    // A later change that has to rebuild stays on the search's own website.
    failSend = true;
    const editing = editManusRecreation(job.competitorId, "Make the headline bigger");
    const third = await waitFor(async () => {
      const id = (await getCompetitor(job.competitorId))?.recreatedPage?.manus?.taskId;
      return id && id !== second ? id : null;
    }, "the change's build");
    failSend = false;
    assert.match(briefOf(third), /Original Dental/);
    assert.doesNotMatch(briefOf(third), /Newco Smiles/);
    taskState.set(third, "done");
    await editing;
  } finally {
    failSend = false;
    analyzeWith = null;
  }
  await drain(ctx.user.id);
});

test("a change to a version rebuilds for the version's website, not one a later job saved on the run", async () => {
  const ctx = await setup({ count: 0, profile: ORIGINAL });
  try {
    const job = await addJob(ctx, "https://client.invalid");
    await dispatchRecreateQueue(ctx.user.id);
    const first = await taskOf(job.competitorId);
    taskState.set(first, "done");
    await jobEnded(ctx.user.id, job.id, "finished");
    // A later job for another website was added: the run now holds that website.
    await addedWebsite(ctx.run.id, "https://later.invalid");

    const before = analyzed.length;
    failSend = true;
    const editing = editManusRecreation(job.competitorId, "Make the headline bigger");
    const second = await waitFor(async () => {
      const id = (await getCompetitor(job.competitorId))?.recreatedPage?.manus?.taskId;
      return id && id !== first ? id : null;
    }, "the change's build");
    failSend = false;
    assert.equal(analyzed.length, before, "nothing is analysed");
    const brief = briefOf(second);
    assert.match(brief, /Original Dental/);
    assert.doesNotMatch(brief, /later\.invalid/);
    assert.equal((await getCompetitor(job.competitorId))?.recreatedPage?.businessUrl, "https://client.invalid");
    taskState.set(second, "done");
    await editing;
  } finally {
    failSend = false;
  }
  await drain(ctx.user.id);
});

test("changes to a version built for another website keep its website and business", async () => {
  const ctx = await setup({ count: 0, profile: ORIGINAL });
  analyzeWith = async (url) => profileOf(url, "Newco Smiles", "#ABCDEF");
  try {
    const job = await addJob(ctx, "https://newco.invalid");
    await dispatchRecreateQueue(ctx.user.id);
    const first = await taskOf(job.competitorId);
    // What the agent's questions are answered from, also after a restart (resume), names the version's business.
    const state = (await getCompetitor(job.competitorId))?.recreatedPage?.manus;
    assert.match(state?.answerContext || "", /Newco Smiles/);
    assert.match(state?.answerContext || "", /newco\.invalid/);
    assert.doesNotMatch(state?.answerContext || "", /Original Dental/);
    taskState.set(first, "done");
    await jobEnded(ctx.user.id, job.id, "finished");

    // The task can no longer be continued, so the change is made by a new build.
    const before = analyzed.length;
    failSend = true;
    const editing = editManusRecreation(job.competitorId, "Make the headline bigger");
    const second = await waitFor(async () => {
      const id = (await getCompetitor(job.competitorId))?.recreatedPage?.manus?.taskId;
      return id && id !== first ? id : null;
    }, "the change's build");
    failSend = false;
    assert.equal(analyzed.length, before, "the saved profile is used");
    const brief = briefOf(second);
    assert.match(brief, /Newco Smiles/);
    assert.match(brief, /https:\/\/newco\.invalid/);
    assert.doesNotMatch(brief, /Original Dental/);
    assert.doesNotMatch(brief, /\/\/client\.invalid/);
    assert.equal((await getCompetitor(job.competitorId))?.recreatedPage?.businessUrl, "https://newco.invalid");
    taskState.set(second, "done");
    await editing;
  } finally {
    failSend = false;
    analyzeWith = null;
  }
  await drain(ctx.user.id);
});

test("removing a queued job deletes its empty version", async () => {
  const { user, source } = await setup();
  await dispatchRecreateQueue(user.id);
  await withStatus(user.id, "running", 3);
  const [queued] = await withStatus(user.id, "queued", 1);

  await assert.rejects(stopRecreateJob(queued.id, "someone-else"));
  assert.ok(await getCompetitor(queued.competitorId), "another user cannot remove it");

  await stopRecreateJob(queued.id, user.id);
  assert.equal(await jobById(user.id, queued.id), undefined);
  assert.equal(await getCompetitor(queued.competitorId), null, "the empty version is deleted");

  // Only an empty version can be deleted this way.
  assert.equal(await deleteCompetitor(source.id), false);
  assert.ok(await getCompetitor(source.id));
  await drain(user.id);
});

test("deleteCompetitor leaves a version that holds a page", async () => {
  const { user, jobs } = await setup({ count: 1 });
  const [job] = jobs;
  await updateCompetitor(job.competitorId, { recreatedPage: manusPage("T-has-page", "completed") });
  assert.equal(await deleteCompetitor(job.competitorId), false);
  assert.ok(await getCompetitor(job.competitorId));
  await jobsRepo.finishJob(job.id, "finished");
  await drain(user.id);
});

function manusPage(taskId: string, status: RecreatedLandingPage["status"] = "pending"): RecreatedPageLight {
  const now = new Date().toISOString();
  return {
    status,
    createdAt: now,
    updatedAt: now,
    businessUrl: "https://client.invalid",
    keyword: "dentist",
    sourceCompetitorName: "Rival Clinic",
    sourceAnalyzedUrl: "https://rival.invalid/offer",
    brandColors: { primary: "#000", secondary: "#111", accent: "#222", background: "#fff", text: "#000" },
    pipelineVersion: "manus-1",
    error: null,
    manus: {
      taskId,
      taskUrl: null,
      mode: "build",
      turnStartedAt: 0,
      startedAt: now,
      questions: [],
      handledEventIds: [],
      nudges: 0,
    },
    progress: { phase: "build", message: "Working", pct: 40 },
  } as unknown as RecreatedPageLight;
}

async function markRunning(jobId: string): Promise<void> {
  await getDb().query("update recreate_jobs set status = 'running', started_at = now() where id = $1", [jobId]);
}

test("sweep restarts the queue after a simulated restart (in-memory state cleared)", async () => {
  // Rows as a previous process left them: nothing of them is in this process's memory.
  const { user, jobs } = await setup({ count: 4 });
  const [resumed, settledWhileDown, neverStarted, queued] = jobs;
  await markRunning(resumed.id);
  await markRunning(settledWhileDown.id);
  await markRunning(neverStarted.id);
  taskState.set("T-sweep-resume", "running");
  await updateCompetitor(resumed.competitorId, { recreatedPage: manusPage("T-sweep-resume") });
  await updateCompetitor(settledWhileDown.competitorId, { recreatedPage: manusPage("T-sweep-done", "completed") });

  await sweepRecreateQueue();

  // The page that finished while the server was down is recorded.
  assert.equal((await jobById(user.id, settledWhileDown.id))?.status, "finished");
  // The running build is followed again.
  await waitFor(async () => calls.some((c) => c.method === "task.listMessages" && c.taskId === "T-sweep-resume"), "the resumed task to be polled");
  // The job that never reached the agent, and the queued one, start.
  await taskOf(neverStarted.competitorId);
  await taskOf(queued.competitorId);
  assert.equal((await jobById(user.id, queued.id))?.status, "running");
  assert.equal((await jobById(user.id, resumed.id))?.status, "running");

  // The resumed build finishing is recorded without any browser asking.
  taskState.set("T-sweep-resume", "done");
  await waitFor(async () => (await jobById(user.id, resumed.id))?.status === "finished", "the resumed job to finish");
  await drain(user.id);
});

test("a job refused for too many running builds goes back to the queue and starts later", async () => {
  const { user, jobs } = await setup({ count: 1 });
  // Three builds started outside the queue hold every recreate slot.
  const holds = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await reserveCredits({
      userId: user.id,
      amountSubunits: creditsToSubunits(1),
      operation: RECREATE_BUILD_OPERATION,
      maxOpenReservations: 3,
      scope: "recreate",
    });
    assert.ok(r.ok);
    holds.push(r.reservation.id);
  }
  await dispatchRecreateQueue(user.id);
  await settle(200);
  const job = await jobById(user.id, jobs[0].id);
  assert.notEqual(job?.status, "failed", "a full set of slots is not a failure");
  assert.equal((await getCompetitor(jobs[0].competitorId))?.recreatedPage ?? null, null);

  await releaseReservation(holds[0], "test", "settled");
  await taskOf(jobs[0].competitorId);
  assert.equal((await jobById(user.id, jobs[0].id))?.status, "running");
  for (const id of holds.slice(1)) await releaseReservation(id, "test", "settled");
  await drain(user.id);
});

/*
 * Next.js can load a module more than once (instrumentation and route
 * handlers). A cache-busting specifier gives a second, separate copy here.
 */
function secondCopy(file: string): string {
  return `../src/lib/pipeline/${file}?instance=2`;
}

test("a second copy of the queue module sees the jobs the first is running", async () => {
  const { user, jobs } = await setup({ count: 1 });
  const [job] = jobs;
  let release!: () => void;
  holdCreate = new Promise<void>((resolve) => (release = resolve));
  const createsBefore = calls.filter((c) => c.method === "task.create").length;
  try {
    await dispatchRecreateQueue(user.id);
    // The build is held just before it reaches the agent: a pending page with no task yet.
    await waitFor(async () => (await getCompetitor(job.competitorId))?.recreatedPage?.status === "pending", "the build to start");
    const startedAt = (await jobById(user.id, job.id))?.startedAt;
    const state = (globalThis as Record<string, unknown>)[RECREATE_QUEUE_STATE_KEY] as { inFlight: Set<string> };
    assert.ok(state?.inFlight.has(job.id), "the job is tracked on globalThis");

    const other = (await import(secondCopy("recreateQueue.ts"))) as typeof import("../src/lib/pipeline/recreateQueue");
    assert.notEqual(other.sweepRecreateQueue, sweepRecreateQueue, "a separate module copy");
    await other.sweepRecreateQueue(user.id);
    const after = await jobById(user.id, job.id);
    assert.equal(after?.status, "running");
    assert.equal(after?.startedAt, startedAt, "the other copy did not requeue and restart it");
  } finally {
    holdCreate = null;
    release();
  }
  await taskOf(job.competitorId);
  await settle(100);
  assert.equal(calls.filter((c) => c.method === "task.create").length - createsBefore, 1, "one build, not two");
  await drain(user.id);
});

test("a stop from a second copy of the pipeline module aborts a run the first follows", async () => {
  const { user, jobs } = await setup({ count: 1 });
  const [job] = jobs;
  assert.equal(await jobsRepo.removeQueued(job.id, user.id), true);
  taskState.set("T-shared-stop", "running");
  await updateCompetitor(job.competitorId, { recreatedPage: manusPage("T-shared-stop") });
  const polls = () => calls.filter((c) => c.method === "task.listMessages" && c.taskId === "T-shared-stop").length;

  await resumeManusRecreation(job.competitorId);
  await waitFor(async () => polls() > 0, "the run to be followed");
  const otherRun = (await import(secondCopy("manus/run.ts"))) as typeof import("../src/lib/pipeline/manus/run");
  await otherRun.stopManusRecreation(job.competitorId, "Stopped by user");
  await settle(100);
  const afterStop = polls();
  await settle(200);
  assert.equal(polls(), afterStop, "the followed run stopped polling");
  assert.equal((await getCompetitor(job.competitorId))?.recreatedPage?.error, "Stopped by user");
});

test("a resumed build is not taken for dead before the agent's own time limit", () => {
  const saved = process.env.MANUS_TIMEOUT_MINUTES;
  try {
    delete process.env.MANUS_TIMEOUT_MINUTES;
    assert.ok(resumedBuildStaleMs() > 90 * 60_000, "longer than the default 90-minute limit");
    process.env.MANUS_TIMEOUT_MINUTES = "120";
    assert.ok(resumedBuildStaleMs() > 120 * 60_000, "follows MANUS_TIMEOUT_MINUTES");
    assert.ok(resumedBuildStaleMs() <= 130 * 60_000, "with only a small margin");
  } finally {
    if (saved === undefined) delete process.env.MANUS_TIMEOUT_MINUTES;
    else process.env.MANUS_TIMEOUT_MINUTES = saved;
  }
});

const { createPeriodicSweep, recreateSweepMs, startPeriodicRecreateSweep, stopPeriodicRecreateSweep } = await import(
  "@/lib/pipeline/recreateQueue"
);

function fakeInterval() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      timers.set(next, { fn, ms });
      return next++;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
  };
}

test("the periodic sweep starts once, never overlaps itself, and stops", async () => {
  const clock = fakeInterval();
  let calls = 0;
  let release: () => void = () => {};
  const sweep = createPeriodicSweep({
    everyMs: 1000,
    sweep: () => {
      calls += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  assert.equal(sweep.start(), true);
  assert.equal(sweep.start(), false, "a second start is refused");
  assert.equal(clock.timers.size, 1, "one timer");
  assert.equal([...clock.timers.values()][0].ms, 1000);

  const first = sweep.tick();
  assert.equal(await sweep.tick(), false, "a tick while one is running is skipped");
  assert.equal(calls, 1);
  release();
  assert.equal(await first, true);
  const second = sweep.tick();
  release();
  assert.equal(await second, true, "the next tick runs once the first finished");
  assert.equal(calls, 2);

  sweep.stop();
  assert.equal(clock.timers.size, 0, "stop clears the timer");
  assert.equal(await sweep.tick(), false, "nothing runs after stop");
});

test("a failing sweep is logged and the next tick still runs", async () => {
  const errors: unknown[] = [];
  let calls = 0;
  const sweep = createPeriodicSweep({
    everyMs: 10,
    sweep: async () => {
      calls += 1;
      if (calls === 1) throw new Error("db down");
    },
    onError: (err) => errors.push(err),
    setTimer: fakeInterval().setTimer,
    clearTimer: () => {},
  });
  sweep.start();
  assert.equal(await sweep.tick(), true);
  assert.equal(errors.length, 1);
  assert.equal(await sweep.tick(), true);
  assert.equal(calls, 2);
  sweep.stop();
});

test("the process-wide periodic sweep is started once and can be stopped", () => {
  const saved = process.env.RECREATE_QUEUE_SWEEP_MS;
  try {
    delete process.env.RECREATE_QUEUE_SWEEP_MS;
    assert.equal(recreateSweepMs(), 3 * 60_000, "every three minutes by default");
    process.env.RECREATE_QUEUE_SWEEP_MS = "60000";
    assert.equal(recreateSweepMs(), 60_000);
    process.env.RECREATE_QUEUE_SWEEP_MS = "nonsense";
    assert.equal(recreateSweepMs(), 3 * 60_000);
    assert.equal(startPeriodicRecreateSweep(), true);
    assert.equal(startPeriodicRecreateSweep(), false, "started twice: the second is refused");
  } finally {
    stopPeriodicRecreateSweep();
    if (saved === undefined) delete process.env.RECREATE_QUEUE_SWEEP_MS;
    else process.env.RECREATE_QUEUE_SWEEP_MS = saved;
  }
  assert.equal(startPeriodicRecreateSweep(), true, "can start again after a stop");
  stopPeriodicRecreateSweep();
});
