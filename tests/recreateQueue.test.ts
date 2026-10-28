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
const calls: Array<{ method: string; taskId: string }> = [];
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
    taskSeq += 1;
    const id = `T-${taskSeq}`;
    taskState.set(id, "running");
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
const { dispatchRecreateQueue, stopRecreateJob, sweepRecreateQueue } = await import("@/lib/pipeline/recreateQueue");
import type { CompetitorRecord, RecreatedLandingPage, RecreatedPageLight, SearchJob } from "@/lib/types";
import type { RecreateJob } from "@/lib/data/recreateJobs";

after(async () => {
  failAll = true;
  // Let every run still going see the error and end before the database closes.
  await waitFor(async () => ((await jobsRepo.listRunning()).length === 0 ? true : null), "all runs ended", 10_000).catch(
    () => undefined,
  );
  await settle(100);
  globalThis.fetch = realFetch;
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
async function setup(options: { credits?: number; count?: number } = {}) {
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
