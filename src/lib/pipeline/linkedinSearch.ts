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
import { compactGeoSearchQueries } from "./keywordSuggestions";
import {
  getJob,
  isSearchJobSuppressed,
  isLookupJobSuppressed,
  saveCompetitor,
  saveJob,
  saveLookupAd,
  saveLookupJob,
} from "../db";
import {
  buildGuardrailContext,
  guardCompetitorHeuristic,
} from "../guardrails";
import {
  MAX_SEARCH_QUERIES_LINKEDIN,
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
import {
  newId,
  normalizeLinkedInCompanyUrl,
} from "./brandReview";
import {
  mapLinkedInAdToCandidate,
  pickBestLinkedInCandidate,
  sampleAdFromLinkedInCandidate,
} from "./adMappers";
import { enrichLookupPageMetrics } from "./lookupEnrichment";
import { linkedInCountriesFromGeo } from "../geo";

const MAX_LI_PAGES = 5;
const MAX_COMPANY_COUNT_PAGES = 5;

/** Count company ads across LinkedIn Ad Library pages for active-ads gate. */
async function countLinkedInCompanyAds(
  companyName: string,
  countries: string,
): Promise<{
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
      countries,
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
    skipGuardrails: Boolean(options?.skipGuardrails),
    guardrailOverride: options?.guardrailOverride || null,
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
    const localSearch = preferLocalGeo && targetLocations.length > 0;
    const queries = localSearch
      ? compactGeoSearchQueries({
          keywords,
          locations: targetLocations,
          categoryLabel: selectedCategory?.label || null,
          maxQueries: 6,
        })
      : await (async () => {
          const expanded = new Set<string>(keywords);
          for (const kw of keywords) {
            try {
              for (const q of await expandKeywordQueries(kw, businessProfile, {
                geoMode,
                targetLocations,
                selectedCategory,
              }))
                expanded.add(q);
            } catch {
              /* seed only */
            }
          }
          return Array.from(expanded).slice(0, MAX_SEARCH_QUERIES_LINKEDIN);
        })();

    outer: for (const query of queries) {
      if (isSearchJobSuppressed(jobId)) break outer;
      let token: string | null = null;
      let pages = 0;

      do {
        if (accepted.length >= TARGET_COMPETITORS) break outer;
        if (isSearchJobSuppressed(jobId)) break outer;
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
                relaxed: accepted.length >= 2,
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

          const guard = guardCompetitorHeuristic(
            buildGuardrailContext({
              businessProfile,
              selectedCategoryLabel: selectedCategory?.label || null,
              searchKeywords: keywords,
              override: options?.guardrailOverride || null,
              skipGuardrails: Boolean(options?.skipGuardrails),
            }),
            {
              pageName: primary.pageName,
              adText: primary.fullText || primary.body,
              landingPageUrl: primary.landingPageUrl,
              services: filter.services,
              llmReason: filter.reason,
            },
          );
          if (!guard.ok) {
            job.progress.rejected += 1;
            job.progress.message = `Guardrail blocked ${primary.pageName}: ${guard.reason}`;
            saveJob(job);
            continue;
          }

          job.progress.message = `Counting LinkedIn ads for ${primary.pageName}…`;
          saveJob(job);

          let activeCount = pageAds.length;
          try {
            const counted = await countLinkedInCompanyAds(
              primary.pageName,
              liCountries,
            );
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

          const { cheapLocationFromText } = await import("./competitorLocation");

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

          // Save first with minimal brand — deep location deferred to offer analysis
          const brand: BrandReview = {
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
          job.progress.stage = "searching_ads";

          try {
            const { enrichCompetitorSociavaultAddress } = await import(
              "./competitorLocation"
            );
            const loc = await enrichCompetitorSociavaultAddress({
              competitorId: competitor.id,
              facebookUrl: null,
              linkedinUrl: liUrl,
              geoMode,
              targetLocations,
            });
            if (loc) {
              competitor.locationLabel = loc.locationLabel;
              competitor.locationCity = loc.locationCity;
              competitor.locationSuburb = loc.locationSuburb;
              competitor.locationCountry = loc.locationCountry;
              competitor.locationStatus = loc.locationStatus;
              competitor.locationSource = loc.locationSource;
            }
          } catch {
            /* keep provisional */
          }

          const locNote = competitor.locationLabel
            ? ` · ${competitor.locationLabel}`
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
        const { cheapLocationFromText } = await import("./competitorLocation");
        const provisional = cheapLocationFromText({
          pageName: held.primary.pageName,
          adText: held.primary.fullText || held.primary.body,
          landingUrl: held.primary.landingPageUrl,
          targets: targetLocations,
          geoMode,
        });
        const brand: BrandReview = {
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
        job.progress.accepted = accepted.length;
        try {
          const { enrichCompetitorSociavaultAddress } = await import(
            "./competitorLocation"
          );
          await enrichCompetitorSociavaultAddress({
            competitorId: competitor.id,
            facebookUrl: null,
            linkedinUrl: held.liUrl,
            geoMode,
            targetLocations,
          });
        } catch {
          /* ignore */
        }
      }
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
          ? `Found ${accepted.length} LinkedIn competitors. Brand review & deep location run on demand / during offer analysis.`
          : "No qualifying LinkedIn competitors found.";
      final.updatedAt = new Date().toISOString();
      saveJob(final);
    }
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
  options?: {
    businessUrl?: string | null;
    businessProfile?: import("../types").BusinessProfile | null;
  },
) {
  const name = forcedCandidate?.name || queryName;
  const now = new Date().toISOString();
  const businessUrl = (options?.businessUrl || "").trim() || null;
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
    let token: string | null = null;
    let pages = 0;
    const stored: LookupAdRecord[] = [];
    const seen = new Set<string>();

    do {
      if (isLookupJobSuppressed(job.id)) return;
      const res = await searchLinkedInAds({
        company: name,
        countries: "US,AU",
        paginationToken: token,
      });
      if (isLookupJobSuppressed(job.id)) return;
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

    if (stored.length > 0) {
      job.status = "completed";
      job.progress.stage = "done";
      job.progress.message = `Loaded ${stored.length} LinkedIn ads for "${name}". Use Get offer & page details on an ad to analyze its landing page.`;
    } else {
      job.status = "partial";
      job.progress.stage = "done";
      job.progress.message = `No LinkedIn ads found for "${name}".`;
    }
    saveLookupJob(job);
  } catch (err) {
    job.status = "failed";
    job.error = (err as Error).message;
    job.progress.stage = "failed";
    job.progress.message = (err as Error).message;
    saveLookupJob(job);
  }
}
