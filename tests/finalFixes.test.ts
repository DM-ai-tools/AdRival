import assert from "node:assert/strict";
import { after, test } from "node:test";
import { useTempStore } from "./helpers/store";

const store = await useTempStore("final-fixes");
after(() => store.cleanup());
process.env.MANUS_API_KEY = "test-key";
process.env.MANUS_POLL_MS = "10";
process.env.MANUS_PROJECT_NAME = "redeisgn pipeline";
delete process.env.MANUS_PROJECT_ID;

import { analyzeLevels } from "../src/lib/pipeline/awareness/levelAgents";
import type { JsonCaller } from "../src/lib/pipeline/llmJson";
import { InsufficientCreditsError } from "../src/lib/accounting/errors";
import { inFlightKey, stageInFlight, tryAddInFlight } from "../src/lib/pipeline/awareness/inFlight";

const visibleText = "Tired of wasting money on ads that never convert? Start your free trial today.";
const base = {
  headingOutline: [{ level: 1, text: "Stop wasting ad spend", snippet: "Tired" }],
  heroCandidates: ["Stop wasting ad spend"],
  visibleText,
};
const audienceOk = JSON.stringify({
  audienceLevel: "newbie",
  reason: "Plain.",
  evidence: "Tired of wasting money on ads that never convert",
});
const awarenessOk = JSON.stringify({
  awarenessStage: "problem_aware",
  awarenessFocus: "only_problem",
  reason: "Pain first.",
  evidence: "wasting money on ads that never convert",
  blocks: [],
});

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const err = console.error;
  const warn = console.warn;
  const info = console.info;
  console.error = () => undefined;
  console.warn = () => undefined;
  console.info = () => undefined;
  return fn().finally(() => {
    console.error = err;
    console.warn = warn;
    console.info = info;
  });
}

// Finding 1
test("a total level-agent outage rejects with a plain error", async () => {
  const call: JsonCaller = async () => {
    throw new Error("provider down");
  };
  await quiet(async () => {
    await assert.rejects(analyzeLevels({ ...base, call }), (e: unknown) => {
      return e instanceof Error && !(e instanceof InsufficientCreditsError);
    });
  });
});

test("through runWithLevels an outage leaves levels null", async () => {
  const { runWithLevels } = await import("../src/lib/pipeline/landingPageAnalysis");
  const call: JsonCaller = async () => {
    throw new Error("provider down");
  };
  const r = await quiet(() => runWithLevels(async () => "x", () => analyzeLevels({ ...base, call })));
  assert.deepEqual(r, { extracted: "x", levels: null });
});

test("an audience-only failure keeps the awareness labels", async () => {
  const call: JsonCaller = async (system) => {
    if (/audience/i.test(system.slice(0, 200))) throw new Error("audience agent down");
    return awarenessOk;
  };
  const r = await quiet(() => analyzeLevels({ ...base, call }));
  assert.equal(r.levels.awarenessStage, "problem_aware");
  assert.equal(r.levels.audienceLevel, "unclear");
});

test("an awareness-only failure still rejects", async () => {
  const call: JsonCaller = async (system) => {
    if (/audience/i.test(system.slice(0, 200))) return audienceOk;
    throw new Error("awareness agent down");
  };
  await quiet(async () => {
    await assert.rejects(analyzeLevels({ ...base, call }), /Awareness agent failed/);
  });
});

test("a credit error from the caller is rethrown unchanged", async () => {
  const credit = new InsufficientCreditsError(1, 0);
  const call: JsonCaller = async () => {
    throw credit;
  };
  await assert.rejects(analyzeLevels({ ...base, call }), (e: unknown) => e === credit);
});

// Finding 2
test("levels are written only when the stored analysis is still the one we read", async () => {
  const { shouldWriteLevels } = await import("../src/lib/pipeline/landingPageAnalysis");
  const before = { status: "completed", analyzedAt: "t1" };
  assert.equal(shouldWriteLevels({ before, current: { status: "completed", analyzedAt: "t1" } }), true);
  assert.equal(shouldWriteLevels({ before, current: { status: "completed", analyzedAt: "t2" } }), false);
  assert.equal(shouldWriteLevels({ before, current: { status: "pending", analyzedAt: "t1" } }), false);
  assert.equal(shouldWriteLevels({ before, current: null }), false);
});

test("an already labelled page returns without a fetch or model call", async () => {
  const { updateCompetitor, saveJob } = await import("../src/lib/db");
  const { makeSearchProject, makeCompetitor } = await import("./helpers/factories");
  const { labelCompetitorLevels } = await import("../src/lib/pipeline/landingPageAnalysis");
  const job = await makeSearchProject({ keyword: "dentist" });
  await saveJob(job);
  const c = await makeCompetitor({ runId: job.id, pageName: "Labelled" });
  await updateCompetitor(c.id, {
    pageAnalysis: {
      status: "completed",
      analyzedUrl: "https://labelled.example",
      analyzedAt: "t1",
      levels: { audienceLevel: "newbie", awarenessStage: "unaware" } as never,
    },
  });
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("network must not be used");
  }) as typeof fetch;
  try {
    const r = await labelCompetitorLevels(c.id);
    assert.equal(r.pageAnalysis?.levels?.awarenessStage, "unaware");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Finding 3
test("an in-flight ICP key survives a source switch and only its owner removes it", () => {
  const set = new Set<string>();
  const A = { kind: "search", id: "run-a" };
  const B = { kind: "search", id: "run-b" };
  assert.equal(tryAddInFlight(set, inFlightKey(A, "unaware")), true);
  assert.equal(stageInFlight(set, A), "unaware");
  // Switching to B shows nothing running there, and A's key is untouched.
  assert.equal(stageInFlight(set, B), null);
  assert.equal(set.has(inFlightKey(A, "unaware")), true);
  // Back on A, a second click for the same stage is refused.
  assert.equal(stageInFlight(set, A), "unaware");
  assert.equal(tryAddInFlight(set, inFlightKey(A, "unaware")), false);
  // A request on B owns its own key; finishing it does not clear A's.
  assert.equal(tryAddInFlight(set, inFlightKey(B, "unaware")), true);
  set.delete(inFlightKey(B, "unaware"));
  assert.equal(stageInFlight(set, A), "unaware");
  set.delete(inFlightKey(A, "unaware"));
  assert.equal(stageInFlight(set, A), null);
});

// Finding 5
test("level agents run for standalone and internal (search offers) lookups alike", async () => {
  const mod = (await import("../src/lib/pipeline/landingPageAnalysis")) as Record<string, unknown>;
  // The internalOnly skip was reversed: offers pages are listed and labelled in the A/B tab.
  assert.equal(mod.shouldLabelLevels, undefined);
});

// Finding 4
function icp(id: string, runId: string, stage: "problem_aware" | "unaware") {
  return {
    id,
    source: { kind: "search" as const, id: runId },
    stage,
    createdAt: new Date().toISOString(),
    painPoints: ["Leads dry up"],
    demographics: { ageRange: null, role: null, budget: null, location: null, other: null },
    psychographics: [],
    saysOutLoud: ["Where did my money go"],
    interests: [],
    hopesAndDesires: [],
    stageNotes: "Knows the pain.",
    suggestedAngle: "Lead with the wasted spend.",
  };
}

async function recreateSetup() {
  const { saveJob, updateCompetitor } = await import("../src/lib/db");
  const { makeSearchProject, makeCompetitor } = await import("./helpers/factories");
  const job = await makeSearchProject({ keyword: "dentist" });
  await saveJob({
    ...job,
    businessUrl: "https://brightdental.example",
    businessProfile: {
      url: "https://brightdental.example",
      businessName: "Bright Dental",
      industry: "Dental",
      description: "Family dentist.",
      offerings: ["Check-ups"],
      competitorKeywords: ["dentist"],
      positioningSummary: "Gentle.",
      categories: [],
      locations: [],
      analyzedAt: new Date().toISOString(),
    } as never,
  });
  const c = await makeCompetitor({ runId: job.id, pageName: "Rival Clinic" });
  await updateCompetitor(c.id, {
    pageAnalysis: {
      status: "completed",
      analyzedUrl: "https://rivalclinic.example/offer",
      analyzedAt: new Date().toISOString(),
      offer: { primaryOffer: "Free check-up", cta: "Book now" },
      pageArchitecture: { sections: [{ name: "Hero", purpose: "Offer", summary: "" }] },
    },
  });
  return { job, c };
}

test("a replaced ICP is resolved to the current one for the same source and stage", async () => {
  const { upsertIcp, getCompetitor, updateCompetitor } = await import("../src/lib/db");
  const { runManusRecreation } = await import("../src/lib/pipeline/manus/run");
  const { job, c } = await recreateSetup();
  await upsertIcp(icp("icp-old", job.id, "problem_aware"));
  // Regenerating replaces the row under a new id.
  await upsertIcp(icp("icp-new", job.id, "problem_aware"));
  await updateCompetitor(c.id, {
    recreatedPage: {
      status: "completed",
      targetIcp: { icpId: "icp-old", stage: "problem_aware" },
    } as never,
  });

  let brief = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = new URL(String(input));
    const method = url.pathname.replace("/v2/", "");
    if (method === "task.create") {
      const body = JSON.parse(String(init?.body)) as {
        message: { content: Array<{ type: string; filename?: string; file_data?: string }> };
      };
      const file = body.message.content.find((p) => p.filename === "brief.md");
      brief = Buffer.from(String(file?.file_data).split(",")[1], "base64").toString("utf8");
      return new Response(JSON.stringify({ ok: false, error: { message: "stop here" } }), { status: 400 });
    }
    const data = method === "project.list" ? [{ id: "P1", name: "Redesign Pipeline" }] : [];
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  }) as typeof fetch;
  try {
    await quiet(() => runManusRecreation(c.id, {}));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(brief, /The reader this page is for/);
  assert.match(brief, /Where did my money go/);
  assert.equal((await getCompetitor(c.id))?.recreatedPage?.targetIcp?.icpId, "icp-new");
});

test("a page whose ICP was removed throws before any Manus call", async () => {
  const { updateCompetitor, getCompetitor, getRecreatedPage } = await import("../src/lib/db");
  const { runManusRecreation } = await import("../src/lib/pipeline/manus/run");
  const { c } = await recreateSetup();
  await updateCompetitor(c.id, {
    recreatedPage: {
      status: "completed",
      html: "<p>old</p>",
      targetIcp: { icpId: "gone", stage: "unaware" },
    } as never,
  });
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("network must not be used");
  }) as typeof fetch;
  try {
    await assert.rejects(runManusRecreation(c.id, {}), /audience profile was removed/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0);
  // The saved page is untouched and no task was created. The competitor row
  // keeps the light page; its HTML lives in the page store.
  const stored = (await getCompetitor(c.id))?.recreatedPage;
  assert.equal(stored?.hasPage, true);
  assert.equal(stored?.targetIcp?.icpId, "gone");
  assert.equal((await getRecreatedPage(c.id))?.html, "<p>old</p>");
});
