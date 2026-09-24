import { v4 as uuidv4 } from "uuid";
import {
  extractAds,
  extractCursor,
  extractFullAdCopy,
  extractGoogleAds,
  extractGoogleCursor,
  extractLinkedInAds,
  extractLinkedInPagination,
  getCompanyAds,
  getGoogleCompanyAds,
  searchLinkedInAds,
  type GoogleAdCreative,
  type LinkedInAd,
} from "../sociavault/client";
import {
  getCompetitorsByRun,
  getJob,
  getSearchCompetitorAdsByCompetitor,
  getSearchCompetitorAdsByRun,
  getLookupJob,
  isSearchJobSuppressed,
  saveJob,
  saveLookupAds,
  saveLookupJob,
  saveSearchCompetitorAds,
} from "../db";
import type {
  CompetitorRecord,
  LookupAdRecord,
  LookupCoreOfferLadder,
  OfferLadderStep,
  LookupJob,
  LookupOffersReport,
  SearchCompetitorAdRecord,
  SearchJob,
} from "../types";
import type { AdPlatform } from "../platforms";
import { adRunsOnFacebook, adRunsOnInstagram } from "../sociavault/client";
import { mapGoogleCreativeToCandidate, mapLinkedInAdToCandidate } from "./adMappers";
import { runLookupOffersReportPhase } from "./lookupOffersReport";
import {
  buildGuardrailContext,
  filterOfferLaddersWithGuardrail,
} from "../guardrails";

const MAX_COMPETITORS = 10;
const MAX_ADS_PER_COMPETITOR = 18;
const ADS_PER_COMPETITOR_FOR_ANALYSIS = 12;
const FETCH_CONCURRENCY = 4;
const META_PAGES_PER_COUNTRY = 3;

function asPlatform(value?: string | null): AdPlatform {
  const p = String(value || "facebook").toLowerCase();
  if (p === "instagram" || p === "google" || p === "youtube" || p === "linkedin") return p;
  return "facebook";
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => run()),
  );
  return out;
}

function updateProgress(
  job: SearchJob,
  patch: Partial<SearchJob["progress"]>,
) {
  job.progress = { ...job.progress, ...patch };
  job.updatedAt = new Date().toISOString();
  saveJob(job);
}

function toLookupAd(
  lookupId: string,
  ad: SearchCompetitorAdRecord,
): LookupAdRecord {
  return {
    id: uuidv4(),
    lookupId,
    adArchiveId: ad.adArchiveId,
    pageId: ad.pageId,
    pageName: ad.pageName,
    country: ad.country,
    isActive: ad.isActive,
    title: ad.title,
    body: ad.body,
    ctaText: ad.ctaText ?? null,
    landingPageUrl: ad.landingPageUrl ?? null,
    startDateString: ad.startDateString ?? null,
    endDateString: ad.endDateString ?? null,
    daysRunning: ad.daysRunning,
    adLibraryUrl: ad.adLibraryUrl,
    format: ad.format,
    imageUrl: ad.imageUrl,
    videoUrl: ad.videoUrl,
    youtubeUrl: ad.youtubeUrl,
    domain: ad.domain,
    visibleUrl: ad.visibleUrl,
    impressions: ad.impressions,
    advertiserPageUrl: ad.advertiserPageUrl,
    raw: {
      ...ad.raw,
      _searchOfferSource: {
        runId: ad.runId,
        competitorId: ad.competitorId,
        competitorName: ad.pageName,
      },
    },
    createdAt: new Date().toISOString(),
  };
}

function adRefFromSource(src: SearchCompetitorAdRecord, lookupAdId: string) {
  return {
    adId: src.id,
    lookupAdId,
    adArchiveId: src.adArchiveId,
    competitorId: src.competitorId,
    competitorName: src.pageName,
    adLibraryUrl: src.adLibraryUrl,
    title: src.title || null,
    body: src.body || null,
    ctaText: src.ctaText ?? null,
    landingPageUrl: src.landingPageUrl ?? null,
  };
}

function dedupeLaddersWithSources(
  report: LookupOffersReport,
  adIndex: Map<string, SearchCompetitorAdRecord>,
): LookupOffersReport {
  const ladders = report.valueLadder?.ladders || [];
  if (!ladders.length) return report;
  const byCore = new Map<string, LookupCoreOfferLadder>();
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const allAds = Array.from(adIndex.values());

  for (const ladder of ladders) {
    const key = norm(ladder.coreOffer);
    const existing = byCore.get(key);
    const refs = new Map<string, ReturnType<typeof adRefFromSource>>();
    const names = new Set<string>();
    const normalizeLp = (url?: string | null) =>
      (url || "").replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
    const lpKey = normalizeLp(ladder.landingPageUrl);
    const stepUrls = new Set(
      (ladder.steps || []).map((step) => normalizeLp(step.landingPageUrl)).filter(Boolean),
    );
    if (lpKey) stepUrls.add(lpKey);

    const addSrc = (src: SearchCompetitorAdRecord | undefined, lookupAdId: string) => {
      if (!src) return;
      names.add(src.pageName);
      refs.set(`${src.competitorId}:${src.id}`, adRefFromSource(src, lookupAdId));
    };

    for (const leaf of ladder.adOffers || []) {
      for (const adId of leaf.sampleAdIds || []) {
        addSrc(adIndex.get(adId), adId);
      }
      if (!leaf.sampleCopy) {
        const first = (leaf.sampleAdIds || [])
          .map((id) => adIndex.get(id))
          .find(Boolean);
        if (first) {
          leaf.sampleCopy = [first.title, first.body]
            .filter(Boolean)
            .join(" — ")
            .slice(0, 500);
          if (!leaf.cta) leaf.cta = first.ctaText ?? null;
        }
      }
    }

    if (stepUrls.size) {
      for (const src of allAds) {
        const srcLp = normalizeLp(src.landingPageUrl);
        if (srcLp && stepUrls.has(srcLp)) addSrc(src, src.id);
      }
    }
    const stepsWithSources: OfferLadderStep[] = (ladder.steps || []).map((step) => {
      const key = normalizeLp(step.landingPageUrl);
      const extra = key
        ? allAds.filter((src) => normalizeLp(src.landingPageUrl) === key).map((src) => src.pageName)
        : [];
      return {
        ...step,
        competitors: [...new Set([...(step.competitors || []), ...extra])].sort(),
      };
    });

    const withSources: LookupCoreOfferLadder = {
      ...ladder,
      steps: stepsWithSources.length ? stepsWithSources : ladder.steps,
      sourceCompetitors: names.size
        ? Array.from(names).sort()
        : ladder.sourceCompetitors,
      sourceAdRefs: Array.from(refs.values()).slice(0, 80),
    };
    if (!existing) {
      byCore.set(key, withSources);
      continue;
    }
    const mergedOffers = [...existing.adOffers, ...withSources.adOffers];
    const seenCreative = new Set<string>();
    const adOffers = mergedOffers.filter((o) => {
      const k = `${o.creativeId}|${norm(o.offer)}`;
      if (seenCreative.has(k)) return false;
      seenCreative.add(k);
      return true;
    });
    const srcNames = new Set([
      ...(existing.sourceCompetitors || []),
      ...(withSources.sourceCompetitors || []),
    ]);
    const srcRefs = new Map<string, ReturnType<typeof adRefFromSource>>();
    for (const r of [...(existing.sourceAdRefs || []), ...(withSources.sourceAdRefs || [])]) {
      srcRefs.set(`${r.competitorId}:${r.adId}`, r as ReturnType<typeof adRefFromSource>);
    }
    const stepMap = new Map<string, OfferLadderStep>();
    for (const step of [...(existing.steps || []), ...(withSources.steps || [])]) {
      const stepKey = norm(step.offer);
      const prev = stepMap.get(stepKey);
      if (!prev) {
        stepMap.set(stepKey, { ...step, competitors: [...(step.competitors || [])] });
        continue;
      }
      stepMap.set(stepKey, {
        ...prev,
        competitors: [...new Set([...(prev.competitors || []), ...(step.competitors || [])])].sort(),
      });
    }
    byCore.set(key, {
      ...existing,
      adOffers,
      steps: [...stepMap.values()]
        .sort((a, b) => a.order - b.order)
        .map((step, stepIndex) => ({ ...step, order: stepIndex + 1 })),
      adCount: Math.max(existing.adCount, withSources.adCount),
      sourceCompetitors: Array.from(srcNames).sort(),
      sourceAdRefs: Array.from(srcRefs.values()).slice(0, 80),
    });
  }

  const merged = Array.from(byCore.values()).map((l, i) => ({ ...l, rank: i + 1 }));
  return {
    ...report,
    valueLadder: {
      ...(report.valueLadder || { ladders: [] }),
      ladders: merged,
      summary:
        merged.length < ladders.length
          ? `${merged.length} offer ladders after combining similar flows (${ladders.length - merged.length} merged).`
          : report.valueLadder?.summary,
    },
  };
}

async function fetchMetaAds(
  runId: string,
  competitor: CompetitorRecord,
  platform: AdPlatform,
  countryHint?: string | null,
): Promise<SearchCompetitorAdRecord[]> {
  const out: SearchCompetitorAdRecord[] = [];
  const seen = new Set<string>();
  const primary = String(countryHint || competitor.country || "US").toUpperCase();
  const countries = primary === "AU" || primary === "US" ? [primary] : [primary, "US"];
  for (const country of countries) {
    let cursor: string | null = null;
    let pages = 0;
    do {
      let response;
      try {
        response = await getCompanyAds({
          pageId: competitor.pageId,
          status: "ACTIVE",
          country,
          language: "EN",
          cursor,
          trim: false,
        });
      } catch {
        response = await getCompanyAds({
          pageId: competitor.pageId,
          status: "ALL",
          country,
          language: "EN",
          cursor,
          trim: false,
        });
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
        const copy = extractFullAdCopy(ad.snapshot as Parameters<typeof extractFullAdCopy>[0]);
        out.push({
          id: uuidv4(),
          runId,
          competitorId: competitor.id,
          pageId: competitor.pageId,
          pageName: competitor.pageName,
          platform,
          adArchiveId,
          country,
          isActive: ad.is_active !== false && String(ad.is_active) !== "false",
          title: copy.title || "",
          body: copy.body || "",
          ctaText: copy.ctaText,
          landingPageUrl: copy.landingPageUrl,
          startDateString: ad.start_date_string ?? null,
          endDateString: ad.end_date_string ?? null,
          adLibraryUrl: `https://www.facebook.com/ads/library/?id=${adArchiveId}`,
          raw: {
            ad_archive_id: adArchiveId,
            page_id: competitor.pageId,
          },
          createdAt: new Date().toISOString(),
        });
        if (out.length >= MAX_ADS_PER_COMPETITOR) break;
      }
      if (out.length >= MAX_ADS_PER_COMPETITOR) break;
    } while (cursor && pages < META_PAGES_PER_COUNTRY);
    if (out.length >= MAX_ADS_PER_COMPETITOR) break;
  }
  return out;
}

async function fetchGoogleAds(
  runId: string,
  competitor: CompetitorRecord,
  platform: AdPlatform,
): Promise<SearchCompetitorAdRecord[]> {
  const domain = competitor.sampleAd.domain || competitor.sampleAd.visibleUrl || null;
  const advertiserId = competitor.pageId && !competitor.pageId.startsWith("domain:")
    ? competitor.pageId
    : null;
  const creatives: GoogleAdCreative[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res = await getGoogleCompanyAds({
      advertiser_id: advertiserId || undefined,
      domain: advertiserId ? undefined : domain || undefined,
      region: "all",
      cursor,
    });
    pages += 1;
    const ads = extractGoogleAds(res);
    cursor = extractGoogleCursor(res);
    for (const ad of ads) {
      const id = String(ad.creativeId || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      creatives.push(ad);
      if (creatives.length >= MAX_ADS_PER_COMPETITOR) break;
    }
    if (creatives.length >= MAX_ADS_PER_COMPETITOR) break;
  } while (cursor && pages < 4);

  const out: SearchCompetitorAdRecord[] = [];
  for (const ad of creatives.slice(0, MAX_ADS_PER_COMPETITOR)) {
    const details = {
      title: String(ad.advertiserName || ""),
      body: "",
      cta: null as string | null,
      landing: String(ad.adUrl || "") || null,
      youtubeUrl: null as string | null,
      visibleUrl: String(ad.domain || "") || null,
      firstShown: (ad.firstShown as string) || null,
      lastShown: (ad.lastShown as string) || null,
      format: (ad.format as string) || null,
    };
    const mapped = mapGoogleCreativeToCandidate(ad, details);
    if (platform === "youtube") {
      const yt = details.youtubeUrl || mapped.landingPageUrl;
      if (!yt || !/youtube\.com|youtu\.be/i.test(yt)) continue;
    }
    out.push({
      id: uuidv4(),
      runId,
      competitorId: competitor.id,
      pageId: competitor.pageId,
      pageName: competitor.pageName,
      platform,
      adArchiveId: String(ad.creativeId || uuidv4()),
      country: String(competitor.country || "ALL"),
      isActive: true,
      title: mapped.title || "",
      body: mapped.body || "",
      ctaText: mapped.ctaText ?? null,
      landingPageUrl: mapped.landingPageUrl ?? null,
      startDateString: mapped.startDateString ?? null,
      endDateString: mapped.endDateString ?? null,
      daysRunning: mapped.daysRunning,
      adLibraryUrl:
        String(ad.adUrl || "").trim() ||
        `https://adstransparency.google.com/advertiser/${ad.advertiserId || competitor.pageId}`,
      format: details.format || String(ad.format || ""),
      imageUrl: (ad.imageUrl as string) || null,
      youtubeUrl: details.youtubeUrl || null,
      domain: String(ad.domain || domain || "").trim() || null,
      visibleUrl: details.visibleUrl || null,
      raw: { creativeId: ad.creativeId, advertiserId: ad.advertiserId },
      createdAt: new Date().toISOString(),
    });
  }
  return out.slice(0, MAX_ADS_PER_COMPETITOR);
}

async function fetchLinkedInAds(
  runId: string,
  competitor: CompetitorRecord,
): Promise<SearchCompetitorAdRecord[]> {
  const out: SearchCompetitorAdRecord[] = [];
  const seen = new Set<string>();
  let token: string | null = null;
  let pages = 0;
  do {
    const res = await searchLinkedInAds({
      company: competitor.pageName,
      countries: "US,AU",
      paginationToken: token,
    });
    const ads = extractLinkedInAds(res);
    const pageInfo = extractLinkedInPagination(res);
    token = pageInfo.isLastPage ? null : pageInfo.token;
    pages += 1;
    for (const ad of ads) {
      const id = String(ad.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const mapped = mapLinkedInAdToCandidate(ad as LinkedInAd);
      out.push({
        id: uuidv4(),
        runId,
        competitorId: competitor.id,
        pageId: competitor.pageId,
        pageName: competitor.pageName,
        platform: "linkedin",
        adArchiveId: id,
        country: String(competitor.country || "US"),
        isActive: true,
        title: mapped.title || "",
        body: mapped.body || "",
        ctaText: mapped.ctaText ?? null,
        landingPageUrl: mapped.landingPageUrl ?? null,
        startDateString: mapped.startDateString ?? null,
        endDateString: mapped.endDateString ?? null,
        daysRunning: mapped.daysRunning,
        adLibraryUrl:
          String((ad as LinkedInAd).url || "").trim() ||
          `https://www.linkedin.com/ad-library/detail/${id}`,
        format: String((ad as LinkedInAd).adType || ""),
        imageUrl: (ad as LinkedInAd).image || null,
        videoUrl: (ad as LinkedInAd).video || null,
        impressions: (ad as LinkedInAd).totalImpressions || null,
        advertiserPageUrl: (ad as LinkedInAd).advertiserLinkedinPage || null,
        raw: { id, advertiser: competitor.pageName },
        createdAt: new Date().toISOString(),
      });
      if (out.length >= MAX_ADS_PER_COMPETITOR) break;
    }
    if (out.length >= MAX_ADS_PER_COMPETITOR) break;
  } while (token && pages < 6);
  return out;
}

async function fetchAndCacheAdsForCompetitor(
  runId: string,
  competitor: CompetitorRecord,
  force = false,
  countryHint?: string | null,
): Promise<SearchCompetitorAdRecord[]> {
  if (!force) {
    const cached = getSearchCompetitorAdsByCompetitor(runId, competitor.id);
    if (cached.length > 0) return cached;
  }
  const platform = asPlatform(String(competitor.platform || "facebook"));
  let ads: SearchCompetitorAdRecord[] = [];
  if (platform === "facebook" || platform === "instagram") {
    ads = await fetchMetaAds(runId, competitor, platform, countryHint);
  } else if (platform === "google" || platform === "youtube") {
    ads = await fetchGoogleAds(runId, competitor, platform);
  } else if (platform === "linkedin") {
    ads = await fetchLinkedInAds(runId, competitor);
  }
  saveSearchCompetitorAds(ads, {
    runId,
    replaceCompetitorId: competitor.id,
  });
  return ads;
}

function pickAdsForAnalysis(
  ads: SearchCompetitorAdRecord[],
  limit = ADS_PER_COMPETITOR_FOR_ANALYSIS,
): SearchCompetitorAdRecord[] {
  return [...ads]
    .sort((a, b) => {
      const lp = (x: SearchCompetitorAdRecord) => (x.landingPageUrl ? 1 : 0);
      const copy = (x: SearchCompetitorAdRecord) =>
        (x.body?.length || 0) + (x.title?.length || 0);
      return lp(b) - lp(a) || copy(b) - copy(a);
    })
    .slice(0, limit);
}

function failOffers(job: SearchJob, message: string): SearchJob {
  job.offersReport = {
    status: "failed",
    createdAt: job.offersReport?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: message,
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
  updateProgress(job, {
    stage: "done",
    offersPhase: "failed",
    offersCurrentName: null,
    offersPct: 100,
    message,
  });
  return job;
}

export async function runSearchOffersReportPhase(
  runId: string,
  options?: {
    /** Re-run LLM offer analysis even if a report already exists. */
    force?: boolean;
    /**
     * Re-fetch ads from SociaVault.
     * Default false on refresh — re-analyzes ads already cached for this run.
     */
    refetchAds?: boolean;
    /** Limit analysis to these competitor ids (fresh-run picker). */
    competitorIds?: string[] | null;
  },
): Promise<SearchJob | null> {
  const job = getJob(runId);
  if (!job) return null;
  if (isSearchJobSuppressed(runId)) return job;

  try {
    const selectedIds =
      options?.competitorIds && options.competitorIds.length > 0
        ? new Set(options.competitorIds)
        : job.offersCompetitorIds && job.offersCompetitorIds.length > 0
          ? new Set(job.offersCompetitorIds)
          : null;

    const competitors = getCompetitorsByRun(runId)
      .filter((c) => !selectedIds || selectedIds.has(c.id))
      .sort((a, b) => (b.activeAdsCount || 0) - (a.activeAdsCount || 0))
      .slice(0, MAX_COMPETITORS);
    if (!competitors.length) {
      return failOffers(job, "No competitors found to analyze offers.");
    }

    const refetchAds = Boolean(options?.refetchAds);
    const fetchTotal = competitors.length;
    updateProgress(job, {
      stage: "analyzing_offers",
      offersPhase: "fetch_ads",
      offersDone: 0,
      offersTotal: fetchTotal + 3,
      offersPct: 3,
      offersCurrentName: null,
      message: refetchAds
        ? `Fetching ads for ${competitors.length} competitors…`
        : `Loading cached ads for ${competitors.length} competitors…`,
    });

    let fetched = 0;
    await mapPool(competitors, FETCH_CONCURRENCY, async (c) => {
      if (isSearchJobSuppressed(runId)) return false;
      await fetchAndCacheAdsForCompetitor(
        runId,
        c,
        refetchAds,
        job.geo || c.country,
      );
      fetched += 1;
      const pct = Math.round((fetched / Math.max(fetchTotal, 1)) * 55);
      updateProgress(job, {
        offersPhase: "fetch_ads",
        offersCurrentName: c.pageName,
        offersDone: fetched,
        offersTotal: fetchTotal + 3,
        offersPct: Math.min(55, Math.max(4, pct)),
        message: refetchAds
          ? `Fetched ads ${fetched}/${fetchTotal}: ${c.pageName}`
          : `Cached ads ${fetched}/${fetchTotal}: ${c.pageName}`,
      });
      return true;
    });

    if (isSearchJobSuppressed(runId)) return getJob(runId) || job;

    const cached = getSearchCompetitorAdsByRun(runId).filter((a) =>
      competitors.some((c) => c.id === a.competitorId),
    );
    if (!cached.length) {
      return failOffers(job, "No ads fetched for the selected competitors.");
    }

    const analysisAds: SearchCompetitorAdRecord[] = [];
    for (const c of competitors) {
      analysisAds.push(
        ...pickAdsForAnalysis(
          cached.filter((a) => a.competitorId === c.id),
        ),
      );
    }

    const syntheticLookupId = `search-offers:${runId}:${Date.now()}`;
    const lookupJob: LookupJob = {
      id: syntheticLookupId,
      queryName: `Keyword search offers (${job.keyword})`,
      platform: job.platform || "facebook",
      status: "running",
      internalOnly: true,
      progress: {
        stage: "analyzing_offers",
        message: "Building offers report…",
        candidatesFound: competitors.length,
        adsFetched: analysisAds.length,
        pagesScanned: 0,
        offersPhase: "starting",
        offersDone: 0,
        offersTotal: 3,
        offersCurrentName: null,
        offersPct: 3,
      },
      selectedPage: null,
      candidates: [],
      adIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveLookupJob(lookupJob);
    if (isSearchJobSuppressed(runId)) return getJob(runId) || job;
    const adIndex = new Map<string, SearchCompetitorAdRecord>();
    const mappedAds = analysisAds.map((ad) => {
      const mapped = toLookupAd(syntheticLookupId, ad);
      adIndex.set(mapped.id, ad);
      return mapped;
    });
    saveLookupAds(mappedAds);

    updateProgress(job, {
      offersPhase: "analysis",
      offersDone: fetchTotal,
      offersTotal: fetchTotal + 3,
      offersPct: 58,
      message: `Analyzing ${analysisAds.length} ads across ${competitors.length} competitors…`,
    });

    await runLookupOffersReportPhase(syntheticLookupId, {
      force: true,
      finalStatus: "completed",
      maxLandingPages: 16,
      maxCreativeClusters: 24,
      relevance: {
        searchKeywords: job.keywords?.length
          ? job.keywords
          : job.keyword
            ? [job.keyword]
            : [],
        selectedCategory: job.selectedCategory || null,
        businessProfile: job.businessProfile || null,
      },
      onProgress: (tick) => {
        if (isSearchJobSuppressed(runId)) return;
        const analysisPct = 58 + Math.round((tick.pct / 100) * 40);
        updateProgress(job, {
          offersPhase: tick.phase,
          offersCurrentName: tick.currentName ?? null,
          offersDone: fetchTotal + tick.done,
          offersTotal: fetchTotal + Math.max(tick.total, 1),
          offersPct: Math.min(98, Math.max(58, analysisPct)),
          message: tick.message,
        });
      },
    });
    const done = getLookupJob(syntheticLookupId);
    const report = done?.offersReport || null;
    if (!report || report.status !== "completed") {
      return failOffers(job, report?.error || "Offers report failed");
    }

    const enhanced = dedupeLaddersWithSources(report, adIndex);
    const guardCtx = buildGuardrailContext({
      businessProfile: job.businessProfile,
      selectedCategoryLabel: job.selectedCategory?.label || null,
      searchKeywords: job.keywords || [job.keyword],
      override: job.guardrailOverride || null,
      skipGuardrails: Boolean(job.skipGuardrails),
    });
    const ladders = enhanced.valueLadder?.ladders || [];
    const filtered = filterOfferLaddersWithGuardrail(guardCtx, ladders);
    if (filtered.rejected.length && enhanced.valueLadder) {
      enhanced.valueLadder = {
        ...enhanced.valueLadder,
        ladders: filtered.kept,
        summary: [
          enhanced.valueLadder.summary,
          filtered.rejected.length
            ? `Guardrail removed ${filtered.rejected.length} off-SOP ladder${filtered.rejected.length === 1 ? "" : "s"} (courses/podcasts/tools/etc.).`
            : null,
        ]
          .filter(Boolean)
          .join(" "),
      };
    }
    job.offersReport = enhanced;
    updateProgress(job, {
      stage: "done",
      offersPhase: "done",
      offersCurrentName: null,
      offersDone: fetchTotal + 3,
      offersTotal: fetchTotal + 3,
      offersPct: 100,
      message: `Offers dashboard ready · ${enhanced.valueLadder?.ladders.length || 0} unique ladders from ${competitors.length} competitors (${analysisAds.length} ads)${
        filtered.rejected.length
          ? ` · ${filtered.rejected.length} ladders blocked by industry SOP`
          : ""
      }.`,
    });
    saveJob(job);
    return job;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failOffers(job, message);
  }
}

