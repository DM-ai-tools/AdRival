import assert from "node:assert/strict";
import test from "node:test";

import { ARCHIVE_AFTER_DAYS, buildRecreateList, isArchived } from "../src/lib/recreateList";
import type { RecreateJob } from "../src/lib/data/recreateJobs";
import type { CompetitorRecord, RecreatedPageLight } from "../src/lib/types";

/*
 * The Recreate tab's list (src/lib/recreateList.ts): queue jobs merged with
 * the recreated pages, newest first, archived 14 days after finishing.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-28T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

function page(overrides: Partial<RecreatedPageLight> = {}): RecreatedPageLight {
  return {
    status: "completed",
    createdAt: daysAgo(20),
    updatedAt: daysAgo(20),
    businessUrl: "https://client.invalid",
    keyword: "dentist",
    sourceCompetitorName: "Rival Clinic",
    sourceAnalyzedUrl: "https://rival.invalid/offer",
    brandColors: { primary: "#000", secondary: "#111", accent: "#222" },
    hasPage: true,
    pageBytes: 10,
    pageUpdatedAt: daysAgo(20),
    ...overrides,
  } as RecreatedPageLight;
}

function record(id: string, overrides: Partial<CompetitorRecord> = {}): CompetitorRecord {
  return {
    id,
    runId: "run-1",
    pageId: `page-${id}`,
    pageName: "Rival Clinic",
    country: "AU",
    platform: "facebook",
    activeAdsCount: 4,
    services: [],
    sampleAd: {
      adArchiveId: "a",
      title: "t",
      body: "b",
      daysRunning: 45,
      adLibraryUrl: "https://x.invalid",
      landingPageUrl: "https://rival.invalid/offer",
    },
    brand: {},
    pageAnalysis: { status: "completed", analyzedUrl: "https://rival.invalid/offer", analyzedAt: daysAgo(30) },
    createdAt: daysAgo(30),
    ...overrides,
  } as CompetitorRecord;
}

function version(id: string, overrides: Partial<CompetitorRecord> = {}): CompetitorRecord {
  return record(id, {
    recreateOnly: {
      sourceUrl: "https://rival.invalid/offer",
      matchKey: "rival.invalid/offer",
      fromCompetitorId: "src-1",
      variantOf: "src-1",
    },
    ...overrides,
  });
}

function job(id: string, competitorId: string, overrides: Partial<RecreateJob> = {}): RecreateJob {
  return {
    id,
    ownerUserId: "user-1",
    competitorId,
    runId: "run-1",
    spaceId: null,
    status: "queued",
    options: { businessUrl: "https://client.invalid", styleDirection: "minimal", userFeedback: null, targetIcp: null },
    error: null,
    createdAt: daysAgo(1),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

test("isArchived is false at 13 days and true at 15 days", () => {
  assert.equal(ARCHIVE_AFTER_DAYS, 14);
  assert.equal(isArchived(daysAgo(13), NOW), false);
  assert.equal(isArchived(daysAgo(15), NOW), true);
  assert.equal(isArchived(null, NOW), false, "not finished: never archived");
  assert.equal(isArchived("not a date", NOW), false);
});

test("isArchived uses the finish date, not the creation date", () => {
  const items = buildRecreateList({
    jobs: [
      job("j-old-recent", "rv-1", { status: "finished", createdAt: daysAgo(40), startedAt: daysAgo(40), finishedAt: daysAgo(2) }),
      job("j-failed-long-ago", "rv-2", { status: "failed", createdAt: daysAgo(20), finishedAt: daysAgo(16), error: "agent broke" }),
      job("j-queued-long", "rv-3", { status: "queued", createdAt: daysAgo(30) }),
    ],
    records: [version("rv-1", { recreatedPage: page() }), version("rv-2", { recreatedPage: page({ status: "failed" }) }), version("rv-3")],
    now: NOW,
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.equal(byId.get("j-old-recent")?.archived, false, "created 40 days ago, finished 2 days ago");
  assert.equal(byId.get("j-failed-long-ago")?.archived, true, "failed jobs follow the same rule");
  assert.equal(byId.get("j-queued-long")?.archived, false, "a queued job is never archived");
});

test('legacy source records with a recreatedPage appear as legacy items with "—" fields', () => {
  // A competitor recreated before versions existed: the page lives on the source record itself.
  const legacy = record("c-legacy", {
    activeAdsCount: 0,
    sampleAd: { adArchiveId: "a", title: "t", body: "b", daysRunning: -1, adLibraryUrl: "https://x.invalid" },
    recreatedPage: page({
      createdAt: daysAgo(3),
      updatedAt: daysAgo(2),
      businessName: undefined,
      keyword: "",
      styleDirection: undefined,
      targetIcp: undefined,
      manus: { taskId: "T-secret" } as RecreatedPageLight["manus"],
    }),
  });
  const items = buildRecreateList({ jobs: [], records: [legacy], now: NOW });
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.state, "legacy");
  assert.equal(item.id, "c-legacy");
  assert.equal(item.competitorId, "c-legacy");
  assert.equal(item.jobId, null, "no queue job: nothing to stop");
  assert.equal(item.businessName, null);
  assert.equal(item.keyword, null);
  assert.equal(item.styleDirection, null);
  assert.equal(item.targetIcp, null);
  assert.equal(item.daysRunning, null, "unknown days running shows —");
  assert.equal(item.activeAds, null, "unknown active ads shows —");
  assert.equal(item.progress, null);
  assert.equal(item.sourceName, "Rival Clinic");
  assert.equal(item.sourceUrl, "https://rival.invalid/offer");
  assert.equal(item.hasPage, true);
  assert.equal(item.openPath, "/recreate/c-legacy");
  assert.equal(item.finishedAt, daysAgo(2), "a finished legacy page counts from its last update");
  assert.equal(item.archived, false);
  assert.equal(JSON.stringify(items).includes("T-secret"), false, "the design agent's task stays on the server");

  const old = buildRecreateList({
    jobs: [],
    records: [record("c-old", { recreatedPage: page({ updatedAt: daysAgo(30) }) })],
    now: NOW,
  });
  assert.equal(old[0].archived, true, "old pages are archived too");
});

test("jobs merge with their versions, newest first, with the source page's signals", () => {
  const running = version("rv-run", {
    recreatedPage: page({
      status: "design_pending",
      createdAt: daysAgo(0.5),
      updatedAt: daysAgo(0.1),
      businessName: "Bright Smiles",
      hasPage: false,
      progress: { phase: "build", message: "Building with Manus", pct: 42 },
      error: null,
    }),
  });
  const items = buildRecreateList({
    jobs: [
      job("j-queued", "rv-queued", {
        createdAt: daysAgo(0.2),
        options: {
          businessUrl: "https://client.invalid",
          styleDirection: null,
          userFeedback: "warmer",
          targetIcp: { icpId: "icp-1", stage: "problem_aware" },
        },
      }),
      job("j-run", "rv-run", { status: "running", createdAt: daysAgo(0.5), startedAt: daysAgo(0.5) }),
    ],
    records: [running, version("rv-queued", { activeAdsCount: 9 }), record("c-legacy", { recreatedPage: page() })],
    runs: new Map([["run-1", { keyword: "dentist sydney", businessName: "Bright Smiles Run" }]]),
    now: NOW,
  });
  assert.deepEqual(
    items.map((i) => i.id),
    ["j-queued", "j-run", "c-legacy"],
    "newest first; the running version is one item, not also a legacy one",
  );
  const [queued, run] = items;
  assert.equal(queued.state, "queued");
  assert.equal(queued.jobId, "j-queued");
  assert.equal(queued.competitorId, "rv-queued");
  assert.equal(queued.daysRunning, 45);
  assert.equal(queued.activeAds, 9);
  assert.equal(queued.progress, null);
  assert.equal(queued.hasPage, false);
  assert.equal(queued.businessName, "Bright Smiles Run", "before the build, the run's business");
  assert.equal(queued.keyword, "dentist sydney");
  assert.deepEqual(queued.targetIcp, { icpId: "icp-1", stage: "problem_aware" });
  assert.equal(queued.styleDirection, null);
  assert.equal(queued.openPath, "/recreate/rv-queued");

  assert.equal(run.state, "running");
  assert.equal(run.businessName, "Bright Smiles", "the page's own business once built");
  assert.equal(run.keyword, "dentist");
  assert.equal(run.styleDirection, "minimal");
  assert.deepEqual(run.progress, { pct: 42, message: "Building with design agent" }, "progress text is masked");
  assert.equal(run.finishedAt, null);
});
