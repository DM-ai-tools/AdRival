import { v4 as uuidv4 } from "uuid";
import {
  extractLinkedInAds,
  extractLinkedInPagination,
  searchLinkedInAds,
} from "../sociavault/client";
import {
  analyzeAdCandidate,
  expandKeywordQueries,
  hasServiceKeywordSignal,
} from "../openai/analyzer";
import { saveCompetitor, saveJob, saveLookupAd, saveLookupJob } from "../db";
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
import {
  getPlatformAdThresholds,
  meetsActiveAdsThreshold,
  parseKeywords,
} from "../platforms";
import { newId, normalizeLinkedInCompanyUrl, runBrandReview } from "./brandReview";
import {
  mapLinkedInAdToCandidate,
  pickBestLinkedInCandidate,
  sampleAdFromLinkedInCandidate,
} from "./adMappers";
import { enrichLookupPageMetrics } from "./lookupEnrichment";
import { linkedInCountriesFromGeo } from "../geo";

const MAX_LI_PAGES = 12;
const MAX_COMPANY_COUNT_PAGES = 8;

/** Count company ads across LinkedIn Ad Library pages for active-ads gate. */
async function countLinkedInCompanyAds(companyName: string): Promise<{
  count: number;
  maxDays: number;
  sample: AdCandidate | null;
  withMeta: AdCandidate[];
}> {
  let token: string | null = null;
  let pages = 0;
  let count = 0;
  let maxDays = -1;
  const withMeta: AdCandidate[] = [];
  const seen = new Set<string>();

  do {
    const res = await searchLinkedInAds({
      company: companyName,
      countries: "US,AU",
      paginationToken: token,
    });
    const ads = extractLinkedInAds(res);
    const pageInfo = extractLinkedInPagination(res);
    token = pageInfo.isLastPage ? null : pageInfo.token;
    pages += 1;

    for (const raw of ads) {
      const id = String(raw.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const c = mapLinkedInAdToCandidate(raw);
      withMeta.push(c);
      count += 1;
      if (c.daysRunning > maxDays) maxDays = c.daysRunning;
    }
  } while (token && pages < MAX_COMPANY_COUNT_PAGES);

  const sample =
    withMeta.length > 0 ? pickBestLinkedInCandidate(withMeta) : null;

  return { count, maxDays, sample, withMeta };
}

export async function runLinkedInSearch(
  jobId: string,
  keywordInput: string | string[],
  options?: import("./searchOptions").SearchDispatchOptions,
) {
  const keywords = parseKeywords(keywordInput);
  const now = new Date().toISOString();
  const geo = options?.geo || "US";
  const businessProfile = options?.businessProfile || null;
  const businessUrl =
    (options?.businessUrl || businessProfile?.url || "").trim() || null;
  const liCountries = linkedInCountriesFromGeo(geo);
  const job: SearchJob = {
    id: jobId,
    keyword: keywords.join(", "),
    keywords,
    platform: "linkedin",
    geo,
    geoMode: options?.geoMode || "countrywide",
    selectedCategory: options?.selectedCategory || null,
    targetLocations: options?.targetLocations || [],
    keywordLocation: options?.keywordLocation || null,
    countries: liCountries.split(","),
    businessUrl,
    businessProfile,
    status: "running",
    progress: {
      stage: "searching_ads",
      scannedAds: 0,
      scannedPages: 0,
      accepted: 0,
      target: TARGET_COMPETITORS,
      rejected: 0,
      message: businessProfile
        ? `Searching LinkedIn for ${businessProfile.industry} competitors…`
        : "Searching LinkedIn Ad Library…",
    },
    competitorIds: [],
    createdAt: now,
    updatedAt: now,
  };
  saveJob(job);

  const accepted: CompetitorRecord[] = [];
  const seenAdvertisers = new Set<string>();
  const analyzed = new Set<string>();
  const thresholds = getPlatformAdThresholds("linkedin");
  const selectedCategory = options?.selectedCategory || null;
  const targetLocations = options?.targetLocations || [];
  const geoMode = options?.geoMode || "countrywide";
  const preferLocalGeo =
    geoMode === "company_locations" || geoMode === "keyword_location";
  const signalOptions = {
    businessProfile,
    searchKeywords: keywords,
    selectedCategory,
  };
  const heldGeo: Array<{
    pageId: string;
    primary: AdCandidate;
    pool: AdCandidate[];
    filter: Awaited<ReturnType<typeof analyzeAdCandidate>>;
    activeCount: number;
    liUrl: string | null;
  }> = [];

  try {
    const queries = new Set<string>(keywords);
    for (const kw of keywords) {
      try {
        for (const q of await expandKeywordQueries(kw, businessProfile, {
          geoMode,
          targetLocations,
          selectedCategory,
        }))
          queries.add(q);
      } catch {
        /* seed only */
      }
    }
    if (preferLocalGeo) {
      for (const loc of targetLocations.slice(0, 4)) {
        const place = loc.suburb || loc.city || loc.label;
        if (!place) continue;
        for (const kw of keywords.slice(0, 3)) queries.add(`${kw} ${place}`);
      }
    }

    outer: for (const query of Array.from(queries).slice(0, 16)) {
      let token: string | null = null;
      let pages = 0;

      do {
        if (accepted.length >= TARGET_COMPETITORS) break outer;
        job.progress.message = `LinkedIn keyword "${query}" — page ${pages + 1}…`;
        saveJob(job);

        let res;
        try {
          res = await searchLinkedInAds({
            keyword: query,
            countries: liCountries,
            paginationToken: token,
          });
        } catch (err) {
          job.progress.message = `LinkedIn search error: ${(err as Error).message}`;
          saveJob(job);
          break;
        }

        pages += 1;
        job.progress.scannedPages += 1;
        const ads = extractLinkedInAds(res);
        const pageInfo = extractLinkedInPagination(res);
        token = pageInfo.isLastPage ? null : pageInfo.token;

        const byAdvertiser = new Map<string, AdCandidate[]>();
        for (const raw of ads) {
          job.progress.scannedAds += 1;
          const c = mapLinkedInAdToCandidate(raw);
          if (!c.pageId) continue;
          const list = byAdvertiser.get(c.pageId) ?? [];
          list.push(c);
          byAdvertiser.set(c.pageId, list);
        }

        for (const [pageId, pageAds] of byAdvertiser) {
          if (accepted.length >= TARGET_COMPETITORS) break outer;
          if (seenAdvertisers.has(pageId) || analyzed.has(pageId)) continue;
          analyzed.add(pageId);

          const pool = pageAds;
          let primary = pickBestLinkedInCandidate(pool);
          const signal = `${primary.title}\n${primary.body}\n${primary.fullText}`;
          if (!hasServiceKeywordSignal(signal, signalOptions)) {
            job.progress.rejected += 1;
            continue;
          }

          let filter;
          try {
            filter = await analyzeAdCandidate(
              keywords[0] || query,
              primary,
              null,
              pool.filter((a) => a.adArchiveId !== primary.adArchiveId).slice(0, 5),
              {
                relaxed: accepted.length >= 5,
                businessProfile,
                searchKeywords: keywords,
                selectedCategory,
              },
            );
          } catch {
            job.progress.rejected += 1;
            continue;
          }

          if (
            !filter.relevant ||
            (!businessProfile && !filter.isMarketingAgency)
          ) {
            job.progress.rejected += 1;
            continue;
          }

          job.progress.message = `Counting LinkedIn ads for ${primary.pageName}…`;
          saveJob(job);

          let activeCount = pageAds.length;
          try {
            const counted = await countLinkedInCompanyAds(primary.pageName);
            if (counted.count > activeCount) activeCount = counted.count;
            if (counted.sample) {
              primary = pickBestLinkedInCandidate([primary, counted.sample]);
            }
          } catch {
            // keep batch count
          }

          if (!meetsActiveAdsThreshold(activeCount, thresholds)) {
            job.progress.rejected += 1;
            job.progress.message = `Skipped ${primary.pageName}: ${activeCount} ads (need ≥${thresholds.minActiveAds})`;
            saveJob(job);
            continue;
          }

          const liUrl =
            normalizeLinkedInCompanyUrl(primary.pageProfileUri) ||
            primary.pageProfileUri ||
            null;

          const {
            cheapLocationFromText,
            resolveAndMatchCompetitorLocation,
          } = await import("./competitorLocation");
          const { updateCompetitor } = await import("../db");

          const provisional = cheapLocationFromText({
            pageName: primary.pageName,
            adText: primary.fullText || primary.body,
            landingUrl: primary.landingPageUrl,
            targets: targetLocations,
            geoMode,
          });

          if (
            preferLocalGeo &&
            provisional.locationStatus === "mismatch" &&
            accepted.filter((c) => c.locationStatus !== "mismatch").length < 4
          ) {
            heldGeo.push({
              pageId,
              primary,
              pool,
              filter,
              activeCount,
              liUrl,
            });
            job.progress.message = `Holding ${primary.pageName}: outside target geo — seeking locals first`;
            saveJob(job);
            continue;
          }

          // Save first with minimal brand
          let brand: BrandReview = {
            linkedinUrl: liUrl,
            website: primary.landingPageUrl || null,
            category: "LinkedIn advertiser",
          };

          const competitor: CompetitorRecord = {
            id: newId(),
            runId: job.id,
            pageId,
            pageName: primary.pageName,
            country: geo,
            platform: "linkedin",
            locationLabel: provisional.locationLabel,
            locationCity: provisional.locationCity,
            locationSuburb: provisional.locationSuburb,
            locationCountry: provisional.locationCountry,
            locationStatus: provisional.locationStatus,
            locationSource: provisional.locationSource,
            activeAdsCount: activeCount,
            services: filter.services as ServiceLabel[],
            sampleAd: sampleAdFromLinkedInCandidate(primary),
            brand,
            createdAt: new Date().toISOString(),
          };
          seenAdvertisers.add(pageId);
          saveCompetitor(competitor);
          accepted.push(competitor);
          job.competitorIds.push(competitor.id);
          job.progress.accepted = accepted.length;
          job.progress.message = `Accepted ${primary.pageName} (${accepted.length}/${TARGET_COMPETITORS}) — location pending…`;
          saveJob(job);

          job.progress.stage = "brand_review";
          job.progress.message = `Enriching brand for ${primary.pageName}…`;
          saveJob(job);
          try {
            brand = await runBrandReview({
              pageId,
              pageName: primary.pageName,
              pageProfileUri: null,
              linkedinUrlHint: liUrl,
              websiteHint: primary.landingPageUrl,
              categoryHint: "LinkedIn advertiser",
              sourcePlatform: "linkedin",
            });
            if (!brand.linkedinUrl && liUrl) brand.linkedinUrl = liUrl;
          } catch (err) {
            job.progress.message = `Partial brand review for ${primary.pageName}: ${(err as Error).message}`;
            saveJob(job);
          }

          job.progress.stage = "location_check";
          job.progress.message = `Resolving location for ${primary.pageName}…`;
          saveJob(job);
          let loc = provisional;
          try {
            const locResult = await resolveAndMatchCompetitorLocation({
              pageName: primary.pageName,
              website: brand.website,
              facebookUrl: brand.facebookUrl,
              linkedinUrl: brand.linkedinUrl || liUrl,
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
          job.progress.message = `Accepted ${primary.pageName} (${accepted.length}/${TARGET_COMPETITORS})${locNote}`;
          saveJob(job);
        }
      } while (token && pages < MAX_LI_PAGES);
    }

    // Fill from geo-held LinkedIn rivals only after locals
    if (accepted.length < TARGET_COMPETITORS && heldGeo.length > 0) {
      job.progress.stage = "filling_quota";
      job.progress.message = `Filling from ${heldGeo.length} geo-held LinkedIn candidates…`;
      saveJob(job);
      for (const held of heldGeo) {
        if (accepted.length >= TARGET_COMPETITORS) break;
        if (seenAdvertisers.has(held.pageId)) continue;
        const {
          cheapLocationFromText,
          resolveAndMatchCompetitorLocation,
        } = await import("./competitorLocation");
        const { updateCompetitor } = await import("../db");
        const provisional = cheapLocationFromText({
          pageName: held.primary.pageName,
          adText: held.primary.fullText || held.primary.body,
          landingUrl: held.primary.landingPageUrl,
          targets: targetLocations,
          geoMode,
        });
        let brand: BrandReview = {
          linkedinUrl: held.liUrl,
          website: held.primary.landingPageUrl || null,
          category: "LinkedIn advertiser",
        };
        const competitor: CompetitorRecord = {
          id: newId(),
          runId: job.id,
          pageId: held.pageId,
          pageName: held.primary.pageName,
          country: geo,
          platform: "linkedin",
          locationLabel: provisional.locationLabel,
          locationCity: provisional.locationCity,
          locationSuburb: provisional.locationSuburb,
          locationCountry: provisional.locationCountry,
          locationStatus: provisional.locationStatus,
          locationSource: provisional.locationSource,
          activeAdsCount: held.activeCount,
          services: held.filter.services as ServiceLabel[],
          sampleAd: sampleAdFromLinkedInCandidate(held.primary),
          brand,
          createdAt: new Date().toISOString(),
        };
        seenAdvertisers.add(held.pageId);
        saveCompetitor(competitor);
        accepted.push(competitor);
        job.competitorIds.push(competitor.id);
        try {
          brand = await runBrandReview({
            pageId: held.pageId,
            pageName: held.primary.pageName,
            pageProfileUri: null,
            linkedinUrlHint: held.liUrl,
            websiteHint: held.primary.landingPageUrl,
            categoryHint: "LinkedIn advertiser",
            sourcePlatform: "linkedin",
          });
          if (!brand.linkedinUrl && held.liUrl) brand.linkedinUrl = held.liUrl;
        } catch {
          /* keep minimal */
        }
        let loc = provisional;
        try {
          const locResult = await resolveAndMatchCompetitorLocation({
            pageName: held.primary.pageName,
            website: brand.website,
            facebookUrl: brand.facebookUrl,
            linkedinUrl: brand.linkedinUrl || held.liUrl,
            geoMode,
            targetLocations,
            provisional,
            skipPerplexityIfResolved: provisional.locationStatus === "matched",
          });
          loc = locResult.location;
        } catch {
          /* provisional */
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
        job.progress.accepted = accepted.length;
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
        ? `Found ${accepted.length} LinkedIn competitors.`
        : "No qualifying LinkedIn competitors found.";
    job.updatedAt = new Date().toISOString();
    saveJob(job);
  } catch (err) {
    job.status = "failed";
    job.error = (err as Error).message;
    job.progress.stage = "failed";
    job.progress.message = (err as Error).message;
    saveJob(job);
  }
}

export async function runLinkedInLookup(
  lookupId: string,
  queryName: string,
  forcedCandidate?: LookupPageCandidate | null,
) {
  const name = forcedCandidate?.name || queryName;
  const now = new Date().toISOString();
  const job: LookupJob = {
    id: lookupId,
    queryName: name,
    platform: "linkedin",
    status: "running",
    progress: {
      stage: "fetching_ads",
      message: `Searching LinkedIn Ad Library for "${name}"…`,
      candidatesFound: 1,
      adsFetched: 0,
      pagesScanned: 0,
    },
    selectedPage: forcedCandidate || {
      pageId: name,
      name,
      category: "LinkedIn company",
    },
    candidates: forcedCandidate
      ? [forcedCandidate]
      : [
          {
            pageId: name,
            name,
            category: "LinkedIn company",
          } satisfies LookupPageCandidate,
        ],
    llmReason: forcedCandidate
      ? `User selected alternate match "${name}"`
      : "LinkedIn lookup uses company name search directly.",
    llmConfidence: forcedCandidate ? 1 : 0.7,
    adIds: [],
    createdAt: now,
    updatedAt: now,
  };
  saveLookupJob(job);

  try {
    let token: string | null = null;
    let pages = 0;
    const stored: LookupAdRecord[] = [];
    const seen = new Set<string>();

    do {
      const res = await searchLinkedInAds({
        company: name,
        countries: "US,AU",
        paginationToken: token,
      });
      const ads = extractLinkedInAds(res);
      const pageInfo = extractLinkedInPagination(res);
      token = pageInfo.isLastPage ? null : pageInfo.token;
      pages += 1;
      job.progress.pagesScanned += 1;

      for (const ad of ads) {
        const id = String(ad.id || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const mapped = mapLinkedInAdToCandidate(ad);
        const sample = sampleAdFromLinkedInCandidate(mapped);
        const record: LookupAdRecord = {
          id: uuidv4(),
          lookupId: job.id,
          adArchiveId: id,
          pageId: mapped.pageId || name,
          pageName: mapped.pageName || name,
          country: "US",
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
          videoUrl: sample.videoUrl,
          impressions: sample.impressions,
          advertiserPageUrl: sample.advertiserPageUrl,
          raw: ad as Record<string, unknown>,
          createdAt: new Date().toISOString(),
        };
        saveLookupAd(record);
        stored.push(record);
        job.adIds.push(record.id);
      }

      if (stored[0]) {
        job.selectedPage = {
          pageId: stored[0].pageId,
          name: stored[0].pageName,
          category: "LinkedIn advertiser",
          raw: {
            advertiserPageUrl: stored[0].advertiserPageUrl || null,
          },
        };
      }

      job.progress.adsFetched = stored.length;
      job.progress.message = `Fetched ${stored.length} LinkedIn ads…`;
      saveLookupJob(job);
    } while (token && pages < MAX_LI_PAGES);

    if (job.selectedPage) {
      job.progress.message = `Fetching profile metrics for "${job.selectedPage.name}"…`;
      saveLookupJob(job);
      job.selectedPage = await enrichLookupPageMetrics(job.selectedPage, {
        platform: "linkedin",
        linkedinUrlHint:
          job.selectedPage.raw?.advertiserPageUrl != null
            ? String(job.selectedPage.raw.advertiserPageUrl)
            : null,
      });
      saveLookupJob(job);
    }

    job.status = stored.length > 0 ? "completed" : "partial";
    job.progress.stage = "done";
    job.progress.message =
      stored.length > 0
        ? `Loaded ${stored.length} LinkedIn ads for "${name}".`
        : `No LinkedIn ads found for "${name}".`;
    saveLookupJob(job);
  } catch (err) {
    job.status = "failed";
    job.error = (err as Error).message;
    job.progress.stage = "failed";
    job.progress.message = (err as Error).message;
    saveLookupJob(job);
  }
}
