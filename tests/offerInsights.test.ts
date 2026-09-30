import assert from "node:assert/strict";
import { test } from "node:test";
import type { LookupCoreOfferLadder, SearchCompetitorAdRecord } from "../src/lib/types";

const ad = (id: string, pageName: string, over: Partial<SearchCompetitorAdRecord> = {}): SearchCompetitorAdRecord =>
  ({
    id,
    runId: "r",
    competitorId: pageName,
    pageId: pageName,
    pageName,
    platform: "facebook",
    adArchiveId: id,
    country: "AU",
    isActive: true,
    title: "",
    body: "",
    adLibraryUrl: `https://www.facebook.com/ads/library/?id=${id}`,
    raw: {},
    createdAt: "2026-09-01",
    ...over,
  }) as SearchCompetitorAdRecord;

const ladder = (id: string, offer: string, tier: LookupCoreOfferLadder["ticketTier"], competitors: string[], adIds: string[]): LookupCoreOfferLadder =>
  ({
    id,
    rank: 1,
    coreOffer: offer,
    details: "",
    cta: null,
    ticketTier: tier,
    pricing: null,
    funnelStage: "BOFU",
    landingPageUrl: null,
    adCount: 0,
    adOffers: [],
    sourceCompetitors: competitors,
    sourceAdRefs: adIds.map((adId) => ({ adId, competitorId: competitors[0], competitorName: competitors[0] })),
  }) as LookupCoreOfferLadder;

test("offers pushed by more, longer-running ads from more competitors rank first", async () => {
  const { rankOffers, competitorLadder, competitorWebsites, marketSnapshot } = await import("../src/lib/offerInsights");
  const ads = [
    ad("a1", "Alpha", { title: "Free SEO audit", daysRunning: 120, landingPageUrl: "https://alpha.com.au/audit", ctaText: "Book now" }),
    ad("a2", "Alpha", { title: "Free SEO audit today", daysRunning: 90, landingPageUrl: "https://alpha.com.au/audit", ctaText: "Book now" }),
    ad("b1", "Beta", { title: "Free SEO audit", daysRunning: 60, landingPageUrl: "https://www.beta.com/free-audit", ctaText: "Learn more" }),
    ad("a3", "Alpha", { title: "SEO retainer", daysRunning: 5, landingPageUrl: "https://facebook.com/alpha" }),
  ];
  const ladders = [
    ladder("retainer", "SEO retainer", "high", ["Alpha"], ["a3"]),
    ladder("audit", "Free SEO audit", "low", ["Alpha", "Beta"], ["a1", "a2", "b1"]),
  ];

  const ranked = rankOffers(ladders, ads);
  assert.equal(ranked[0].ladder.id, "audit");
  assert.equal(ranked[0].adCount, 3);
  assert.equal(ranked[0].longestDays, 120);
  assert.equal(ranked[0].competitor, "Alpha", "the competitor pushing it hardest");
  assert.equal(ranked[0].website, "https://alpha.com.au");
  assert.equal(ranked[0].score, 100);
  assert.ok(ranked[1].score < ranked[0].score);

  // Facebook pages are not a business website.
  assert.equal(competitorWebsites(ads).get("Alpha"), "https://alpha.com.au");
  assert.equal(competitorWebsites(ads).get("Beta"), "https://beta.com");

  assert.deepEqual(competitorLadder(ladders, "Alpha").map((l) => l.id), ["audit", "retainer"], "entry before premium");

  const snap = marketSnapshot(ladders, ads);
  assert.equal(snap.competitors, 2);
  assert.equal(snap.topCta?.label, "Book now");
  assert.equal(snap.tiers.low, 1);
  assert.equal(snap.longestRunningDays, 120);
});
