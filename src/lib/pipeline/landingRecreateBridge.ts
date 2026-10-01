import { createHash } from "node:crypto";
import {
  getCompetitor,
  getCompetitorsByRun,
  getJob,
  getRecreateOnlyPagesByRun,
  getSearchCompetitorAdsByRun,
  saveCompetitor,
} from "../db";
import type { CompetitorRecord, SearchCompetitorAdRecord } from "../types";
import { landingPageMatchKey } from "./sameLandingPageAds";

/**
 * Recreate any landing page from a search's offers dashboard. The Recreate
 * page works on a competitor record, so a landing page is matched to the
 * competitor whose analysed page it already is; otherwise a record is held
 * for that page alone (marked recreateOnly, so competitor lists, counts and
 * exports leave it out). It lives in the same search, so the client's brand,
 * access and billing are the search's own.
 */

function pageRecordId(runId: string, matchKey: string): string {
  return `lp-${createHash("sha1").update(`${runId}|${matchKey}`).digest("hex").slice(0, 16)}`;
}

function normalizedUrl(url: string): string {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** The record (found competitor or held page) for a landing page in a search, if one exists. */
export function findLandingPageRecord(runId: string, url: string): CompetitorRecord | null {
  const key = landingPageMatchKey(url);
  if (!key) return null;
  const held = getCompetitor(pageRecordId(runId, key));
  if (held) return held;
  return (
    // The competitor's analysed page (after redirects) or its ad's destination.
    getCompetitorsByRun(runId).find(
      (c) => landingPageMatchKey(c.pageAnalysis?.analyzedUrl) === key || landingPageMatchKey(c.sampleAd?.landingPageUrl) === key,
    ) || null
  );
}

/** Every landing page in a search that already has a record, by match key. */
export function landingPageRecordsByKey(runId: string): Map<string, CompetitorRecord> {
  const out = new Map<string, CompetitorRecord>();
  for (const c of getCompetitorsByRun(runId)) {
    for (const url of [c.sampleAd?.landingPageUrl, c.pageAnalysis?.analyzedUrl]) {
      const key = landingPageMatchKey(url);
      if (key && !out.has(key)) out.set(key, c);
    }
  }
  // A page held for recreation wins: it is the record the dashboard opened.
  for (const c of getRecreateOnlyPagesByRun(runId)) {
    if (c.recreateOnly?.matchKey) out.set(c.recreateOnly.matchKey, c);
  }
  return out;
}

/** The record to analyse and recreate this landing page with, created if needed. */
export function ensureLandingPageRecord(runId: string, rawUrl: string): { competitor: CompetitorRecord; created: boolean } {
  const job = getJob(runId);
  if (!job) throw new Error("Search not found");
  const url = normalizedUrl(rawUrl);
  const key = landingPageMatchKey(url);
  if (!key) throw new Error("This landing page address could not be read.");

  const existing = findLandingPageRecord(runId, url);
  if (existing) return { competitor: existing, created: false };

  // The ads pointing at this page tell us whose page it is.
  const ads: SearchCompetitorAdRecord[] = getSearchCompetitorAdsByRun(runId).filter(
    (ad) => landingPageMatchKey(ad.landingPageUrl) === key,
  );
  const sample = ads[0] || null;
  const owner = sample?.competitorId ? getCompetitor(sample.competitorId) : null;
  let host = key;
  try {
    host = new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    /* keep the key */
  }

  const record: CompetitorRecord = {
    id: pageRecordId(runId, key),
    runId,
    pageId: `lp-page-${pageRecordId(runId, key)}`,
    pageName: owner?.pageName || sample?.pageName || host,
    country: owner?.country || sample?.country || "ALL",
    platform: owner?.platform || sample?.platform || job.platform,
    activeAdsCount: Math.max(1, ads.length),
    services: [],
    sampleAd: {
      adArchiveId: sample?.adArchiveId || "",
      title: sample?.title || "",
      body: sample?.body || "",
      daysRunning: sample?.daysRunning ?? -1,
      adLibraryUrl: sample?.adLibraryUrl || "",
      ctaText: sample?.ctaText || null,
      landingPageUrl: url,
      format: sample?.format || null,
      imageUrl: sample?.imageUrl || null,
      videoUrl: sample?.videoUrl || null,
      youtubeUrl: sample?.youtubeUrl || null,
      domain: sample?.domain || host,
      visibleUrl: sample?.visibleUrl || null,
      startDate: sample?.startDateString || null,
      endDate: sample?.endDateString || null,
      impressions: sample?.impressions || null,
      advertiserPageUrl: sample?.advertiserPageUrl || null,
    },
    brand: { website: owner?.brand?.website || null, category: owner?.brand?.category || null },
    pageAnalysis: null,
    recreatedPage: null,
    createdAt: new Date().toISOString(),
    recreateOnly: { sourceUrl: url, matchKey: key, fromCompetitorId: owner?.id || null },
  };
  if (!saveCompetitor(record)) throw new Error("The landing page could not be saved for recreation.");
  return { competitor: getCompetitor(record.id) || record, created: true };
}
