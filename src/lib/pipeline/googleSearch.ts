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
  isAgencySeed,
  pickCompanyPageMatch,
  pickGoogleAdDomains,
  serviceKeywordOverlapScore,
} from "../openai/analyzer";
import { OPENROUTER_FAST_MODEL } from "../openrouter/openaiCompat";
import {
  buildSearchRings,
  placesUpToRing,
  ringSearchQueries,
  serviceAnchors,
} from "./searchRings";
import { googleRegionFromGeo } from "../geo";
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
  saveJobProgress,
  saveLookupAd,
  saveLookupJob,
  updateCompetitor,
} from "../db";
import {
  buildGuardrailContext,
  guardCompetitorHeuristic,
  precheckCompetitor,
} from "../guardrails";
import { isCreditError } from "../accounting/errors";
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
import { ownBusinessCheck } from "./ownBusiness";
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
/** Transparency region that returns creatives across countries (lookups; a search uses the chosen country). */
const GOOGLE_ADS_REGION = "all";
/** Web results read per search query (Firecrawl's maximum is 10). */
const WEB_RESULTS_PER_QUERY = 10;
/** Domains checked for live ads per search step — each is a SociaVault credit. */
const MAX_DOMAIN_CHECKS_PER_STEP = 20;
/** Domains checked for live ads across the whole run. */
const MAX_DOMAIN_CHECKS_TOTAL = 60;
/** Directories, marketplaces, review and job sites: they rank but are not competitors. */
const NOT_ADVERTISER_HOST =
  /(^|\.)(yellowpages|truelocal|hotfrog|localsearch|startlocal|yell|healthengine|hotdoc|whitecoat|ratemds|healthgrades|zocdoc|webmd|tripadvisor|reddit|quora|amazon|ebay|gumtree|craigslist|seek|indeed|glassdoor|angi|angieslist|homeadvisor|thumbtack|houzz|bark|oneflare|hipages|serviceseeking|airtasker|productreview|trustpilot|capterra|bbb|mapquest|foursquare|nextdoor|wikihow|medium|pinterest|apple|bing|yahoo|bookings?|opentable|zomato|doctify|nhs|realestate|domain|zillow|wix|wordpress|blogspot)\.[a-z.]+$/i;
/** How many advertisers to qualify at once. The next fetch waits until this batch is reviewed. */
const AD_REVIEW_BATCH = 4;
/** Detail calls per advertiser before the model runs. More copy is loaded after accept. */
const DETAILS_PER_ADVERTISER = 1;
/** Ads read per advertiser while looking for one with readable text (image ads often have none). */
const MAX_DETAIL_TRIES = 3;
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
      ) ||
      NOT_ADVERTISER_HOST.test(host)
    ) {
      return null;
    }
    return host;
  } catch {
    return null;
  }
}

/**
 * Web search for the keywords in the chosen country, top results first.
 * Firecrawl first; when it fails (out of credits, down), SociaVault's Google
 * search answers instead, so a Firecrawl problem never stops the search.
 * Returns business domains in search-rank order, with their snippets.
 */
async function webSearchDomains(args: {
  queries: string[];
  country?: string;
  businessProfile?: import("../types").BusinessProfile | null;
  /** Keyword words a result must share (service part, without place names). */
  signalKeywords: string[];
  exclude: Set<string>;
  state: { firecrawlDown: boolean };
}): Promise<{
  domains: string[];
  snippets: Array<{ title?: string; url?: string; description?: string }>;
}> {
  const { queries, country, businessProfile, signalKeywords, exclude, state } = args;
  const perQuery = await mapPool(queries, 4, async (query) => {
    const hits: Array<{ title?: string; url?: string; description?: string }> = [];
    try {
      let firecrawlRes: Awaited<ReturnType<typeof firecrawlSearch>> | null = null;
      if (!state.firecrawlDown) {
        try {
          firecrawlRes = await firecrawlSearch(query, {
            limit: WEB_RESULTS_PER_QUERY,
            country,
          });
        } catch (err) {
          state.firecrawlDown = true;
          console.warn("[googleSearch] Firecrawl web search failed; using SociaVault search", (err as Error).message);
        }
      }
      if (firecrawlRes) {
        for (const hit of flattenFirecrawlSearchResults(firecrawlRes)) {
          hits.push({
            title: hit.title || undefined,
            url: hit.url,
            description: hit.description || undefined,
          });
        }
      } else {
        const res = await googleSearch(query, country || "US");
        hits.push(
          ...normalizeList<{ title?: string; url?: string; description?: string }>(
            res.data?.results,
          ),
        );
      }
    } catch (err) {
      // SociaVault out of credits stops the search (it also finds the ads);
      // anything else only loses this one web search.
      if (isCreditError(err)) throw err;
      console.warn("[googleSearch] web search failed", (err as Error).message);
    }
    return hits.slice(0, WEB_RESULTS_PER_QUERY);
  });

  // Interleave by rank: every query's #1 result, then every #2, and so on.
  const domains: string[] = [];
  const snippets: Array<{ title?: string; url?: string; description?: string }> = [];
  const seen = new Set<string>();
  for (let rank = 0; rank < WEB_RESULTS_PER_QUERY; rank += 1) {
    for (const hits of perQuery) {
      const hit = hits[rank];
      if (!hit) continue;
      const domain = domainFromUrl(hit.url);
      if (!domain || seen.has(domain) || exclude.has(domain)) continue;
      const blob = `${hit.title || ""}\n${hit.description || ""}\n${hit.url || ""}`;
      if (
        serviceKeywordOverlapScore(blob, {
          businessProfile: businessProfile || null,
          searchKeywords: signalKeywords,
        }) <= 0
      ) {
        continue;
      }
      seen.add(domain);
      domains.push(domain);
      snippets.push(hit);
    }
  }
  return { domains, snippets };
}

/** Drops directories, publishers and non-competitors, keeping search-rank order. */
async function keepLikelyCompetitorDomains(args: {
  keyword: string;
  domains: string[];
  snippets: Array<{ title?: string; url?: string; description?: string }>;
  platform: "google" | "youtube";
  businessProfile?: import("../types").BusinessProfile | null;
}): Promise<string[]> {
  const { domains } = args;
  if (domains.length <= 3) return domains;
  try {
    const pick = await pickGoogleAdDomains(args.keyword, domains, [], {
      platform: args.platform,
      limit: domains.length,
      webSnippets: args.snippets,
      businessProfile: args.businessProfile || null,
      model: OPENROUTER_FAST_MODEL,
    });
    const kept = new Set(pick.domains.map((d) => d.toLowerCase().replace(/^www\./, "")));
    const ordered = domains.filter((d) => kept.has(d));
    return ordered.length ? ordered : domains;
  } catch (err) {
    if (isCreditError(err)) throw err;
    return domains;
  }
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

/** Counts why an advertiser or site was dropped, for the run's "Why were ads rejected?" breakdown. */
function bumpReason(job: SearchJob, key: keyof NonNullable<SearchJob["progress"]["rejectReasons"]>, by = 1) {
  const reasons = (job.progress.rejectReasons ??= {
    inactive: 0,
    shortDuration: 0,
    noServiceSignal: 0,
    nonEnglish: 0,
    noLandingPage: 0,
    llmReject: 0,
    llmError: 0,
    lowActiveAds: 0,
    countError: 0,
  });
  reasons[key] = (reasons[key] || 0) + by;
}

function websiteUrl(domain: string): string {
  const d = domain.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return `https://${d}`;
}

/**
 * Google / YouTube search, limited to the chosen country:
 * 1) Web search for the keywords in that country. The top-ranked business
 *    domains are checked in the Ads Transparency Center for ads shown there.
 * 2) Transparency advertiser-name search for the same keywords.
 * A city/suburb search runs these steps ring by ring (nearby areas, wider
 * area, state) and then country-wide, stopping once the list is full.
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
  // Ads must have been shown in the chosen country; "all" keeps every region.
  const adsRegion = googleRegionFromGeo(geo);
  const webCountry = adsRegion !== "all" ? adsRegion : undefined;
  const businessProfile = options?.businessProfile || null;
  const businessUrl =
    (options?.businessUrl || businessProfile?.url || "").trim() || null;
  const geoMode = options?.geoMode || "countrywide";
  const baseTargets = options?.targetLocations || [];
  const rings =
    (geoMode === "company_locations" || geoMode === "keyword_location") &&
    baseTargets.length > 0
      ? buildSearchRings(businessProfile, baseTargets)
      : [];
  const job: SearchJob = {
    id: jobId,
    keyword: keywords.join(", "),
    keywords,
    platform,
    geo,
    geoMode,
    selectedCategory: options?.selectedCategory || null,
    targetLocations: rings.length ? placesUpToRing(rings, 0) : baseTargets,
    keywordLocation: options?.keywordLocation || null,
    countries: adsRegion !== "all" ? [adsRegion] : undefined,
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
  const seenAdvertisers = new Set<string>();
  const checkedDomains = new Set<string>();
  const ownDomain = domainFromUrl(businessUrl);
  if (ownDomain) checkedDomains.add(ownDomain);
  const thresholds = getPlatformAdThresholds(platform);
  const pendingReview: Array<Parameters<typeof tryAcceptFromAds>[0]> = [];
  const heldMismatches: CompetitorRecord[] = [];
  const webState = { firecrawlDown: !hasFirecrawlKey() };
  const regionName = webCountry || "all regions";
  let domainChecks = 0;
  /** Off while searching local rings: rivals named for another place wait. */
  let countryWide = rings.length === 0;
  let relaxedReview = false;

  const done = () => accepted.length >= TARGET_COMPETITORS || isSearchJobSuppressed(jobId);
  const progress = (stage: SearchJob["progress"]["stage"], message: string) => {
    job.progress.stage = stage;
    job.progress.message = message;
    job.updatedAt = new Date().toISOString();
    saveJobProgress(job);
  };

  async function flushReview() {
    if (!pendingReview.length) return;
    if (isSearchJobSuppressed(job.id)) {
      pendingReview.length = 0;
      return;
    }
    const batch = pendingReview.splice(0, pendingReview.length);
    progress(
      "analyzing_ad",
      `Reviewing ${batch.length} ad ${batch.length === 1 ? "copy" : "copies"} in parallel…`,
    );
    await mapPool(batch, AD_REVIEW_BATCH, async (args) => {
      if (done()) return;
      await tryAcceptFromAds(args);
    });
  }

  const fetchAds = async (params: { advertiser_id?: string; domain?: string }) => {
    const res = await getGoogleCompanyAds({ ...params, region: adsRegion });
    let ads = extractGoogleAds(res);
    if (platform === "youtube") ads = ads.filter((ad) => isYouTubeCreative(ad));
    job.progress.scannedPages += 1;
    return ads.slice(0, 8);
  };

  const queueReview = (row: {
    ads: GoogleAdCreative[];
    query: string;
    domain: string;
    pageId: string;
    pageName: string;
    country: string;
    websiteHint: string | null;
    fromWeb: boolean;
  }) => {
    job.progress.scannedAds += row.ads.length;
    pendingReview.push({
      ...row,
      job,
      accepted,
      keywords,
      platform,
      thresholds,
      heldMismatches: countryWide ? undefined : heldMismatches,
      relaxedReview,
    });
  };

  const acceptHeld = (competitor: CompetitorRecord) => {
    saveCompetitor(competitor);
    accepted.push(competitor);
    job.competitorIds.push(competitor.id);
    job.progress.accepted = accepted.length;
    queueAddressEnrich(job, competitor);
  };

  /** Held rivals whose place a wider ring now covers are local: take them first. */
  const releaseHeld = async (all: boolean) => {
    const { cheapLocationFromText, matchPlaceToTargets } = await import("./competitorLocation");
    for (const competitor of [...heldMismatches]) {
      if (done()) break;
      if (!all) {
        // The address looked up when it was held, else its ad copy.
        const geoNow =
          competitor.locationSource !== "none" && (competitor.locationLabel || competitor.locationCity)
            ? matchPlaceToTargets(
                {
                  locationLabel: competitor.locationLabel ?? null,
                  locationCity: competitor.locationCity ?? null,
                  locationSuburb: competitor.locationSuburb ?? null,
                  locationCountry: competitor.locationCountry ?? null,
                  locationStatus: "unknown",
                  locationSource: competitor.locationSource || "none",
                },
                job.targetLocations || [],
                geoMode,
              )
            : cheapLocationFromText({
                pageName: competitor.pageName,
                adText: `${competitor.sampleAd?.title || ""}\n${competitor.sampleAd?.body || ""}`,
                landingUrl: competitor.sampleAd?.landingPageUrl || competitor.brand?.website || null,
                targets: job.targetLocations || [],
                geoMode,
              });
        if (geoNow.locationStatus !== "matched") continue;
        Object.assign(competitor, {
          locationLabel: geoNow.locationLabel,
          locationCity: geoNow.locationCity,
          locationSuburb: geoNow.locationSuburb,
          locationCountry: geoNow.locationCountry,
          locationStatus: geoNow.locationStatus,
          locationSource: geoNow.locationSource,
        });
      }
      heldMismatches.splice(heldMismatches.indexOf(competitor), 1);
      acceptHeld(competitor);
    }
    saveJob(job);
  };

  /** Top-ranked web domains → their ads in the chosen country → review. */
  const checkWebDomains = async (domains: string[], query: string) => {
    const fresh = domains.filter((d) => !checkedDomains.has(d));
    for (let i = 0; i < fresh.length; i += AD_REVIEW_BATCH) {
      if (done() || domainChecks >= MAX_DOMAIN_CHECKS_TOTAL) return;
      const slice = fresh
        .slice(i, i + AD_REVIEW_BATCH)
        .slice(0, MAX_DOMAIN_CHECKS_TOTAL - domainChecks);
      for (const d of slice) checkedDomains.add(d);
      domainChecks += slice.length;
      progress(
        "verifying_domains",
        `Checking ${slice.length} top-ranked sites for Google ads shown in ${regionName} (${Math.min(i + slice.length, fresh.length)}/${fresh.length})…`,
      );
      const rows = await mapPool(slice, AD_REVIEW_BATCH, async (domain) => {
        try {
          const ads = await fetchAds({ domain });
          if (!ads.length) bumpReason(job, "noAdsInRegion");
          return ads.length ? { domain, ads } : null;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isCreditError(err) || /credit|quota|402|401|403|rate limited/i.test(msg)) throw err;
          return null;
        }
      });
      for (const row of rows) {
        if (!row) continue;
        const byAdvertiser = new Map<string, GoogleAdCreative[]>();
        for (const ad of row.ads) {
          const aid = String(ad.advertiserId || "") || String(ad.advertiserName || row.domain);
          const list = byAdvertiser.get(aid) ?? [];
          list.push(ad);
          byAdvertiser.set(aid, list);
        }
        for (const [pageId, advAds] of byAdvertiser) {
          if (seenAdvertisers.has(pageId)) continue;
          seenAdvertisers.add(pageId);
          queueReview({
            ads: advAds,
            query,
            domain: row.domain,
            pageId,
            pageName: String(advAds[0]?.advertiserName || row.domain).trim() || row.domain,
            country: webCountry || String(job.geo || "US"),
            websiteHint: websiteUrl(row.domain),
            fromWeb: true,
          });
        }
      }
      await flushReview();
    }
  };

  /** Transparency advertiser-name search; ads still limited to the chosen country. */
  const searchAdvertiserNames = async (queries: string[], cap: number) => {
    for (const query of queries) {
      if (done()) return;
      progress("finding_domains", `Transparency search for "${query}"…`);
      let advertisers: ReturnType<typeof extractGoogleAdvertisers> = [];
      try {
        advertisers = extractGoogleAdvertisers(await searchGoogleAdvertisers(query));
        job.progress.scannedPages += 1;
      } catch (err) {
        if (isCreditError(err)) throw err;
        progress("finding_domains", `Transparency search warning: ${(err as Error).message}`);
      }
      const batch = advertisers.slice(0, cap);
      for (let i = 0; i < batch.length; i += AD_REVIEW_BATCH) {
        if (done()) return;
        const slice = batch.slice(i, i + AD_REVIEW_BATCH);
        progress("fetching_ads", `Fetching ads for ${slice.length} Transparency advertisers…`);
        const rows = await mapPool(slice, AD_REVIEW_BATCH, async (adv) => {
          const id = String(adv.advertiser_id || "");
          if (!id || seenAdvertisers.has(id)) return null;
          seenAdvertisers.add(id);
          try {
            const ads = await fetchAds({ advertiser_id: id });
            return ads.length ? { adv, id, ads } : null;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (isCreditError(err) || /credit|quota|402|401|403|rate limited/i.test(msg)) throw err;
            job.progress.rejected += 1;
            return null;
          }
        });
        for (const row of rows) {
          if (!row) continue;
          queueReview({
            ads: row.ads,
            query,
            domain: String(row.adv.name || row.id),
            pageId: row.id,
            pageName: String(row.adv.name || "Unknown"),
            country: row.adv.region ? String(row.adv.region) : webCountry || String(job.geo || "US"),
            websiteHint: null,
            fromWeb: false,
          });
        }
        await flushReview();
      }
    }
  };

  try {
    const allKeywords = keywords.map((kw) => kw.trim()).filter(Boolean);
    const anchors = rings.length
      ? serviceAnchors(
          [...(businessProfile?.serviceArea?.searchTerms || []), ...allKeywords],
          [
            ...rings.flatMap((r) => r.places.map((p) => p.city)),
            ...baseTargets.flatMap((l) => [l.city, l.suburb || "", l.region || ""]),
          ],
          job.selectedCategory?.label || null,
        )
      : allKeywords;
    // Transparency search matches advertiser names: "SEO" finds
    // "Yoast SEO"-style tools, "SEO agency" finds agencies.
    const agency = isAgencySeed(businessProfile, job.selectedCategory, allKeywords);
    const nameQueriesFor = (list: string[]) =>
      agency
        ? Array.from(
            new Set([
              ...list.map((kw) =>
                /\b(agency|agencies|services?|company|consultant|firm)\b/i.test(kw) ? kw : `${kw} agency`,
              ),
              ...list,
            ]),
          )
        : list;
    const expansions = async (seeds: string[]) => {
      const lists = await mapPool(seeds.slice(0, 4), 4, async (kw) => {
        try {
          return await expandKeywordQueries(
            kw,
            businessProfile,
            { geoMode: "countrywide", targetLocations: [], selectedCategory: job.selectedCategory },
            OPENROUTER_FAST_MODEL,
          );
        } catch (err) {
          if (isCreditError(err)) throw err;
          return [kw];
        }
      });
      const seen = new Set(seeds.map((s) => s.toLowerCase()));
      const out: string[] = [];
      for (const q of lists.flat()) {
        const key = q.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(q.trim());
      }
      return out.slice(0, MAX_EXTRA_GOOGLE_QUERIES);
    };

    type Step = { label: string; level: number | null; webQueries: () => Promise<string[]>; nameQueries: () => Promise<string[]> };
    const steps: Step[] = rings.map((ring) => {
      const queries = ringSearchQueries({ anchors, ring, maxQueries: 6 });
      return {
        label: ring.label,
        level: ring.level,
        webQueries: async () => queries,
        nameQueries: async () => queries.slice(0, 2),
      };
    });
    let extra: string[] | null = null;
    const extraOnce = async () => (extra ??= await expansions(anchors));
    steps.push({
      label: webCountry ? `across ${webCountry}` : "in all regions",
      level: null,
      webQueries: async () => [...anchors.slice(0, 4), ...(await extraOnce())],
      nameQueries: async () => [...nameQueriesFor(anchors), ...(await extraOnce())],
    });

    for (const [index, step] of steps.entries()) {
      if (done()) break;
      if (step.level != null) {
        job.targetLocations = placesUpToRing(rings, step.level);
        relaxedReview = step.level > 0;
        if (step.level > 0) await releaseHeld(false);
      } else if (rings.length) {
        // Local rings ran short: go country-wide, rivals held for being in
        // another city first.
        countryWide = true;
        relaxedReview = true;
        await releaseHeld(true);
      }
      if (done()) break;
      progress(
        "finding_domains",
        index === 0
          ? `Searching the web for "${anchors[0] || allKeywords[0]}" ${step.label} (results from ${regionName})…`
          : `Found ${accepted.length} of ${TARGET_COMPETITORS} so far. Widening the search ${step.label}…`,
      );

      const webQueries = await step.webQueries();
      const web = await webSearchDomains({
        queries: webQueries,
        country: webCountry,
        businessProfile,
        signalKeywords: anchors.length ? anchors : allKeywords,
        exclude: checkedDomains,
        state: webState,
      });
      if (web.domains.length && !done()) {
        progress("ranking_domains", `Ranking ${web.domains.length} sites found ${step.label}…`);
        const kept = await keepLikelyCompetitorDomains({
          keyword: webQueries[0] || anchors[0] || "",
          domains: web.domains,
          snippets: web.snippets,
          platform,
          businessProfile,
        });
        if (kept.length < web.domains.length) bumpReason(job, "notCompetitorSite", web.domains.length - kept.length);
        await checkWebDomains(kept.slice(0, MAX_DOMAIN_CHECKS_PER_STEP), webQueries[0] || "");
      }
      if (!done()) {
        await searchAdvertiserNames(await step.nameQueries(), step.level == null ? 8 : 4);
      }
    }
    if (pendingReview.length) await flushReview();

    // Anything still held fills the list last.
    if (heldMismatches.length && !done()) {
      progress("filling_quota", "Adding competitors from outside the local area to fill the list…");
      await releaseHeld(true);
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
          ? `Found ${accepted.length} competitors on ${platform} (ads shown in ${regionName}). Brand review & deep location run on demand / during offer analysis.`
          : `No qualifying competitors found on ${platform} with ads shown in ${regionName}.`;
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

function queueAddressEnrich(job: SearchJob, competitor: CompetitorRecord) {
  const competitorId = competitor.id;
  void (async () => {
    try {
      const { enrichCompetitorSociavaultAddress } = await import(
        "./competitorLocation"
      );
      await enrichCompetitorSociavaultAddress({
        competitorId,
        facebookUrl: competitor.brand?.facebookUrl || null,
        linkedinUrl: competitor.brand?.linkedinUrl || null,
        geoMode: job.geoMode || "countrywide",
        targetLocations: job.targetLocations || [],
      });
    } catch {
      /* provisional location stays */
    }
  })();
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
  heldMismatches?: CompetitorRecord[];
  /** Past the first local ring the AI review is relaxed. */
  relaxedReview?: boolean;
  /** Found by a web search for the keywords, so its copy need not repeat them. */
  fromWeb?: boolean;
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
    heldMismatches,
    relaxedReview,
    fromWeb,
  } = args;

  if (isSearchJobSuppressed(job.id)) return;

  // The client's own business shows up in its own keyword searches.
  if (
    ownBusinessCheck(job.businessProfile || null, job.businessUrl)({
      pageName,
      urls: [domain, websiteHint, ...ads.map((ad) => ad.domain)],
    })
  ) {
    job.progress.rejected += 1;
    bumpReason(job, "guardrailReject");
    job.progress.message = `Skipped ${pageName}: this is your client's own business`;
    saveJobProgress(job);
    return;
  }

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

  // Text ads first: image and video ads often come back with no readable
  // words, and one unreadable ad must not cost the whole advertiser. Up to
  // MAX_DETAIL_TRIES ads are read, stopping at the first with English copy.
  const isText = (ad: GoogleAdCreative) => String(ad.format || "").toLowerCase() === "text";
  const textFirst = [...sampleSource].sort((a, b) => Number(isText(b)) - Number(isText(a)));
  const english: AdCandidate[] = [];
  let readable = 0;
  for (const ad of textFirst.slice(0, MAX_DETAIL_TRIES)) {
    if (isSearchJobSuppressed(job.id)) return;
    const details = await enrichGoogleAd(ad);
    if (platform === "youtube" && !isYouTubeCreative(ad, details)) continue;
    const candidate = mapGoogleCreativeToCandidate(ad, details);
    if (`${candidate.title} ${candidate.body}`.trim().length < 12) continue;
    readable += 1;
    if (!looksLikeEnglish(`${candidate.title}\n${candidate.body}\n${candidate.fullText}`)) continue;
    english.push(candidate);
    if (english.length >= DETAILS_PER_ADVERTISER) break;
  }

  if (english.length === 0) {
    job.progress.rejected += 1;
    bumpReason(job, readable ? "nonEnglish" : "noReadableCopy");
    job.progress.message = readable
      ? `Skipped ${pageName}: ad copy is not English`
      : `Skipped ${pageName}: none of its ads had readable text`;
    saveJobProgress(job);
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
    bumpReason(job, "noReadableCopy");
    job.progress.message = `Skipped ${pageName}: creatives had no readable ad copy`;
    saveJobProgress(job);
    return;
  }

  const hasSignals =
    keywords.some((kw) => kw.trim().length >= 3) || Boolean(job.businessProfile);
  if (
    hasSignals &&
    !fromWeb &&
    primaryCopy.length >= 40 &&
    serviceKeywordOverlapScore(primaryCopy, {
      businessProfile: job.businessProfile,
      searchKeywords: keywords,
      selectedCategory: job.selectedCategory,
    }) === 0
  ) {
    job.progress.rejected += 1;
    bumpReason(job, "noServiceSignal");
    job.progress.message = `Skipped ${pageName}: ad copy does not match the keywords`;
    saveJobProgress(job);
    return;
  }

  if (!meetsDurationThreshold(primary.daysRunning, thresholds)) {
    job.progress.rejected += 1;
    bumpReason(job, "shortDuration");
    job.progress.message = `Skipped ${pageName}: its ads have not run long enough`;
    saveJobProgress(job);
    return;
  }

  if (isSearchJobSuppressed(job.id) || accepted.length >= TARGET_COMPETITORS) return;

  const guardCtx = buildGuardrailContext({
    businessProfile: job.businessProfile,
    selectedCategoryLabel: job.selectedCategory?.label || null,
    searchKeywords: keywords,
    override: job.guardrailOverride || null,
    skipGuardrails: Boolean(job.skipGuardrails),
  });
  const allCopy = english.map((c) => `${c.title}\n${c.body}\n${c.fullText}`).join("\n");
  const targetCountries = (job.countries?.length ? job.countries : [String(job.geo || "US")]).map(String);
  // Plugins, proxies, courses, publishers, foreign sites: no AI review needed.
  const pre = precheckCompetitor(guardCtx, {
    pageName,
    adText: `${pageName}\n${allCopy}`,
    landingPageUrls: english.map((c) => c.landingPageUrl),
    targetCountries,
  });
  if (!pre.ok) {
    job.progress.rejected += 1;
    bumpReason(job, "guardrailReject");
    job.progress.message = `Skipped ${pageName}: ${pre.reason}`;
    saveJobProgress(job);
    return;
  }

  let filter;
  try {
    job.progress.stage = "analyzing_ad";
    job.progress.message = `LLM reviewing ${pageName}…`;
    saveJobProgress(job);
    filter = await analyzeAdCandidate(
      keywords[0] || query,
      primary,
      null,
      english.filter((a) => a.adArchiveId !== primary.adArchiveId).slice(0, 5),
      {
        relaxed: Boolean(relaxedReview) || accepted.length >= 3,
        businessProfile: job.businessProfile,
        searchKeywords: keywords,
        selectedCategory: job.selectedCategory,
        targetCountry: targetCountries[0] || null,
      },
    );
  } catch (err) {
    if (isCreditError(err)) throw err;
    job.progress.rejected += 1;
    bumpReason(job, "llmError");
    job.progress.message = `Skipped ${pageName}: the relevance review failed (${(err as Error).message.slice(0, 80)})`;
    saveJobProgress(job);
    return;
  }

  if (
    !filter.relevant ||
    (!job.businessProfile && !filter.isMarketingAgency)
  ) {
    job.progress.rejected += 1;
    bumpReason(job, "llmReject");
    job.progress.message = `Rejected ${pageName}: ${filter.reason || "not a competitor"}`;
    saveJobProgress(job);
    return;
  }

  const guard = guardCompetitorHeuristic(guardCtx, {
    pageName,
    adText: allCopy,
    landingPageUrl: primary.landingPageUrl,
    services: filter.services,
  });
  if (!guard.ok) {
    job.progress.rejected += 1;
    bumpReason(job, "guardrailReject");
    job.progress.message = `Guardrail blocked ${pageName}: ${guard.reason}`;
    saveJobProgress(job);
    return;
  }

  const activeCount = durationQualified.length > 0
    ? durationQualified.length
    : pool.length;

  if (!meetsActiveAdsThreshold(activeCount, thresholds)) {
    job.progress.rejected += 1;
    bumpReason(job, "lowActiveAds");
    job.progress.message = `Skipped ${pageName}: ${activeCount} ads (need ≥${thresholds.minActiveAds})`;
    saveJobProgress(job);
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

  // City/suburb search (held list given while searching local rings): the
  // business's real address decides, since ad copy rarely names the suburb.
  if (heldMismatches) {
    job.progress.message = `Checking where ${pageName} is located…`;
    saveJobProgress(job);
    const { lookupCompetitorPlace, matchPlaceToTargets } = await import("./competitorLocation");
    const looked = await lookupCompetitorPlace({
      pageName,
      website,
      landingPageUrl: primary.landingPageUrl,
      countryHint: country,
    });
    const place = looked
      ? matchPlaceToTargets(looked, job.targetLocations || [], job.geoMode || "countrywide")
      : provisional;
    Object.assign(competitor, {
      locationLabel: place.locationLabel,
      locationCity: place.locationCity,
      locationSuburb: place.locationSuburb,
      locationCountry: place.locationCountry,
      locationStatus: place.locationStatus,
      locationSource: place.locationSource,
    });
    if (place.locationStatus !== "matched") {
      heldMismatches.push(competitor);
      job.progress.message = `Holding ${pageName}: ${
        looked ? `based in ${looked.locationLabel || looked.locationCity}` : "address not found"
      } — searching nearer first`;
      saveJobProgress(job);
      return;
    }
  }

  // Reviews run in parallel; another one may have filled the list meanwhile.
  if (accepted.length >= TARGET_COMPETITORS || isSearchJobSuppressed(job.id)) return;
  saveCompetitor(competitor);
  accepted.push(competitor);
  job.competitorIds.push(competitor.id);
  job.progress.accepted = accepted.length;

  const restForLanding = sampleSource.slice(DETAILS_PER_ADVERTISER, DETAILS_PER_ADVERTISER + 2);
  queueAddressEnrich(job, competitor);
  void (async () => {
    if (primary.landingPageUrl || restForLanding.length === 0) return;
    for (const ad of restForLanding) {
      const details = await enrichGoogleAd(ad);
      const candidate = mapGoogleCreativeToCandidate(ad, details);
      if (!candidate.landingPageUrl) continue;
      const richer = sampleAdFromGoogleCandidate(candidate, platform, domainHint);
      updateCompetitor(competitor.id, { sampleAd: richer });
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
