import type { LinkedInAd, GoogleAdCreative } from "../sociavault/client";
import type { AdCandidate, CompetitorRecord } from "../types";
import { daysFromDateRange, linkedInDaysRunning } from "../platforms";

type SampleAd = CompetitorRecord["sampleAd"];

function cleanStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/** Prefer creatives with CTA, landing URL, known duration, then richest copy. */
export function scoreLinkedInAd(c: AdCandidate): number {
  let score = (c.fullText?.length || 0) / 100;
  if (c.ctaText) score += 40;
  if (c.landingPageUrl) score += 40;
  if (c.daysRunning >= 0) score += 25;
  if (c.title) score += 10;
  return score;
}

export function pickBestLinkedInCandidate(ads: AdCandidate[]): AdCandidate {
  return [...ads].sort((a, b) => scoreLinkedInAd(b) - scoreLinkedInAd(a))[0];
}

export function mapLinkedInAdToCandidate(ad: LinkedInAd): AdCandidate {
  const title = cleanStr(ad.headline) || "";
  const body = cleanStr(ad.description) || "";
  const timing = linkedInDaysRunning({
    startDate: ad.startDate,
    endDate: ad.endDate,
    adDuration: ad.adDuration,
  });
  const cta = cleanStr(ad.cta);
  const landing = cleanStr(ad.destinationUrl);
  const pageId = cleanStr(ad.advertiserLinkedinPage) ||
    cleanStr(ad.advertiser) ||
    cleanStr(ad.poster) ||
    "";

  return {
    adArchiveId: cleanStr(ad.id) || cryptoRandom(),
    pageId,
    pageName: cleanStr(ad.advertiser) || cleanStr(ad.poster) || "Unknown",
    pageProfileUri: cleanStr(ad.advertiserLinkedinPage),
    isActive: true,
    startDateString: timing.start,
    endDateString: timing.end,
    daysRunning: timing.days,
    title,
    body,
    fullText: [title, body, cta, landing, ad.adType, ad.adDuration]
      .filter(Boolean)
      .join("\n"),
    ctaText: cta,
    landingPageUrl: landing,
    snapshot: ad as Record<string, unknown>,
  };
}

export function sampleAdFromLinkedInCandidate(c: AdCandidate): SampleAd {
  const raw = (c.snapshot || {}) as LinkedInAd;
  return {
    adArchiveId: c.adArchiveId,
    title: c.title,
    body: (c.body || c.fullText || "").slice(0, 800),
    daysRunning: c.daysRunning,
    adLibraryUrl:
      cleanStr(raw.url) ||
      `https://www.linkedin.com/ad-library/detail/${c.adArchiveId}`,
    ctaText: c.ctaText ?? null,
    landingPageUrl: c.landingPageUrl ?? null,
    format: cleanStr(raw.adType),
    imageUrl: cleanStr(raw.image),
    videoUrl: cleanStr(raw.video),
    startDate: c.startDateString ?? null,
    endDate: c.endDateString ?? null,
    impressions: cleanStr(raw.totalImpressions),
    advertiserPageUrl: cleanStr(raw.advertiserLinkedinPage) || c.pageProfileUri,
  };
}

export function mapGoogleCreativeToCandidate(
  ad: GoogleAdCreative,
  details?: {
    title?: string;
    body?: string;
    cta?: string | null;
    landing?: string | null;
    youtubeUrl?: string | null;
    visibleUrl?: string | null;
    firstShown?: string | null;
    lastShown?: string | null;
    format?: string | null;
  },
): AdCandidate {
  const title = cleanStr(details?.title) || "";
  const body = cleanStr(details?.body) || "";
  const first = details?.firstShown || ad.firstShown || null;
  const last = details?.lastShown || ad.lastShown || null;
  const daysRunning = daysFromDateRange(first, last);
  const landing = cleanStr(details?.landing);
  const youtubeUrl = cleanStr(details?.youtubeUrl);

  return {
    adArchiveId: cleanStr(ad.creativeId) || cryptoRandom(),
    pageId: cleanStr(ad.advertiserId) || "",
    pageName: cleanStr(ad.advertiserName) || "Unknown",
    isActive: true,
    startDateString: first ? String(first) : null,
    endDateString: last ? String(last) : null,
    daysRunning,
    title,
    body,
    fullText: [title, body, landing, youtubeUrl, details?.visibleUrl, ad.domain]
      .filter(Boolean)
      .join("\n"),
    ctaText: cleanStr(details?.cta),
    landingPageUrl: landing || youtubeUrl,
    snapshot: {
      ...ad,
      _details: details,
    } as Record<string, unknown>,
  };
}

export function sampleAdFromGoogleCandidate(
  c: AdCandidate,
  platform: "google" | "youtube",
  domainHint?: string | null,
): SampleAd {
  const raw = (c.snapshot || {}) as GoogleAdCreative & {
    _details?: {
      youtubeUrl?: string | null;
      visibleUrl?: string | null;
      format?: string | null;
    };
  };
  const details = raw._details;
  const creativeYt = cleanStr(details?.youtubeUrl);
  const ytOnly =
    creativeYt &&
    (/youtube\.com|youtu\.be/i.test(creativeYt) ? creativeYt : null);

  const advertiserId = cleanStr(raw.advertiserId) || c.pageId;
  const creativeId = cleanStr(raw.creativeId) || c.adArchiveId;
  const transparencyUrl =
    cleanStr(raw.adUrl) ||
    (advertiserId && creativeId
      ? `https://adstransparency.google.com/advertiser/${advertiserId}/creative/${creativeId}`
      : advertiserId
        ? `https://adstransparency.google.com/advertiser/${advertiserId}`
        : "");

  // Landing must be a real destination — never the transparency URL or a guessed social
  let landing = cleanStr(c.landingPageUrl);
  if (
    landing &&
    (/adstransparency\.google\.com/i.test(landing) ||
      /facebook\.com|fb\.com/i.test(landing))
  ) {
    landing = null;
  }
  // For youtube platform, landing can be the video URL
  if (platform === "youtube" && !landing && ytOnly) {
    landing = ytOnly;
  }

  return {
    adArchiveId: c.adArchiveId,
    title: c.title,
    body: (c.body || c.fullText || "").slice(0, 800),
    daysRunning: c.daysRunning,
    adLibraryUrl: transparencyUrl,
    ctaText: c.ctaText ?? null,
    landingPageUrl: landing,
    format: cleanStr(details?.format) || cleanStr(raw.format),
    imageUrl: cleanStr(raw.imageUrl),
    youtubeUrl: ytOnly,
    domain: cleanStr(raw.domain) || cleanStr(domainHint) || null,
    visibleUrl: cleanStr(details?.visibleUrl),
    startDate: c.startDateString ?? null,
    endDate: c.endDateString ?? null,
  };
}

function cryptoRandom() {
  return `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
