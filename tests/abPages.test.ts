import assert from "node:assert/strict";
import test from "node:test";
import { buildAbPages, pickBaseForStage, type AbPage } from "../src/lib/pipeline/awareness/abPages";
import type { CompetitorRecord, LandingPageOfferAnalysis, PageLevels } from "../src/lib/types";

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
    brand: id,
    url: "https://x",
    headline: null,
    primaryOffer: null,
    cta: null,
    status: "completed",
    levels: stage ? levels(stage) : null,
    activeAds,
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
