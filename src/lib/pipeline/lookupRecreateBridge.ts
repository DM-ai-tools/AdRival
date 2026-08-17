import {
  getCompetitor,
  getJob,
  getLookupAd,
  getLookupAds,
  getLookupJob,
  listAllCompetitors,
  saveCompetitor,
  saveJob,
  updateCompetitor,
  updateJob,
  updateLookupAd,
  updateLookupJob,
} from "../db";
import type {
  CompetitorRecord,
  LookupAdRecord,
  RecreatedLandingPage,
  SearchJob,
} from "../types";
import { landingPageMatchKey } from "./sameLandingPageAds";

export type ExistingRecreationHit = {
  competitorId: string;
  pageName: string;
  status: RecreatedLandingPage["status"];
  sourceAnalyzedUrl: string;
  matchKey: string;
  fromLookupAdId?: string | null;
  updatedAt: string;
};

function recreationRunId(lookupId: string): string {
  return `lookup-recreate-${lookupId}`;
}

function recreationCompetitorId(adId: string): string {
  return `lookup-ad-${adId}`;
}

function resolveAdLandingUrl(ad: LookupAdRecord): string | null {
  const raw =
    ad.pageAnalysis?.analyzedUrl ||
    ad.landingPageUrl ||
    ad.youtubeUrl ||
    ad.advertiserPageUrl ||
    null;
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/** Find prior recreations for the same landing-page destination. */
export function findExistingRecreationsForUrl(
  url: string | null | undefined,
  options?: { excludeCompetitorId?: string | null },
): ExistingRecreationHit[] {
  const key = landingPageMatchKey(url);
  if (!key) return [];

  const hits: ExistingRecreationHit[] = [];
  const exclude = options?.excludeCompetitorId || null;

  for (const c of listAllCompetitors(5000)) {
    if (exclude && c.id === exclude) continue;
    const page = c.recreatedPage;
    if (!page) continue;
    if (
      page.status !== "completed" &&
      page.status !== "content_ready" &&
      page.status !== "design_pending"
    ) {
      continue;
    }
    const urls = [
      page.sourceAnalyzedUrl,
      c.pageAnalysis?.analyzedUrl,
      c.sampleAd?.landingPageUrl,
    ];
    const match = urls.some((u) => landingPageMatchKey(u) === key);
    if (!match) continue;
    hits.push({
      competitorId: c.id,
      pageName: c.pageName,
      status: page.status,
      sourceAnalyzedUrl: page.sourceAnalyzedUrl || urls.find(Boolean) || "",
      matchKey: key,
      fromLookupAdId: c.id.startsWith("lookup-ad-")
        ? c.id.slice("lookup-ad-".length)
        : null,
      updatedAt: page.updatedAt,
    });
  }

  return hits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Materialize a SearchJob + CompetitorRecord for a lookup ad so the shared
 * /recreate/[competitorId] pipeline can run unchanged.
 */
export function ensureLookupRecreationCompetitor(adId: string): {
  competitorId: string;
  competitor: CompetitorRecord;
  existingSameUrl: ExistingRecreationHit[];
  created: boolean;
} {
  const ad = getLookupAd(adId);
  if (!ad) throw new Error("Lookup ad not found");

  if (ad.pageAnalysis?.status !== "completed") {
    throw new Error(
      "Analyze the landing page first (Get offer & page details).",
    );
  }

  const lookup = getLookupJob(ad.lookupId);
  if (!lookup) throw new Error("Lookup job not found");

  const businessUrl = (
    lookup.businessUrl ||
    lookup.businessProfile?.url ||
    ""
  ).trim();
  if (!businessUrl) {
    throw new Error(
      "Add your business website URL on this lookup so recreation can use your brand.",
    );
  }
  const normalizedBusiness = /^https?:\/\//i.test(businessUrl)
    ? businessUrl
    : `https://${businessUrl}`;

  const sourceUrl = resolveAdLandingUrl(ad);
  if (!sourceUrl) {
    throw new Error("This ad has no landing page URL to recreate.");
  }

  const runId = recreationRunId(ad.lookupId);
  const competitorId =
    ad.recreationCompetitorId || recreationCompetitorId(ad.id);

  let job = getJob(runId);
  const now = new Date().toISOString();
  if (!job) {
    const newJob: SearchJob = {
      id: runId,
      keyword: lookup.queryName,
      keywords: [lookup.queryName],
      platform: lookup.platform,
      geo: "all",
      countries: ["ALL"],
      status: "completed",
      progress: {
        stage: "done",
        scannedAds: 0,
        scannedPages: 0,
        accepted: 0,
        target: 0,
        rejected: 0,
        message: `Lookup recreation bridge for “${lookup.queryName}”`,
      },
      competitorIds: [],
      businessUrl: normalizedBusiness,
      businessProfile: lookup.businessProfile || null,
      createdAt: now,
      updatedAt: now,
    };
    saveJob(newJob);
    job = newJob;
  } else {
    updateJob(runId, {
      businessUrl: normalizedBusiness,
      businessProfile: lookup.businessProfile || job.businessProfile || null,
      keyword: job.keyword || lookup.queryName,
    });
    job = getJob(runId)!;
  }

  let competitor = getCompetitor(competitorId);
  let created = false;
  if (!competitor) {
    competitor = {
      id: competitorId,
      runId,
      pageId: ad.pageId || `lookup-${ad.id}`,
      pageName: ad.pageName || lookup.queryName,
      country: ad.country || "ALL",
      platform: lookup.platform,
      activeAdsCount: 1,
      services: [],
      sampleAd: {
        adArchiveId: ad.adArchiveId,
        title: ad.title,
        body: ad.body,
        daysRunning: ad.daysRunning ?? -1,
        adLibraryUrl: ad.adLibraryUrl,
        ctaText: ad.ctaText,
        landingPageUrl: ad.landingPageUrl || sourceUrl,
        format: ad.format,
        imageUrl: ad.imageUrl,
        videoUrl: ad.videoUrl,
        youtubeUrl: ad.youtubeUrl,
        domain: ad.domain,
        visibleUrl: ad.visibleUrl,
        startDate: ad.startDateString,
        endDate: ad.endDateString,
        impressions: ad.impressions,
        advertiserPageUrl: ad.advertiserPageUrl,
      },
      brand: {},
      pageAnalysis: ad.pageAnalysis,
      recreatedPage: null,
      createdAt: now,
    };
    const ok = saveCompetitor(competitor);
    if (!ok) throw new Error("Failed to create recreation competitor bridge");
    created = true;
  } else {
    // Keep analysis / landing URL in sync with the lookup ad
    updateCompetitor(competitorId, {
      pageAnalysis: ad.pageAnalysis,
      pageName: ad.pageName || competitor.pageName,
      sampleAd: {
        ...competitor.sampleAd,
        landingPageUrl: ad.landingPageUrl || sourceUrl,
        title: ad.title || competitor.sampleAd.title,
        body: ad.body || competitor.sampleAd.body,
      },
    });
    competitor = getCompetitor(competitorId)!;
  }

  if (ad.recreationCompetitorId !== competitorId) {
    updateLookupAd(ad.id, { recreationCompetitorId: competitorId });
  }

  const existingSameUrl = findExistingRecreationsForUrl(sourceUrl, {
    excludeCompetitorId: competitorId,
  });

  // Also treat this competitor's own completed page as "already done"
  if (
    competitor.recreatedPage &&
    (competitor.recreatedPage.status === "completed" ||
      competitor.recreatedPage.status === "content_ready")
  ) {
    const selfKey = landingPageMatchKey(
      competitor.recreatedPage.sourceAnalyzedUrl || sourceUrl,
    );
    if (selfKey && landingPageMatchKey(sourceUrl) === selfKey) {
      existingSameUrl.unshift({
        competitorId,
        pageName: competitor.pageName,
        status: competitor.recreatedPage.status,
        sourceAnalyzedUrl:
          competitor.recreatedPage.sourceAnalyzedUrl || sourceUrl,
        matchKey: selfKey,
        fromLookupAdId: ad.id,
        updatedAt: competitor.recreatedPage.updatedAt,
      });
    }
  }

  return { competitorId, competitor, existingSameUrl, created };
}

/** Attach / refresh brand profile on a lookup job (and its recreation bridge job). */
export function setLookupBusinessBrand(
  lookupId: string,
  input: {
    businessUrl: string;
    businessProfile?: SearchJob["businessProfile"];
  },
): ReturnType<typeof getLookupJob> {
  const url = input.businessUrl.trim();
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const updated = updateLookupJob(lookupId, {
    businessUrl: normalized,
    businessProfile: input.businessProfile || null,
  });
  const runId = recreationRunId(lookupId);
  if (getJob(runId)) {
    updateJob(runId, {
      businessUrl: normalized,
      businessProfile: input.businessProfile || null,
    });
  }
  return updated;
}

export function getLookupAdsSharingLandingUrl(
  lookupId: string,
  url: string | null | undefined,
): LookupAdRecord[] {
  const key = landingPageMatchKey(url);
  if (!key) return [];
  return getLookupAds(lookupId).filter((ad) => {
    const u =
      ad.pageAnalysis?.analyzedUrl ||
      ad.landingPageUrl ||
      ad.youtubeUrl ||
      null;
    return landingPageMatchKey(u) === key;
  });
}
