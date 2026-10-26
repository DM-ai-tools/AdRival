import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { setClientForTests, type Queryable, type TestClient } from "../src/lib/data/client";
import { migrate } from "../src/lib/data/migrate";
import { ArchivedPageUnavailableError } from "../src/lib/data/archive";
import * as competitors from "../src/lib/data/competitors";
import * as runs from "../src/lib/data/runs";
import {
  editManusRecreation,
  resumeManusRecreation,
  runManusRecreation,
  stopManusRecreation,
} from "../src/lib/pipeline/manus/run";
import type { CompetitorRecord, RecreatedLandingPage, RecreatedPageLight, SearchJob } from "../src/lib/types";
import { createPgliteClient, type PgliteTestClient } from "./helpers/testDb";

/*
 * Async ordering in the Manus recreation run (the Manus API is faked; no
 * provider is reached): a rebuild that fails before it starts leaves the
 * running build alone, and a failure recording credits after a run never
 * replaces the run's own result.
 */

process.env.MANUS_API_KEY = "test-key";
process.env.MANUS_POLL_MS = "10";
process.env.MANUS_PROJECT_ID = "test-project";
process.env.MANUS_CONNECTORS = "";
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;

let base: PgliteTestClient;
/** While set, reading a search job fails (recordCredits reads the run's owner). */
let failJobReads = false;

function failingQueryable(q: Queryable): Queryable {
  return {
    query<R = Record<string, unknown>>(text: string, params?: unknown[]) {
      if (failJobReads && /^select data from jobs where id = \$1$/.test(text.trim())) {
        return Promise.reject(new Error("job read failed"));
      }
      return q.query<R>(text, params);
    },
  };
}

type Call = { method: string; body: Record<string, unknown> | null };
const calls: Call[] = [];
/** What the faked task reports when polled. */
let agentStatus: "running" | "error" = "running";
const realFetch = globalThis.fetch;

function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = url.pathname.replace("/v2/", "");
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  calls.push({ method, body });
  const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
  if (method === "task.listMessages") {
    const at = Date.now() + 60_000;
    const messages =
      agentStatus === "error"
        ? [
            { id: `s${at}`, type: "status_update", timestamp: at, status_update: { agent_status: "error" } },
            { id: `e${at}`, type: "error_message", timestamp: at, error_message: { content: "agent broke" } },
          ]
        : [{ id: `s${at}`, type: "status_update", timestamp: at, status_update: { agent_status: "running" } }];
    return json({ ok: true, messages });
  }
  if (method === "task.detail") return json({ ok: true, task: { id: "T", status: "running", credit_usage: 0 } });
  return json({ ok: true });
}

before(async () => {
  base = await createPgliteClient();
  await migrate(base);
  const client: TestClient = {
    ...failingQueryable(base),
    tx: (fn) => base.tx((t) => fn(failingQueryable(t))),
  };
  setClientForTests(client);
  globalThis.fetch = fakeFetch as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  setClientForTests(null);
  await base.close();
});

let seq = 0;

function manusPage(taskId: string): RecreatedLandingPage {
  const now = new Date().toISOString();
  return {
    status: "pending",
    createdAt: now,
    updatedAt: now,
    businessUrl: "https://client.invalid",
    keyword: "dentist",
    sourceCompetitorName: "Rival Clinic",
    sourceAnalyzedUrl: "https://rival.invalid",
    brandColors: { primary: "#000", secondary: "#111", accent: "#222", background: "#fff", text: "#000" },
    pipelineVersion: "manus-1",
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
  } as unknown as RecreatedLandingPage;
}

async function savedCompetitor(page: RecreatedLandingPage, html?: string): Promise<CompetitorRecord> {
  seq += 1;
  const at = new Date().toISOString();
  const job: SearchJob = {
    id: `mra-job-${seq}`,
    keyword: "dentist",
    keywords: ["dentist"],
    platform: "facebook",
    geo: "AU",
    countries: ["AU"],
    status: "completed",
    progress: { stage: "done", scannedAds: 0, scannedPages: 0, accepted: 1, target: 10, rejected: 0, message: "" },
    competitorIds: [],
    businessUrl: "https://client.invalid",
    ownerUserId: "owner-1",
    createdAt: at,
    updatedAt: at,
  };
  assert.equal(await runs.saveJob(job), true);
  const competitor = {
    id: `mra-comp-${seq}`,
    runId: job.id,
    pageId: `mra-page-${seq}`,
    pageName: "Rival Clinic",
    country: "AU",
    platform: "facebook",
    activeAdsCount: 3,
    services: [],
    sampleAd: { adArchiveId: "a", title: "t", body: "b", daysRunning: 3, adLibraryUrl: "https://x.invalid" },
    brand: {},
    pageAnalysis: { status: "completed", analyzedUrl: "https://rival.invalid", analyzedAt: at },
    recreatedPage: page as unknown as RecreatedPageLight,
    createdAt: at,
  } as CompetitorRecord;
  const saved = await competitors.saveCompetitor(
    html === undefined ? competitor : { ...competitor, recreatedPageHeavy: { html } },
  );
  assert.equal(saved, true);
  return competitor;
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

test("a rebuild that fails reading the old page leaves the running build alone", async () => {
  const c = await savedCompetitor(manusPage("T-running"));
  // Content archived to Storage that cannot be read: getRecreatedPage throws.
  await base.query(
    "insert into recreated_pages (competitor_id, archive_path, archived_at, bytes) values ($1, 'pages/x.gz', now(), 10)",
    [c.id],
  );
  agentStatus = "running";
  await resumeManusRecreation(c.id);
  await settle();
  calls.length = 0;

  await assert.rejects(runManusRecreation(c.id), ArchivedPageUnavailableError);
  assert.deepEqual(
    calls.filter((x) => x.method === "task.stop"),
    [],
    "the running task must not be stopped",
  );
  const pollsBefore = calls.filter((x) => x.method === "task.listMessages").length;
  await settle();
  const pollsAfter = calls.filter((x) => x.method === "task.listMessages").length;
  assert.ok(pollsAfter > pollsBefore, "the running build keeps following its task");

  await stopManusRecreation(c.id).catch(() => undefined);
});

test("a failure recording credits does not replace an edit's result", async () => {
  const c = await savedCompetitor({ ...manusPage("T-edit"), status: "completed" }, "<html><body><h1>Built</h1></body></html>");
  agentStatus = "error";
  failJobReads = true;
  try {
    const result = await editManusRecreation(c.id, "Make the headline bigger");
    assert.equal(result.id, c.id);
    assert.match(result.recreatedPage?.error || "", /agent broke/);
  } finally {
    failJobReads = false;
    agentStatus = "running";
  }
});

test("a failure recording credits after a resumed run is logged, not an unhandled rejection", async () => {
  const c = await savedCompetitor(manusPage("T-resume"));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  agentStatus = "error";
  failJobReads = true;
  try {
    await resumeManusRecreation(c.id);
    for (let i = 0; i < 50; i += 1) {
      await settle(20);
      if ((await competitors.getCompetitor(c.id))?.recreatedPage?.status === "failed") break;
    }
    await settle();
    assert.equal((await competitors.getCompetitor(c.id))?.recreatedPage?.status, "failed");
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    failJobReads = false;
    agentStatus = "running";
  }
});

/** Marks the page's content as archived to Storage that cannot be read (no Storage configured here). */
async function archiveUnreadable(competitorId: string, hasPage: boolean): Promise<void> {
  await base.query(
    `insert into recreated_pages (competitor_id, archive_path, archived_at, bytes) values ($1, 'recreated-pages-archive/gone.json.gz', now(), 10)
     on conflict (competitor_id) do update set content = null, archive_path = excluded.archive_path, archived_at = now()`,
    [competitorId],
  );
  await base.query(
    "update competitors set data = jsonb_set(data, '{recreatedPage,hasPage}', $2::jsonb) where id = $1",
    [competitorId, JSON.stringify(hasPage)],
  );
}

test("a run failure is recorded even when the archived page cannot be read (falls back to the marker)", async () => {
  const c = await savedCompetitor(manusPage("T-fail-archived"));
  await archiveUnreadable(c.id, true);
  agentStatus = "error";
  try {
    await resumeManusRecreation(c.id);
    let page: RecreatedPageLight | null | undefined;
    for (let i = 0; i < 50; i += 1) {
      await settle(20);
      page = (await competitors.getCompetitor(c.id))?.recreatedPage;
      if (page?.error) break;
    }
    assert.match(page?.error || "", /agent broke/);
    // The marker says a page exists, so the earlier page stays shown.
    assert.equal(page?.status, "completed");
  } finally {
    agentStatus = "running";
  }
});

test("stop is recorded even when the archived page cannot be read", async () => {
  const c = await savedCompetitor(manusPage("T-stop-archived"));
  await archiveUnreadable(c.id, false);
  const stopped = await stopManusRecreation(c.id, "Stopped by user");
  assert.equal(stopped.recreatedPage?.status, "failed");
  assert.equal(stopped.recreatedPage?.error, "Stopped by user");

  const kept = await savedCompetitor(manusPage("T-stop-archived-kept"));
  await archiveUnreadable(kept.id, true);
  const stoppedKept = await stopManusRecreation(kept.id, "Stopped by user");
  assert.equal(stoppedKept.recreatedPage?.status, "completed");
});
