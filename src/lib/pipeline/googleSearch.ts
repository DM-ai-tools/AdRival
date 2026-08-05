import { v4 as uuidv4 } from "uuid";
import {
  extractGoogleAds,
  extractGoogleAdsEstimate,
  extractGoogleAdvertisers,
  extractGoogleCursor,
  extractGoogleWebsites,
  getGoogleAdDetails,
  getGoogleCompanyAds,
  googleSearch,
  normalizeList,
  searchGoogleAdvertisers,
  type GoogleAdCreative,
} from "../sociavault/client";
import {
  analyzeAdCandidate,
  expandKeywordQueries,
  pickCompanyPageMatch,
  pickGoogleAdDomains,
  proposeAgencyDomains,
  serviceKeywordOverlapScore,
} from "../openai/analyzer";
import {
  isSearchJobSuppressed,
  saveCompetitor,
  saveJob,
  saveLookupAd,
  saveLookupJob,
} from "../db";
import { runLookupOffersReportPhase } from "./lookupOffersReport";
import {
  TARGET_COMPETITORS,
  type AdCandidate,
  type BrandReview,
  type CompetitorRecord,
  type LookupAdRecord,
  type LookupJob,
  type LookupPageCandidate,
  type SearchJob,
  type ServiceLabel,
} from "../types";
import type { AdPlatform } from "../platforms";
import {
  daysFromDateRange,
  getPlatformAdThresholds,
  meetsActiveAdsThreshold,
  meetsDurationThreshold,
  parseKeywords,
} from "../platforms";
import { newId, runBrandReview } from "./brandReview";
import {
  mapGoogleCreativeToCandidate,
  sampleAdFromGoogleCandidate,
} from "./adMappers";
import {
  isYouTubeUrl,
  normalizeWebsiteUrl,
  sanitizeBrandForPlatform,
} from "./linkGuards";
import { enrichLookupPageMetrics } from "./lookupEnrichment";

const MAX_DOMAIN_AD_PAGES = 10;
const MAX_ADS_PAGES = 15;
const MAX_DOMAINS_PER_QUERY = 12;
/** Transparency region that returns creatives across countries (US alone under-counts). */
const GOOGLE_ADS_REGION = "all";
/** Cap hard-verify calls per query — each is a SociaVault credit. */
const MAX_DOMAIN_VERIFY = 8;

function normalizeDomainQuery(query: string): string | null {
  const q = query
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "")
    .replace(/\s+/g, "");
  if (!q.includes(".")) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(q)) return null;
  return q;
}

function creativeKey(ad: GoogleAdCreative): string {
  return (
    String(ad.creativeId || "") ||
    String(ad.adUrl || "") ||
    `${ad.advertiserId || ""}:${ad.firstShown || ""}:${ad.format || ""}`
  );
}

async function fetchGoogleAdsPages(params: {
  advertiser_id?: string;
  domain?: string;
  region?: string;
  maxPages?: number;
  onPage?: (info: {
    page: number;
    batch: number;
    total: number;
    estimate: number | null;
  }) => void;
}): Promise<{ ads: GoogleAdCreative[]; estimate: number | null }> {
  const out: GoogleAdCreative[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let estimate: number | null = null;
  const maxPages = params.maxPages ?? MAX_ADS_PAGES;

  do {
    const res = await getGoogleCompanyAds({
      advertiser_id: params.advertiser_id,
      domain: params.domain,
      region: params.region ?? GOOGLE_ADS_REGION,
      cursor,
    });
    const batch = extractGoogleAds(res);
    estimate = extractGoogleAdsEstimate(res) ?? estimate;
    for (const ad of batch) {
      const key = creativeKey(ad);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(ad);
    }
    cursor = extractGoogleCursor(res);
    pages += 1;
    params.onPage?.({
      page: pages,
      batch: batch.length,
      total: out.length,
      estimate,
    });
  } while (cursor && pages < maxPages);

  return { ads: out, estimate };
}

function domainFromUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (!host.includes(".") || host.length < 4) return null;
    if (
      /(facebook|instagram|linkedin|youtube|google|twitter|tiktok|wikipedia|yelp|clutch|g2)\./i.test(
        host,
      )
    ) {
      return null;
    }
    return host;
  } catch {
    return null;
  }
}

/** Web-search + Transparency domains, then LLM-rank + hard SociaVault verify. */
async function discoverAndVerifyDomains(args: {
  query: string;
  platform: "google" | "youtube";
  transparencyDomains: string[];
  advertisers: Array<{ name: string; region?: string | null }>;
  businessProfile?: import("../types").BusinessProfile | null;
  /** ISO country for web search bias (AU, US, …); Transparency ads still use "all". */
  webRegion?: string;
  onProgress: (message: string) => void;
}): Promise<{ domains: string[]; reason: string; verifiedAdsSample: number }> {
  const {
    query,
    platform,
    transparencyDomains,
    advertisers,
    businessProfile,
    webRegion,
    onProgress,
  } = args;

  const snippets: Array<{ title?: string; url?: string; description?: string }> =
    [];
  const webDomains: string[] = [];
  const profile = businessProfile || null;
  const industry = profile?.industry || "";
  const searchRegion =
    webRegion && webRegion !== "all" ? webRegion.toUpperCase() : "US";

  const searchQueries = profile
    ? [
        query,
        `${query} ${industry}`.trim(),
        ...(profile.offerings || []).slice(0, 2).map((o) => `${o} ${query}`.trim()),
        platform === "youtube" ? `${query} YouTube ads` : `${query} Google ads`,
      ].filter(Boolean)
    : [
        `${query} marketing agency`,
        `${query} Google Ads agency`,
        `${query} PPC agency`,
        platform === "youtube"
          ? `${query} YouTube ads agency`
          : `${query} digital marketing agency`,
      ];

  onProgress(
    profile
      ? `Web-searching competitor domains for "${query}"…`
      : `Web-searching agency domains for "${query}"…`,
  );
  for (const q of searchQueries.slice(0, 3)) {
    try {
      const res = await googleSearch(q, searchRegion);
      const results = normalizeList<{
        title?: string;
        url?: string;
        description?: string;
      }>(res.data?.results);
      for (const r of results.slice(0, 10)) {
        snippets.push(r);
        const d = domainFromUrl(r.url);
        if (d) webDomains.push(d);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/credit|quota|402|401|403|rate limited/i.test(msg)) throw err;
    }
  }

  let proposed: string[] = [];
  try {
    const prop = await proposeAgencyDomains(query, platform, 8, profile);
    proposed = prop.domains;
  } catch {
    /* optional */
  }

  // Prefer Transparency websites first — they already advertise on Google
  const candidatePool = Array.from(
    new Set([
      ...transparencyDomains.map((d) => domainFromUrl(d) || d).filter(Boolean),
      ...webDomains,
      ...proposed,
    ]),
  ) as string[];

  onProgress(
    `LLM ranking ${candidatePool.length} domains (Transparency + web)…`,
  );
  let ranked: string[] = [];
  let reason = "";
  try {
    const pick = await pickGoogleAdDomains(query, candidatePool, advertisers, {
      platform,
      limit: MAX_DOMAINS_PER_QUERY,
      webSnippets: snippets,
      businessProfile: profile,
    });
    ranked = pick.domains;
    reason = pick.reason;
  } catch {
    // Prefer transparency domains when LLM ranking fails
    ranked = (
      transparencyDomains.length
        ? [
            ...transparencyDomains,
            ...candidatePool.filter((d) => !transparencyDomains.includes(d)),
          ]
        : candidatePool
    ).slice(0, MAX_DOMAINS_PER_QUERY);
    reason = "Fallback domain list (LLM ranking unavailable)";
  }

  // Hard verify: domain must return ≥1 public creative (any format).
  // YouTube video filter applies later when accepting — requiring video here
  // dropped lenders that only show video on later pages.
  const toVerify = ranked.slice(0, MAX_DOMAIN_VERIFY);
  onProgress(`Verifying ${toVerify.length} domains in Google Transparency…`);
  const verified: string[] = [];
  let verifiedAdsSample = 0;
  for (const domain of toVerify) {
    if (verified.length >= MAX_DOMAINS_PER_QUERY) break;
    try {
      const adsRes = await getGoogleCompanyAds({
        domain,
        region: GOOGLE_ADS_REGION,
      });
      const ads = extractGoogleAds(adsRes);
      if (ads.length > 0) {
        verified.push(domain);
        verifiedAdsSample += ads.length;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/credit|quota|402|401|403|rate limited/i.test(msg)) throw err;
      // skip domains that error individually
    }
  }

  if (verified.length === 0) {
    // Transparency domains already came from search-advertisers — try them raw
    const fallback = transparencyDomains
      .map((d) => domainFromUrl(d) || d)
      .filter(Boolean)
      .slice(0, 6) as string[];
    return {
      domains: fallback,
      reason: `${reason} · 0/${toVerify.length} hard-verified — using Transparency website list`,
      verifiedAdsSample: 0,
    };
  }

  return {
    domains: verified,
    reason: `${reason} · verified ${verified.length}/${toVerify.length} with public ads`,
    verifiedAdsSample,
  };
}

async function enrichGoogleAd(ad: GoogleAdCreative) {
  if (!ad.adUrl) {
    return {
      title: "",
      body: "",
      cta: null as string | null,
      landing: null as string | null,
      youtubeUrl: null as string | null,
      visibleUrl: null as string | null,
      firstShown: ad.firstShown || null,
      lastShown: ad.lastShown || null,
      format: ad.format || null,
    };
  }
  try {
    const details = await getGoogleAdDetails(ad.adUrl);
    const data = details.data || {};
    const variations = data.variations;
    const list = Array.isArray(variations)
      ? variations
      : variations
        ? Object.values(variations as Record<string, unknown>)
        : [];
    const ranked = [...list].sort((a, b) => {
      const aa = a as { destinationUrl?: string; youtubeUrl?: string | null };
      const bb = b as { destinationUrl?: string; youtubeUrl?: string | null };
      const sa = (aa.destinationUrl ? 2 : 0) + (aa.youtubeUrl ? 2 : 0);
      const sb = (bb.destinationUrl ? 2 : 0) + (bb.youtubeUrl ? 2 : 0);
      return sb - sa;
    });
    const first = (ranked[0] || {}) as {
      headline?: string;
      description?: string;
      destinationUrl?: string;
      visibleUrl?: string;
      youtubeUrl?: string | null;
    };
    return {
      title: first.headline || "",
      body: first.description || "",
      cta: null as string | null,
      landing: first.destinationUrl || null,
      youtubeUrl: first.youtubeUrl || null,
      visibleUrl: first.visibleUrl || null,
      firstShown:
        (data.firstShown as string | null | undefined) || ad.firstShown || null,
      lastShown:
        (data.lastShown as string | null | undefined) || ad.lastShown || null,
      format: (data.format as string | undefined) || ad.format || null,
    };
  } catch {
    return {
      title: "",
      body: "",
      cta: null as string | null,
      landing: null as string | null,
      youtubeUrl: null as string | null,
      visibleUrl: null as string | null,
      firstShown: ad.firstShown || null,
      lastShown: ad.lastShown || null,
      format: ad.format || null,
    };
  }
}

function isYouTubeCreative(
  ad: GoogleAdCreative,
  details?: { youtubeUrl?: string | null },
): boolean {
  const format = String(ad.format || "").toLowerCase();
  return format === "video" || Boolean(details?.youtubeUrl);
}

function websiteUrl(domain: string): string {
  const d = domain.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return `https://${d}`;
}

async function fetchAdsForDomain(domain: string, region = GOOGLE_ADS_REGION) {
  const { ads } = await fetchGoogleAdsPages({
    domain,
    region,
    maxPages: MAX_DOMAIN_AD_PAGES,
  });
  return ads;
}

/**
 * Domain-first Google / YouTube search:
 * 1) search-advertisers → websites + advertisers
 * 2) LLM picks domains likely running ads
 * 3) company-ads by domain
 * 4) YouTube keeps video-format creatives only
 */
export async function runGoogleFamilySearch(
  jobId: string,
  keywordInput: string | string[],
  platform: Extract<AdPlatform, "google" | "youtube">,
  options?: import("./searchOptions").SearchDispatchOptions,
) {
  const keywords = parseKeywords(keywordInput);
  const now = new Date().toISOString();
  const geo = options?.geo || "all";
  const businessProfile = options?.businessProfile || null;
  const businessUrl =
    (options?.businessUrl || businessProfile?.url || "").trim() || null;
  const job: SearchJob = {
    id: jobId,
    keyword: keywords.join(", "),
    keywords,
    platform,
    geo,
    geoMode: options?.geoMode || "countrywide",
    selectedCategory: options?.selectedCategory || null,
    targetLocations: options?.targetLocations || [],
    keywordLocation: options?.keywordLocation || null,
    businessUrl,
    businessProfile,
    status: "running",
    progress: {
      stage: "expanding_queries",
      scannedAds: 0,
      scannedPages: 0,
      accepted: 0,
      target: TARGET_COMPETITORS,
      rejected: 0,
      message: businessProfile
        ? `Discovering ${platform} competitors for ${businessProfile.industry}…`
        : `Discovering ${platform} advertiser domains…`,
    },
    competitorIds: [],
    createdAt: now,
    updatedAt: now,
  };
  saveJob(job);

  const accepted: CompetitorRecord[] = [];
  const seenDomains = new Set<string>();
  const seenAdvertisers = new Set<string>();
  const thresholds = getPlatformAdThresholds(platform);

  try {
    const queries = new Set<string>(keywords);
    for (const kw of keywords) {
      try {
        for (const q of await expandKeywordQueries(kw, businessProfile, {
          geoMode: job.geoMode,
          targetLocations: job.targetLocations,
          selectedCategory: job.selectedCategory,
        }))
          queries.add(q);
      } catch {
        /* keep seed */
      }
    }
    if (
      job.geoMode === "company_locations" ||
      job.geoMode === "keyword_location"
    ) {
      for (const loc of (job.targetLocations || []).slice(0, 4)) {
        const place = loc.suburb || loc.city || loc.label;
        if (!place) continue;
        for (const kw of keywords.slice(0, 3)) queries.add(`${kw} ${place}`);
      }
    }

    outer: for (const query of Array.from(queries).slice(0, 18)) {
      if (accepted.length >= TARGET_COMPETITORS) break;
      if (isSearchJobSuppressed(jobId)) break outer;

      job.progress.stage = "finding_domains";
      job.progress.message = `Web + Transparency domain discovery for "${query}"…`;
      job.updatedAt = new Date().toISOString();
      saveJob(job);

      let transparencyDomains: string[] = [];
      let advertisersRaw: Awaited<
        ReturnType<typeof extractGoogleAdvertisers>
      > = [];
      let advertisers: Array<{ name: string; region?: string | null }> = [];
      try {
        const res = await searchGoogleAdvertisers(query);
        transparencyDomains = extractGoogleWebsites(res);
        advertisersRaw = extractGoogleAdvertisers(res);
        advertisers = advertisersRaw.map((a) => ({
          name: String(a.name || ""),
          region: a.region ? String(a.region) : null,
        }));
        job.progress.scannedPages += 1;
      } catch (err) {
        job.progress.message = `Transparency search warning: ${(err as Error).message}`;
        saveJob(job);
      }

      // 1) Transparency advertiser IDs first — already keyword-matched, cheap vs domain verify
      const advertiserBatch = advertisersRaw.slice(0, 14);
      if (advertiserBatch.length > 0) {
        job.progress.stage = "fetching_ads";
        job.progress.message = `Fetching ads for ${advertiserBatch.length} Transparency advertisers…`;
        saveJob(job);
        for (const adv of advertiserBatch) {
          if (accepted.length >= TARGET_COMPETITORS) break outer;
          const id = String(adv.advertiser_id || "");
          if (!id || seenAdvertisers.has(id)) continue;
          seenAdvertisers.add(id);
          try {
            const adsRes = await getGoogleCompanyAds({
              advertiser_id: id,
              region: GOOGLE_ADS_REGION,
            });
            let ads = extractGoogleAds(adsRes);
            if (platform === "youtube") {
              ads = ads.filter((ad) => isYouTubeCreative(ad));
            }
            job.progress.scannedAds += ads.length;
            job.progress.scannedPages += 1;
            if (ads.length === 0) continue;
            await tryAcceptFromAds({
              ads,
              job,
              accepted,
              keywords,
              query,
              platform,
              thresholds,
              domain: String(adv.name || id),
              pageId: id,
              pageName: String(adv.name || "Unknown"),
              country: adv.region ? String(adv.region) : String(job.geo || "US"),
              websiteHint: null,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/credit|quota|402|401|403|rate limited/i.test(msg)) throw err;
            job.progress.rejected += 1;
          }
        }
      }

      if (accepted.length >= TARGET_COMPETITORS) break outer;

      // Skip expensive domain verify when advertisers already filled most of the target
      if (accepted.length >= Math.max(4, Math.ceil(TARGET_COMPETITORS * 0.6))) {
        continue;
      }

      // 2) Domain discovery fills gaps when advertisers alone aren't enough
      job.progress.stage = "ranking_domains";
      let rankedDomains: string[] = [];
      try {
        const discovered = await discoverAndVerifyDomains({
          query,
          platform,
          transparencyDomains,
          advertisers,
          businessProfile,
          webRegion: geo,
          onProgress: (message) => {
            job.progress.stage = /Verifying/i.test(message)
              ? "verifying_domains"
              : "ranking_domains";
            job.progress.message = message;
            saveJob(job);
          },
        });
        rankedDomains = discovered.domains;
        if (discovered.verifiedAdsSample > 0) {
          job.progress.scannedAds += discovered.verifiedAdsSample;
        }
        job.progress.message = `Selected ${rankedDomains.length} domains — ${discovered.reason.slice(0, 180)}`;
        saveJob(job);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/credit|quota|402|401|403|rate limited/i.test(msg)) {
          throw err;
        }
        rankedDomains = transparencyDomains.slice(0, MAX_DOMAINS_PER_QUERY);
        job.progress.message = `Domain discovery fallback: ${msg}`;
        saveJob(job);
      }

      if (
        rankedDomains.length === 0 &&
        accepted.length === 0 &&
        advertiserBatch.length === 0
      ) {
        job.progress.message = `No verified domains/advertisers with ads for "${query}"`;
        saveJob(job);
        continue;
      }

      for (const domain of rankedDomains) {
        if (accepted.length >= TARGET_COMPETITORS) break outer;
        const key = domain.toLowerCase();
        if (seenDomains.has(key)) continue;
        seenDomains.add(key);

        job.progress.stage = "fetching_ads";
        job.progress.message = `Fetching ${platform} ads for ${domain}…`;
        saveJob(job);

        let ads: GoogleAdCreative[] = [];
        try {
          // Use "all" so AU/US geo doesn't hide creatives found during verify
          ads = await fetchAdsForDomain(domain, GOOGLE_ADS_REGION);
          job.progress.scannedPages += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/credit|quota|402|401|403|rate limited/i.test(msg)) throw err;
          job.progress.rejected += 1;
          job.progress.message = `Domain ${domain} failed: ${msg}`;
          saveJob(job);
          continue;
        }

        // YouTube: only video-format creatives
        if (platform === "youtube") {
          ads = ads.filter((ad) => isYouTubeCreative(ad));
        }

        job.progress.scannedAds += ads.length;

        if (ads.length === 0) {
          job.progress.message = `No public creatives for ${domain}`;
          saveJob(job);
          continue;
        }

        // Group by advertiser so one domain can yield multiple competitors
        const byAdvertiser = new Map<string, GoogleAdCreative[]>();
        for (const ad of ads) {
          const aid =
            String(ad.advertiserId || "") ||
            String(ad.advertiserName || domain);
          const list = byAdvertiser.get(aid) ?? [];
          list.push(ad);
          byAdvertiser.set(aid, list);
        }

        for (const [pageId, advAds] of byAdvertiser) {
          if (accepted.length >= TARGET_COMPETITORS) break outer;
          if (seenAdvertisers.has(pageId)) continue;
          seenAdvertisers.add(pageId);

          const pageName =
            String(advAds[0]?.advertiserName || domain).trim() || domain;

          await tryAcceptFromAds({
            ads: advAds,
            job,
            accepted,
            keywords,
            query,
            platform,
            thresholds,
            domain,
            pageId,
            pageName,
            country: String(job.geo || "US"),
            websiteHint: websiteUrl(domain),
          });
        }
      }
    }

    job.status =
      accepted.length >= TARGET_COMPETITORS
        ? "completed"
        : accepted.length > 0
          ? "partial"
          : "failed";
    job.progress.stage = "done";
    job.progress.message =
      accepted.length > 0
        ? `Found ${accepted.length} competitors on ${platform} via domain discovery.`
        : `No qualifying competitors found on ${platform}.`;
    job.updatedAt = new Date().toISOString();
    saveJob(job);
  } catch (err) {
    job.status = "failed";
    job.error = (err as Error).message;
    job.progress.stage = "failed";
    job.progress.message = (err as Error).message;
    job.updatedAt = new Date().toISOString();
    saveJob(job);
  }
}

async function tryAcceptFromAds(args: {
  ads: GoogleAdCreative[];
  job: SearchJob;
  accepted: CompetitorRecord[];
  keywords: string[];
  query: string;
  platform: "google" | "youtube";
  thresholds: ReturnType<typeof getPlatformAdThresholds>;
  domain: string;
  pageId: string;
  pageName: string;
  country: string;
  websiteHint: string | null;
}) {
  const {
    ads,
    job,
    accepted,
    keywords,
    query,
    platform,
    thresholds,
    domain,
    pageId,
    pageName,
    country,
    websiteHint,
  } = args;

  if (isSearchJobSuppressed(job.id)) return;

  let pool = ads;
  if (platform === "youtube") {
    pool = ads.filter((ad) => isYouTubeCreative(ad));
  }
  if (pool.length === 0) {
    job.progress.rejected += 1;
    return;
  }

  const durationQualified = thresholds.skipDuration
    ? pool
    : pool.filter((ad) =>
        meetsDurationThreshold(
          daysFromDateRange(ad.firstShown, ad.lastShown),
          thresholds,
        ),
      );
  const sampleSource =
    durationQualified.length > 0 ? durationQualified : pool;

  const enriched: AdCandidate[] = [];
  for (const ad of sampleSource.slice(0, 8)) {
    const details = await enrichGoogleAd(ad);
    if (platform === "youtube" && !isYouTubeCreative(ad, details)) continue;
    enriched.push(mapGoogleCreativeToCandidate(ad, details));
  }

  if (enriched.length === 0) {
    job.progress.rejected += 1;
    return;
  }

  const primary = [...enriched].sort((a, b) => {
    const score = (c: AdCandidate) => {
      const text = `${c.title}\n${c.body}\n${c.fullText}`;
      const hasCopy = (c.body || c.fullText || c.title || "").trim().length;
      const kw =
        serviceKeywordOverlapScore(text, {
          businessProfile: job.businessProfile,
          searchKeywords: keywords,
          selectedCategory: job.selectedCategory,
        }) * 40;
      return (
        kw +
        (hasCopy >= 40 ? 80 : hasCopy >= 10 ? 30 : -100) +
        (c.landingPageUrl ? 50 : 0) +
        (c.title ? 20 : 0) +
        (c.daysRunning >= 0 ? 15 : 0) +
        (c.fullText?.length || 0) / 50
      );
    };
    return score(b) - score(a);
  })[0];

  const primaryCopy = (
    primary.fullText ||
    primary.body ||
    primary.title ||
    ""
  ).trim();
  if (primaryCopy.length < 12) {
    job.progress.rejected += 1;
    job.progress.message = `Skipped ${pageName}: creatives had no readable ad copy`;
    saveJob(job);
    return;
  }

  if (!meetsDurationThreshold(primary.daysRunning, thresholds)) {
    job.progress.rejected += 1;
    return;
  }

  let filter;
  try {
    job.progress.stage = "analyzing_ad";
    job.progress.message = `LLM reviewing ${pageName}…`;
    saveJob(job);
    filter = await analyzeAdCandidate(
      keywords[0] || query,
      primary,
      null,
      enriched.filter((a) => a.adArchiveId !== primary.adArchiveId).slice(0, 5),
      {
        relaxed: accepted.length >= 2,
        businessProfile: job.businessProfile,
        searchKeywords: keywords,
        selectedCategory: job.selectedCategory,
      },
    );
  } catch {
    job.progress.rejected += 1;
    return;
  }

  if (
    !filter.relevant ||
    (!job.businessProfile && !filter.isMarketingAgency)
  ) {
    job.progress.rejected += 1;
    return;
  }

  const activeCount = durationQualified.length > 0
    ? durationQualified.length
    : pool.length;

  if (!meetsActiveAdsThreshold(activeCount, thresholds)) {
    job.progress.rejected += 1;
    job.progress.message = `Skipped ${pageName}: ${activeCount} ads (need ≥${thresholds.minActiveAds})`;
    saveJob(job);
    return;
  }

  const snap = primary.snapshot as GoogleAdCreative & {
    _details?: { youtubeUrl?: string | null };
  };
  const domainHint = snap.domain || domain;
  const website =
    normalizeWebsiteUrl(websiteHint) ||
    (domainHint ? websiteUrl(domainHint) : null);
  const creativeYt = isYouTubeUrl(snap._details?.youtubeUrl)
    ? String(snap._details?.youtubeUrl)
    : null;

  let brand: BrandReview = {
    website,
    category:
      platform === "youtube" ? "YouTube advertiser" : "Google advertiser",
    youtubeUrl: creativeYt,
  };

  const {
    cheapLocationFromText,
    resolveAndMatchCompetitorLocation,
  } = await import("./competitorLocation");
  const { updateCompetitor } = await import("../db");

  const provisional = cheapLocationFromText({
    pageName,
    adText: primary.fullText || primary.body,
    landingUrl: primary.landingPageUrl || website,
    targets: job.targetLocations || [],
    geoMode: job.geoMode || "countrywide",
  });

  const sampleAd = sampleAdFromGoogleCandidate(primary, platform, domainHint);

  // Save first — never block on location
  const competitor: CompetitorRecord = {
    id: newId(),
    runId: job.id,
    pageId,
    pageName,
    country,
    platform,
    locationLabel: provisional.locationLabel,
    locationCity: provisional.locationCity,
    locationSuburb: provisional.locationSuburb,
    locationCountry: provisional.locationCountry,
    locationStatus: provisional.locationStatus,
    locationSource: provisional.locationSource,
    activeAdsCount: activeCount,
    services: filter.services as ServiceLabel[],
    sampleAd,
    brand,
    createdAt: new Date().toISOString(),
  };

  saveCompetitor(competitor);
  accepted.push(competitor);
  job.competitorIds.push(competitor.id);
  job.progress.accepted = accepted.length;
  job.progress.message = `Accepted ${pageName} (${accepted.length}/${TARGET_COMPETITORS}) via ${domain} — location pending…`;
  saveJob(job);

  // Enrich brand + location after accept
  job.progress.stage = "brand_review";
  job.progress.message = `Enriching brand for ${pageName}…`;
  saveJob(job);
  try {
    brand = await runBrandReview({
      pageId,
      pageName,
      websiteHint: website,
      youtubeUrlHint: creativeYt,
      youtubeHandleHint: null,
      categoryHint:
        platform === "youtube" ? "YouTube advertiser" : "Google advertiser",
      sourcePlatform: platform,
    });
    brand = sanitizeBrandForPlatform(brand, platform, {
      websiteHint: website,
      creativeYoutubeUrl: creativeYt,
    });
  } catch (err) {
    job.progress.message = `Partial brand review for ${pageName}: ${(err as Error).message}`;
    saveJob(job);
  }

  job.progress.stage = "location_check";
  job.progress.message = `Resolving location for ${pageName}…`;
  saveJob(job);
  let loc = provisional;
  try {
    const locResult = await resolveAndMatchCompetitorLocation({
      pageName,
      website: brand.website || website,
      facebookUrl: brand.facebookUrl,
      linkedinUrl: brand.linkedinUrl,
      geoMode: job.geoMode || "countrywide",
      targetLocations: job.targetLocations || [],
      provisional,
      skipPerplexityIfResolved: provisional.locationStatus === "matched",
    });
    loc = locResult.location;
  } catch {
    // keep provisional
  }

  updateCompetitor(competitor.id, {
    brand,
    locationLabel: loc.locationLabel,
    locationCity: loc.locationCity,
    locationSuburb: loc.locationSuburb,
    locationCountry: loc.locationCountry,
    locationStatus: loc.locationStatus,
    locationSource: loc.locationSource,
  });
  const idx = accepted.findIndex((c) => c.id === competitor.id);
  if (idx >= 0) {
    accepted[idx] = {
      ...accepted[idx],
      brand,
      locationLabel: loc.locationLabel,
      locationCity: loc.locationCity,
      locationSuburb: loc.locationSuburb,
      locationCountry: loc.locationCountry,
      locationStatus: loc.locationStatus,
      locationSource: loc.locationSource,
    };
  }

  job.progress.stage = "searching_ads";
  const locNote =
    loc.locationStatus === "unknown"
      ? " · location unknown"
      : loc.locationStatus === "mismatch"
        ? ` · location mismatch${loc.locationLabel ? ` (${loc.locationLabel})` : ""}`
        : loc.locationLabel
          ? ` · ${loc.locationLabel}`
          : "";
  job.progress.message = `Accepted ${pageName} (${accepted.length}/${TARGET_COMPETITORS}) via ${domain}${locNote}`;
  saveJob(job);
}

export async function runGoogleFamilyLookup(
  lookupId: string,
  queryName: string,
  platform: Extract<AdPlatform, "google" | "youtube">,
  forcedCandidate?: LookupPageCandidate | null,
) {
  const now = new Date().toISOString();
  const job: LookupJob = {
    id: lookupId,
    queryName,
    platform,
    status: "running",
    progress: {
      stage: "searching_pages",
      message: `Searching Google advertisers for "${queryName}"…`,
      candidatesFound: 0,
      adsFetched: 0,
      pagesScanned: 0,
    },
    selectedPage: null,
    candidates: [],
    adIds: [],
    createdAt: now,
    updatedAt: now,
  };
  saveLookupJob(job);

  try {
    const res = await searchGoogleAdvertisers(queryName);
    const advertisers = extractGoogleAdvertisers(res);
    const websites = extractGoogleWebsites(res);
    const domainQuery = normalizeDomainQuery(queryName);

    const candidates: LookupPageCandidate[] = [
      ...websites.map((domain) => ({
        pageId: `domain:${domain}`,
        name: domain,
        category: "Website domain",
        country: null,
        raw: { domain } as Record<string, unknown>,
      })),
      ...advertisers
        .map((a) => ({
          pageId: String(a.advertiser_id || ""),
          name: String(a.name || ""),
          category: a.region ? `Region ${a.region}` : null,
          country: a.region ? String(a.region) : null,
          raw: a as Record<string, unknown>,
        }))
        .filter((c) => c.pageId && c.name),
    ].slice(0, 24);

    // Prefer exact domain match when the user typed a domain (search-advertisers
    // often returns unrelated same-name advertisers in other regions).
    if (forcedCandidate?.pageId) {
      const rest = candidates.filter((c) => c.pageId !== forcedCandidate.pageId);
      candidates.splice(0, candidates.length, forcedCandidate, ...rest);
    } else if (domainQuery) {
      const exact =
        candidates.find((c) => c.pageId === `domain:${domainQuery}`) ||
        candidates.find(
          (c) => c.name.toLowerCase().replace(/^www\./, "") === domainQuery,
        );
      if (exact) {
        const rest = candidates.filter((c) => c.pageId !== exact.pageId);
        candidates.splice(0, candidates.length, exact, ...rest);
      } else {
        candidates.unshift({
          pageId: `domain:${domainQuery}`,
          name: domainQuery,
          category: "Website domain",
          country: null,
          raw: { domain: domainQuery },
        });
      }
    }

    job.candidates = candidates;
    job.progress.candidatesFound = candidates.length;
    job.progress.stage = "verifying_page";
    job.progress.message = `Found ${candidates.length} matches. Verifying…`;
    saveLookupJob(job);

    if (candidates.length === 0) {
      job.status = "failed";
      job.error = `No Google advertisers/domains found for "${queryName}"`;
      job.progress.stage = "failed";
      job.progress.message = job.error;
      saveLookupJob(job);
      return;
    }

    let selected = candidates[0];
    let pickReason = "Top domain/advertiser match";
    let pickConfidence = 0.7;

    if (forcedCandidate?.pageId) {
      selected =
        candidates.find((c) => c.pageId === forcedCandidate.pageId) ||
        forcedCandidate;
      pickReason = `User selected alternate match "${selected.name}"`;
      pickConfidence = 1;
    } else if (domainQuery && selected.pageId.startsWith("domain:")) {
      pickReason = `Matched website domain "${domainQuery}" from search-advertisers`;
      pickConfidence = 0.95;
    } else {
      const pick = await pickCompanyPageMatch(
        queryName,
        candidates.map((c) => ({
          pageId: c.pageId,
          name: c.name,
          category: c.category,
          likes: c.likes,
          verification: null,
          igUsername: null,
          pageAlias: null,
        })),
      );
      selected =
        candidates.find((c) => c.pageId === pick.selectedPageId) ||
        candidates[0];
      pickReason = pick.reason;
      pickConfidence = pick.confidence;
    }

    job.selectedPage = selected;
    job.llmReason = pickReason;
    job.llmConfidence = pickConfidence;
    job.progress.stage = "fetching_ads";
    job.progress.message = `Fetching ads for ${selected.name}…`;
    saveLookupJob(job);

    const isDomain = selected.pageId.startsWith("domain:");
    const domain = isDomain
      ? selected.pageId.replace(/^domain:/, "")
      : selected.name.includes(".")
        ? selected.name.replace(/^www\./i, "").toLowerCase()
        : domainQuery;

    // Flow: domain/advertiser → company-ads (region=all) → resolve advertiser_id
    // → company-ads by advertiser_id → ad-details per creative URL.
    let creatives: GoogleAdCreative[] = [];
    let estimate: number | null = null;

    if (isDomain && domain) {
      job.progress.message = `Loading company ads for domain ${domain}…`;
      saveLookupJob(job);
      const byDomain = await fetchGoogleAdsPages({
        domain,
        region: GOOGLE_ADS_REGION,
        onPage: ({ page, total, estimate: est }) => {
          job.progress.pagesScanned = page;
          job.progress.adsFetched = total;
          estimate = est ?? estimate;
          job.progress.message = `Domain ${domain}: ${total} ads${est != null ? ` (est. ${est})` : ""}…`;
          saveLookupJob(job);
        },
      });
      creatives = byDomain.ads;
      estimate = byDomain.estimate ?? estimate;
    } else if (!isDomain) {
      const byAdv = await fetchGoogleAdsPages({
        advertiser_id: selected.pageId,
        region: GOOGLE_ADS_REGION,
        onPage: ({ page, total, estimate: est }) => {
          job.progress.pagesScanned = page;
          job.progress.adsFetched = total;
          estimate = est ?? estimate;
          job.progress.message = `Advertiser ads: ${total}${est != null ? ` (est. ${est})` : ""}…`;
          saveLookupJob(job);
        },
      });
      creatives = byAdv.ads;
      estimate = byAdv.estimate ?? estimate;
    }

    const advertiserIds = Array.from(
      new Set(
        creatives
          .map((ad) => String(ad.advertiserId || "").trim())
          .filter(Boolean),
      ),
    );

    // Prefer advertiser_id fetch for a complete creative list (user-described flow)
    if (advertiserIds.length > 0) {
      const merged = new Map<string, GoogleAdCreative>();
      for (const ad of creatives) merged.set(creativeKey(ad), ad);

      for (const advertiserId of advertiserIds.slice(0, 5)) {
        job.progress.message = `Fetching all creatives for advertiser ${advertiserId}…`;
        saveLookupJob(job);
        const byAdv = await fetchGoogleAdsPages({
          advertiser_id: advertiserId,
          region: GOOGLE_ADS_REGION,
          onPage: ({ page, total, estimate: est }) => {
            job.progress.pagesScanned += 1;
            estimate = est ?? estimate;
            job.progress.message = `Advertiser ${advertiserId}: page ${page}, ${total} ads${est != null ? ` (est. ${est})` : ""}…`;
            saveLookupJob(job);
          },
        });
        for (const ad of byAdv.ads) merged.set(creativeKey(ad), ad);
        estimate = byAdv.estimate ?? estimate;
      }
      creatives = Array.from(merged.values());

      if (advertiserIds.length === 1) {
        const primary = creatives.find((a) => a.advertiserId === advertiserIds[0]);
        job.selectedPage = {
          ...selected,
          pageId: advertiserIds[0],
          name:
            String(primary?.advertiserName || selected.name || domain || "").trim() ||
            selected.name,
          category: selected.category || "Google advertiser",
          country: selected.country,
          raw: {
            ...(selected.raw || {}),
            advertiser_id: advertiserIds[0],
            domain: domain || undefined,
            resolvedFromDomain: isDomain,
          },
        };
        selected = job.selectedPage;
      }
    }

    // Pull FB likes / IG followers for the resolved advertiser via Meta endpoints
    job.progress.message = `Fetching profile metrics for "${selected.name}"…`;
    saveLookupJob(job);
    selected = await enrichLookupPageMetrics(selected, {
      platform,
      websiteHint: domain ? `https://${domain}` : null,
    });
    job.selectedPage = selected;
    const selectedIds = new Set(
      [selected.pageId, domain ? `domain:${domain}` : ""].filter(Boolean),
    );
    job.candidates = [
      selected,
      ...job.candidates.filter((c) => !selectedIds.has(c.pageId)),
    ];
    saveLookupJob(job);

    if (platform === "youtube") {
      creatives = creatives.filter((ad) => isYouTubeCreative(ad));
    }

    job.progress.adsFetched = creatives.length;
    job.progress.message = `Enriching ${creatives.length} ${platform} ads${estimate != null ? ` (est. ${estimate})` : ""}…`;
    saveLookupJob(job);

    const stored: LookupAdRecord[] = [];
    const seen = new Set<string>();

    for (const ad of creatives) {
      const id = String(ad.creativeId || creativeKey(ad));
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const details = await enrichGoogleAd(ad);
      if (platform === "youtube" && !isYouTubeCreative(ad, details)) {
        continue;
      }

      const mapped = mapGoogleCreativeToCandidate(ad, details);
      const sample = sampleAdFromGoogleCandidate(mapped, platform, domain);
      const record: LookupAdRecord = {
        id: uuidv4(),
        lookupId: job.id,
        adArchiveId: id,
        pageId: selected.pageId,
        pageName: selected.name,
        country: selected.country || "ALL",
        isActive: true,
        title: sample.title,
        body: sample.body,
        ctaText: sample.ctaText,
        landingPageUrl: sample.landingPageUrl,
        startDateString: sample.startDate,
        endDateString: sample.endDate,
        daysRunning: sample.daysRunning,
        adLibraryUrl: sample.adLibraryUrl,
        format: sample.format,
        imageUrl: sample.imageUrl,
        youtubeUrl: sample.youtubeUrl,
        domain: sample.domain || domain,
        visibleUrl: sample.visibleUrl,
        raw: { ...ad, details } as Record<string, unknown>,
        createdAt: new Date().toISOString(),
      };
      saveLookupAd(record);
      stored.push(record);
      job.adIds.push(record.id);
      job.progress.adsFetched = stored.length;
      job.progress.message = `Loaded ${stored.length}/${creatives.length} ${platform} ads…`;
      saveLookupJob(job);
    }

    job.status = "running";
    job.progress.stage = "analyzing_offers";
    job.progress.adsFetched = stored.length;
    job.progress.message =
      stored.length > 0
        ? `Loaded ${stored.length} ads — analyzing unique creatives & landing pages…`
        : `Matched "${selected.name}" but found no public ${platform} ads.`;
    job.updatedAt = new Date().toISOString();
    saveLookupJob(job);

    if (stored.length > 0) {
      await runLookupOffersReportPhase(job.id, { finalStatus: "completed" });
    } else {
      job.status = "partial";
      job.progress.stage = "done";
      job.updatedAt = new Date().toISOString();
      saveLookupJob(job);
    }
  } catch (err) {
    job.status = "failed";
    job.error = (err as Error).message;
    job.progress.stage = "failed";
    job.progress.message = (err as Error).message;
    saveLookupJob(job);
  }
}
