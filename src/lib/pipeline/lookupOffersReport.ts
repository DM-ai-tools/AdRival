import OpenAI from "openai";
import { z } from "zod";
import {
  getLookupAds,
  getLookupJob,
  saveLookupJob,
} from "../db";
import type {
  LookupAdRecord,
  LookupJob,
  LookupOffersReport,
  LookupUniqueAdCreative,
  LookupUniqueLandingPage,
  LookupUniqueOfferLine,
} from "../types";
import { analyzeLookupAdLandingPage } from "./landingPageAnalysis";
import {
  extractAdHook,
  landingPageMatchKey,
} from "./sameLandingPageAds";

const MAX_LP_TO_ANALYZE = 8;
const MAX_CREATIVE_CLUSTERS = 40;
const LP_CONCURRENCY = 2;

function normalizeCopy(title: string, body: string): string {
  return `${title || ""}\n${body || ""}`
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function fingerprint(s: string): string {
  return s.slice(0, 160);
}

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

function normalizeOfferKey(offer: string): string {
  return offer
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

type CreativeCluster = {
  id: string;
  key: string;
  ads: LookupAdRecord[];
  title: string;
  body: string;
  cta: string | null;
  landingPageUrl: string | null;
};

function clusterAdCreatives(ads: LookupAdRecord[]): CreativeCluster[] {
  const buckets = new Map<string, CreativeCluster>();
  for (const ad of ads) {
    const key = fingerprint(normalizeCopy(ad.title, ad.body));
    if (!key || key.length < 8) continue;
    const existing = buckets.get(key);
    if (existing) {
      existing.ads.push(ad);
      continue;
    }
    buckets.set(key, {
      id: `c${buckets.size}`,
      key,
      ads: [ad],
      title: ad.title,
      body: ad.body,
      cta: ad.ctaText || null,
      landingPageUrl: ad.landingPageUrl || ad.youtubeUrl || null,
    });
  }
  return [...buckets.values()]
    .sort((a, b) => b.ads.length - a.ads.length)
    .slice(0, MAX_CREATIVE_CLUSTERS);
}

const creativeLlmSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      hook: z.string(),
      offer: z.string(),
    }),
  ),
});

async function enrichCreativeClusters(
  clusters: CreativeCluster[],
): Promise<Map<string, { hook: string; offer: string }>> {
  const map = new Map<string, { hook: string; offer: string }>();
  for (const c of clusters) {
    map.set(c.id, {
      hook: extractAdHook(c.title, c.body),
      offer: heuristicOffer(c.title, c.body, c.cta),
    });
  }
  if (!process.env.OPENAI_API_KEY || clusters.length === 0) return map;

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You analyze advertising creatives for a competitor lookup report.
For each creative cluster extract:
- hook: attention-grabbing opening / pain / curiosity (1 short sentence)
- offer: what they promise or sell (deal, service, price, freebie) — 1 short phrase
Keep wording concrete. Do not invent prices not in the copy.
Return JSON: { "items": [{ "id", "hook", "offer" }] }`,
        },
        {
          role: "user",
          content: JSON.stringify({
            creatives: clusters.map((c) => ({
              id: c.id,
              title: c.title,
              body: (c.body || "").slice(0, 500),
              cta: c.cta,
              adCount: c.ads.length,
            })),
          }),
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content || "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return map;
    const parsed = creativeLlmSchema.safeParse(JSON.parse(match[0]));
    if (!parsed.success) return map;
    for (const item of parsed.data.items) {
      if (!item.id) continue;
      map.set(item.id, {
        hook: (item.hook || "").trim() || map.get(item.id)?.hook || "—",
        offer: (item.offer || "").trim() || map.get(item.id)?.offer || "—",
      });
    }
  } catch (err) {
    console.warn("[lookupOffersReport] creative LLM failed", err);
  }
  return map;
}

function dedupeOfferLines(
  lines: Array<{
    offer: string;
    source: LookupUniqueOfferLine["source"];
    adCount: number;
    urls?: string[];
    sampleHooks?: string[];
  }>,
): LookupUniqueOfferLine[] {
  const byKey = new Map<string, LookupUniqueOfferLine>();
  for (const line of lines) {
    const offer = (line.offer || "").trim();
    if (!offer || offer === "—" || offer.length < 4) continue;
    const key = normalizeOfferKey(offer);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        offer,
        source: line.source,
        adCount: line.adCount,
        urls: line.urls ? [...line.urls] : undefined,
        sampleHooks: line.sampleHooks ? [...line.sampleHooks] : undefined,
      });
      continue;
    }
    prev.adCount += line.adCount;
    if (line.source !== prev.source) prev.source = "both";
    if (line.urls?.length) {
      prev.urls = [...new Set([...(prev.urls || []), ...line.urls])];
    }
    if (line.sampleHooks?.length) {
      prev.sampleHooks = [
        ...new Set([...(prev.sampleHooks || []), ...line.sampleHooks]),
      ].slice(0, 4);
    }
  }
  return [...byKey.values()].sort((a, b) => b.adCount - a.adCount);
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return out;
}

type LpBucket = {
  matchKey: string;
  url: string;
  ads: LookupAdRecord[];
};

function clusterLandingPages(ads: LookupAdRecord[]): LpBucket[] {
  const buckets = new Map<string, LpBucket>();
  for (const ad of ads) {
    const url = ad.landingPageUrl || ad.youtubeUrl || null;
    const key = landingPageMatchKey(url);
    if (!key || !url) continue;
    // Skip ad-library destinations
    if (
      /facebook\.com\/ads\/library|adstransparency\.google|linkedin\.com\/ad-library/i.test(
        key,
      )
    ) {
      continue;
    }
    const existing = buckets.get(key);
    if (existing) {
      existing.ads.push(ad);
      continue;
    }
    buckets.set(key, { matchKey: key, url, ads: [ad] });
  }
  return [...buckets.values()].sort((a, b) => b.ads.length - a.ads.length);
}

/**
 * Build unique ad-copy + unique landing-page offers report for a lookup job.
 */
export async function buildLookupOffersReport(
  lookupId: string,
  options?: { forceReanalyzePages?: boolean },
): Promise<LookupOffersReport> {
  const now = new Date().toISOString();
  const ads = getLookupAds(lookupId);
  if (ads.length === 0) {
    return {
      status: "failed",
      createdAt: now,
      updatedAt: now,
      error: "No ads to analyze",
      adsAnalyzed: 0,
      adCopy: { uniqueCreatives: 0, creatives: [], uniqueOffers: [] },
      landingPages: {
        uniqueUrls: 0,
        analyzed: 0,
        failed: 0,
        pages: [],
        uniqueOffers: [],
      },
    };
  }

  // —— Ad copy clusters ——
  const clusters = clusterAdCreatives(ads);
  const enriched = await enrichCreativeClusters(clusters);
  const creatives: LookupUniqueAdCreative[] = clusters.map((c) => {
    const hit = enriched.get(c.id);
    return {
      id: c.id,
      hook: hit?.hook || extractAdHook(c.title, c.body),
      offer: hit?.offer || heuristicOffer(c.title, c.body, c.cta),
      sampleCopy: `${c.title}${c.body ? ` — ${c.body.slice(0, 160)}` : ""}`.slice(
        0,
        220,
      ),
      adCount: c.ads.length,
      sampleAdIds: c.ads.slice(0, 5).map((a) => a.id),
      landingPageUrl: c.landingPageUrl,
    };
  });

  const adCopyOffers = dedupeOfferLines(
    creatives.map((c) => ({
      offer: c.offer,
      source: "ad_copy" as const,
      adCount: c.adCount,
      sampleHooks: [c.hook],
      urls: c.landingPageUrl ? [c.landingPageUrl] : undefined,
    })),
  );

  // —— Unique landing pages ——
  const lpBuckets = clusterLandingPages(ads);
  const toAnalyze = lpBuckets.slice(0, MAX_LP_TO_ANALYZE);
  const skipped = lpBuckets.slice(MAX_LP_TO_ANALYZE);

  const analyzedPages = await mapPool(toAnalyze, LP_CONCURRENCY, async (bucket) => {
    const representative =
      bucket.ads.find(
        (a) =>
          a.pageAnalysis?.status === "completed" &&
          a.pageAnalysis.offer?.primaryOffer &&
          !options?.forceReanalyzePages,
      ) || bucket.ads[0];

    // Reuse completed analysis when available
    if (
      !options?.forceReanalyzePages &&
      representative.pageAnalysis?.status === "completed" &&
      representative.pageAnalysis.offer
    ) {
      const o = representative.pageAnalysis.offer;
      return {
        url: representative.pageAnalysis.analyzedUrl || bucket.url,
        matchKey: bucket.matchKey,
        adCount: bucket.ads.length,
        status: "completed" as const,
        headline: o.headline ?? null,
        primaryOffer: o.primaryOffer,
        pricing: o.pricing ?? null,
        cta: o.cta ?? null,
        uniqueValueProps: o.uniqueValueProps || [],
        summary: representative.pageAnalysis.summary ?? null,
        error: null,
        sampleAdId: representative.id,
      } satisfies LookupUniqueLandingPage;
    }

    try {
      const updated = await analyzeLookupAdLandingPage(representative.id);
      const analysis = updated.pageAnalysis;
      const o = analysis?.offer;
      if (!analysis || analysis.status === "failed" || !o?.primaryOffer) {
        return {
          url: bucket.url,
          matchKey: bucket.matchKey,
          adCount: bucket.ads.length,
          status: "failed" as const,
          primaryOffer: null,
          error:
            analysis?.error || "Landing page analysis returned no offer",
          sampleAdId: representative.id,
        } satisfies LookupUniqueLandingPage;
      }
      return {
        url: analysis.analyzedUrl || bucket.url,
        matchKey: bucket.matchKey,
        adCount: bucket.ads.length,
        status: "completed" as const,
        headline: o.headline ?? null,
        primaryOffer: o.primaryOffer,
        pricing: o.pricing ?? null,
        cta: o.cta ?? null,
        uniqueValueProps: o.uniqueValueProps || [],
        summary: analysis.summary ?? null,
        error: null,
        sampleAdId: representative.id,
      } satisfies LookupUniqueLandingPage;
    } catch (err) {
      return {
        url: bucket.url,
        matchKey: bucket.matchKey,
        adCount: bucket.ads.length,
        status: "failed" as const,
        primaryOffer: null,
        error: err instanceof Error ? err.message : String(err),
        sampleAdId: representative.id,
      } satisfies LookupUniqueLandingPage;
    }
  });

  const skippedPages: LookupUniqueLandingPage[] = skipped.map((b) => ({
    url: b.url,
    matchKey: b.matchKey,
    adCount: b.ads.length,
    status: "skipped",
    primaryOffer: null,
    error: `Skipped (analyzed top ${MAX_LP_TO_ANALYZE} destinations by ad volume)`,
    sampleAdId: b.ads[0]?.id || null,
  }));

  const pages = [...analyzedPages, ...skippedPages];
  const lpOffers = dedupeOfferLines(
    pages
      .filter((p) => p.status === "completed" && p.primaryOffer)
      .map((p) => ({
        offer: p.primaryOffer!,
        source: "landing_page" as const,
        adCount: p.adCount,
        urls: [p.url],
        sampleHooks: p.headline ? [p.headline] : undefined,
      })),
  );

  const analyzedCount = pages.filter((p) => p.status === "completed").length;
  const failedCount = pages.filter((p) => p.status === "failed").length;

  const summary = [
    `${ads.length} ads`,
    `${creatives.length} unique creatives`,
    `${adCopyOffers.length} unique ad offers`,
    `${lpBuckets.length} unique landing pages`,
    `${analyzedCount} LPs analyzed`,
    `${lpOffers.length} unique LP offers`,
  ].join(" · ");

  return {
    status: "completed",
    createdAt: now,
    updatedAt: new Date().toISOString(),
    error: null,
    summary,
    adsAnalyzed: ads.length,
    adCopy: {
      uniqueCreatives: creatives.length,
      creatives,
      uniqueOffers: adCopyOffers,
    },
    landingPages: {
      uniqueUrls: lpBuckets.length,
      analyzed: analyzedCount,
      failed: failedCount,
      pages,
      uniqueOffers: lpOffers,
    },
  };
}

function patchLookupJob(job: LookupJob, patch: Partial<LookupJob>) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  saveLookupJob(job);
}

/**
 * Run after ads are fetched: analyze unique creatives + LPs, persist on the job.
 * Keeps status "running" until the report finishes so the client keeps polling.
 */
export async function runLookupOffersReportPhase(
  lookupId: string,
  options?: {
    force?: boolean;
    /** Final job status after report (default completed if ads exist) */
    finalStatus?: "completed" | "partial";
  },
): Promise<LookupJob | null> {
  const job = getLookupJob(lookupId);
  if (!job) return null;

  const ads = getLookupAds(lookupId);
  const finalStatus =
    options?.finalStatus || (ads.length > 0 ? "completed" : "partial");

  if (
    !options?.force &&
    job.offersReport?.status === "completed" &&
    job.offersReport.adsAnalyzed === ads.length
  ) {
    patchLookupJob(job, {
      status: finalStatus,
      progress: {
        ...job.progress,
        stage: "done",
        adsFetched: ads.length,
        message:
          job.progress.message ||
          `Loaded ${ads.length} ads · offers report ready.`,
      },
    });
    return getLookupJob(lookupId);
  }

  const pending: LookupOffersReport = {
    status: "pending",
    createdAt: job.offersReport?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
    adsAnalyzed: ads.length,
    adCopy: { uniqueCreatives: 0, creatives: [], uniqueOffers: [] },
    landingPages: {
      uniqueUrls: 0,
      analyzed: 0,
      failed: 0,
      pages: [],
      uniqueOffers: [],
    },
  };

  patchLookupJob(job, {
    status: "running",
    offersReport: pending,
    progress: {
      ...job.progress,
      stage: "analyzing_offers",
      adsFetched: ads.length,
      message: `Analyzing ${ads.length} ad copies and unique landing pages for offers…`,
    },
  });

  try {
    const report = await buildLookupOffersReport(lookupId, {
      forceReanalyzePages: Boolean(options?.force),
    });
    const offerCount =
      report.adCopy.uniqueOffers.length + report.landingPages.uniqueOffers.length;
    patchLookupJob(job, {
      status: finalStatus,
      offersReport: report,
      progress: {
        ...job.progress,
        stage: "done",
        adsFetched: ads.length,
        message:
          ads.length > 0
            ? `Loaded ${ads.length} ads · ${offerCount} unique offers across creatives & landing pages.`
            : job.progress.message,
      },
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    patchLookupJob(job, {
      status: finalStatus,
      offersReport: {
        ...pending,
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: message,
      },
      progress: {
        ...job.progress,
        stage: "done",
        adsFetched: ads.length,
        message: `Loaded ${ads.length} ads · offers analysis failed: ${message}`,
      },
    });
  }

  return getLookupJob(lookupId);
}
