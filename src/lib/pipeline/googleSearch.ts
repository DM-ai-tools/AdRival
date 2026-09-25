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
  serviceKeywordOverlapScore,
} from "../openai/analyzer";
import { OPENROUTER_FAST_MODEL } from "../openrouter/openaiCompat";
import {
  firecrawlSearch,
  flattenFirecrawlSearchResults,
  hasFirecrawlKey,
} from "../firecrawl/client";
import {
  getJob,
  isSearchJobSuppressed,
  isLookupJobSuppressed,
  saveCompetitor,
  saveJob,
  saveLookupAd,
  saveLookupJob,
  updateCompetitor,
} from "../db";
import {
  buildGuardrailContext,
  guardCompetitorHeuristic,
} from "../guardrails";
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
import { newId } from "./brandReview";
import {
  mapGoogleCreativeToCandidate,
  sampleAdFromGoogleCandidate,
} from "./adMappers";
import {
  isYouTubeUrl,
  normalizeWebsiteUrl,
} from "./linkGuards";
import { enrichLookupPageMetrics } from "./lookupEnrichment";
import { looksLikeEnglish } from "./adLanguage";

const MAX_ADS_PAGES = 6;
/** Transparency region that returns creatives across countries (US alone under-counts). */
const GOOGLE_ADS_REGION = "all";
/** Cap hard-verify calls per query — each is a SociaVault credit. */
const MAX_DOMAIN_VERIFY = 4;
/** How many advertisers to qualify at once. The next fetch waits until this batch is reviewed. */
const AD_REVIEW_BATCH = 4;
/** Detail calls per advertiser before the model runs. More copy is loaded after accept. */
const DETAILS_PER_ADVERTISER = 1;
/** User keywords always run. This many extra expansions are allowed after them. */
const MAX_EXTRA_GOOGLE_QUERIES = 3;

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
  const workers = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

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
  /** Return false to abort further pages (e.g. user hit Stop). */
  onPage?: (info: {
    page: number;
    batch: number;
    total: number;
    estimate: number | null;
  }) => void | boolean;
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
    const cont = params.onPage?.({
      page: pages,
      batch: batch.length,
      total: out.length,
      estimate,
    });
    if (cont === false) break;
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

/** Organic domains only when Transparency has not filled the roster. One search per user keyword, then one company-ads check. */
async function discoverGapDomains(args: {
  queries: string[];
  platform: "google" | "youtube";
  businessProfile?: import("../types").BusinessProfile | null;
  webRegion?: string;
  onProgress: (message: string) => void;
}): Promise<Array<{ domain: string; ads: GoogleAdCreative[] }>> {
  const { queries, platform, businessProfile, webRegion, onProgress } = args;
  const profile = businessProfile || null;
  const searchRegion =
    webRegion && webRegion !== "all" ? webRegion.toUpperCase() : undefined;
  const snippets: Array<{ title?: string; url?: string; description?: string }> =
    [];
  const webDomains: string[] = [];

  onProgress(
    `Searching the web for more ${platform} competitor domains…`,
  );
  await mapPool(queries.slice(0, 4), 4, async (query) => {
    try {
      if (hasFirecrawlKey()) {
        const res = await firecrawlSearch(query, {
          limit: 5,
          country: searchRegion,
        });
        for (const hit of flattenFirecrawlSearchResults(res).slice(0, 5)) {
          snippets.push({
            title: hit.title || undefined,
            url: hit.url,
            description: hit.description || undefined,
          });
          const domain = domainFromUrl(hit.url);
          if (!domain) continue;
          const blob = `${hit.title || ""}\n${hit.description || ""}\n${hit.url || ""}`;
          const overlap = serviceKeywordOverlapScore(blob, {
            businessProfile: profile,
            searchKeywords: queries,
          });
          if (overlap <= 0) continue;
          webDomains.push(domain);
        }
        return;
      }
      const res = await googleSearch(query, searchRegion || "US");
      const results = normalizeList<{
        title?: string;
        url?: string;
        description?: string;
      }>(res.data?.results);
      for (const hit of results.slice(0, 5)) {
        snippets.push(hit);
        const domain = domainFromUrl(hit.url);
        if (!domain) continue;
        const blob = `${hit.title || ""}\n${hit.description || ""}\n${hit.url || ""}`;
        if (
          serviceKeywordOverlapScore(blob, {
            businessProfile: profile,
            searchKeywords: queries,
          }) <= 0
        ) {
          continue;
        }
        webDomains.push(domain);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/credit|quota|402|401|403|rate limited/i.test(msg)) throw err;
    }
  });

  const candidatePool = Array.from(new Set(webDomains));
  if (candidatePool.length === 0) return [];

  onProgress(`Ranking ${candidatePool.length} web domains…`);
  let ranked = candidatePool.slice(0, MAX_DOMAIN_VERIFY);
  try {
    const pick = await pickGoogleAdDomains(
      queries[0] || "",
      candidatePool,
      [],
      {
        platform,
        limit: MAX_DOMAIN_VERIFY,
        webSnippets: snippets,
        businessProfile: profile,
        model: OPENROUTER_FAST_MODEL,
      },
    );
    if (pick.domains.length) ranked = pick.domains.slice(0, MAX_DOMAIN_VERIFY);
  } catch {
    ranked = candidatePool.slice(0, MAX_DOMAIN_VERIFY);
  }

  onProgress(`Checking ${ranked.length} domains for live ads…`);
  const checked = await mapPool(ranked, AD_REVIEW_BATCH, async (domain) => {
    try {
      const adsRes = await getGoogleCompanyAds({
        domain,
        region: GOOGLE_ADS_REGION,
      });
      let ads = extractGoogleAds(adsRes).slice(0, 8);
      if (platform === "youtube") {
        ads = ads.filter((ad) => isYouTubeCreative(ad));
      }
      if (!ads.length) return null;
      return { domain, ads };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/credit|quota|402|401|403|rate limited/i.test(msg)) throw err;
      return null;
    }
  });
  return checked.filter((row): row is { domain: string; ads: GoogleAdCreative[] } =>
    Boolean(row),
  );
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

/**
 * Google / YouTube search:
 * 1) Transparency advertisers for the user's keywords (plus up to 3 expansions)
 * 2) Company ads fetched 4 at a time, then reviewed together
 * 3) One web search only if the roster is still short — those ad results are reviewed directly
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
    skipGuardrails: Boolean(options?.skipGuardrails),
    guardrailOverride: options?.guardrailOverride || null,
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
  const pendingReview: Array<Parameters<typeof tryAcceptFromAds>[0]> = [];

  async function flushReview() {
    if (!pendingReview.length) return;
    if (isSearchJobSuppressed(job.id)) {
      pendingReview.length = 0;
      return;
    }
    const batch = pendingReview.splice(0, pendingReview.length);
    job.progress.stage = "analyzing_ad";
    job.progress.message = `Reviewing ${batch.length} ad ${batch.length === 1 ? "copy" : "copies"} in parallel…`;
    job.updatedAt = new Date().toISOString();
    saveJob(job);
    await mapPool(batch, AD_REVIEW_BATCH, async (args) => {
      if (accepted.length >= TARGET_COMPETITORS) return;
      if (isSearchJobSuppressed(job.id)) return;
      await tryAcceptFromAds(args);
    });
  }

  try {
    const seedQueries = keywords.map((kw) => kw.trim()).filter(Boolean);
    const extraPool: string[] = [];
    const rememberExtra = (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (seedQueries.some((seed) => seed.toLowerCase() === key)) return;
      if (extraPool.some((existing) => existing.toLowerCase() === key)) return;
      extraPool.push(trimmed);
    };
    const expandedLists = await mapPool(seedQueries, 4, async (kw) => {
      try {
        return await expandKeywordQueries(
          kw,
          businessProfile,
          {
            geoMode: job.geoMode,
            targetLocations: job.targetLocations,
            selectedCategory: job.selectedCategory,
          },
          OPENROUTER_FAST_MODEL,
        );
      } catch {
        return [kw];
      }
    });
    for (const list of expandedLists) {
      for (const query of list) rememberExtra(query);
    }
    if (
      job.geoMode === "company_locations" ||
      job.geoMode === "keyword_location"
    ) {
      for (const loc of (job.targetLocations || []).slice(0, 4)) {
        const place = loc.suburb || loc.city || loc.label;
        if (!place) continue;
        for (const kw of seedQueries.slice(0, 3)) rememberExtra(`${kw} ${place}`);
      }
    }
    const queries = [
      ...seedQueries,
      ...extraPool.slice(0, MAX_EXTRA_GOOGLE_QUERIES),
    ];

    outer: for (const query of queries) {
      if (accepted.length >= TARGET_COMPETITORS) break;
      if (isSearchJobSuppressed(jobId)) break outer;

      job.progress.stage = "finding_domains";
      job.progress.message = `Transparency search for "${query}"…`;
      job.updatedAt = new Date().toISOString();
      saveJob(job);

      let advertisersRaw: Awaited<
        ReturnType<typeof extractGoogleAdvertisers>
      > = [];
      try {
        const res = await searchGoogleAdvertisers(query);
        advertisersRaw = extractGoogleAdvertisers(res);
        job.progress.scannedPages += 1;
      } catch (err) {
        job.progress.message = `Transparency search warning: ${(err as Error).message}`;
        saveJob(job);
      }

      const advertiserBatch = advertisersRaw.slice(0, 8);
      for (let i = 0; i < advertiserBatch.length; i += AD_REVIEW_BATCH) {
        if (accepted.length >= TARGET_COMPETITORS) break outer;
        if (isSearchJobSuppressed(jobId)) break outer;
        const slice = advertiserBatch.slice(i, i + AD_REVIEW_BATCH);
        job.progress.stage = "fetching_ads";
        job.progress.message = `Fetching ads for ${slice.length} Transparency advertisers…`;
        saveJob(job);
        const rows = await mapPool(slice, AD_REVIEW_BATCH, async (adv) => {
          const id = String(adv.advertiser_id || "");
          if (!id || seenAdvertisers.has(id)) return null;
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
            ads = ads.slice(0, 8);
            job.progress.scannedAds += ads.length;
            job.progress.scannedPages += 1;
            if (ads.length === 0) return null;
            return {
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
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/credit|quota|402|401|403|rate limited/i.test(msg)) throw err;
            job.progress.rejected += 1;
            return null;
          }
        });
        for (const row of rows) {
          if (row) pendingReview.push(row);
        }
        await flushReview();
      }
    }

    if (
      accepted.length < TARGET_COMPETITORS &&
      !isSearchJobSuppressed(jobId)
    ) {
      const gaps = await discoverGapDomains({
        queries: seedQueries.length ? seedQueries : queries,
        platform,
        businessProfile,
        webRegion: geo,
        onProgress: (message) => {
          job.progress.stage = /Checking/i.test(message)
            ? "verifying_domains"
            : "ranking_domains";
          job.progress.message = message;
          saveJob(job);
        },
      });
      for (const gap of gaps) {
        if (accepted.length >= TARGET_COMPETITORS) break;
        if (isSearchJobSuppressed(jobId)) break;
        const key = gap.domain.toLowerCase();
        if (seenDomains.has(key)) continue;
        seenDomains.add(key);
        job.progress.scannedAds += gap.ads.length;
        job.progress.scannedPages += 1;
        const byAdvertiser = new Map<string, GoogleAdCreative[]>();
        for (const ad of gap.ads) {
          const aid =
            String(ad.advertiserId || "") ||
            String(ad.advertiserName || gap.domain);
          const list = byAdvertiser.get(aid) ?? [];
          list.push(ad);
          byAdvertiser.set(aid, list);
        }
        for (const [pageId, advAds] of byAdvertiser) {
          if (seenAdvertisers.has(pageId)) continue;
          seenAdvertisers.add(pageId);
          pendingReview.push({
            ads: advAds,
            job,
            accepted,
            keywords,
            query: seedQueries[0] || gap.domain,
            platform,
            thresholds,
            domain: gap.domain,
            pageId,
            pageName:
              String(advAds[0]?.advertiserName || gap.domain).trim() ||
              gap.domain,
            country: String(job.geo || "US"),
            websiteHint: websiteUrl(gap.domain),
          });
          if (pendingReview.length >= AD_REVIEW_BATCH) await flushReview();
        }
      }
      if (pendingReview.length) await flushReview();
    }

    job.status =
      accepted.length >= TARGET_COMPETITORS
        ? "completed"
        : accepted.length > 0
          ? "partial"
          : "failed";
    job.updatedAt = new Date().toISOString();
    saveJob(job);

    if (!isSearchJobSuppressed(jobId)) {
      const final = getJob(jobId) || job;
      final.status = job.status;
      final.progress.stage = "done";
      final.progress.message =
        accepted.length > 0
          ? `Found ${accepted.length} competitors on ${platform}. Brand review & deep location run on demand / during offer analysis.`
          : `No qualifying competitors found on ${platform}.`;
      final.updatedAt = new Date().toISOString();
      saveJob(final);
    }
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

  const sample = sampleSource.slice(0, DETAILS_PER_ADVERTISER);
  const detailed = await mapPool(sample, DETAILS_PER_ADVERTISER, async (ad) => {
    if (isSearchJobSuppressed(job.id)) return null;
    const details = await enrichGoogleAd(ad);
    return { ad, details };
  });
  const english: AdCandidate[] = [];
  for (const row of detailed) {
    if (!row) continue;
    if (platform === "youtube" && !isYouTubeCreative(row.ad, row.details)) continue;
    const candidate = mapGoogleCreativeToCandidate(row.ad, row.details);
    const copy = `${candidate.title}\n${candidate.body}\n${candidate.fullText}`;
    if (!looksLikeEnglish(copy)) continue;
    english.push(candidate);
  }

  if (english.length === 0) {
    job.progress.rejected += 1;
    job.progress.message = `Skipped ${pageName}: ad copy is not English`;
    saveJob(job);
    return;
  }

  const primary = [...english].sort((a, b) => {
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

  const hasSignals =
    keywords.some((kw) => kw.trim().length >= 3) || Boolean(job.businessProfile);
  if (
    hasSignals &&
    primaryCopy.length >= 40 &&
    serviceKeywordOverlapScore(primaryCopy, {
      businessProfile: job.businessProfile,
      searchKeywords: keywords,
      selectedCategory: job.selectedCategory,
    }) === 0
  ) {
    job.progress.rejected += 1;
    job.progress.message = `Skipped ${pageName}: ad copy does not match the keywords`;
    saveJob(job);
    return;
  }

  if (!meetsDurationThreshold(primary.daysRunning, thresholds)) {
    job.progress.rejected += 1;
    return;
  }

  if (isSearchJobSuppressed(job.id) || accepted.length >= TARGET_COMPETITORS) return;

  let filter;
  try {
    job.progress.stage = "analyzing_ad";
    job.progress.message = `LLM reviewing ${pageName}…`;
    saveJob(job);
    filter = await analyzeAdCandidate(
      keywords[0] || query,
      primary,
      null,
      english.filter((a) => a.adArchiveId !== primary.adArchiveId).slice(0, 5),
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

  const guard = guardCompetitorHeuristic(
    buildGuardrailContext({
      businessProfile: job.businessProfile,
      selectedCategoryLabel: job.selectedCategory?.label || null,
      searchKeywords: keywords,
      override: job.guardrailOverride || null,
      skipGuardrails: Boolean(job.skipGuardrails),
    }),
    {
      pageName,
      adText: primary.fullText || primary.body,
      landingPageUrl: primary.landingPageUrl,
      services: filter.services,
      llmReason: filter.reason,
    },
  );
  if (!guard.ok) {
    job.progress.rejected += 1;
    job.progress.message = `Guardrail blocked ${pageName}: ${guard.reason}`;
    saveJob(job);
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

  const { cheapLocationFromText } = await import("./competitorLocation");

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

  const competitorId = competitor.id;
  const restForLanding = sampleSource.slice(DETAILS_PER_ADVERTISER, DETAILS_PER_ADVERTISER + 2);
  void (async () => {
    try {
      const { enrichCompetitorSociavaultAddress } = await import("./competitorLocation");
      await enrichCompetitorSociavaultAddress({
        competitorId,
        facebookUrl: brand.facebookUrl || null,
        linkedinUrl: brand.linkedinUrl || null,
        geoMode: job.geoMode || "countrywide",
        targetLocations: job.targetLocations || [],
      });
    } catch {
      /* provisional location stays */
    }
    if (primary.landingPageUrl || restForLanding.length === 0) return;
    for (const ad of restForLanding) {
      const details = await enrichGoogleAd(ad);
      const candidate = mapGoogleCreativeToCandidate(ad, details);
      if (!candidate.landingPageUrl) continue;
      const richer = sampleAdFromGoogleCandidate(candidate, platform, domainHint);
      updateCompetitor(competitorId, { sampleAd: richer });
      break;
    }
  })();

  const locNote = competitor.locationLabel
    ? ` · ${competitor.locationLabel}`
    : "";
  job.progress.stage = "searching_ads";
  job.progress.message = `Accepted ${pageName} (${accepted.length}/${TARGET_COMPETITORS}) via ${domain}${locNote}`;
  saveJob(job);
}

export async function runGoogleFamilyLookup(
  lookupId: string,
  queryName: string,
  platform: Extract<AdPlatform, "google" | "youtube">,
  forcedCandidate?: LookupPageCandidate | null,
  options?: {
    businessUrl?: string | null;
    businessProfile?: import("../types").BusinessProfile | null;
  },
) {
  const now = new Date().toISOString();
  const businessUrl = (options?.businessUrl || "").trim() || null;
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
    businessUrl: businessUrl
      ? /^https?:\/\//i.test(businessUrl)
        ? businessUrl
        : `https://${businessUrl}`
      : null,
    businessProfile: options?.businessProfile || null,
    createdAt: now,
    updatedAt: now,
  };
  saveLookupJob(job);

  if (isLookupJobSuppressed(lookupId)) return;

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
    if (isLookupJobSuppressed(lookupId)) return;

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
          if (isLookupJobSuppressed(lookupId)) return false;
          job.progress.pagesScanned = page;
          job.progress.adsFetched = total;
          estimate = est ?? estimate;
          job.progress.message = `Domain ${domain}: ${total} ads${est != null ? ` (est. ${est})` : ""}…`;
          saveLookupJob(job);
        },
      });
      if (isLookupJobSuppressed(lookupId)) return;
      creatives = byDomain.ads;
      estimate = byDomain.estimate ?? estimate;
    } else if (!isDomain) {
      const byAdv = await fetchGoogleAdsPages({
        advertiser_id: selected.pageId,
        region: GOOGLE_ADS_REGION,
        onPage: ({ page, total, estimate: est }) => {
          if (isLookupJobSuppressed(lookupId)) return false;
          job.progress.pagesScanned = page;
          job.progress.adsFetched = total;
          estimate = est ?? estimate;
          job.progress.message = `Advertiser ads: ${total}${est != null ? ` (est. ${est})` : ""}…`;
          saveLookupJob(job);
        },
      });
      if (isLookupJobSuppressed(lookupId)) return;
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
            if (isLookupJobSuppressed(lookupId)) return false;
            job.progress.pagesScanned += 1;
            estimate = est ?? estimate;
            job.progress.message = `Advertiser ${advertiserId}: page ${page}, ${total} ads${est != null ? ` (est. ${est})` : ""}…`;
            saveLookupJob(job);
          },
        });
        if (isLookupJobSuppressed(lookupId)) return;
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

    job.progress.adsFetched = stored.length;
    if (stored.length > 0) {
      job.status = "completed";
      job.progress.stage = "done";
      job.progress.message = `Loaded ${stored.length} ${platform} ads for "${selected.name}". Use Get offer & page details on an ad to analyze its landing page.`;
    } else {
      job.status = "partial";
      job.progress.stage = "done";
      job.progress.message = `Matched "${selected.name}" but found no public ${platform} ads.`;
    }
    job.updatedAt = new Date().toISOString();
    saveLookupJob(job);
  } catch (err) {
    job.status = "failed";
    job.error = (err as Error).message;
    job.progress.stage = "failed";
    job.progress.message = (err as Error).message;
    saveLookupJob(job);
  }
}
