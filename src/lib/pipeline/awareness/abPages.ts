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
  origin: "competitor" | "offers" | "lookup";
  brand: string;
  url: string;
  headline: string | null;
  primaryOffer: string | null;
  cta: string | null;
  status: "pending" | "completed" | "failed" | "none";
  levels: PageLevels | null;
  activeAds: number | null;
  analyzedAt: string | null;
};

function toPage(
  id: string,
  source: AbPage["source"],
  origin: AbPage["origin"],
  brand: string,
  analysis: LandingPageOfferAnalysis,
  activeAds: number | null,
): AbPage {
  return {
    id,
    source,
    origin,
    brand,
    url: analysis.analyzedUrl ?? "",
    headline: analysis.offer?.headline ?? null,
    primaryOffer: analysis.offer?.primaryOffer ?? null,
    cta: analysis.offer?.cta ?? null,
    status: analysis.status ?? "none",
    levels: analysis.levels ?? null,
    activeAds,
    analyzedAt: analysis.analyzedAt ?? null,
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
    pages.push(toPage(c.id, "competitor", "competitor", c.pageName, c.pageAnalysis, c.activeAdsCount ?? null));
  }
  for (const a of input.lookupAds ?? []) {
    if (!a.pageAnalysis) continue;
    pages.push(toPage(a.id, "lookupAd", "lookup", a.pageName, a.pageAnalysis, null));
  }
  return pages;
}

/** Lower-cased host, no fragment, no trailing slash: enough to tell two listings of one page apart. */
function urlKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return trimmed.replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
  }
}

function betterOffer(a: AbPage, b: AbPage): boolean {
  const done = Number(a.status === "completed") - Number(b.status === "completed");
  if (done) return done > 0;
  const lev = Number(Boolean(a.levels)) - Number(Boolean(b.levels));
  if (lev) return lev > 0;
  return (a.analyzedAt ?? "") > (b.analyzedAt ?? "");
}

/**
 * Competitor pages followed by the offers dashboard's analysed pages, one per distinct
 * landing URL. A competitor page wins over an offers page with the same URL.
 */
export function mergeOfferPages(competitorPages: AbPage[], offerAds: LookupAdRecord[]): AbPage[] {
  const taken = new Set(competitorPages.map((p) => urlKey(p.url)).filter(Boolean));
  const best = new Map<string, AbPage>();
  for (const ad of offerAds) {
    if (!ad.pageAnalysis) continue;
    const page = toPage(ad.id, "lookupAd", "offers", ad.pageName, ad.pageAnalysis, null);
    const key = urlKey(page.url) || `id:${page.id}`;
    if (taken.has(key)) continue;
    const prev = best.get(key);
    if (!prev || betterOffer(page, prev)) best.set(key, page);
  }
  return [...competitorPages, ...best.values()];
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
