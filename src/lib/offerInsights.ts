import type { LookupCoreOfferLadder, OfferTicketTier, SearchCompetitorAdRecord } from "./types";
import { adsForOffer, compareOffersLowToHigh } from "../components/OfferLadderFlow";

/**
 * Which offers are winning in a market, from the ads behind them.
 *
 * "Virality" here is what an advertiser's own spending says about an offer:
 * how many ads push it, how long those ads have been kept running
 * (advertisers keep paying for what converts), and how many competitors run
 * the same offer.
 */

export type OfferInsight = {
  ladder: LookupCoreOfferLadder;
  /** The competitor that pushes this offer hardest. */
  competitor: string | null;
  competitors: string[];
  ads: Array<SearchCompetitorAdRecord & { offerMatch: boolean }>;
  adCount: number;
  activeAds: number;
  longestDays: number | null;
  medianDays: number | null;
  /** 0–100 */
  score: number;
  website: string | null;
  landingPage: string | null;
  bestAd: (SearchCompetitorAdRecord & { offerMatch: boolean }) | null;
};

export type MarketSnapshot = {
  competitors: number;
  ads: number;
  offers: number;
  withPricing: number;
  tiers: Record<OfferTicketTier, number>;
  topCta: { label: string; count: number } | null;
  longestRunningDays: number | null;
};

const NOT_A_BUSINESS_SITE =
  /(^|\.)(facebook|fb|instagram|messenger|whatsapp|wa|linktr|bit|tinyurl|calendly|typeform|google|goo|youtube|youtu|linkedin|tiktok|x|twitter)\.[a-z.]+$/i;

/** The business's main domain: "ghl.grownomics.com.au" → "grownomics.com.au". */
function mainDomain(hostname: string): string {
  const parts = hostname.replace(/^www\./i, "").toLowerCase().split(".");
  // Two-part public suffixes such as .com.au or .co.uk keep three labels.
  const twoPartSuffix = parts.length >= 3 && /^(com|co|net|org|gov|edu|ac)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2;
  return parts.slice(twoPartSuffix ? -3 : -2).join(".");
}

function origin(url?: string | null): string | null {
  try {
    const u = new URL(String(url || ""));
    if (!/^https?:$/.test(u.protocol)) return null;
    if (NOT_A_BUSINESS_SITE.test(u.hostname)) return null;
    return `https://${mainDomain(u.hostname)}`;
  } catch {
    return null;
  }
}

/** Days an ad has run: the stored count, else from its start date. */
export function adDays(ad: SearchCompetitorAdRecord): number | null {
  if (typeof ad.daysRunning === "number" && ad.daysRunning >= 0) return ad.daysRunning;
  const start = Date.parse(ad.startDateString || "");
  if (!Number.isFinite(start)) return null;
  const endParsed = Date.parse(ad.endDateString || "");
  const end = Number.isFinite(endParsed) && ad.isActive === false ? endParsed : Date.now();
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

/** Each competitor's own website: the site most of its ads send people to. */
export function competitorWebsites(ads: SearchCompetitorAdRecord[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const ad of ads) {
    const site = origin(ad.landingPageUrl);
    if (!site) continue;
    const name = ad.pageName;
    const m = counts.get(name) ?? new Map<string, number>();
    m.set(site, (m.get(site) ?? 0) + 1);
    counts.set(name, m);
  }
  const out = new Map<string, string>();
  for (const [name, m] of counts) {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) out.set(name, best[0]);
  }
  return out;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Offers ranked by virality, best first. */
export function rankOffers(
  ladders: LookupCoreOfferLadder[],
  ads: SearchCompetitorAdRecord[],
): OfferInsight[] {
  const sites = competitorWebsites(ads);
  const rows = ladders.map((ladder) => {
    const matched = adsForOffer(ladder, ads);
    const byCompetitor = new Map<string, number>();
    for (const ad of matched) byCompetitor.set(ad.pageName, (byCompetitor.get(ad.pageName) ?? 0) + 1);
    const competitors = [
      ...new Set([...(ladder.sourceCompetitors || []), ...byCompetitor.keys()]),
    ];
    // Prefer a competitor the report lists for this offer, so the offer can
    // be found in that competitor's ladder.
    const listed = ladder.sourceCompetitors || [];
    const lead =
      [...listed].sort((a, b) => (byCompetitor.get(b) ?? 0) - (byCompetitor.get(a) ?? 0))[0] ??
      [...byCompetitor.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      null;
    const days = matched.map(adDays).filter((d): d is number => d !== null);
    return {
      ladder,
      competitor: lead,
      competitors,
      ads: matched,
      adCount: Math.max(matched.length, ladder.adCount || 0),
      activeAds: matched.filter((ad) => ad.isActive !== false).length,
      longestDays: days.length ? Math.max(...days) : null,
      medianDays: median(days),
      score: 0,
      website: lead ? sites.get(lead) ?? null : null,
      landingPage: ladder.landingPageUrl || matched.find((ad) => ad.offerMatch && ad.landingPageUrl)?.landingPageUrl || null,
      bestAd:
        [...matched].sort(
          (a, b) =>
            Number(b.offerMatch) - Number(a.offerMatch) ||
            (adDays(b) ?? -1) - (adDays(a) ?? -1),
        )[0] ?? null,
    } satisfies OfferInsight;
  });

  const maxAds = Math.max(1, ...rows.map((r) => r.adCount));
  const maxDays = Math.min(180, Math.max(1, ...rows.map((r) => r.longestDays ?? 0)));
  const maxComp = Math.max(1, ...rows.map((r) => r.competitors.length));
  const anyDays = rows.some((r) => r.longestDays !== null);
  for (const r of rows) {
    const a = r.adCount / maxAds;
    const d = Math.min(r.longestDays ?? 0, 180) / maxDays;
    const c = r.competitors.length / maxComp;
    const raw = anyDays ? 0.45 * a + 0.35 * d + 0.2 * c : 0.7 * a + 0.3 * c;
    r.score = Math.round(raw * 100);
  }
  return rows.sort(
    (a, b) => b.score - a.score || b.adCount - a.adCount || compareOffersLowToHigh(a.ladder, b.ladder),
  );
}

/** One competitor's offers, entry → premium: the ladder a top offer sits on. */
export function competitorLadder(
  ladders: LookupCoreOfferLadder[],
  competitor: string | null,
): LookupCoreOfferLadder[] {
  if (!competitor) return [];
  return ladders
    .filter((l) => (l.sourceCompetitors || []).includes(competitor))
    .sort(compareOffersLowToHigh);
}

export function marketSnapshot(
  ladders: LookupCoreOfferLadder[],
  ads: SearchCompetitorAdRecord[],
): MarketSnapshot {
  const tiers: Record<OfferTicketTier, number> = { low: 0, mid: 0, high: 0, unknown: 0 };
  for (const l of ladders) tiers[l.ticketTier || "unknown"] += 1;
  const ctas = new Map<string, { label: string; count: number }>();
  for (const ad of ads) {
    const label = (ad.ctaText || "").replace(/\s+/g, " ").trim();
    if (!label) continue;
    const key = label.toLowerCase();
    const row = ctas.get(key) ?? { label, count: 0 };
    row.count += 1;
    ctas.set(key, row);
  }
  const days = ads.map(adDays).filter((d): d is number => d !== null);
  return {
    competitors: new Set(ads.map((ad) => ad.pageName)).size,
    ads: ads.length,
    offers: ladders.length,
    withPricing: ladders.filter((l) => Boolean(l.pricing)).length,
    tiers,
    topCta: [...ctas.values()].sort((a, b) => b.count - a.count)[0] ?? null,
    longestRunningDays: days.length ? Math.max(...days) : null,
  };
}
