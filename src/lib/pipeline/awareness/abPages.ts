import type {
  AwarenessStage,
  CompetitorRecord,
  LandingPageOfferAnalysis,
  LookupAdRecord,
  PageLevels,
} from "../../types";
import { AWARENESS_STAGES } from "./coverage";

export type AbPage = {
  id: string;
  source: "competitor" | "lookupAd";
  brand: string;
  url: string;
  headline: string | null;
  primaryOffer: string | null;
  cta: string | null;
  status: "pending" | "completed" | "failed" | "none";
  levels: PageLevels | null;
  activeAds: number | null;
};

function toPage(
  id: string,
  source: AbPage["source"],
  brand: string,
  analysis: LandingPageOfferAnalysis,
  activeAds: number | null,
): AbPage {
  return {
    id,
    source,
    brand,
    url: analysis.analyzedUrl ?? "",
    headline: analysis.offer?.headline ?? null,
    primaryOffer: analysis.offer?.primaryOffer ?? null,
    cta: analysis.offer?.cta ?? null,
    status: analysis.status ?? "none",
    levels: analysis.levels ?? null,
    activeAds,
  };
}

/** Pages with a landing-page analysis, ready for the A/B testing view. */
export function buildAbPages(input: {
  competitors?: CompetitorRecord[];
  lookupAds?: LookupAdRecord[];
}): AbPage[] {
  const pages: AbPage[] = [];
  for (const c of input.competitors ?? []) {
    if (c.recreateOnly || !c.pageAnalysis) continue;
    pages.push(toPage(c.id, "competitor", c.pageName, c.pageAnalysis, c.activeAdsCount ?? null));
  }
  for (const a of input.lookupAds ?? []) {
    if (!a.pageAnalysis) continue;
    pages.push(toPage(a.id, "lookupAd", a.pageName, a.pageAnalysis, null));
  }
  return pages;
}

/** The completed page closest to a stage; unlabelled or unclear pages only as a last resort. */
export function pickBaseForStage(pages: AbPage[], stage: AwarenessStage): AbPage | null {
  const target = AWARENESS_STAGES.indexOf(stage as (typeof AWARENESS_STAGES)[number]);
  let best: { page: AbPage; tier: number; distance: number } | null = null;
  for (const page of pages) {
    if (page.status !== "completed") continue;
    const pos = page.levels
      ? AWARENESS_STAGES.indexOf(page.levels.awarenessStage as (typeof AWARENESS_STAGES)[number])
      : -1;
    const tier = pos >= 0 ? 0 : 1;
    const distance = pos >= 0 && target >= 0 ? Math.abs(pos - target) : 0;
    const better =
      !best ||
      tier < best.tier ||
      (tier === best.tier &&
        (distance < best.distance ||
          (distance === best.distance && (page.activeAds ?? 0) > (best.page.activeAds ?? 0))));
    if (better) best = { page, tier, distance };
  }
  return best?.page ?? null;
}
