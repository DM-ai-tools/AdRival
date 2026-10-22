import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAbPages,
  mergeOfferPages,
  pickBaseForStage,
  type AbPage,
} from "../src/lib/pipeline/awareness/abPages";
import type {
  CompetitorRecord,
  LandingPageOfferAnalysis,
  LookupAdRecord,
  PageLevels,
} from "../src/lib/types";

function levels(stage: PageLevels["awarenessStage"]): PageLevels {
  return {
    audienceLevel: "consumer",
    audienceReason: "r",
    audienceEvidence: null,
    awarenessStage: stage,
    awarenessFocus: null,
    awarenessReason: "r",
    awarenessEvidence: null,
    sectionLevels: [],
  } as unknown as PageLevels;
}

function analysis(
  status: LandingPageOfferAnalysis["status"],
  extra: Partial<LandingPageOfferAnalysis> = {},
): LandingPageOfferAnalysis {
  return {
    status,
    analyzedUrl: "https://a.example/lp",
    analyzedAt: "2026-01-01T00:00:00.000Z",
    offer: { headline: "Head", primaryOffer: "Offer", cta: "Buy" },
    ...extra,
  };
}

function competitor(id: string, extra: Partial<CompetitorRecord> = {}): CompetitorRecord {
  return {
    id,
    runId: "run1",
    pageName: `Brand ${id}`,
    activeAdsCount: 1,
    ...extra,
  } as unknown as CompetitorRecord;
}

function page(id: string, stage: PageLevels["awarenessStage"] | null, activeAds: number | null): AbPage {
  return {
    id,
    source: "competitor",
    origin: "competitor",
    brand: id,
    url: "https://x",
    headline: null,
    primaryOffer: null,
    cta: null,
    status: "completed",
    levels: stage ? levels(stage) : null,
    activeAds,
    analyzedAt: null,
  };
}

test("buildAbPages excludes recreateOnly and records without analysis", () => {
  const pages = buildAbPages({
    competitors: [
      competitor("a", { pageAnalysis: analysis("completed", { levels: levels("unaware") }) }),
      competitor("b", { recreateOnly: { sourceUrl: "u", matchKey: "k", fromCompetitorId: null }, pageAnalysis: analysis("completed") }),
      competitor("c"),
    ],
  });
  assert.deepEqual(pages.map((p) => p.id), ["a"]);
  assert.equal(pages[0].headline, "Head");
  assert.equal(pages[0].activeAds, 1);
});

test("buildAbPages lists pending pages and tolerates missing levels", () => {
  const pages = buildAbPages({
    competitors: [
      competitor("p", { pageAnalysis: analysis("pending", { offer: null }) }),
      competitor("f", { pageAnalysis: analysis("failed", { offer: null }) }),
      competitor("n", { pageAnalysis: analysis("completed") }),
    ],
  });
  assert.deepEqual(pages.map((p) => p.status), ["pending", "failed", "completed"]);
  assert.equal(pages[2].levels, null);
  assert.equal(pages[0].headline, null);
});

test("pickBaseForStage prefers exact, then nearest, ties by active ads", () => {
  const pages = [page("a", "unaware", 1), page("b", "solution_aware", 2), page("c", "most_aware", 9)];
  assert.equal(pickBaseForStage(pages, "solution_aware")?.id, "b");
  assert.equal(pickBaseForStage(pages, "unaware")?.id, "a");
  assert.equal(pickBaseForStage(pages, "problem_aware")?.id, "b");
  const tie = [page("x", "unaware", 1), page("y", "solution_aware", 5)];
  assert.equal(pickBaseForStage(tie, "problem_aware")?.id, "y");
  const tie2 = [page("x", "unaware", 3), page("y", "solution_aware", 3)];
  assert.equal(pickBaseForStage(tie2, "problem_aware")?.id, "x");
});

test("pickBaseForStage uses unlabelled pages last and returns null with none", () => {
  assert.equal(pickBaseForStage([], "unaware"), null);
  assert.equal(pickBaseForStage([{ ...page("p", null, 1), status: "pending" }], "unaware"), null);
  assert.equal(pickBaseForStage([page("u", null, 1), page("z", "unclear", 1)], "unaware")?.id, "u");
  assert.equal(pickBaseForStage([page("u", null, 1), page("m", "most_aware", 1)], "unaware")?.id, "m");
});

function offerAd(id: string, extra: Partial<LookupAdRecord> = {}): LookupAdRecord {
  return { id, lookupId: "search-offers:run1:1", pageName: `Offer ${id}`, ...extra } as unknown as LookupAdRecord;
}

function competitorPages(): AbPage[] {
  return buildAbPages({
    competitors: [competitor("c1", { pageAnalysis: analysis("completed", { analyzedUrl: "https://A.example/lp" }) })],
  });
}

test("mergeOfferPages lists competitor pages then offers pages with origins", () => {
  const merged = mergeOfferPages(competitorPages(), [
    offerAd("o1", { pageAnalysis: analysis("completed", { analyzedUrl: "https://b.example/x" }) }),
  ]);
  assert.deepEqual(
    merged.map((p) => [p.id, p.origin, p.source]),
    [
      ["c1", "competitor", "competitor"],
      ["o1", "offers", "lookupAd"],
    ],
  );
  assert.equal(merged[1].brand, "Offer o1");
  assert.equal(merged[1].analyzedAt, "2026-01-01T00:00:00.000Z");
  const lookup = buildAbPages({ lookupAds: [offerAd("l1", { pageAnalysis: analysis("completed") })] });
  assert.equal(lookup[0].origin, "lookup");
});

test("mergeOfferPages keeps one page per URL and the competitor wins", () => {
  const merged = mergeOfferPages(competitorPages(), [
    offerAd("o1", { pageAnalysis: analysis("completed", { analyzedUrl: "https://a.EXAMPLE/lp/#top" }) }),
  ]);
  assert.deepEqual(merged.map((p) => p.id), ["c1"]);
});

test("mergeOfferPages prefers completed, then levelled, then latest among same-URL offers ads", () => {
  const url = "https://b.example/x";
  const merged = mergeOfferPages([], [
    offerAd("failed", { pageAnalysis: analysis("failed", { analyzedUrl: url, analyzedAt: "2026-03-01T00:00:00.000Z" }) }),
    offerAd("plain", { pageAnalysis: analysis("completed", { analyzedUrl: url, analyzedAt: "2026-02-01T00:00:00.000Z" }) }),
    offerAd("lev", { pageAnalysis: analysis("completed", { analyzedUrl: url, levels: levels("unaware") }) }),
  ]);
  assert.deepEqual(merged.map((p) => p.id), ["lev"]);
  const later = mergeOfferPages([], [
    offerAd("old", { pageAnalysis: analysis("completed", { analyzedUrl: url }) }),
    offerAd("new", { pageAnalysis: analysis("completed", { analyzedUrl: url, analyzedAt: "2026-05-01T00:00:00.000Z" }) }),
  ]);
  assert.deepEqual(later.map((p) => p.id), ["new"]);
});

test("mergeOfferPages ignores unanalysed ads and leaves competitor pages alone when empty", () => {
  const base = competitorPages();
  assert.deepEqual(mergeOfferPages(base, []), base);
  assert.deepEqual(mergeOfferPages(base, [offerAd("none")]), base);
  assert.deepEqual(mergeOfferPages([], []), []);
});

test("an offers page without levels loads as levels null", () => {
  const merged = mergeOfferPages([], [
    offerAd("o", { pageAnalysis: analysis("completed", { analyzedUrl: "https://c.example" }) }),
  ]);
  assert.equal(merged[0].levels, null);
});

test("mergeOfferPages ignores tracking params and their order when deduping", () => {
  const merged = mergeOfferPages(competitorPages(), [
    offerAd("o1", { pageAnalysis: analysis("completed", { analyzedUrl: "https://a.example/lp?utm_source=fb&fbclid=abc" }) }),
    offerAd("o2", { pageAnalysis: analysis("completed", { analyzedUrl: "https://a.example/lp/?fbclid=abc&utm_source=x#t" }) }),
  ]);
  assert.deepEqual(merged.map((p) => p.id), ["c1"]);
  const two = mergeOfferPages([], [
    offerAd("p1", { pageAnalysis: analysis("completed", { analyzedUrl: "https://b.example/x?utm_source=a&gclid=1" }) }),
    offerAd("p2", { pageAnalysis: analysis("completed", { analyzedUrl: "https://b.example/x?gclid=2&utm_source=b" }) }),
  ]);
  assert.equal(two.length, 1);
});

test("mergeOfferPages keeps pages that differ by a real query param", () => {
  const merged = mergeOfferPages([], [
    offerAd("a1", { pageAnalysis: analysis("completed", { analyzedUrl: "https://b.example/a?id=1&utm_source=x" }) }),
    offerAd("a2", { pageAnalysis: analysis("completed", { analyzedUrl: "https://b.example/a?id=2" }) }),
  ]);
  assert.deepEqual(merged.map((p) => p.id), ["a1", "a2"]);
});
