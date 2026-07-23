import { v4 as uuidv4 } from "uuid";
import {
  extractGoogleAds,
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
} from "../openai/analyzer";
import { saveCompetitor, saveJob, saveLookupAd, saveLookupJob } from "../db";
import {
  TARGET_COMPETITORS,
  type AdCandidate,
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

const MAX_DOMAIN_AD_PAGES = 10;
const MAX_ADS_PAGES = 10;
const MAX_DOMAINS_PER_QUERY = 12;

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

/** Web-search for agency domains, then LLM-rank + SociaVault verify. */
async function discoverAndVerifyDomains(args: {
  query: string;
  platform: "google" | "youtube";
  transparencyDomains: string[];
  advertisers: Array<{ name: string; region?: string | null }>;
  onProgress: (message: string) => void;
}): Promise<{ domains: string[]; reason: string }> {
  const { query, platform, transparencyDomains, advertisers, onProgress } = args;

  const snippets: Array<{ title?: string; url?: string; description?: string }> =
    [];
  const webDomains: string[] = [];

  const searchQueries = [
    `${query} marketing agency`,
    `${query} Google Ads agency`,
    `${query} PPC agency`,
    platform === "youtube"
      ? `${query} YouTube ads agency`
      : `${query} digital marketing agency`,
  ];

  onProgress(`Web-searching agency domains for "${query}"…`);
  for (const q of searchQueries.slice(0, 3)) {
    try {
      const res = await googleSearch(q, "US");
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
    } catch {
      // continue other queries
    }
  }

  let proposed: string[] = [];
  try {
    const prop = await proposeAgencyDomains(query, platform, 8);
    proposed = prop.domains;
  } catch {
    /* optional */
  }

  const candidatePool = Array.from(
    new Set([...webDomains, ...transparencyDomains, ...proposed]),
  );

  onProgress(
    `LLM ranking ${candidatePool.length} domains (web + Transparency)…`,
  );
  let ranked: string[] = [];
  let reason = "";
  try {
    const pick = await pickGoogleAdDomains(query, candidatePool, advertisers, {
      platform,
      limit: MAX_DOMAINS_PER_QUERY,
      webSnippets: snippets,
    });
    ranked = pick.domains;
    reason = pick.reason;
  } catch {
    ranked = candidatePool.slice(0, MAX_DOMAINS_PER_QUERY);
    reason = "Fallback domain list (LLM ranking unavailable)";
  }

  // Cross-verify with SociaVault: domain must return at least one public ad
  onProgress(`Verifying ${ranked.length} domains in Google Transparency…`);
  const verified: string[] = [];
  for (const domain of ranked) {
    if (verified.length >= MAX_DOMAINS_PER_QUERY) break;
    try {
      // Prefer company-ads by domain — proves ads exist
      const adsRes = await getGoogleCompanyAds({
        domain,
        region: "US",
      });
      let ads = extractGoogleAds(adsRes);
      if (platform === "youtube") {
        ads = ads.filter(
          (ad) => String(ad.format || "").toLowerCase() === "video",
        );
        if (ads.length === 0) {
          const advRes = await searchGoogleAdvertisers(domain);
          if (
            extractGoogleWebsites(advRes).length === 0 &&
            extractGoogleAdvertisers(advRes).length === 0
          ) {
            continue;
          }
          verified.push(domain);
          continue;
        }
      }
      if (ads.length > 0) {
        verified.push(domain);
        continue;
      }
      // Soft verify via search-advertisers presence
      const advRes = await searchGoogleAdvertisers(domain);
      if (
        extractGoogleWebsites(advRes).length > 0 ||
        extractGoogleAdvertisers(advRes).length > 0
      ) {
        verified.push(domain);
      }
    } catch {
      // skip unverified
    }
  }

  if (verified.length === 0 && ranked.length > 0) {
    // Last resort: keep ranked list so fetch can still attempt
    return {
      domains: ranked.slice(0, 8),
      reason: `${reason} (SociaVault verify soft-failed; trying ranked domains anyway)`,
    };
  }

  return {
    domains: verified,
    reason: `${reason} · verified ${verified.length}/${ranked.length} via SociaVault`,
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

async function fetchAdsForDomain(domain: string, region = "US") {
  const ads: GoogleAdCreative[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res = await getGoogleCompanyAds({
      domain,
      region,
      cursor,
    });
    ads.push(...extractGoogleAds(res));
    cursor = extractGoogleCursor(res);
    pages += 1;
  } while (cursor && pages < MAX_DOMAIN_AD_PAGES);
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
) {
  const keywords = parseKeywords(keywordInput);
  const now = new Date().toISOString();
  const job: SearchJob = {
    id: jobId,
    keyword: keywords.join(", "),
    keywords,
    platform,
    status: "running",
    progress: {
      stage: "expanding_queries",
      scannedAds: 0,
      scannedPages: 0,
      accepted: 0,
      target: TARGET_COMPETITORS,
      rejected: 0,
      message: `Discovering ${platform} advertiser domains…`,
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
        for (const q of await expandKeywordQueries(kw)) queries.add(q);
      } catch {
        /* keep seed */
      }
    }

    outer: for (const query of Array.from(queries).slice(0, 10)) {
      if (accepted.length >= TARGET_COMPETITORS) break;

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

      job.progress.stage = "ranking_domains";
      let rankedDomains: string[] = [];
      try {
        const discovered = await discoverAndVerifyDomains({
          query,
          platform,
          transparencyDomains,
          advertisers,
          onProgress: (message) => {
            job.progress.message = message;
            saveJob(job);
          },
        });
        rankedDomains = discovered.domains;
        job.progress.message = `Selected ${rankedDomains.length} domains — ${discovered.reason.slice(0, 180)}`;
        saveJob(job);
      } catch (err) {
        rankedDomains = transparencyDomains.slice(0, MAX_DOMAINS_PER_QUERY);
        job.progress.message = `Domain discovery fallback: ${(err as Error).message}`;
        saveJob(job);
      }

      // If no domains, fall back to advertiser IDs
      if (rankedDomains.length === 0) {
        job.progress.message = `No verified domains for "${query}"; trying advertiser IDs…`;
        saveJob(job);
        for (const adv of advertisersRaw.slice(0, 10)) {
          const id = String(adv.advertiser_id || "");
          if (!id || seenAdvertisers.has(id)) continue;
          seenAdvertisers.add(id);
          try {
            const adsRes = await getGoogleCompanyAds({
              advertiser_id: id,
              region: adv.region ? String(adv.region) : "US",
            });
            let ads = extractGoogleAds(adsRes);
            if (platform === "youtube") {
              ads = ads.filter((ad) => isYouTubeCreative(ad));
            }
            job.progress.scannedAds += ads.length;
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
              country: adv.region ? String(adv.region) : "US",
              websiteHint: null,
            });
            if (accepted.length >= TARGET_COMPETITORS) break outer;
          } catch {
            job.progress.rejected += 1;
          }
        }
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
          ads = await fetchAdsForDomain(domain, "US");
          job.progress.scannedPages += 1;
        } catch (err) {
          job.progress.rejected += 1;
          job.progress.message = `Domain ${domain} failed: ${(err as Error).message}`;
          saveJob(job);
          continue;
        }

        // YouTube: only video-format creatives
        if (platform === "youtube") {
          ads = ads.filter((ad) => isYouTubeCreative(ad));
        }

        job.progress.scannedAds += ads.length;

        if (ads.length === 0) {
          job.progress.rejected += 1;
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
            country: "US",
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
    const score = (c: AdCandidate) =>
      (c.landingPageUrl ? 50 : 0) +
      (c.title ? 20 : 0) +
      (c.daysRunning >= 0 ? 15 : 0) +
      (c.fullText?.length || 0) / 50;
    return score(b) - score(a);
  })[0];

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
      enriched.filter((a) => a.adArchiveId !== primary.adArchiveId).slice(0, 3),
      { relaxed: true },
    );
  } catch {
    job.progress.rejected += 1;
    return;
  }

  if (!filter.relevant || !filter.isMarketingAgency) {
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

  job.progress.stage = "brand_review";
  job.progress.message = `Brand review for ${pageName}…`;
  saveJob(job);

  const snap = primary.snapshot as GoogleAdCreative & {
    _details?: { youtubeUrl?: string | null };
  };
  const domainHint = snap.domain || domain;
  const website =
    normalizeWebsiteUrl(websiteHint) ||
    (domainHint ? websiteUrl(domainHint) : null);
  // Only a real YouTube creative URL — never landing pages / transparency URLs
  const creativeYt = isYouTubeUrl(snap._details?.youtubeUrl)
    ? String(snap._details?.youtubeUrl)
    : null;

  let brand;
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
  } catch (err) {
    brand = {
      website,
      category:
        platform === "youtube" ? "YouTube advertiser" : "Google advertiser",
      youtubeUrl: creativeYt,
    };
    job.progress.message = `Partial brand review for ${pageName}: ${(err as Error).message}`;
    saveJob(job);
  }

  brand = sanitizeBrandForPlatform(brand, platform, {
    websiteHint: website,
    creativeYoutubeUrl: creativeYt,
  });

  const sampleAd = sampleAdFromGoogleCandidate(primary, platform, domainHint);

  const competitor: CompetitorRecord = {
    id: newId(),
    runId: job.id,
    pageId,
    pageName,
    country,
    platform,
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
  job.progress.stage = "searching_ads";
  job.progress.message = `Accepted ${pageName} (${accepted.length}/${TARGET_COMPETITORS}) via ${domain}`;
  saveJob(job);
}

export async function runGoogleFamilyLookup(
  lookupId: string,
  queryName: string,
  platform: Extract<AdPlatform, "google" | "youtube">,
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

    const candidates: LookupPageCandidate[] = [
      ...advertisers
        .map((a) => ({
          pageId: String(a.advertiser_id || ""),
          name: String(a.name || ""),
          category: a.region ? `Region ${a.region}` : null,
          country: a.region ? String(a.region) : null,
          raw: a as Record<string, unknown>,
        }))
        .filter((c) => c.pageId && c.name),
      ...websites.map((domain) => ({
        pageId: `domain:${domain}`,
        name: domain,
        category: "Website domain",
        country: "US",
        raw: { domain } as Record<string, unknown>,
      })),
    ].slice(0, 24);

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

    const pick = await pickCompanyPageMatch(
      queryName,
      candidates.map((c) => ({
        pageId: c.pageId,
        name: c.name,
        category: c.category,
        likes: null,
        verification: null,
        igUsername: null,
        pageAlias: null,
      })),
    );

    const selected =
      candidates.find((c) => c.pageId === pick.selectedPageId) || candidates[0];
    job.selectedPage = selected;
    job.llmReason = pick.reason;
    job.llmConfidence = pick.confidence;
    job.progress.stage = "fetching_ads";
    job.progress.message = `Fetching ads for ${selected.name}…`;
    saveLookupJob(job);

    let cursor: string | null = null;
    let pages = 0;
    const stored: LookupAdRecord[] = [];
    const seen = new Set<string>();
    const isDomain = selected.pageId.startsWith("domain:");
    const domain = isDomain
      ? selected.pageId.replace(/^domain:/, "")
      : selected.name.includes(".")
        ? selected.name
        : null;

    do {
      const adsRes = await getGoogleCompanyAds({
        advertiser_id: isDomain ? undefined : selected.pageId,
        domain: domain || undefined,
        region: selected.country || "US",
        cursor,
      });
      let ads = extractGoogleAds(adsRes);
      if (platform === "youtube") {
        ads = ads.filter((ad) => isYouTubeCreative(ad));
      }
      cursor = extractGoogleCursor(adsRes);
      pages += 1;
      job.progress.pagesScanned += 1;

      for (const ad of ads) {
        const id = String(ad.creativeId || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const details = await enrichGoogleAd(ad);
        if (platform === "youtube" && !isYouTubeCreative(ad, details)) {
          continue;
        }

        const mapped = mapGoogleCreativeToCandidate(ad, details);
        const sample = sampleAdFromGoogleCandidate(
          mapped,
          platform,
          domain,
        );
        const record: LookupAdRecord = {
          id: uuidv4(),
          lookupId: job.id,
          adArchiveId: id,
          pageId: selected.pageId,
          pageName: selected.name,
          country: selected.country || "US",
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
      }

      job.progress.adsFetched = stored.length;
      job.progress.message = `Fetched ${stored.length} ${platform} ads…`;
      saveLookupJob(job);
    } while (cursor && pages < MAX_ADS_PAGES);

    job.status = stored.length > 0 ? "completed" : "partial";
    job.progress.stage = "done";
    job.progress.message =
      stored.length > 0
        ? `Loaded ${stored.length} ads for "${selected.name}".`
        : `Matched "${selected.name}" but found no public ${platform} ads.`;
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
