import assert from "node:assert/strict";
import test, { after } from "node:test";
import { useTempStore } from "./helpers/store";

const store = useTempStore("landing-recreate");
after(() => store.cleanup());

// Imported after useTempStore so `db.ts` picks up ADRIVAL_DATA_DIR.
const { makeSearchProject } = await import("./helpers/factories");
const { getCompetitorsByRun, getJob, listHistoryRuns, saveCompetitor, saveSearchCompetitorAds } = await import("@/lib/db");
const { ensureLandingPageRecord, landingPageRecordsByKey } = await import("@/lib/pipeline/landingRecreateBridge");
const { landingPageMatchKey } = await import("@/lib/pipeline/sameLandingPageAds");

function competitor(runId: string, id: string, landingPageUrl: string) {
  return {
    id,
    runId,
    pageId: `page-${id}`,
    pageName: "Online Road",
    country: "AU",
    platform: "facebook",
    activeAdsCount: 3,
    services: [],
    sampleAd: { adArchiveId: `ad-${id}`, title: "Free strategy session", body: "Grow with us", daysRunning: 30, adLibraryUrl: "https://facebook.com/ads/library/?id=1", landingPageUrl },
    brand: { website: "https://onlineroad.com.au" },
    createdAt: new Date().toISOString(),
  };
}

test("a dashboard landing page that is a competitor's own page reuses that competitor", () => {
  const job = makeSearchProject();
  saveCompetitor(competitor(job.id, "c-own", "https://onlineroad.com.au/strategy-session/"));
  const { competitor: record, created } = ensureLandingPageRecord(job.id, "https://onlineroad.com.au/strategy-session");
  assert.equal(created, false);
  assert.equal(record.id, "c-own");
});

test("any other landing page gets its own record, kept out of competitor lists and counts", () => {
  const job = makeSearchProject();
  saveCompetitor(competitor(job.id, "c-main", "https://onlineroad.com.au/strategy-session/"));
  saveSearchCompetitorAds([
    {
      id: "ad-seo",
      runId: job.id,
      competitorId: "c-main",
      pageId: "page-c-main",
      pageName: "Online Road",
      platform: "facebook",
      adArchiveId: "999",
      country: "AU",
      isActive: true,
      title: "SEO audit",
      body: "Book a free SEO audit",
      landingPageUrl: "https://onlineroad.com.au/seo-audit?utm_source=fb",
      adLibraryUrl: "https://facebook.com/ads/library/?id=999",
      raw: {},
      createdAt: new Date().toISOString(),
    },
  ]);

  const first = ensureLandingPageRecord(job.id, "https://onlineroad.com.au/seo-audit");
  assert.equal(first.created, true);
  assert.ok(first.competitor.recreateOnly, "marked as held for recreation");
  assert.equal(first.competitor.pageName, "Online Road", "named after the competitor whose ads point at it");
  assert.equal(first.competitor.recreateOnly?.fromCompetitorId, "c-main");
  assert.equal(first.competitor.sampleAd.title, "SEO audit", "the page's own ad is its sample");

  // Asking again finds the same record.
  const again = ensureLandingPageRecord(job.id, "onlineroad.com.au/seo-audit/");
  assert.equal(again.created, false);
  assert.equal(again.competitor.id, first.competitor.id);

  // Not a competitor: lists, roster and history counts leave it out.
  assert.deepEqual(getCompetitorsByRun(job.id).map((c) => c.id), ["c-main"]);
  assert.deepEqual(getJob(job.id)?.competitorIds, ["c-main"]);
  assert.equal(listHistoryRuns(500).find((r) => r.id === job.id)?.competitorCount, 1);

  // The dashboard can still find it by the page's key.
  const byKey = landingPageRecordsByKey(job.id);
  assert.equal(byKey.get(landingPageMatchKey("https://onlineroad.com.au/seo-audit")!)?.id, first.competitor.id);
  assert.equal(byKey.get(landingPageMatchKey("https://onlineroad.com.au/strategy-session")!)?.id, "c-main");
});
