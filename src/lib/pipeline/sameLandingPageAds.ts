import OpenAI from "openai";
import { z } from "zod";
import {
  adRunsOnFacebook,
  adRunsOnInstagram,
  extractAds,
  extractCursor,
  extractFullAdCopy,
  getCompanyAds,
  isLandingPageUrl,
} from "../sociavault/client";
import { normalizeLandingUrl } from "./htmlFetch";
import {
  SEARCH_COUNTRIES,
  type CompetitorRecord,
  type LookupAdRecord,
  type SameLandingPageAd,
  type SameLandingPageAdsSummary,
} from "../types";
import type { AdPlatform } from "../platforms";

const MAX_PAGES_PER_COUNTRY = 12;
const MAX_ADS_IN_UI = 20;

type RawCompanyAd = {
  adArchiveId: string;
  title: string;
  body: string;
  fullText: string;
  ctaText: string | null;
  landingPageUrl: string | null;
  isActive: boolean;
  daysRunning: number;
  startDate: string | null;
  country: string;
  adLibraryUrl: string;
};

/** Normalize destination URLs so tracking params don't split the same LP. */
export function landingPageMatchKey(url: string | null | undefined): string | null {
  const normalized = normalizeLandingUrl(url || "", { stripTracking: true });
  if (!normalized) return null;
  try {
    const u = new URL(normalized);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "") || "";
    return `${host}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

function daysSince(iso?: string | null): number {
  if (!iso) return -1;
  const t = Date.parse(String(iso));
  if (Number.isNaN(t)) return -1;
  return Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
}

/** Heuristic hook: headline, else first punchy sentence of body. */
export function extractAdHook(
  title?: string | null,
  body?: string | null,
): string {
  const t = (title || "").replace(/\s+/g, " ").trim();
  if (t.length >= 6 && t.length <= 140) return t;

  const bodyClean = (body || "").replace(/\s+/g, " ").trim();
  if (!bodyClean) return t || "—";

  const first =
    bodyClean.split(/(?<=[.!?])\s+|\n+/)[0]?.trim() || bodyClean.slice(0, 160);
  if (first.length >= 6) return first.slice(0, 160);
  return t || first || "—";
}

/** Cheap offer angle from creative when LLM is unavailable. */
function heuristicOffer(
  title?: string | null,
  body?: string | null,
  cta?: string | null,
): string {
  const blob = `${title || ""} ${body || ""}`.replace(/\s+/g, " ").trim();
  const price =
    blob.match(
      /(?:\$|₹|£|€|AUD\s*|USD\s*)\s?\d[\d,]*(?:\.\d+)?(?:\s*\/\s*(?:mo|month|yr|year))?/i,
    )?.[0] || null;
  const free = /\b(free\s+(?:audit|consult|quote|trial|assessment)|complimentary)\b/i.exec(
    blob,
  )?.[0];
  const bits = [free, price, cta].filter(Boolean);
  if (bits.length) return bits.join(" · ");
  if (blob.length >= 20) return blob.slice(0, 140) + (blob.length > 140 ? "…" : "");
  return cta || "See ad creative";
}

const hooksSchema = z.object({
  items: z.array(
    z.object({
      adArchiveId: z.string(),
      hook: z.string(),
      offer: z.string(),
    }),
  ),
});

async function enrichHooksAndOffers(
  ads: RawCompanyAd[],
  pageOffer?: string | null,
): Promise<Map<string, { hook: string; offer: string }>> {
  const map = new Map<string, { hook: string; offer: string }>();
  for (const ad of ads) {
    map.set(ad.adArchiveId, {
      hook: extractAdHook(ad.title, ad.body || ad.fullText),
      offer: heuristicOffer(ad.title, ad.body || ad.fullText, ad.ctaText),
    });
  }

  if (!process.env.OPENAI_API_KEY || ads.length === 0) return map;

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const payload = ads.slice(0, MAX_ADS_IN_UI).map((a) => ({
      adArchiveId: a.adArchiveId,
      title: a.title,
      body: (a.body || a.fullText || "").slice(0, 500),
      cta: a.ctaText,
    }));
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract the advertising HOOK and OFFER from each ad creative.
Hook = the attention-grabbing opening line / pain / curiosity (1 short sentence).
Offer = what they are selling or promising (deal, service, price, freebie) — 1 short phrase.
Page-level offer context (optional): ${pageOffer || "n/a"}
Return JSON: { "items": [{ "adArchiveId", "hook", "offer" }] }`,
        },
        { role: "user", content: JSON.stringify({ ads: payload }) },
      ],
    });
    const raw = completion.choices[0]?.message?.content || "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return map;
    const parsed = hooksSchema.safeParse(JSON.parse(match[0]));
    if (!parsed.success) return map;
    for (const item of parsed.data.items) {
      if (!item.adArchiveId) continue;
      map.set(item.adArchiveId, {
        hook: (item.hook || "").trim() || map.get(item.adArchiveId)?.hook || "—",
        offer:
          (item.offer || "").trim() || map.get(item.adArchiveId)?.offer || "—",
      });
    }
  } catch (err) {
    console.warn("[sameLandingPageAds] hook/offer LLM failed", err);
  }

  return map;
}

async function fetchMetaCompanyAds(input: {
  pageId: string;
  platform?: AdPlatform | string | null;
}): Promise<RawCompanyAd[]> {
  const platform = String(input.platform || "facebook");
  const seen = new Set<string>();
  const out: RawCompanyAd[] = [];

  for (const country of SEARCH_COUNTRIES) {
    let cursor: string | null = null;
    let pages = 0;
    do {
      let response;
      try {
        response = await getCompanyAds({
          pageId: input.pageId,
          status: "ACTIVE",
          country,
          language: "EN",
          cursor,
          trim: false,
        });
      } catch {
        try {
          response = await getCompanyAds({
            pageId: input.pageId,
            status: "ALL",
            country,
            language: "EN",
            cursor,
            trim: false,
          });
        } catch {
          break;
        }
      }

      pages += 1;
      const ads = extractAds(response);
      cursor = extractCursor(response);

      for (const ad of ads) {
        if (platform === "instagram" && !adRunsOnInstagram(ad)) continue;
        if (platform === "facebook" && !adRunsOnFacebook(ad)) continue;
        const adArchiveId = ad.ad_archive_id ? String(ad.ad_archive_id) : "";
        if (!adArchiveId || seen.has(adArchiveId)) continue;
        seen.add(adArchiveId);

        const copy = extractFullAdCopy(
          ad.snapshot as Parameters<typeof extractFullAdCopy>[0],
        );
        out.push({
          adArchiveId,
          title: copy.title || "",
          body: copy.body || "",
          fullText: copy.fullText || copy.body || "",
          ctaText: copy.ctaText,
          landingPageUrl: copy.landingPageUrl,
          isActive:
            ad.is_active !== false && String(ad.is_active) !== "false",
          daysRunning: daysSince(ad.start_date_string),
          startDate: ad.start_date_string ?? null,
          country,
          adLibraryUrl: `https://www.facebook.com/ads/library/?id=${adArchiveId}`,
        });
      }
    } while (cursor && pages < MAX_PAGES_PER_COUNTRY);
  }

  return out;
}

function dedupeCreatives(ads: SameLandingPageAd[]): SameLandingPageAd[] {
  const seen = new Set<string>();
  const out: SameLandingPageAd[] = [];
  for (const ad of ads) {
    const key = `${ad.hook}|${ad.offer}`.toLowerCase().slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ad);
  }
  return out;
}

/**
 * Fetch advertiser ads, keep those pointing at the analyzed landing page,
 * and extract hook + offer for each.
 */
export async function collectSameLandingPageAds(input: {
  competitor: CompetitorRecord;
  analyzedUrl: string;
  pageOffer?: string | null;
}): Promise<SameLandingPageAdsSummary> {
  const targetKey = landingPageMatchKey(input.analyzedUrl);
  const sampleKey = landingPageMatchKey(input.competitor.sampleAd?.landingPageUrl);
  const matchKeys = new Set(
    [targetKey, sampleKey].filter((k): k is string => Boolean(k)),
  );

  const platform = String(input.competitor.platform || "facebook");
  const isMeta = platform === "facebook" || platform === "instagram";

  if (!isMeta) {
    // Non-Meta: still surface the sample ad if it shares the LP
    const sample = input.competitor.sampleAd;
    const sampleMatches =
      sample &&
      (matchKeys.has(landingPageMatchKey(sample.landingPageUrl) || "") ||
        landingPageMatchKey(sample.landingPageUrl) === targetKey);
    const ads: SameLandingPageAd[] = [];
    if (sample && sampleMatches) {
      ads.push({
        adArchiveId: sample.adArchiveId,
        adLibraryUrl: sample.adLibraryUrl,
        hook: extractAdHook(sample.title, sample.body),
        offer: heuristicOffer(sample.title, sample.body, sample.ctaText),
        title: sample.title,
        bodySnippet: (sample.body || "").slice(0, 220) || null,
        ctaText: sample.ctaText ?? null,
        isActive: true,
        daysRunning: sample.daysRunning,
        startDate: sample.startDate ?? null,
        country: String(input.competitor.country || ""),
      });
    }
    return {
      landingUrl: input.analyzedUrl,
      scannedAds: sample ? 1 : 0,
      matchingAds: ads.length,
      ads,
      note: `${platform} full-library scan isn’t available yet — showing the sample ad when it matches this landing page.`,
    };
  }

  if (!input.competitor.pageId) {
    return {
      landingUrl: input.analyzedUrl,
      scannedAds: 0,
      matchingAds: 0,
      ads: [],
      note: "Missing page id — could not fetch company ads.",
    };
  }

  let raw: RawCompanyAd[] = [];
  try {
    raw = await fetchMetaCompanyAds({
      pageId: input.competitor.pageId,
      platform,
    });
  } catch (err) {
    console.warn("[sameLandingPageAds] fetch failed", err);
    return {
      landingUrl: input.analyzedUrl,
      scannedAds: 0,
      matchingAds: 0,
      ads: [],
      note: `Could not fetch company ads: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Always consider the stored sample ad
  const sample = input.competitor.sampleAd;
  if (sample?.adArchiveId && !raw.some((a) => a.adArchiveId === sample.adArchiveId)) {
    raw.unshift({
      adArchiveId: sample.adArchiveId,
      title: sample.title || "",
      body: sample.body || "",
      fullText: sample.body || "",
      ctaText: sample.ctaText ?? null,
      landingPageUrl: sample.landingPageUrl ?? null,
      isActive: true,
      daysRunning: sample.daysRunning,
      startDate: sample.startDate ?? null,
      country: String(input.competitor.country || ""),
      adLibraryUrl: sample.adLibraryUrl,
    });
  }

  const matching = raw.filter((ad) => {
    if (!isLandingPageUrl(ad.landingPageUrl) && !ad.landingPageUrl) return false;
    const key = landingPageMatchKey(ad.landingPageUrl);
    if (!key) return false;
    if (matchKeys.size === 0) return false;
    return matchKeys.has(key);
  });

  // If nothing matched (URL variants / redirects), fall back to sample when present
  const pool =
    matching.length > 0
      ? matching
      : sample?.landingPageUrl &&
          landingPageMatchKey(sample.landingPageUrl) &&
          (targetKey === landingPageMatchKey(sample.landingPageUrl) ||
            matchKeys.has(landingPageMatchKey(sample.landingPageUrl)!))
        ? raw.filter((a) => a.adArchiveId === sample.adArchiveId)
        : [];

  const enriched = await enrichHooksAndOffers(pool.slice(0, MAX_ADS_IN_UI), input.pageOffer);

  const ads: SameLandingPageAd[] = pool.slice(0, MAX_ADS_IN_UI).map((ad) => {
    const extra = enriched.get(ad.adArchiveId);
    return {
      adArchiveId: ad.adArchiveId,
      adLibraryUrl: ad.adLibraryUrl,
      hook: extra?.hook || extractAdHook(ad.title, ad.body || ad.fullText),
      offer:
        extra?.offer ||
        heuristicOffer(ad.title, ad.body || ad.fullText, ad.ctaText),
      title: ad.title || null,
      bodySnippet: (ad.body || ad.fullText || "").slice(0, 220) || null,
      ctaText: ad.ctaText,
      isActive: ad.isActive,
      daysRunning: ad.daysRunning >= 0 ? ad.daysRunning : null,
      startDate: ad.startDate,
      country: ad.country,
    };
  });

  const unique = dedupeCreatives(ads);

  return {
    landingUrl: input.analyzedUrl,
    scannedAds: raw.length,
    matchingAds: matching.length || unique.length,
    ads: unique,
    note:
      matching.length === 0 && unique.length > 0
        ? "Exact LP matches were sparse; included the sample creative for this page."
        : matching.length > MAX_ADS_IN_UI
          ? `Showing ${unique.length} unique creatives of ${matching.length} ads on this landing page.`
          : null,
  };
}

/**
 * For lookup ads: scan sibling ads in the same lookup job that share the LP.
 */
export async function collectSameLandingPageAdsFromLookup(input: {
  ad: LookupAdRecord;
  siblings: LookupAdRecord[];
  analyzedUrl: string;
  pageOffer?: string | null;
}): Promise<SameLandingPageAdsSummary> {
  const targetKey = landingPageMatchKey(input.analyzedUrl);
  const adKey = landingPageMatchKey(input.ad.landingPageUrl);
  const keys = new Set(
    [targetKey, adKey].filter((k): k is string => Boolean(k)),
  );

  const matching = input.siblings.filter((s) => {
    const k = landingPageMatchKey(s.landingPageUrl);
    return k && keys.has(k);
  });

  const asRaw: RawCompanyAd[] = matching.slice(0, MAX_ADS_IN_UI).map((s) => ({
    adArchiveId: s.adArchiveId,
    title: s.title || "",
    body: s.body || "",
    fullText: s.body || "",
    ctaText: s.ctaText ?? null,
    landingPageUrl: s.landingPageUrl ?? null,
    isActive: Boolean(s.isActive),
    daysRunning: -1,
    startDate: s.startDateString ?? null,
    country: String(s.country || ""),
    adLibraryUrl: s.adLibraryUrl,
  }));

  const enriched = await enrichHooksAndOffers(asRaw, input.pageOffer);

  const ads: SameLandingPageAd[] = asRaw.map((s) => {
    const extra = enriched.get(s.adArchiveId);
    return {
      adArchiveId: s.adArchiveId,
      adLibraryUrl: s.adLibraryUrl,
      hook: extra?.hook || extractAdHook(s.title, s.body),
      offer: extra?.offer || heuristicOffer(s.title, s.body, s.ctaText),
      title: s.title,
      bodySnippet: (s.body || "").slice(0, 220) || null,
      ctaText: s.ctaText,
      isActive: s.isActive,
      daysRunning: null,
      startDate: s.startDate,
      country: s.country,
    };
  });

  return {
    landingUrl: input.analyzedUrl,
    scannedAds: input.siblings.length,
    matchingAds: matching.length,
    ads: dedupeCreatives(ads),
    note: null,
  };
}
