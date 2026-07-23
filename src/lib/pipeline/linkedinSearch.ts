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
) {
  const keywords = parseKeywords(keywordInput);
  const now = new Date().toISOString();
  const job: SearchJob = {
    id: jobId,
    keyword: keywords.join(", "),
    keywords,
    platform: "linkedin",
    status: "running",
    progress: {
      stage: "searching_ads",
      scannedAds: 0,
      scannedPages: 0,
      accepted: 0,
      target: TARGET_COMPETITORS,
      rejected: 0,
      message: "Searching LinkedIn Ad Library…",
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

  try {
    const queries = new Set<string>(keywords);
    for (const kw of keywords) {
      try {
        for (const q of await expandKeywordQueries(kw)) queries.add(q);
      } catch {
        /* seed only */
      }
    }

    outer: for (const query of Array.from(queries).slice(0, 10)) {
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
            countries: "US,AU",
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
          if (!hasServiceKeywordSignal(signal)) {
            job.progress.rejected += 1;
            continue;
          }

          let filter;
          try {
            filter = await analyzeAdCandidate(
              keywords[0] || query,
              primary,
              null,
              pool.filter((a) => a.adArchiveId !== primary.adArchiveId).slice(0, 3),
              { relaxed: true },
            );
          } catch {
            job.progress.rejected += 1;
            continue;
          }

          if (!filter.relevant || !filter.isMarketingAgency) {
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

          job.progress.stage = "brand_review";
          job.progress.message = `Brand review for ${primary.pageName}…`;
          saveJob(job);

          const liUrl =
            normalizeLinkedInCompanyUrl(primary.pageProfileUri) ||
            primary.pageProfileUri ||
            null;

          let brand;
          try {
            brand = await runBrandReview({
              pageId,
              pageName: primary.pageName,
              pageProfileUri: null,
              linkedinUrlHint: liUrl,
              websiteHint: primary.landingPageUrl,
              categoryHint: "LinkedIn advertiser",
            });
            // Always keep the Ad Library company page when brand review dropped it
            if (!brand.linkedinUrl && liUrl) brand.linkedinUrl = liUrl;
          } catch (err) {
            brand = {
              linkedinUrl: liUrl,
              website: primary.landingPageUrl || null,
              category: "LinkedIn advertiser",
            };
            job.progress.message = `Partial brand review for ${primary.pageName}: ${(err as Error).message}`;
            saveJob(job);
          }

          seenAdvertisers.add(pageId);
          const competitor: CompetitorRecord = {
            id: newId(),
            runId: job.id,
            pageId,
            pageName: primary.pageName,
            country: "US",
            platform: "linkedin",
            activeAdsCount: activeCount,
            services: filter.services as ServiceLabel[],
            sampleAd: sampleAdFromLinkedInCandidate(primary),
            brand,
            createdAt: new Date().toISOString(),
          };
          saveCompetitor(competitor);
          accepted.push(competitor);
          job.competitorIds.push(competitor.id);
          job.progress.accepted = accepted.length;
          job.progress.stage = "searching_ads";
          job.progress.message = `Accepted ${primary.pageName} (${accepted.length}/${TARGET_COMPETITORS})`;
          saveJob(job);
        }
      } while (token && pages < MAX_LI_PAGES);
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

export async function runLinkedInLookup(lookupId: string, queryName: string) {
  const now = new Date().toISOString();
  const job: LookupJob = {
    id: lookupId,
    queryName,
    platform: "linkedin",
    status: "running",
    progress: {
      stage: "fetching_ads",
      message: `Searching LinkedIn Ad Library for "${queryName}"…`,
      candidatesFound: 1,
      adsFetched: 0,
      pagesScanned: 0,
    },
    selectedPage: {
      pageId: queryName,
      name: queryName,
      category: "LinkedIn company",
    },
    candidates: [
      {
        pageId: queryName,
        name: queryName,
        category: "LinkedIn company",
      } satisfies LookupPageCandidate,
    ],
    llmReason: "LinkedIn lookup uses company name search directly.",
    llmConfidence: 0.7,
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
        company: queryName,
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
          pageId: mapped.pageId || queryName,
          pageName: mapped.pageName || queryName,
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
        };
      }

      job.progress.adsFetched = stored.length;
      job.progress.message = `Fetched ${stored.length} LinkedIn ads…`;
      saveLookupJob(job);
    } while (token && pages < MAX_LI_PAGES);

    job.status = stored.length > 0 ? "completed" : "partial";
    job.progress.stage = "done";
    job.progress.message =
      stored.length > 0
        ? `Loaded ${stored.length} LinkedIn ads for "${queryName}".`
        : `No LinkedIn ads found for "${queryName}".`;
    saveLookupJob(job);
  } catch (err) {
    job.status = "failed";
    job.error = (err as Error).message;
    job.progress.stage = "failed";
    job.progress.message = (err as Error).message;
    saveLookupJob(job);
  }
}
