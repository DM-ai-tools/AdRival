import {
  extractAds,
  extractCursor,
  extractFullAdCopy,
  extractSearchResultsCount,
  isLandingPageUrl,
  searchAdLibrary,
  getCompanyAds,
  adRunsOnFacebook,
  adRunsOnInstagram,
  type AdLibrarySearchResult,
} from "../sociavault/client";
import {
  analyzeAdCandidate,
  expandKeywordQueries,
  hasAgencyPositioningSignal,
  hasServiceKeywordSignal,
  serviceKeywordOverlapScore,
  type AdFilterResult,
} from "../openai/analyzer";
import { newId } from "./brandReview";
import { looksLikeEnglish } from "./adLanguage";
import { isCreditError } from "../accounting/errors";
import {
  isSearchJobSuppressed,
  markPageSeen,
  saveCompetitor,
  saveJob,
  saveJobProgress,
} from "../db";
import {
  cheapLocationFromText,
  lookupCompetitorPlace,
  matchPlaceToTargets,
  type ResolvedCompetitorLocation,
  locationRankScore,
} from "./competitorLocation";
import { compactGeoSearchQueries } from "./keywordSuggestions";
import { ownBusinessCheck } from "./ownBusiness";
import {
  buildSearchRings,
  placesUpToRing,
  adLibraryRingQueries,
  serviceAnchors,
} from "./searchRings";
import type { SearchDispatchOptions } from "./searchOptions";
import {
  buildGuardrailContext,
  getSopForContext,
  guardCompetitorHeuristic,
  precheckCompetitor,
} from "../guardrails";
import { searchQueriesForKeywords } from "./searchQueries";
import {
  MAX_PAGES_PER_QUERY,
  MAX_SEARCH_PAGES,
  MAX_SEARCH_QUERIES_META,
  RELAXED_MIN_ACTIVE_ADS,
  RELAXED_MIN_AD_DURATION_DAYS,
  TARGET_COMPETITORS,
  type AdCandidate,
  type BrandReview,
  type CompetitorRecord,
  type JobProgress,
  type SearchCountry,
  type SearchJob,
  type ServiceLabel,
} from "../types";
import type { AdPlatform } from "../platforms";
import { parseKeywords, getPlatformAdThresholds, meetsDurationThreshold } from "../platforms";
import { metaCountriesFromGeo } from "../geo";

/** Ad Library result pages a city/suburb search may read (country-wide: MAX_SEARCH_PAGES). */
const LOCAL_SEARCH_PAGES = 84;

/** How many advertisers ahead of the current one get their LLM review started. */
const REVIEW_AHEAD = 3;

/**
 * The bar an advertiser must clear. `widened` is set once the planned queries
 * ran out short of the target: from then on the review is relaxed and a
 * landing page is not required, so a small market still yields a full list.
 */
function currentThresholds(
  acceptedCount: number,
  platform: AdPlatform,
  widened = false,
  local = false,
) {
  // Keep LLM strict early; only relax after we have a solid local/relevant core
  const relaxedLlm = widened || acceptedCount >= 5;

  // City/suburb searches: local rivals run few ads, so any live ad counts,
  // with no run-time or landing-page requirement. Relevance is still reviewed.
  if (local) {
    return {
      minDays: 0,
      minActiveAds: 1,
      requireDaysGreaterThan: false,
      skipDuration: true,
      relaxedLlm,
      requireLanding: false,
    };
  }

  if (platform !== "facebook") {
    const t = getPlatformAdThresholds(platform);
    if (platform === "instagram") {
      return {
        minDays: RELAXED_MIN_AD_DURATION_DAYS,
        minActiveAds: RELAXED_MIN_ACTIVE_ADS,
        requireDaysGreaterThan: true,
        skipDuration: false,
        relaxedLlm,
        requireLanding: !widened && acceptedCount < 5,
      };
    }
    return {
      minDays: t.minDaysExclusive,
      minActiveAds: Math.min(t.minActiveAds, RELAXED_MIN_ACTIVE_ADS),
      requireDaysGreaterThan: t.requireDaysGreaterThan,
      skipDuration: t.skipDuration,
      relaxedLlm,
      requireLanding: !widened && acceptedCount < 5,
    };
  }

  return {
    minDays: RELAXED_MIN_AD_DURATION_DAYS,
    minActiveAds: RELAXED_MIN_ACTIVE_ADS,
    requireDaysGreaterThan: false,
    skipDuration: false,
    relaxedLlm,
    requireLanding: !widened && acceptedCount < 3,
  };
}

function daysSince(
  iso?: string | null,
  unix?: number | string | null,
  totalActiveTimeSec?: number | string | null,
): number {
  let startMs: number | null = null;

  if (iso) {
    const t = Date.parse(String(iso));
    if (!Number.isNaN(t)) startMs = t;
  }

  if (startMs == null && unix != null && unix !== "") {
    const n = typeof unix === "number" ? unix : Number(unix);
    if (Number.isFinite(n) && n > 0) {
      startMs = n > 1e12 ? n : n * 1000;
    }
  }

  let fromStart = -1;
  if (startMs != null) {
    fromStart = Math.floor((Date.now() - startMs) / (1000 * 60 * 60 * 24));
  }

  let fromActive = -1;
  if (totalActiveTimeSec != null && totalActiveTimeSec !== "") {
    const sec =
      typeof totalActiveTimeSec === "number"
        ? totalActiveTimeSec
        : Number(totalActiveTimeSec);
    if (Number.isFinite(sec) && sec > 0) {
      fromActive = Math.floor(sec / 86400);
    }
  }

  // Prefer the larger reliable signal (active time can under-count pauses)
  if (fromStart < 0 && fromActive < 0) return -1;
  return Math.max(fromStart, fromActive);
}

function toCandidate(
  ad: AdLibrarySearchResult,
  country: SearchCountry,
): AdCandidate | null {
  const pageId = ad.page_id ? String(ad.page_id) : "";
  const adArchiveId = ad.ad_archive_id ? String(ad.ad_archive_id) : "";
  if (!pageId || !adArchiveId) return null;

  const copy = extractFullAdCopy(
    ad.snapshot as Parameters<typeof extractFullAdCopy>[0],
  );

  const rawUnix =
    typeof ad.start_date === "number" || typeof ad.start_date === "string"
      ? ad.start_date
      : null;
  const totalActive =
    typeof ad.total_active_time === "number" ||
    typeof ad.total_active_time === "string"
      ? ad.total_active_time
      : null;

  const daysRunning = daysSince(
    ad.start_date_string,
    rawUnix,
    totalActive as number | string | null,
  );

  return {
    adArchiveId,
    pageId,
    pageName: String(ad.page_name || ad.snapshot?.page_name || "Unknown"),
    pageProfileUri: ad.snapshot?.page_profile_uri ?? null,
    isActive: ad.is_active !== false && String(ad.is_active) !== "false",
    startDateString: ad.start_date_string ?? null,
    endDateString: ad.end_date_string ?? null,
    daysRunning,
    title: copy.title,
    body: copy.body,
    fullText: copy.fullText,
    ctaText: copy.ctaText,
    landingPageUrl: copy.landingPageUrl,
    linkDescription: copy.linkDescription,
    caption: copy.caption,
    pageCategories: copy.pageCategories,
    country,
    snapshot: ad.snapshot as Record<string, unknown> | undefined,
  };
}

/** Prefer creatives with keyword/service overlap + local geo mentions, then richest copy. */
function pickSampleAd(
  ads: AdCandidate[],
  opts?: {
    requireLanding?: boolean;
    signalOptions?: Parameters<typeof serviceKeywordOverlapScore>[1];
    targets?: SearchDispatchOptions["targetLocations"];
    geoMode?: SearchDispatchOptions["geoMode"];
  },
): AdCandidate | null {
  const pool = opts?.requireLanding === false
    ? ads
    : ads.filter((a) => isLandingPageUrl(a.landingPageUrl));
  if (pool.length === 0) return null;

  const targets = opts?.targets || [];
  const geoMode = opts?.geoMode || "countrywide";

  return [...pool].sort((a, b) => {
    const textA = `${a.title}\n${a.body}\n${a.fullText}`;
    const textB = `${b.title}\n${b.body}\n${b.fullText}`;
    const kwA = serviceKeywordOverlapScore(textA, opts?.signalOptions);
    const kwB = serviceKeywordOverlapScore(textB, opts?.signalOptions);
    const geoA = locationRankScore(
      cheapLocationFromText({
        pageName: a.pageName,
        adText: textA,
        landingUrl: a.landingPageUrl,
        targets,
        geoMode: geoMode || "countrywide",
      }).locationStatus,
    );
    const geoB = locationRankScore(
      cheapLocationFromText({
        pageName: b.pageName,
        adText: textB,
        landingUrl: b.landingPageUrl,
        targets,
        geoMode: geoMode || "countrywide",
      }).locationStatus,
    );
    return (
      kwB - kwA ||
      geoB - geoA ||
      (b.fullText?.length || 0) - (a.fullText?.length || 0) ||
      (b.body?.length || 0) - (a.body?.length || 0)
    );
  })[0];
}

function richestAd(ads: AdCandidate[]): AdCandidate {
  return [...ads].sort(
    (a, b) =>
      (b.fullText?.length || 0) - (a.fullText?.length || 0) ||
      (b.body?.length || 0) - (a.body?.length || 0),
  )[0];
}

function updateJob(job: SearchJob, patch: Partial<SearchJob>) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  saveJob(job);
}

function setProgress(job: SearchJob, progress: Partial<JobProgress>) {
  job.progress = { ...job.progress, ...progress };
  job.updatedAt = new Date().toISOString();
  saveJobProgress(job);
}

/** Active-ads proxy from creatives already seen in this search (no extra API round-trips). */
function activeAdsSeenInSearch(pageAds: AdCandidate[]): number {
  const active = pageAds.filter((a) => a.isActive !== false).length;
  return Math.max(active, pageAds.length > 0 ? 1 : 0);
}

/**
 * Active Meta Ad Library volume for a page in the selected ad market.
 * Prefer `searchResultsCount` from company-ads (one request) — no pagination.
 */
async function countMetaActiveAds(
  pageId: string,
  country: string,
): Promise<number> {
  const primary = String(country || "US").toUpperCase();
  try {
    const response = await getCompanyAds({
      pageId,
      status: "ACTIVE",
      country: primary,
      language: "EN",
      trim: true,
    });
    const reported = extractSearchResultsCount(response);
    if (reported != null) return reported;
    // Fallback if the field is missing: first-page unique ids only
    const ads = extractAds(response);
    const seen = new Set<string>();
    for (const ad of ads) {
      const id = ad.ad_archive_id ? String(ad.ad_archive_id) : "";
      if (id) seen.add(id);
    }
    return seen.size;
  } catch (err) {
    // A missing ad count is recoverable; a missing budget or grant is not.
    if (isCreditError(err)) throw err;
    return 0;
  }
}

/**
 * Runs Meta Ad Library discovery (Facebook or Instagram-filtered).
 * Call without awaiting from the API route.
 */
export async function runCompetitorSearch(
  jobId: string,
  keywordInput: string | string[],
  platform: AdPlatform = "facebook",
  options?: SearchDispatchOptions,
) {
  const keywords = parseKeywords(keywordInput);
  const primaryKeyword = keywords[0] || String(keywordInput);
  const geo = options?.geo || "US";
  const countries = metaCountriesFromGeo(geo);
  const businessProfile = options?.businessProfile || null;
  const businessUrl =
    (options?.businessUrl || businessProfile?.url || "").trim() || null;
  const geoMode = options?.geoMode || "countrywide";
  const targetLocations = options?.targetLocations || [];
  const selectedCategory = options?.selectedCategory || null;
  const preferLocalGeo =
    geoMode === "company_locations" || geoMode === "keyword_location";
  // City/suburb search: nearest ring first, widening ring by ring while short.
  const rings = preferLocalGeo && targetLocations.length > 0
    ? buildSearchRings(businessProfile, targetLocations)
    : [];
  const localMode = rings.length > 0;
  let ringLevel = 0;
  /** Places that count as local right now; grows as rings widen. */
  let activeTargets = localMode ? placesUpToRing(rings, 0) : targetLocations;
  /** The city the business sits in: "suit hire Melbourne" finds far more local advertisers than a suburb query. */
  const localMetro = businessProfile?.serviceArea?.metro || targetLocations.find((l) => l.isPrimary)?.city || targetLocations[0]?.city || null;
  const anchors = localMode
    ? serviceAnchors(
        // Short local phrases from the analysis ("dentist") go ahead of category names.
        [...(businessProfile?.serviceArea?.searchTerms || []), ...(keywords.length ? keywords : [primaryKeyword])],
        [
          ...rings.flatMap((r) => r.places.map((p) => p.city)),
          ...targetLocations.flatMap((l) => [l.city, l.suburb || "", l.region || ""]),
        ],
        selectedCategory?.label || null,
      )
    : [];
  const signalOptions = {
    businessProfile,
    searchKeywords: keywords,
    selectedCategory,
  };
  const guardrailCtx = buildGuardrailContext({
    businessProfile,
    selectedCategoryLabel: selectedCategory?.label || null,
    searchKeywords: keywords,
    override: options?.guardrailOverride || null,
    skipGuardrails: Boolean(options?.skipGuardrails),
  });
  const industrySop = getSopForContext(guardrailCtx);
  const isOwnBusiness = ownBusinessCheck(businessProfile, businessUrl);
  const isOwnPage = (pageAds: AdCandidate[]) =>
    isOwnBusiness({
      pageName: pageAds[0]?.pageName,
      facebookUrl: pageAds.find((a) => a.pageProfileUri)?.pageProfileUri,
      urls: pageAds.map((a) => a.landingPageUrl),
    });
  const now = new Date().toISOString();
  const job: SearchJob = {
    id: jobId,
    keyword: keywords.join(", "),
    keywords,
    platform,
    geo,
    geoMode,
    selectedCategory,
    targetLocations: activeTargets,
    keywordLocation: options?.keywordLocation || null,
    countries,
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
        ? `Finding ${platform} competitors for ${businessProfile.industry} (${industrySop.label} SOP)…`
        : `Expanding ${keywords.length} keyword(s) for ${platform}…`,
      rejectReasons: {
        inactive: 0,
        shortDuration: 0,
        noServiceSignal: 0,
        nonEnglish: 0,
        noLandingPage: 0,
        llmReject: 0,
        llmError: 0,
        lowActiveAds: 0,
        countError: 0,
        guardrailReject: 0,
      },
    },
    competitorIds: [],
    createdAt: now,
    updatedAt: now,
  };
  saveJob(job);

  const accepted: CompetitorRecord[] = [];
  const rejectedPages = new Set<string>();
  // Within-run dedupe only — historical seen blocked rediscovery and starved later runs
  const seen = new Set<string>();
  const analyzedPages = new Set<string>();

  type NearMiss = {
    pageId: string;
    primary: AdCandidate;
    extras: AdCandidate[];
    filter: AdFilterResult;
    activeCount: number;
    brand?: BrandReview;
    score: number;
    reason: "lowActiveAds" | "geoMismatch";
    /** Address looked up by a city/suburb search, matched again as rings widen. */
    place?: ResolvedCompetitorLocation | null;
  };
  const nearMisses: NearMiss[] = [];
  const addressLookups: Promise<void>[] = [];
  /** Set once the planned queries ran out short of the target (see currentThresholds). */
  let widened = false;
  /** Pages turned down only by the strict early bar; they get another look once widened. */
  const strictRejected = new Set<string>();

  /**
   * More queries for when the planned ones run out short of the target: AI
   * expansions of every keyword, the category and the business's competitor
   * keywords, then those seeds as typed. A place-named search otherwise runs
   * only one or two queries ("suit hire melbourne", "suit hire").
   */
  const widenSearchQueries = async (): Promise<string[]> => {
    const seeds = Array.from(
      new Set(
        [
          // A local search going country-wide drops the place names.
          ...(localMode ? anchors : keywords.length ? keywords : [primaryKeyword]),
          selectedCategory?.label || "",
          ...(businessProfile?.competitorKeywords || []).slice(0, 4),
        ]
          .map((q) => q.replace(/\s+/g, " ").trim())
          .filter(Boolean),
      ),
    );
    let expanded: string[] = [];
    try {
      expanded = await searchQueriesForKeywords(
        seeds.slice(0, 6),
        (kw) => expandKeywordQueries(kw, businessProfile, { geoMode, targetLocations, selectedCategory }),
        MAX_SEARCH_QUERIES_META + 6,
      );
    } catch (err) {
      if (isCreditError(err)) throw err;
    }
    const out: string[] = [];
    const seenQ = new Set<string>();
    for (const q of [...expanded, ...seeds]) {
      const key = q.trim().toLowerCase();
      if (!key || seenQ.has(key)) continue;
      seenQ.add(key);
      out.push(q.trim());
    }
    return out;
  };

  // Cheap check before any AI review, cached per page.
  const prechecks = new Map<string, ReturnType<typeof precheckCompetitor>>();
  const precheckPage = (pageId: string, pageAds: AdCandidate[]) => {
    let d = prechecks.get(pageId);
    if (!d) {
      d = precheckCompetitor(guardrailCtx, {
        pageName: pageAds[0]?.pageName || "",
        adText: pageAds.map((a) => `${a.title}\n${a.body}\n${a.fullText}`).join("\n"),
        landingPageUrls: pageAds.map((a) => a.landingPageUrl),
        pageCategories: pageAds.flatMap((a) => a.pageCategories || []),
        targetCountries: countries,
      });
      prechecks.set(pageId, d);
    }
    return d;
  };

  const matchedLocalCount = () =>
    accepted.filter((c) => c.locationStatus === "matched").length;

  /** The bar right now. Past the first ring the AI review is relaxed too. */
  const thresholdsNow = () =>
    currentThresholds(accepted.length, platform, widened || ringLevel > 0, localMode);

  const bumpReason = (
    key: keyof NonNullable<JobProgress["rejectReasons"]>,
  ) => {
    if (!job.progress.rejectReasons) {
      job.progress.rejectReasons = {
        inactive: 0,
        shortDuration: 0,
        noServiceSignal: 0,
        nonEnglish: 0,
        noLandingPage: 0,
        llmReject: 0,
        llmError: 0,
        lowActiveAds: 0,
        countError: 0,
        guardrailReject: 0,
      };
    }
    job.progress.rejectReasons[key] =
      (job.progress.rejectReasons[key] || 0) + 1;
    job.progress.rejected += 1;
  };

  const acceptCompetitor = async (
    pageId: string,
    primary: AdCandidate,
    extras: AdCandidate[],
    filter: AdFilterResult,
    activeCount: number,
    brandInput?: BrandReview,
    countryFallback?: SearchCountry,
    /** Address already looked up by a city/suburb search. */
    knownPlace?: ResolvedCompetitorLocation | null,
  ) => {
    // Last guard: never list the client's own business.
    if (isOwnPage([primary, ...extras])) {
      rejectedPages.add(pageId);
      return;
    }
    // 1) Looked-up address, else cheap geo (no network) — provisional label only
    const provisional = knownPlace
      ? matchPlaceToTargets(knownPlace, activeTargets, geoMode)
      : cheapLocationFromText({
          pageName: primary.pageName,
          adText: primary.fullText || primary.body,
          landingUrl: primary.landingPageUrl,
          targets: activeTargets,
          geoMode,
        });

    const sampleBody =
      primary.body ||
      primary.fullText ||
      extras.map((e) => e.body).find(Boolean) ||
      "";

    // 2) Save immediately with minimal brand so the roster fills fast
    let brand: BrandReview = brandInput || {
      facebookUrl: primary.pageProfileUri || null,
      website: primary.landingPageUrl || null,
    };

    const competitor: CompetitorRecord = {
      id: newId(),
      runId: job.id,
      pageId,
      pageName: primary.pageName,
      country: primary.country || countryFallback || "US",
      platform,
      locationLabel: provisional.locationLabel,
      locationCity: provisional.locationCity,
      locationSuburb: provisional.locationSuburb,
      locationCountry: provisional.locationCountry,
      locationStatus: provisional.locationStatus,
      locationSource: provisional.locationSource,
      activeAdsCount: activeCount,
      services: filter.services as ServiceLabel[],
      sampleAd: {
        adArchiveId: primary.adArchiveId,
        title: primary.title,
        body: sampleBody.slice(0, 800),
        daysRunning: primary.daysRunning,
        adLibraryUrl: `https://www.facebook.com/ads/library/?id=${primary.adArchiveId}`,
        ctaText: primary.ctaText ?? null,
        landingPageUrl: primary.landingPageUrl ?? null,
        startDate: primary.startDateString ?? null,
        endDate: primary.endDateString ?? null,
        advertiserPageUrl: primary.pageProfileUri ?? null,
      },
      brand,
      createdAt: new Date().toISOString(),
    };

    saveCompetitor(competitor);
    markPageSeen(pageId);
    seen.add(pageId);
    accepted.push(competitor);
    if (!job.competitorIds.includes(competitor.id)) {
      job.competitorIds.push(competitor.id);
    }

    // Sociavault address (FB page / LI company) so Preview shows a real location.
    // It saves itself, so the search moves on and the run waits for it at the end.
    // Skipped when the city/suburb check already looked the address up.
    if (!knownPlace?.locationLabel && !knownPlace?.locationCity) addressLookups.push(
      import("./competitorLocation")
        .then(({ enrichCompetitorSociavaultAddress }) =>
          enrichCompetitorSociavaultAddress({
            competitorId: competitor.id,
            facebookUrl: brand.facebookUrl || primary.pageProfileUri || null,
            linkedinUrl: brand.linkedinUrl || null,
            geoMode,
            targetLocations: activeTargets,
          }),
        )
        .then((loc) => {
          if (!loc) return;
          competitor.locationLabel = loc.locationLabel;
          competitor.locationCity = loc.locationCity;
          competitor.locationSuburb = loc.locationSuburb;
          competitor.locationCountry = loc.locationCountry;
          competitor.locationStatus = loc.locationStatus;
          competitor.locationSource = loc.locationSource;
        })
        .catch(() => {
          /* keep provisional text location */
        }),
    );

    // Brand review is on-demand via Brand review tab — not during find
    const locNote = competitor.locationLabel
      ? ` · ${competitor.locationLabel}`
      : "";
    setProgress(job, {
      accepted: accepted.length,
      message: `Accepted ${primary.pageName} (${accepted.length}/${TARGET_COMPETITORS})${locNote} — services: ${filter.services.join(", ")}`,
    });
    saveJob(job);
  };

  /**
   * Rivals held only for being outside the local area. Once a ring widens to
   * cover their place they are local and are taken before new searches run.
   */
  const releaseHeldLocals = async (opts?: { addressUnknown?: boolean }) => {
    for (const miss of [...nearMisses]) {
      if (accepted.length >= TARGET_COMPETITORS || isSearchJobSuppressed(job.id)) return;
      if (miss.reason !== "geoMismatch" || seen.has(miss.pageId)) continue;
      if (opts?.addressUnknown) {
        // Going country-wide: rivals whose address was not found came from
        // place-named searches, so they go ahead of new country-wide ones.
        if (miss.place) continue;
      } else {
        const geo = miss.place
          ? matchPlaceToTargets(miss.place, activeTargets, geoMode)
          : cheapLocationFromText({
              pageName: miss.primary.pageName,
              adText: [miss.primary, ...miss.extras]
                .map((a) => `${a.title}\n${a.body}\n${a.fullText}`)
                .join("\n"),
              landingUrl: miss.primary.landingPageUrl,
              targets: activeTargets,
              geoMode,
            });
        if (geo.locationStatus !== "matched") continue;
      }
      let activeCount = miss.activeCount;
      try {
        activeCount = Math.max(
          activeCount,
          await countMetaActiveAds(miss.pageId, String(miss.primary.country || countries[0] || "US")),
        );
      } catch (err) {
        if (isCreditError(err)) throw err;
      }
      if (activeCount < thresholdsNow().minActiveAds) continue;
      nearMisses.splice(nearMisses.indexOf(miss), 1);
      await acceptCompetitor(
        miss.pageId,
        miss.primary,
        miss.extras,
        miss.filter,
        activeCount,
        undefined,
        miss.primary.country as SearchCountry | undefined,
        miss.place,
      );
    }
  };

  try {
    const preferPlaces = preferLocalGeo && targetLocations.length > 0;
    const multiPlace = !localMode && preferLocalGeo && targetLocations.length > 1;
    // Place-named queries return few ads; spread the budget over more places.
    const pageCap = localMode || multiPlace ? 2 : MAX_PAGES_PER_QUERY;
    const acceptSlot = multiPlace
      ? Math.max(2, Math.ceil(TARGET_COMPETITORS / Math.min(targetLocations.length, 4)))
      : TARGET_COMPETITORS;
    let queries: string[] = localMode
      ? adLibraryRingQueries({ anchors, rings, level: 0, metro: localMetro })
      : [];
    if (queries.length) {
      // City/suburb search: the nearest ring's place-named queries.
    } else if (preferPlaces) {
      queries = compactGeoSearchQueries({
        keywords: keywords.length ? keywords : [primaryKeyword],
        locations: targetLocations,
        categoryLabel: selectedCategory?.label || null,
        maxQueries: 6,
      });
    } else {
      queries = await searchQueriesForKeywords(
        keywords.length ? keywords : [primaryKeyword],
        (kw) => expandKeywordQueries(kw, businessProfile, { geoMode, targetLocations, selectedCategory }),
        MAX_SEARCH_QUERIES_META,
      );
    }
    setProgress(job, {
      stage: "searching_ads",
      message: localMode
        ? `Searching ${platform} Ad Library ${rings[0].label} (${queries.length} local queries)…`
        : `Searching ${platform} Ad Library with ${queries.length} ${
            preferPlaces ? "location" : ""
          } queries…`.replace("  ", " "),
    });

    let pageBudget = 0;
    // A local search spends part of its budget ring by ring; the rest is kept
    // so the country-wide step can still fill the list.
    const pageLimit = localMode ? LOCAL_SEARCH_PAGES : MAX_SEARCH_PAGES;
    const ringPageShare = Math.floor(pageLimit * 0.6);
    // The planned queries run first. If they run out short of the target,
    // the search widens once: more queries and a relaxed bar.
    const queryQueue = [...queries];
    const planned = queryQueue.length;
    const ranQueries = new Set<string>();

    outer: for (let qi = 0; ; qi += 1) {
      if (qi >= queryQueue.length) {
        if (
          accepted.length >= TARGET_COMPETITORS ||
          isSearchJobSuppressed(job.id) ||
          pageBudget >= pageLimit
        ) {
          break;
        }
        // City/suburb search: widen to the next ring before going country-wide.
        let nextRingQueries: string[] = [];
        while (!nextRingQueries.length && localMode && !widened && ringLevel < rings.length - 1) {
          ringLevel += 1;
          activeTargets = placesUpToRing(rings, ringLevel);
          job.targetLocations = activeTargets;
          for (const id of strictRejected) {
            rejectedPages.delete(id);
            analyzedPages.delete(id);
          }
          strictRejected.clear();
          setProgress(job, {
            stage: "expanding_queries",
            message: `Found ${accepted.length} of ${TARGET_COMPETITORS} so far. Widening the search ${rings[ringLevel].label}…`,
          });
          await releaseHeldLocals();
          if (accepted.length >= TARGET_COMPETITORS) break outer;
          // Past the rings' share of the budget, wider rings only take the
          // advertisers already held for them; the rest is kept for country-wide.
          nextRingQueries =
            pageBudget < ringPageShare
              ? adLibraryRingQueries({ anchors, rings, level: ringLevel, metro: localMetro }).filter(
                  (q) => !ranQueries.has(q.toLowerCase()),
                )
              : [];
        }
        if (nextRingQueries.length) {
          queryQueue.push(...nextRingQueries);
          setProgress(job, {
            stage: "searching_ads",
            message: `Searching ${rings[ringLevel].label} (${nextRingQueries.length} queries)…`,
          });
          qi -= 1;
          continue;
        }
        if (widened) break;
        widened = true;
        if (localMode) {
          await releaseHeldLocals({ addressUnknown: true });
          if (accepted.length >= TARGET_COMPETITORS) break;
        }
        for (const id of strictRejected) {
          rejectedPages.delete(id);
          analyzedPages.delete(id);
        }
        setProgress(job, {
          stage: "expanding_queries",
          message: localMode
            ? `Found ${accepted.length} of ${TARGET_COMPETITORS} in the local area. Searching country-wide…`
            : `Found ${accepted.length} of ${TARGET_COMPETITORS} so far. Widening the search…`,
        });
        const more = (await widenSearchQueries())
          .filter((q) => !ranQueries.has(q.toLowerCase()))
          .slice(0, MAX_SEARCH_QUERIES_META);
        if (!more.length) break;
        queryQueue.push(...more);
        setProgress(job, {
          stage: "searching_ads",
          message: `Found ${accepted.length} of ${TARGET_COMPETITORS} so far. Searching ${more.length} more queries with a wider net…`,
        });
      }
      const query = queryQueue[qi];
      ranQueries.add(query.toLowerCase());
      // Widened queries are not shared between places, so each may fill any slot.
      const querySlot = qi < planned ? acceptSlot : TARGET_COMPETITORS;
      const queryPageCap = qi < planned || (localMode && !widened) ? pageCap : MAX_PAGES_PER_QUERY;
      const acceptedAtStart = accepted.length;
          for (const country of countries as SearchCountry[]) {
        let cursor: string | null = null;
        let pagesForQuery = 0;

        do {
          if (accepted.length >= TARGET_COMPETITORS) break outer;
          if (accepted.length - acceptedAtStart >= querySlot) break;
          if (isSearchJobSuppressed(job.id)) break outer;
          if (pageBudget >= pageLimit) break outer;
          if (pagesForQuery >= queryPageCap) break;

          setProgress(job, {
            stage: "searching_ads",
            message: `Query "${query}" (${country}) — page ${pageBudget + 1}…`,
          });

          let response;
          try {
            response = await searchAdLibrary({
              query,
              cursor,
              country,
              status: "ACTIVE",
              language: "EN",
              // Need full creative text for LLM body review
              trim: false,
            });
          } catch (err) {
            // A run that has lost its funding or authorization must stop, not
            // degrade into "no competitors found" on the next query.
            if (isCreditError(err)) throw err;
            setProgress(job, {
              message: `Search error for "${query}" (${country}): ${(err as Error).message}. Trying next…`,
            });
            break;
          }

          pageBudget += 1;
          pagesForQuery += 1;
          job.progress.scannedPages = pageBudget;

          const ads = extractAds(response);
          cursor = extractCursor(response);

          setProgress(job, {
            scannedPages: pageBudget,
            message: `Query "${query}" (${country}) — page ${pageBudget}: ${ads.length} ads fetched`,
          });

          if (ads.length === 0) {
            break;
          }

          const thresholds = thresholdsNow();
          const byPage = new Map<string, AdCandidate[]>();

          for (const raw of ads) {
            job.progress.scannedAds += 1;
            if (platform === "instagram" && !adRunsOnInstagram(raw)) continue;
            if (platform === "facebook" && !adRunsOnFacebook(raw)) continue;
            const candidate = toCandidate(raw, country);
            if (!candidate) continue;

            if (!candidate.isActive) {
              bumpReason("inactive");
              continue;
            }
            // Unknown duration: allow through (don't discard)
            if (
              !meetsDurationThreshold(candidate.daysRunning, {
                minDaysExclusive: thresholds.minDays,
                minActiveAds: thresholds.minActiveAds,
                requireDaysGreaterThan: thresholds.requireDaysGreaterThan,
                skipDuration: thresholds.skipDuration,
                activeAdsInclusive: true,
              })
            ) {
              bumpReason("shortDuration");
              continue;
            }
            const signalText = `${candidate.title}\n${candidate.body}\n${candidate.fullText}`;
            if (!looksLikeEnglish(signalText)) {
              bumpReason("nonEnglish");
              continue;
            }
            if (
              thresholds.requireLanding &&
              !isLandingPageUrl(candidate.landingPageUrl)
            ) {
              bumpReason("noLandingPage");
              continue;
            }
            if (
              !hasServiceKeywordSignal(signalText, {
                ...signalOptions,
                softPass: thresholds.relaxedLlm,
              })
            ) {
              bumpReason("noServiceSignal");
              continue;
            }
            const list = byPage.get(candidate.pageId) ?? [];
            list.push(candidate);
            byPage.set(candidate.pageId, list);
          }

          // Analyze geo-local + keyword-strong pages first
          const pageEntries = Array.from(byPage.entries()).sort((a, b) => {
            const scorePage = (pageAds: AdCandidate[]) => {
              const blob = pageAds
                .map((x) => `${x.pageName}\n${x.title}\n${x.body}\n${x.fullText}`)
                .join("\n");
              const kw = serviceKeywordOverlapScore(blob, signalOptions);
              const geo = locationRankScore(
                cheapLocationFromText({
                  pageName: pageAds[0]?.pageName,
                  adText: blob,
                  landingUrl: pageAds[0]?.landingPageUrl,
                  targets: activeTargets,
                  geoMode,
                }).locationStatus,
              );
              return kw * 2 + geo;
            };
            return scorePage(b[1]) - scorePage(a[1]);
          });

          // The LLM review is the slow step. Start it for the next few eligible
          // pages while the current one is decided, but keep every decision
          // sequential and in the same order: a prefetched review is used only
          // if it was made with exactly the inputs the decision would use.
          const reviews = new Map<
            string,
            {
              relaxed: boolean;
              primaryId: string;
              extrasKey: string;
              result: Promise<{ ok: true; value: AdFilterResult } | { ok: false; error: unknown }>;
            }
          >();
          const extrasKeyOf = (list: AdCandidate[]) =>
            list.slice(0, 5).map((a) => a.adArchiveId).join(",");
          const startReview = (primary: AdCandidate, extras: AdCandidate[], relaxed: boolean) =>
            analyzeAdCandidate(
              primaryKeyword,
              primary,
              primary.pageCategories?.[0] ?? null,
              extras.slice(0, 5),
              {
                relaxed,
                businessProfile,
                searchKeywords: keywords,
                selectedCategory,
                targetCountry: primary.country || countries[0] || null,
              },
            );
          const prefetchReviews = (fromIndex: number) => {
            if (accepted.length >= TARGET_COMPETITORS || isSearchJobSuppressed(job.id)) return;
            const thrNow = thresholdsNow();
            for (
              let j = fromIndex + 1;
              j < pageEntries.length && j <= fromIndex + REVIEW_AHEAD;
              j += 1
            ) {
              const [nextId, nextAds] = pageEntries[j];
              if (reviews.has(nextId)) continue;
              if (seen.has(nextId) || rejectedPages.has(nextId) || analyzedPages.has(nextId)) continue;
              if (!precheckPage(nextId, nextAds).ok) continue;
              if (isOwnPage(nextAds)) continue;
              const nextPrimary =
                pickSampleAd(nextAds, {
                  requireLanding: thrNow.requireLanding,
                  signalOptions,
                  targets: activeTargets,
                  geoMode,
                }) || (!thrNow.requireLanding ? richestAd(nextAds) : null);
              if (!nextPrimary) continue;
              if (
                !businessProfile &&
                !hasAgencyPositioningSignal(
                  nextAds.map((a) => `${a.pageName}\n${a.title}\n${a.body}\n${a.fullText}`).join("\n"),
                )
              ) {
                continue;
              }
              const nextExtras = nextAds.filter((a) => a.adArchiveId !== nextPrimary.adArchiveId);
              reviews.set(nextId, {
                relaxed: thrNow.relaxedLlm,
                primaryId: nextPrimary.adArchiveId,
                extrasKey: extrasKeyOf(nextExtras),
                result: startReview(nextPrimary, nextExtras, thrNow.relaxedLlm).then(
                  (value) => ({ ok: true as const, value }),
                  (error: unknown) => ({ ok: false as const, error }),
                ),
              });
            }
          };

          for (const [entryIndex, [pageId, pageAds]] of pageEntries.entries()) {
            if (accepted.length >= TARGET_COMPETITORS) break outer;
            prefetchReviews(entryIndex);
            if (
              seen.has(pageId) ||
              rejectedPages.has(pageId) ||
              analyzedPages.has(pageId)
            ) {
              continue;
            }

            analyzedPages.add(pageId);
            // The client's own page shows up in its own keyword searches.
            if (isOwnPage(pageAds)) {
              rejectedPages.add(pageId);
              bumpReason("guardrailReject");
              setProgress(job, {
                message: `Skipped ${pageAds[0]?.pageName || "a page"}: this is your client's own business`,
              });
              continue;
            }
            const thr = thresholdsNow();
            const primary =
              pickSampleAd(pageAds, {
                requireLanding: thr.requireLanding,
                signalOptions,
                targets: activeTargets,
                geoMode,
              }) ||
              (!thr.requireLanding ? richestAd(pageAds) : null);
            if (!primary) {
              bumpReason("noLandingPage");
              rejectedPages.add(pageId);
              if (thr.requireLanding) strictRejected.add(pageId);
              continue;
            }
            const extras = pageAds.filter(
              (a) => a.adArchiveId !== primary.adArchiveId,
            );

            const pageText = pageAds
              .map((a) => `${a.pageName}\n${a.title}\n${a.body}\n${a.fullText}`)
              .join("\n");
            if (
              !businessProfile &&
              !hasAgencyPositioningSignal(pageText)
            ) {
              rejectedPages.add(pageId);
              bumpReason("llmReject");
              setProgress(job, {
                message: `Skipped ${primary.pageName}: no agency/B2B service positioning in ad copy`,
              });
              continue;
            }
            // Plugins, proxies, courses, publishers: rejected without an AI review.
            const pre = precheckPage(pageId, pageAds);
            if (!pre.ok) {
              rejectedPages.add(pageId);
              bumpReason("guardrailReject");
              setProgress(job, { message: `Skipped ${primary.pageName}: ${pre.reason}` });
              continue;
            }

            const bodyChars = pageAds.reduce(
              (n, a) => n + (a.fullText?.length || a.body?.length || 0),
              0,
            );

            setProgress(job, {
              stage: "analyzing_ad",
              message: businessProfile
                ? `LLM reviewing industry competitor ${primary.pageName} (${pageAds.length} creatives)…`
                : `LLM reviewing agency candidate ${primary.pageName} (${pageAds.length} creatives, ${bodyChars} chars)…`,
            });

            let filter: AdFilterResult;
            try {
              const ahead = reviews.get(pageId);
              const sameInputs =
                ahead &&
                ahead.primaryId === primary.adArchiveId &&
                ahead.extrasKey === extrasKeyOf(extras);
              let reused: AdFilterResult | null = null;
              if (sameInputs && (ahead.relaxed === thr.relaxedLlm || !ahead.relaxed)) {
                const outcome = await ahead.result;
                if (!outcome.ok) throw outcome.error;
                // A strict review that passed also passes the relaxed bar;
                // a strict reject is re-checked once the bar has relaxed.
                if (ahead.relaxed === thr.relaxedLlm || outcome.value.relevant) reused = outcome.value;
              }
              filter = reused ?? (await startReview(primary, extras, thr.relaxedLlm));
            } catch (err) {
              if (isCreditError(err)) throw err;
              setProgress(job, {
                message: `LLM error on ${primary.pageName}: ${(err as Error).message}`,
              });
              rejectedPages.add(pageId);
              bumpReason("llmError");
              continue;
            }

            if (
              !filter.relevant ||
              (!businessProfile && !filter.isMarketingAgency)
            ) {
              rejectedPages.add(pageId);
              if (!thr.relaxedLlm && !filter.relevant) strictRejected.add(pageId);
              bumpReason("llmReject");
              setProgress(job, {
                message: `Rejected ${primary.pageName}: ${
                  !businessProfile && !filter.isMarketingAgency
                    ? "not a marketing agency — "
                    : ""
                }${filter.reason}${
                  filter.bodyEvidence
                    ? ` | evidence: ${filter.bodyEvidence.slice(0, 120)}`
                    : ""
                }`,
              });
              continue;
            }

            const guard = guardCompetitorHeuristic(guardrailCtx, {
              pageName: primary.pageName,
              adText: pageText,
              landingPageUrl: primary.landingPageUrl,
              services: filter.services,
              llmReason: filter.reason,
            });
            if (!guard.ok) {
              rejectedPages.add(pageId);
              bumpReason("guardrailReject");
              setProgress(job, {
                message: `Guardrail blocked ${primary.pageName}: ${guard.reason}`,
              });
              continue;
            }

            const cheapGeo = cheapLocationFromText({
              pageName: primary.pageName,
              adText: pageText,
              landingUrl: primary.landingPageUrl,
              targets: activeTargets,
              geoMode,
            });

            // City/suburb search: an ad rarely names its suburb and the Ad
            // Library is not location-filtered, so the business's real address
            // decides. Only a business inside the current rings is taken now.
            let knownPlace: ResolvedCompetitorLocation | null = null;
            if (localMode && !widened) {
              setProgress(job, { message: `Checking where ${primary.pageName} is located…` });
              const looked = await lookupCompetitorPlace({
                pageName: primary.pageName,
                facebookUrl: primary.pageProfileUri,
                website: primary.landingPageUrl,
                landingPageUrl: primary.landingPageUrl,
                countryHint: country,
              });
              const place = looked ? matchPlaceToTargets(looked, activeTargets, geoMode) : cheapGeo;
              if (place.locationStatus !== "matched") {
                nearMisses.push({
                  pageId,
                  primary,
                  extras,
                  filter,
                  activeCount: 0,
                  // No address found: possibly local, so ahead of known far-away ones.
                  score: filter.relevanceScore + (looked ? 0 : 0.5),
                  reason: "geoMismatch",
                  place: looked,
                });
                setProgress(job, {
                  message: `Holding ${primary.pageName}: ${
                    looked
                      ? `based in ${looked.locationLabel || looked.locationCity}`
                      : "address not found"
                  }, not ${rings[ringLevel].label}`,
                });
                continue;
              }
              knownPlace = looked;
            }

            // Prefer locals: hold clear geo mismatches until the fill pass
            if (preferLocalGeo && !widened && !localMode && cheapGeo.locationStatus === "mismatch") {
              nearMisses.push({
                pageId,
                primary,
                extras,
                filter,
                activeCount: 0,
                score:
                  filter.relevanceScore +
                  locationRankScore(cheapGeo.locationStatus),
                reason: "geoMismatch",
              });
              setProgress(job, {
                message: `Holding ${primary.pageName}: relevant but outside target geo (${cheapGeo.locationLabel || "other city"}) — seeking locals first`,
              });
              continue;
            }
            const seenCount = activeAdsSeenInSearch(pageAds);
            let activeCount = seenCount;
            try {
              setProgress(job, {
                message: `Counting active ads for ${primary.pageName} (${country})…`,
              });
              const counted = await countMetaActiveAds(pageId, country);
              activeCount = Math.max(seenCount, counted);
            } catch (err) {
              if (isCreditError(err)) throw err;
              activeCount = seenCount;
            }

            const adsOk = activeCount >= thr.minActiveAds;

            if (!adsOk) {
              // Queue relevant rivals with low ad volume for fill (prefer locals in sort)
              if (activeCount > 0) {
                nearMisses.push({
                  pageId,
                  primary,
                  extras,
                  filter,
                  activeCount,
                  score:
                    filter.relevanceScore +
                    activeCount / 100 +
                    locationRankScore(cheapGeo.locationStatus) +
                    serviceKeywordOverlapScore(
                      `${primary.title}\n${primary.body}\n${primary.fullText}`,
                      signalOptions,
                    ),
                  reason: "lowActiveAds",
                });
              } else {
                rejectedPages.add(pageId);
              }
              bumpReason("lowActiveAds");
              setProgress(job, {
                message: `Soft-hold ${primary.pageName}: ${activeCount} active ads (need ≥${thr.minActiveAds})`,
              });
              continue;
            }

            await acceptCompetitor(
              pageId,
              primary,
              extras,
              filter,
              activeCount,
              undefined,
              country,
              knownPlace,
            );
          }

          saveJobProgress(job);
        } while (cursor && pageBudget < pageLimit);
      } // country
    } // query

    // Fill remaining slots from geo-held rivals that still clear the ad-volume floor
    if (accepted.length < TARGET_COMPETITORS && nearMisses.length > 0) {
      setProgress(job, {
        stage: "filling_quota",
        message: `Filling remaining slots from ${nearMisses.length} held candidates (prefer geo-local, ≥${thresholdsNow().minActiveAds} ads)…`,
      });

      const fillFrom = async (pool: NearMiss[], minActiveAds?: number) => {
        const ranked = [...pool].sort((a, b) => b.score - a.score);
        const floor = minActiveAds ?? thresholdsNow().minActiveAds;
        for (const miss of ranked) {
          if (accepted.length >= TARGET_COMPETITORS) break;
          if (seen.has(miss.pageId) || rejectedPages.has(miss.pageId)) continue;
          if (!miss.filter.relevant) continue;
          if (!businessProfile && !miss.filter.isMarketingAgency) continue;

          let activeCount = miss.activeCount;
          const missCountry = String(
            miss.primary.country || countries[0] || "US",
          );
          try {
            activeCount = Math.max(
              activeCount,
              await countMetaActiveAds(miss.pageId, missCountry),
            );
          } catch (err) {
            if (isCreditError(err)) throw err;
            /* keep prior count */
          }
          if (activeCount < floor) continue;

          await acceptCompetitor(
            miss.pageId,
            miss.primary,
            miss.extras,
            miss.filter,
            activeCount,
            undefined,
            miss.primary.country as SearchCountry | undefined,
            miss.place,
          );
        }
      };

      await fillFrom(nearMisses.filter((m) => m.reason === "geoMismatch"));

      // Still short of the target: a small market's relevant rivals often run
      // only a few ads. Take the best of them (at least one active ad).
      if (accepted.length < TARGET_COMPETITORS && !isSearchJobSuppressed(job.id)) {
        setProgress(job, {
          stage: "filling_quota",
          message: `Found ${accepted.length} of ${TARGET_COMPETITORS}. Adding relevant competitors that run fewer ads…`,
        });
        await fillFrom(nearMisses, 1);
      }
    }

    await Promise.allSettled(addressLookups);

    const status =
      accepted.length >= TARGET_COMPETITORS
        ? "completed"
        : accepted.length > 0
          ? "partial"
          : "failed";
    if (!isSearchJobSuppressed(jobId)) {
      const geoNote = localMode
        ? ` (${matchedLocalCount()} local; searched ${
            widened ? "nearby areas, then country-wide" : rings[ringLevel].label
          })`
        : preferLocalGeo && matchedLocalCount()
          ? ` (${matchedLocalCount()} geo-matched)`
          : "";
      updateJob(job, {
        status,
        progress: {
          ...job.progress,
          stage: "done",
          accepted: accepted.length,
          message:
            accepted.length > 0
              ? `Found ${accepted.length} competitors${geoNote}. Brand review & deep location run on demand / during offer analysis.`
              : `Found 0/${TARGET_COMPETITORS} competitors after scan. Try a broader keyword.`,
        },
      });
    }
  } catch (err) {
    updateJob(job, {
      status: "failed",
      error: (err as Error).message,
      progress: {
        ...job.progress,
        stage: "failed",
        message: (err as Error).message,
      },
    });
  }
}
