import { v4 as uuidv4 } from "uuid";
import {
  extractAds,
  extractCompanies,
  extractCursor,
  extractFullAdCopy,
  getCompanyAds,
  searchCompanies,
  adRunsOnFacebook,
  adRunsOnInstagram,
} from "../sociavault/client";
import { pickCompanyPageMatch } from "../openai/analyzer";
import {
  saveLookupAd,
  saveLookupJob,
} from "../db";
import {
  SEARCH_COUNTRIES,
  type LookupAdRecord,
  type LookupJob,
  type LookupJobProgress,
  type LookupPageCandidate,
} from "../types";
import { enrichLookupPageMetrics } from "./lookupEnrichment";

const MAX_AD_PAGES_PER_COUNTRY = 25;

function safeNum(n: unknown): number | null {
  if (typeof n === "number" && Number.isFinite(n)) return n;
  if (typeof n === "string" && n.trim() && !Number.isNaN(Number(n))) {
    return Number(n);
  }
  return null;
}

function updateLookup(job: LookupJob, patch: Partial<LookupJob>) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  saveLookupJob(job);
}

function setProgress(job: LookupJob, progress: Partial<LookupJobProgress>) {
  job.progress = { ...job.progress, ...progress };
  job.updatedAt = new Date().toISOString();
  saveLookupJob(job);
}

function toCandidate(
  raw: Record<string, unknown>,
): LookupPageCandidate | null {
  const pageId = raw.page_id != null ? String(raw.page_id) : "";
  const name = raw.name != null ? String(raw.name) : "";
  if (!pageId || !name) return null;
  return {
    pageId,
    name,
    category: raw.category != null ? String(raw.category) : null,
    likes: safeNum(raw.likes),
    verification: raw.verification != null ? String(raw.verification) : null,
    igUsername: raw.ig_username != null ? String(raw.ig_username) : null,
    igFollowers: safeNum(raw.ig_followers),
    pageAlias: raw.page_alias != null ? String(raw.page_alias) : null,
    imageUri: raw.image_uri != null ? String(raw.image_uri) : null,
    country: raw.country != null ? String(raw.country) : null,
    raw,
  };
}

export async function runCompetitorLookup(
  lookupId: string,
  queryName: string,
  platform: import("../platforms").AdPlatform = "facebook",
  forcedCandidate?: LookupPageCandidate | null,
) {
  const now = new Date().toISOString();
  const job: LookupJob = {
    id: lookupId,
    queryName,
    platform,
    status: "running",
    progress: {
      stage: "searching_pages",
      message: `Searching Ad Library pages for "${queryName}"…`,
      candidatesFound: 0,
      adsFetched: 0,
      pagesScanned: 0,
    },
    selectedPage: null,
    candidates: [],
    llmReason: null,
    llmConfidence: null,
    adIds: [],
    createdAt: now,
    updatedAt: now,
  };
  saveLookupJob(job);

  try {
    const companyRes = await searchCompanies(queryName);
    const rawCompanies = extractCompanies(companyRes);
    const candidates = rawCompanies
      .map((c) => toCandidate(c as Record<string, unknown>))
      .filter((c): c is LookupPageCandidate => Boolean(c));

    // Dedupe by pageId
    const byId = new Map<string, LookupPageCandidate>();
    for (const c of candidates) {
      if (!byId.has(c.pageId)) byId.set(c.pageId, c);
    }
    if (forcedCandidate?.pageId && !byId.has(forcedCandidate.pageId)) {
      byId.set(forcedCandidate.pageId, forcedCandidate);
    }
    const unique = Array.from(byId.values()).slice(0, 20);

    job.candidates = unique;
    setProgress(job, {
      candidatesFound: unique.length,
      stage: "verifying_page",
      message: forcedCandidate
        ? `Using selected match "${forcedCandidate.name}"…`
        : `Found ${unique.length} page(s). LLM verifying best match…`,
    });

    if (unique.length === 0 && !forcedCandidate) {
      updateLookup(job, {
        status: "failed",
        error: `No Facebook Ad Library pages found for "${queryName}"`,
        progress: {
          ...job.progress,
          stage: "failed",
          message: `No pages found for "${queryName}"`,
        },
      });
      return;
    }

    let selected: LookupPageCandidate | null = null;
    let pickReason = "";
    let pickConfidence = 0;

    if (forcedCandidate?.pageId) {
      selected =
        unique.find((c) => c.pageId === forcedCandidate.pageId) ||
        forcedCandidate;
      pickReason = `User selected alternate match "${selected.name}"`;
      pickConfidence = 1;
    } else {
      const pick = await pickCompanyPageMatch(
        queryName,
        unique.map((c) => ({
          pageId: c.pageId,
          name: c.name,
          category: c.category,
          likes: c.likes,
          verification: c.verification,
          igUsername: c.igUsername,
          pageAlias: c.pageAlias,
        })),
      );
      selected =
        unique.find((c) => c.pageId === pick.selectedPageId) ?? null;
      pickReason = pick.reason;
      pickConfidence = pick.confidence;
    }

    if (!selected) {
      updateLookup(job, {
        status: "failed",
        llmReason: pickReason,
        llmConfidence: pickConfidence,
        error: "LLM could not confidently match a page for this competitor name",
        progress: {
          ...job.progress,
          stage: "failed",
          message: pickReason,
        },
      });
      return;
    }

    setProgress(job, {
      stage: "verifying_page",
      message: `Enriching profile metrics for "${selected.name}"…`,
    });
    selected = await enrichLookupPageMetrics(selected, { platform });
    // Keep candidates list in sync for the selected row
    job.candidates = job.candidates.map((c) =>
      c.pageId === selected!.pageId ? selected! : c,
    );

    job.selectedPage = selected;
    job.llmReason = pickReason;
    job.llmConfidence = pickConfidence;
    setProgress(job, {
      stage: "fetching_ads",
      message: `Matched "${selected.name}" (${selected.pageId}). Fetching ads…`,
    });

    const seenAds = new Set<string>();
    const stored: LookupAdRecord[] = [];

    for (const country of SEARCH_COUNTRIES) {
      let cursor: string | null = null;
      let pages = 0;

      do {
        setProgress(job, {
          message: `Fetching ads for ${selected.name} (${country}) — page ${pages + 1}…`,
        });

        let response;
        try {
          response = await getCompanyAds({
            pageId: selected.pageId,
            status: "ALL",
            country,
            language: "EN",
            cursor,
            trim: false,
          });
        } catch {
          // Some regions fail with ALL — retry ACTIVE
          try {
            response = await getCompanyAds({
              pageId: selected.pageId,
              status: "ACTIVE",
              country,
              language: "EN",
              cursor,
              trim: false,
            });
          } catch (err) {
            setProgress(job, {
              message: `Ad fetch error (${country}): ${(err as Error).message}`,
            });
            break;
          }
        }

        pages += 1;
        job.progress.pagesScanned += 1;
        const ads = extractAds(response);
        cursor = extractCursor(response);

        for (const ad of ads) {
          if (platform === "instagram" && !adRunsOnInstagram(ad)) continue;
          if (platform === "facebook" && !adRunsOnFacebook(ad)) continue;
          const adArchiveId = ad.ad_archive_id
            ? String(ad.ad_archive_id)
            : "";
          if (!adArchiveId || seenAds.has(adArchiveId)) continue;
          seenAds.add(adArchiveId);

          const copy = extractFullAdCopy(
            ad.snapshot as Parameters<typeof extractFullAdCopy>[0],
          );
          const record: LookupAdRecord = {
            id: uuidv4(),
            lookupId: job.id,
            adArchiveId,
            pageId: selected.pageId,
            pageName: String(ad.page_name || selected.name),
            country,
            isActive:
              ad.is_active !== false && String(ad.is_active) !== "false",
            title: copy.title,
            body: copy.body,
            ctaText: copy.ctaText,
            landingPageUrl: copy.landingPageUrl,
            startDateString: ad.start_date_string ?? null,
            endDateString: ad.end_date_string ?? null,
            adLibraryUrl: `https://www.facebook.com/ads/library/?id=${adArchiveId}`,
            raw: ad as Record<string, unknown>,
            createdAt: new Date().toISOString(),
          };
          saveLookupAd(record);
          stored.push(record);
          if (!job.adIds.includes(record.id)) job.adIds.push(record.id);
        }

        setProgress(job, {
          adsFetched: stored.length,
          pagesScanned: job.progress.pagesScanned,
          message: `Fetched ${stored.length} ads for ${selected.name}…`,
        });
      } while (cursor && pages < MAX_AD_PAGES_PER_COUNTRY);
    }

    updateLookup(job, {
      status: stored.length > 0 ? "completed" : "partial",
      progress: {
        ...job.progress,
        stage: "done",
        adsFetched: stored.length,
        message:
          stored.length > 0
            ? `Loaded ${stored.length} ads for "${selected.name}".`
            : `Matched "${selected.name}" but found no ads in US/AU.`,
      },
    });
  } catch (err) {
    updateLookup(job, {
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
