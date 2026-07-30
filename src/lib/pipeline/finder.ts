import {
  extractAds,
  extractCursor,
  extractFullAdCopy,
  getCompanyAds,
  isLandingPageUrl,
  searchAdLibrary,
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
import { runBrandReview, newId } from "./brandReview";
import { markPageSeen, saveCompetitor, saveJob, updateCompetitor } from "../db";
import {
  cheapLocationFromText,
  locationRankScore,
  resolveAndMatchCompetitorLocation,
} from "./competitorLocation";
import type { SearchDispatchOptions } from "./searchOptions";
import {
  MAX_PAGES_PER_QUERY,
  MAX_SEARCH_PAGES,
  RELAXED_MIN_ACTIVE_ADS,
  RELAXED_MIN_AD_DURATION_DAYS,
  SEARCH_COUNTRIES,
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

/** Lightweight English check — only drop obvious non-English creatives */
function looksLikeEnglish(text: string): boolean {
  const sample = text.replace(/\s+/g, " ").trim();
  if (sample.length < 12) return true;

  const accentHits = (sample.match(/[àâæçéèêëïîôœùûüÿäöüßñ¿¡]/gi) || [])
    .length;
  // Only reject dense foreign accent use
  if (accentHits >= 8) return false;

  const lower = sample.toLowerCase();
  const foreignHints =
    /\b(pour|avec|une|des|les|und|der|die|das|für|mit|nicht|não|você|obrigado|khoá|học|để|của)\b/i;
  const englishHints =
    /\b(the|and|for|your|you|with|our|free|get|ads|marketing|agency|business|google|seo|audit|grow|leads|campaign|ppc|facebook|instagram)\b/i;

  const foreign = foreignHints.test(lower);
  const english = englishHints.test(lower);
  if (foreign && !english) return false;
  return true;
}

function currentThresholds(acceptedCount: number, platform: AdPlatform) {
  // Keep LLM strict early; only relax after we have a solid local/relevant core
  const relaxedLlm = acceptedCount >= 5;

  if (platform !== "facebook") {
    const t = getPlatformAdThresholds(platform);
    if (platform === "instagram") {
      return {
        minDays: RELAXED_MIN_AD_DURATION_DAYS,
        minActiveAds: RELAXED_MIN_ACTIVE_ADS,
        requireDaysGreaterThan: true,
        skipDuration: false,
        relaxedLlm,
        requireLanding: acceptedCount < 5,
      };
    }
    return {
      minDays: t.minDaysExclusive,
      minActiveAds: Math.min(t.minActiveAds, RELAXED_MIN_ACTIVE_ADS),
      requireDaysGreaterThan: t.requireDaysGreaterThan,
      skipDuration: t.skipDuration,
      relaxedLlm,
      requireLanding: acceptedCount < 5,
    };
  }

  return {
    minDays: RELAXED_MIN_AD_DURATION_DAYS,
    minActiveAds: RELAXED_MIN_ACTIVE_ADS,
    requireDaysGreaterThan: false,
    skipDuration: false,
    relaxedLlm,
    requireLanding: acceptedCount < 3,
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
  saveJob(job);
}

async function getActiveAdsCount(pageId: string): Promise<number> {
  // Count across US + AU (API is single-country); take the max so we don't double-count
  const counts: number[] = [];
  for (const country of SEARCH_COUNTRIES) {
    try {
      const res = await getCompanyAds({
        pageId,
        status: "ACTIVE",
        country,
        language: "EN",
        trim: true,
      });
      const count = res.data?.searchResultsCount;
      if (typeof count === "number") counts.push(count);
      else counts.push(extractAds(res).length);
    } catch {
      // ignore country-specific failures
    }
  }
  if (counts.length === 0) {
    const res = await getCompanyAds({ pageId, status: "ACTIVE", trim: true });
    const count = res.data?.searchResultsCount;
    if (typeof count === "number") return count;
    return extractAds(res).length;
  }
  return Math.max(...counts);
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
  const signalOptions = {
    businessProfile,
    searchKeywords: keywords,
    selectedCategory,
  };
  const now = new Date().toISOString();
  const job: SearchJob = {
    id: jobId,
    keyword: keywords.join(", "),
    keywords,
    platform,
    geo,
    geoMode,
    selectedCategory,
    targetLocations,
    keywordLocation: options?.keywordLocation || null,
    countries,
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
        ? `Finding ${platform} competitors for ${businessProfile.industry}…`
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
  };
  const nearMisses: NearMiss[] = [];

  const matchedLocalCount = () =>
    accepted.filter((c) => c.locationStatus === "matched").length;

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
      };
    }
    job.progress.rejectReasons[key] += 1;
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
  ) => {
    // 1) Cheap geo (no network) — provisional label only
    const provisional = cheapLocationFromText({
      pageName: primary.pageName,
      adText: primary.fullText || primary.body,
      landingUrl: primary.landingPageUrl,
      targets: targetLocations,
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

    setProgress(job, {
      accepted: accepted.length,
      message: `Accepted ${primary.pageName} (${accepted.length}/${TARGET_COMPETITORS}) — location pending…`,
    });
    saveJob(job);

    // 3) Enrich brand + full location after accept (never discard the row)
    setProgress(job, {
      stage: "brand_review",
      message: `Enriching brand for ${primary.pageName}…`,
    });
    try {
      brand = await runBrandReview({
        pageId,
        pageName: primary.pageName,
        pageProfileUri: primary.pageProfileUri,
      });
    } catch (err) {
      setProgress(job, {
        message: `Partial brand review for ${primary.pageName}: ${(err as Error).message}`,
      });
    }

    setProgress(job, {
      stage: "location_check",
      message: `Resolving location for ${primary.pageName}…`,
    });
    let loc = provisional;
    try {
      const locResult = await resolveAndMatchCompetitorLocation({
        pageName: primary.pageName,
        website: brand.website,
        facebookUrl: brand.facebookUrl || primary.pageProfileUri,
        linkedinUrl: brand.linkedinUrl,
        geoMode,
        targetLocations,
        provisional,
        skipPerplexityIfResolved: provisional.locationStatus === "matched",
      });
      loc = locResult.location;
    } catch (err) {
      console.warn("[finder] location enrich failed", err);
    }

    const enriched: CompetitorRecord = {
      ...competitor,
      brand,
      locationLabel: loc.locationLabel,
      locationCity: loc.locationCity,
      locationSuburb: loc.locationSuburb,
      locationCountry: loc.locationCountry,
      locationStatus: loc.locationStatus,
      locationSource: loc.locationSource,
    };
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
    if (idx >= 0) accepted[idx] = enriched;

    const locNote =
      loc.locationStatus === "unknown"
        ? " · location unknown"
        : loc.locationStatus === "mismatch"
          ? ` · location mismatch${loc.locationLabel ? ` (${loc.locationLabel})` : ""}`
          : loc.locationLabel
            ? ` · ${loc.locationLabel}`
            : "";
    setProgress(job, {
      accepted: accepted.length,
      message: `Accepted ${primary.pageName} (${accepted.length}/${TARGET_COMPETITORS})${locNote} — services: ${filter.services.join(", ")}`,
    });
  };

  try {
    const querySet = new Set<string>();
    for (const kw of keywords.length ? keywords : [primaryKeyword]) {
      querySet.add(kw);
      try {
        const expanded = await expandKeywordQueries(kw, businessProfile, {
          geoMode,
          targetLocations,
          selectedCategory,
        });
        for (const q of expanded) querySet.add(q);
      } catch {
        // keep seed keyword
      }
    }
    // Seed geo-qualified variants even if expansion failed
    if (preferLocalGeo && targetLocations.length) {
      for (const loc of targetLocations.slice(0, 4)) {
        const place = loc.suburb || loc.city || loc.label;
        if (!place) continue;
        for (const kw of keywords.slice(0, 4)) {
          querySet.add(`${kw} ${place}`);
        }
        if (selectedCategory?.label) {
          querySet.add(`${selectedCategory.label} ${place}`);
        }
      }
    }
    const queries = Array.from(querySet).slice(0, 28);
    setProgress(job, {
      stage: "searching_ads",
      message: `Searching ${platform} Ad Library with ${queries.length} queries${
        preferLocalGeo ? " (geo-prefer)" : ""
      }…`,
    });

    let pageBudget = 0;

    outer: for (const query of queries) {
          for (const country of countries as SearchCountry[]) {
        let cursor: string | null = null;
        let pagesForQuery = 0;

        do {
          if (accepted.length >= TARGET_COMPETITORS) break outer;
          if (pageBudget >= MAX_SEARCH_PAGES) break outer;
          if (pagesForQuery >= MAX_PAGES_PER_QUERY) break;

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

          const thresholds = currentThresholds(accepted.length, platform);
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
                  targets: targetLocations,
                  geoMode,
                }).locationStatus,
              );
              return kw * 2 + geo;
            };
            return scorePage(b[1]) - scorePage(a[1]);
          });

          for (const [pageId, pageAds] of pageEntries) {
            if (accepted.length >= TARGET_COMPETITORS) break outer;
            if (
              seen.has(pageId) ||
              rejectedPages.has(pageId) ||
              analyzedPages.has(pageId)
            ) {
              continue;
            }

            analyzedPages.add(pageId);
            const thr = currentThresholds(accepted.length, platform);
            const primary =
              pickSampleAd(pageAds, {
                requireLanding: thr.requireLanding,
                signalOptions,
                targets: targetLocations,
                geoMode,
              }) ||
              (!thr.requireLanding ? richestAd(pageAds) : null);
            if (!primary) {
              bumpReason("noLandingPage");
              rejectedPages.add(pageId);
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
              filter = await analyzeAdCandidate(
                primaryKeyword,
                primary,
                primary.pageCategories?.[0] ?? null,
                extras.slice(0, 5),
                {
                  relaxed: thr.relaxedLlm,
                  businessProfile,
                  searchKeywords: keywords,
                  selectedCategory,
                },
              );
            } catch (err) {
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

            const cheapGeo = cheapLocationFromText({
              pageName: primary.pageName,
              adText: pageText,
              landingUrl: primary.landingPageUrl,
              targets: targetLocations,
              geoMode,
            });

            // Prefer locals: hold clear geo mismatches until the fill pass
            if (preferLocalGeo && cheapGeo.locationStatus === "mismatch") {
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
            setProgress(job, {
              stage: "counting_ads",
              message: `Checking active ads for ${primary.pageName}…`,
            });

            let activeCount = 0;
            try {
              activeCount = await getActiveAdsCount(pageId);
            } catch (err) {
              rejectedPages.add(pageId);
              bumpReason("countError");
              setProgress(job, {
                message: `Could not count ads for ${primary.pageName}: ${(err as Error).message}`,
              });
              continue;
            }

            const adsOk =
              platform === "facebook"
                ? activeCount > thr.minActiveAds
                : activeCount >= thr.minActiveAds;

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
                message: `Soft-hold ${primary.pageName}: ${activeCount} active ads (need ${
                  platform === "facebook" ? `>${thr.minActiveAds}` : `≥${thr.minActiveAds}`
                })`,
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
            );
          }

          saveJob(job);
        } while (cursor && pageBudget < MAX_SEARCH_PAGES);
      } // country
    } // query

    // Fill remaining slots: locals + keyword-strong first; geo mismatches last
    if (accepted.length < TARGET_COMPETITORS && nearMisses.length > 0) {
      setProgress(job, {
        stage: "filling_quota",
        message: `Filling remaining slots from ${nearMisses.length} held candidates (prefer geo-local)…`,
      });

      const fillFrom = async (pool: NearMiss[]) => {
        const ranked = [...pool].sort((a, b) => b.score - a.score);
        for (const miss of ranked) {
          if (accepted.length >= TARGET_COMPETITORS) break;
          if (seen.has(miss.pageId) || rejectedPages.has(miss.pageId)) continue;
          if (!miss.filter.relevant) continue;
          if (!businessProfile && !miss.filter.isMarketingAgency) continue;

          let activeCount = Math.max(miss.activeCount, 1);
          if (miss.activeCount <= 0) {
            try {
              activeCount = await getActiveAdsCount(miss.pageId);
            } catch {
              activeCount = 1;
            }
            if (activeCount <= 0) continue;
          }

          await acceptCompetitor(
            miss.pageId,
            miss.primary,
            miss.extras,
            miss.filter,
            activeCount,
            undefined,
            miss.primary.country as SearchCountry | undefined,
          );
        }
      };

      await fillFrom(nearMisses.filter((m) => m.reason !== "geoMismatch"));
      if (accepted.length < TARGET_COMPETITORS) {
        await fillFrom(nearMisses.filter((m) => m.reason === "geoMismatch"));
      }
    }

    if (accepted.length >= TARGET_COMPETITORS) {
      updateJob(job, {
        status: "completed",
        progress: {
          ...job.progress,
          stage: "done",
          accepted: accepted.length,
          message: `Found ${accepted.length} competitors${
            preferLocalGeo && matchedLocalCount()
              ? ` (${matchedLocalCount()} geo-matched)`
              : ""
          }.`,
        },
      });
    } else {
      updateJob(job, {
        status: "partial",
        progress: {
          ...job.progress,
          stage: "done",
          accepted: accepted.length,
          message: `Found ${accepted.length}/${TARGET_COMPETITORS} competitors after full scan + fill pass. Try a broader keyword.`,
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
