import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { setClientForTests } from "../src/lib/data/client";
import { migrate } from "../src/lib/data/migrate";
import * as competitors from "../src/lib/data/competitors";
import * as pages from "../src/lib/data/recreatedPages";
import * as lookups from "../src/lib/data/lookups";
import * as runs from "../src/lib/data/runs";
import type {
  CompetitorRecord,
  LookupAdRecord,
  LookupJob,
  RecreatedLandingPage,
  RecreatedPageLight,
  SearchJob,
} from "../src/lib/types";
import { createPgliteClient, type PgliteTestClient } from "./helpers/testDb";

/*
 * Atomic read-modify-write helpers: updateCompetitorWith (optionally with the
 * page content) and updateLookupAdWith. The updater sees the stored row inside
 * the write transaction, so two concurrent updates never lose one another.
 */

let base: PgliteTestClient;

before(async () => {
  base = await createPgliteClient();
  await migrate(base);
  setClientForTests(base);
});

after(async () => {
  setClientForTests(null);
  await base.close();
});

let seq = 0;

function makeJob(): SearchJob {
  seq += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  return {
    id: `uj-${seq}`,
    keyword: "k",
    keywords: ["k"],
    platform: "facebook",
    geo: "AU",
    countries: ["AU"],
    status: "running",
    progress: { stage: "searching_ads", scannedAds: 0, scannedPages: 0, accepted: 0, target: 10, rejected: 0, message: "" },
    competitorIds: [],
    ownerUserId: "owner-1",
    createdAt: at,
    updatedAt: at,
  };
}

function makeLookup(): LookupJob {
  seq += 1;
  const at = new Date(Date.UTC(2026, 0, 2, 0, 0, seq)).toISOString();
  return {
    id: `ul-${seq}`,
    queryName: "Brand",
    platform: "facebook",
    status: "running",
    progress: { stage: "fetching_ads", message: "", candidatesFound: 0, adsFetched: 0, pagesScanned: 0 },
    candidates: [],
    adIds: [],
    ownerUserId: "owner-1",
    createdAt: at,
    updatedAt: at,
  };
}

function makeCompetitor(runId: string, page?: RecreatedLandingPage): CompetitorRecord {
  seq += 1;
  return {
    id: `uc-${seq}`,
    runId,
    pageId: `up-${seq}`,
    pageName: `Competitor ${seq}`,
    country: "AU",
    platform: "facebook",
    activeAdsCount: 1,
    services: [],
    sampleAd: { adArchiveId: `a-${seq}`, title: "t", body: "b", daysRunning: 1, adLibraryUrl: "https://x.invalid" },
    brand: {},
    createdAt: new Date(Date.UTC(2026, 0, 3, 0, 0, seq)).toISOString(),
    ...(page ? { recreatedPage: page as unknown as RecreatedPageLight } : {}),
  } as CompetitorRecord;
}

function makePage(overrides: Partial<RecreatedLandingPage> = {}): RecreatedLandingPage {
  return {
    status: "design_pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    businessUrl: "https://client.invalid",
    keyword: "plumber",
    sourceCompetitorName: "Rival",
    sourceAnalyzedUrl: "https://rival.invalid",
    brandColors: { primary: "#000", secondary: "#111", accent: "#222", background: "#fff", text: "#000" },
    ...overrides,
  };
}

function makeAd(lookupId: string): LookupAdRecord {
  seq += 1;
  return {
    id: `uad-${seq}`,
    lookupId,
    adArchiveId: `arch-${seq}`,
    pageId: "p",
    pageName: "P",
    country: "AU",
    isActive: true,
    title: "t",
    body: "b",
    adLibraryUrl: "https://x.invalid",
    raw: {},
    createdAt: new Date(Date.UTC(2026, 0, 4, 0, 0, seq)).toISOString(),
  };
}

async function savedCompetitor(page?: RecreatedLandingPage, html?: string): Promise<CompetitorRecord> {
  const job = makeJob();
  assert.equal(await runs.saveJob(job), true);
  const c = makeCompetitor(job.id, page);
  assert.equal(
    await competitors.saveCompetitor(html === undefined ? c : { ...c, recreatedPageHeavy: { html, previousHtml: "<p>prev</p>" } }),
    true,
  );
  return c;
}

test("updateCompetitorWith applies the updater's patch to the stored record and returns it", async () => {
  const c = await savedCompetitor();
  const next = await competitors.updateCompetitorWith(c.id, (stored) => ({ activeAdsCount: stored.activeAdsCount + 4 }));
  assert.equal(next?.activeAdsCount, 5);
  assert.equal((await competitors.getCompetitor(c.id))?.activeAdsCount, 5);
});

test("updateCompetitorWith returns null for a missing competitor and never calls the updater", async () => {
  let called = false;
  const next = await competitors.updateCompetitorWith("no-such-competitor", () => {
    called = true;
    return { pageName: "x" };
  });
  assert.equal(next, null);
  assert.equal(called, false);
});

test("updateCompetitorWith writes nothing when the updater returns null", async () => {
  const c = await savedCompetitor();
  const before = await competitors.getCompetitor(c.id);
  const next = await competitors.updateCompetitorWith(c.id, () => null);
  assert.deepEqual(next, before);
  assert.deepEqual(await competitors.getCompetitor(c.id), before);
});

test("concurrent updateCompetitorWith calls never lose an update", async () => {
  const c = await savedCompetitor();
  await Promise.all(
    Array.from({ length: 8 }, () =>
      competitors.updateCompetitorWith(c.id, (stored) => ({ activeAdsCount: stored.activeAdsCount + 1 })),
    ),
  );
  assert.equal((await competitors.getCompetitor(c.id))?.activeAdsCount, 9);
});

test("updateCompetitorWith hands the page content to the updater only when asked", async () => {
  const c = await savedCompetitor(makePage(), "<p>built</p>");
  let seen: unknown = "unset";
  await competitors.updateCompetitorWith(c.id, (_stored, content) => {
    seen = content;
    return null;
  });
  assert.equal(seen, undefined);
  await competitors.updateCompetitorWith(
    c.id,
    (_stored, content) => {
      seen = content;
      return null;
    },
    { withContent: true },
  );
  assert.deepEqual(seen, { html: "<p>built</p>", previousHtml: "<p>prev</p>" });
});

test("updateCompetitorWith passes null content for a competitor without a stored page", async () => {
  const c = await savedCompetitor(makePage());
  let seen: unknown = "unset";
  await competitors.updateCompetitorWith(
    c.id,
    (_stored, content) => {
      seen = content;
      return null;
    },
    { withContent: true },
  );
  assert.equal(seen, null);
});

test("a light page patch keeps the stored content; recreatedPageHeavy replaces it in the same write", async () => {
  const c = await savedCompetitor(makePage(), "<p>built</p>");
  await competitors.updateCompetitorWith(c.id, (stored) => ({
    recreatedPage: { ...stored.recreatedPage!, status: "failed" },
  }));
  assert.equal((await competitors.getCompetitor(c.id))?.recreatedPage?.status, "failed");
  assert.equal((await pages.getRecreatedPage(c.id))?.html, "<p>built</p>");

  const next = await competitors.updateCompetitorWith(
    c.id,
    (stored, content) => ({
      recreatedPage: { ...stored.recreatedPage!, status: "completed" },
      recreatedPageHeavy: { ...content!, html: "<p>new</p>", previousHtml: content!.html },
    }),
    { withContent: true },
  );
  assert.equal(next?.recreatedPage?.status, "completed");
  assert.equal(next?.recreatedPage?.hasPage, true);
  assert.deepEqual(await pages.getRecreatedPage(c.id), { html: "<p>new</p>", previousHtml: "<p>built</p>" });
  const stored = (await competitors.getCompetitor(c.id))?.recreatedPage as unknown as Record<string, unknown>;
  assert.equal(stored.status, "completed");
  assert.ok(!("html" in stored));
});

test("recreatedPageHeavy alone keeps the light page and updates its marker", async () => {
  const c = await savedCompetitor(makePage({ status: "pending" }));
  const before = await competitors.getCompetitor(c.id);
  assert.equal(before?.recreatedPage?.hasPage, false);
  const next = await competitors.updateCompetitorWith(c.id, () => ({ recreatedPageHeavy: { html: "<p>x</p>" } }));
  assert.equal(next?.recreatedPage?.status, "pending");
  assert.equal(next?.recreatedPage?.hasPage, true);
  assert.equal((await pages.getRecreatedPage(c.id))?.html, "<p>x</p>");
});

test("an updater that throws rolls back and the error reaches the caller", async () => {
  const c = await savedCompetitor(makePage(), "<p>built</p>");
  await assert.rejects(
    competitors.updateCompetitorWith(c.id, () => {
      throw new Error("refused");
    }),
    /refused/,
  );
  assert.equal((await pages.getRecreatedPage(c.id))?.html, "<p>built</p>");
});

test("updateLookupAdWith applies the patch atomically and keeps updateLookupAd's pending rule", async () => {
  const lookup = makeLookup();
  await runs.saveLookupJob(lookup);
  const ad = {
    ...makeAd(lookup.id),
    pageAnalysis: {
      status: "completed",
      analyzedUrl: "https://lp.invalid",
      analyzedAt: "2026-01-01T00:00:00.000Z",
      offer: { primaryOffer: "50% off" },
    } as LookupAdRecord["pageAnalysis"],
  };
  assert.equal(await lookups.saveLookupAd(ad), true);

  assert.equal(await lookups.updateLookupAdWith("no-such-ad", () => ({ title: "x" })), null);
  const same = await lookups.updateLookupAdWith(ad.id, () => null);
  assert.equal(same?.title, "t");

  await Promise.all(
    Array.from({ length: 6 }, () => lookups.updateLookupAdWith(ad.id, (stored) => ({ title: `${stored.title}+` }))),
  );
  assert.equal((await lookups.getLookupAd(ad.id))?.title, "t++++++");

  const pending = await lookups.updateLookupAdWith(ad.id, () => ({
    pageAnalysis: { status: "pending", analyzedUrl: "https://lp.invalid", analyzedAt: "2026-01-02T00:00:00.000Z" },
  }));
  assert.equal(pending?.pageAnalysis?.status, "pending");
  assert.equal(pending?.pageAnalysis?.offer?.primaryOffer, "50% off");
});
