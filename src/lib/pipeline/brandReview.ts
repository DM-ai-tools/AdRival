import { v4 as uuidv4 } from "uuid";
import {
  getFacebookProfile,
  getInstagramProfile,
  getLinkedInCompany,
  getTwitterProfile,
  getYoutubeChannel,
} from "../sociavault/client";
import { firecrawlScrapeBranding, hasFirecrawlKey } from "../firecrawl/client";
import {
  detectSocialNetwork,
  extractBrandAssetsFromHtml,
} from "./brandAssets";
import { normalizeWebsiteUrl } from "./linkGuards";
import {
  extractInstagramHandle,
  extractTwitterHandle,
  extractYouTubeParams,
  normalizeLinkedInCompanyUrl,
  parseYouTubeFromUrl,
  socialLinksToSociavaultParams,
  type SociavaultSocialParams,
} from "./socialParams";
import {
  getCompetitorsByRun,
  getJob,
  isSearchJobSuppressed,
  saveJob,
  updateCompetitor,
} from "../db";
import type { BrandReview, CompetitorRecord, SearchJob } from "../types";

export { normalizeLinkedInCompanyUrl, parseYouTubeFromUrl };

function safeNum(n: unknown): number | null {
  if (typeof n === "number" && Number.isFinite(n)) return n;
  if (typeof n === "string" && n.trim() && !Number.isNaN(Number(n))) {
    return Number(n);
  }
  return null;
}

async function collectSocialHrefsFromWebsite(
  website: string,
): Promise<string[]> {
  const hrefs: string[] = [];
  if (!hasFirecrawlKey()) return hrefs;

  try {
    const scraped = await firecrawlScrapeBranding(website);
    const data = scraped.data;
    for (const raw of data?.links || []) {
      if (typeof raw === "string" && detectSocialNetwork(raw)) {
        hrefs.push(raw);
      }
    }
    if (data?.html) {
      const assets = extractBrandAssetsFromHtml(data.html, website);
      for (const s of assets.socialLinks || []) {
        if (s.href) hrefs.push(s.href);
      }
    }
  } catch (err) {
    console.warn(
      "[brandReview] Firecrawl branding scrape failed:",
      (err as Error).message,
    );
  }

  return Array.from(new Set(hrefs));
}

function mergeParams(
  ...parts: SociavaultSocialParams[]
): SociavaultSocialParams {
  const out: SociavaultSocialParams = {};
  for (const p of parts) {
    if (p.facebook && !out.facebook) out.facebook = p.facebook;
    if (p.instagram && !out.instagram) out.instagram = p.instagram;
    if (p.twitter && !out.twitter) out.twitter = p.twitter;
    if (p.youtube && !out.youtube) out.youtube = p.youtube;
    if (p.linkedin && !out.linkedin) out.linkedin = p.linkedin;
  }
  return out;
}

async function fetchMetricsFromParams(
  params: SociavaultSocialParams,
  brand: BrandReview,
): Promise<void> {
  if (params.facebook?.url) {
    brand.facebookUrl = params.facebook.url;
    try {
      const fb = await getFacebookProfile(params.facebook.url);
      brand.facebookUrl = fb.data?.url || params.facebook.url;
      brand.facebookFollowers = safeNum(fb.data?.followerCount);
      brand.facebookLikes = safeNum(fb.data?.likeCount);
      brand.category = fb.data?.category || brand.category;
      if (!brand.website && fb.data?.website) {
        brand.website = normalizeWebsiteUrl(fb.data.website);
      }
    } catch {
      // keep url present; metrics stay null → UI shows Unavailable
    }
  }

  if (params.instagram?.handle) {
    brand.instagramHandle = params.instagram.handle;
    try {
      const ig = await getInstagramProfile(params.instagram.handle);
      brand.instagramFollowers = safeNum(
        ig.data?.data?.user?.edge_followed_by?.count,
      );
      if (!brand.website && ig.data?.data?.user?.external_url) {
        brand.website = normalizeWebsiteUrl(ig.data.data.user.external_url);
      }
    } catch {
      /* leave null */
    }
  }

  if (params.twitter?.handle) {
    brand.twitterHandle = params.twitter.handle;
    try {
      const tw = await getTwitterProfile(params.twitter.handle);
      brand.twitterFollowers = safeNum(tw.data?.legacy?.followers_count);
      if (tw.data?.core?.screen_name) {
        brand.twitterHandle = String(tw.data.core.screen_name).replace(
          /^@/,
          "",
        );
      }
    } catch {
      /* leave null */
    }
  }

  if (
    params.youtube &&
    (params.youtube.channelId || params.youtube.handle || params.youtube.url)
  ) {
    brand.youtubeHandle = params.youtube.handle || brand.youtubeHandle;
    brand.youtubeUrl = params.youtube.url || brand.youtubeUrl;
    try {
      const yt = await getYoutubeChannel({
        channelId: params.youtube.channelId,
        handle: params.youtube.handle,
        url: params.youtube.url,
      });
      brand.youtubeSubscribers = safeNum(yt.data?.subscriberCount);
      brand.youtubeUrl =
        (yt.data?.url as string | undefined) ||
        (yt.data?.channel as string | undefined) ||
        brand.youtubeUrl;
      if (yt.data?.handle) {
        brand.youtubeHandle = String(yt.data.handle).replace(/^@/, "");
      }
    } catch {
      /* leave null */
    }
  }

  if (params.linkedin?.url) {
    brand.linkedinUrl = params.linkedin.url;
    try {
      const li = await getLinkedInCompany(params.linkedin.url);
      brand.linkedinUrl = li.data?.url ? String(li.data.url) : params.linkedin.url;
      brand.linkedinEmployees = safeNum(li.data?.employeeCount);
      brand.linkedinFollowers = safeNum(li.data?.followers);
      if (!brand.website && li.data?.website) {
        brand.website = normalizeWebsiteUrl(
          typeof li.data.website === "string" ? li.data.website : null,
        );
      }
    } catch {
      /* leave null */
    }
  }
}

/**
 * Brand review for one competitor:
 * 1) Firecrawl Branding API → social links from website
 * 2) Normalize to Sociavault query params
 * 3) Fetch followers / likes / LinkedIn employees + followers
 *
 * Missing socials stay null (UI renders "Not present").
 */
export async function runBrandReview(input: {
  pageId: string;
  pageName: string;
  pageProfileUri?: string | null;
  websiteHint?: string | null;
  linkedinUrlHint?: string | null;
  youtubeUrlHint?: string | null;
  youtubeHandleHint?: string | null;
  instagramHandleHint?: string | null;
  facebookUrlHint?: string | null;
  twitterHandleHint?: string | null;
  categoryHint?: string | null;
  sourcePlatform?: import("../platforms").AdPlatform | string;
}): Promise<BrandReview> {
  const brand: BrandReview = {
    website: normalizeWebsiteUrl(input.websiteHint) || null,
    category: input.categoryHint || null,
  };

  const hintParams = socialLinksToSociavaultParams([
    input.facebookUrlHint,
    input.pageProfileUri,
    input.linkedinUrlHint,
    input.youtubeUrlHint,
  ]);
  if (input.instagramHandleHint) {
    const ig = extractInstagramHandle(input.instagramHandleHint);
    if (ig) hintParams.instagram = { handle: ig };
  }
  if (input.twitterHandleHint) {
    const tw = extractTwitterHandle(input.twitterHandleHint);
    if (tw) hintParams.twitter = { handle: tw };
  }
  if (input.youtubeHandleHint && !hintParams.youtube) {
    hintParams.youtube = extractYouTubeParams(input.youtubeHandleHint);
  }

  // Meta numeric page ids → facebook.com/{id}
  if (
    !hintParams.facebook &&
    input.sourcePlatform !== "google" &&
    input.sourcePlatform !== "youtube" &&
    input.sourcePlatform !== "linkedin" &&
    String(input.pageId).match(/^\d+$/)
  ) {
    hintParams.facebook = {
      url: `https://www.facebook.com/${input.pageId}`,
    };
  }

  let firecrawlParams: SociavaultSocialParams = {};
  if (brand.website) {
    const hrefs = await collectSocialHrefsFromWebsite(brand.website);
    firecrawlParams = socialLinksToSociavaultParams(hrefs);
  }

  // Prefer Firecrawl-discovered links; fill gaps from ad/platform hints
  const params = mergeParams(firecrawlParams, hintParams);

  // Google/YouTube: only keep Facebook when Firecrawl found it on the website
  if (
    input.sourcePlatform === "google" ||
    input.sourcePlatform === "youtube"
  ) {
    params.facebook = firecrawlParams.facebook || null;
  }

  await fetchMetricsFromParams(params, brand);

  brand.website = normalizeWebsiteUrl(brand.website);
  return brand;
}

/** Run brand review for every competitor in a finished search job. */
export async function runBrandReviewForJob(
  jobId: string,
  options?: { force?: boolean },
): Promise<{ updated: number; skipped: number }> {
  if (isSearchJobSuppressed(jobId)) {
    return { updated: 0, skipped: 0 };
  }
  const job = getJob(jobId);
  if (!job) return { updated: 0, skipped: 0 };

  const competitors = getCompetitorsByRun(jobId);
  let updated = 0;
  let skipped = 0;

  const total = competitors.length;
  job.progress.stage = "brand_review";
  job.progress.brandReviewDone = 0;
  job.progress.brandReviewTotal = total;
  job.progress.brandReviewCurrentName = null;
  job.progress.message = `Brand review starting for ${total} competitors…`;
  job.updatedAt = new Date().toISOString();
  if (!saveJob(job)) return { updated: 0, skipped: 0 };

  for (let i = 0; i < competitors.length; i++) {
    if (isSearchJobSuppressed(jobId)) break;
    const c = competitors[i];
    const alreadyDone =
      !options?.force &&
      Boolean(
        c.brand?.facebookUrl ||
          c.brand?.instagramHandle ||
          c.brand?.twitterHandle ||
          c.brand?.youtubeUrl ||
          c.brand?.linkedinUrl ||
          c.brand?.facebookFollowers != null ||
          c.brand?.instagramFollowers != null ||
          c.brand?.linkedinEmployees != null,
      );
    // Still re-run when force; otherwise skip rows that already have social metrics
    if (alreadyDone && hasAnySocialMetric(c.brand) && !options?.force) {
      skipped += 1;
      job.progress.brandReviewDone = i + 1;
      job.progress.brandReviewCurrentName = c.pageName;
      job.progress.message = `Brand review ${i + 1}/${total}: ${c.pageName} (skipped — already has metrics)`;
      job.updatedAt = new Date().toISOString();
      saveJob(job);
      continue;
    }

    job.progress.brandReviewDone = i;
    job.progress.brandReviewTotal = total;
    job.progress.brandReviewCurrentName = c.pageName;
    job.progress.message = `Brand review ${i + 1}/${total}: ${c.pageName}…`;
    job.updatedAt = new Date().toISOString();
    saveJob(job);

    try {
      const brand = await runBrandReview({
        pageId: c.pageId,
        pageName: c.pageName,
        pageProfileUri:
          c.sampleAd?.advertiserPageUrl || c.brand?.facebookUrl || null,
        websiteHint: c.brand?.website || c.sampleAd?.landingPageUrl || null,
        linkedinUrlHint: c.brand?.linkedinUrl || null,
        youtubeUrlHint: c.brand?.youtubeUrl || c.sampleAd?.youtubeUrl || null,
        youtubeHandleHint: c.brand?.youtubeHandle || null,
        instagramHandleHint: c.brand?.instagramHandle || null,
        facebookUrlHint: c.brand?.facebookUrl || null,
        twitterHandleHint: c.brand?.twitterHandle || null,
        categoryHint: c.brand?.category || null,
        sourcePlatform: c.platform,
      });
      updateCompetitor(c.id, { brand });
      updated += 1;
    } catch (err) {
      console.warn(
        "[brandReview] failed for",
        c.pageName,
        (err as Error).message,
      );
    }

    job.progress.brandReviewDone = i + 1;
    job.progress.brandReviewCurrentName = c.pageName;
    job.progress.message = `Brand review ${i + 1}/${total}: ${c.pageName} done`;
    job.updatedAt = new Date().toISOString();
    saveJob(job);
  }

  const fresh = getJob(jobId);
  if (fresh && !isSearchJobSuppressed(jobId)) {
    fresh.progress.stage = "done";
    fresh.progress.brandReviewDone = total;
    fresh.progress.brandReviewTotal = total;
    fresh.progress.brandReviewCurrentName = null;
    fresh.progress.message =
      fresh.status === "failed"
        ? fresh.progress.message
        : `Found ${competitors.length} competitors · brand review ${updated} updated` +
          (skipped ? ` · ${skipped} skipped` : "");
    fresh.updatedAt = new Date().toISOString();
    saveJob(fresh);
  }

  return { updated, skipped };
}

function hasAnySocialMetric(brand: BrandReview | undefined): boolean {
  if (!brand) return false;
  return (
    brand.facebookFollowers != null ||
    brand.facebookLikes != null ||
    brand.instagramFollowers != null ||
    brand.twitterFollowers != null ||
    brand.youtubeSubscribers != null ||
    brand.linkedinEmployees != null ||
    brand.linkedinFollowers != null
  );
}

/** Enrich a single competitor (history redo). */
export async function runBrandReviewForCompetitor(
  competitor: CompetitorRecord,
): Promise<BrandReview> {
  const brand = await runBrandReview({
    pageId: competitor.pageId,
    pageName: competitor.pageName,
    pageProfileUri:
      competitor.sampleAd?.advertiserPageUrl ||
      competitor.brand?.facebookUrl ||
      null,
    websiteHint:
      competitor.brand?.website ||
      competitor.sampleAd?.landingPageUrl ||
      null,
    linkedinUrlHint: competitor.brand?.linkedinUrl || null,
    youtubeUrlHint:
      competitor.brand?.youtubeUrl ||
      competitor.sampleAd?.youtubeUrl ||
      null,
    youtubeHandleHint: competitor.brand?.youtubeHandle || null,
    instagramHandleHint: competitor.brand?.instagramHandle || null,
    facebookUrlHint: competitor.brand?.facebookUrl || null,
    twitterHandleHint: competitor.brand?.twitterHandle || null,
    categoryHint: competitor.brand?.category || null,
    sourcePlatform: competitor.platform,
  });
  updateCompetitor(competitor.id, { brand });
  return brand;
}

export function newId() {
  return uuidv4();
}

/** Patch job progress while batch brand-reviewing (exported for pipelines). */
export function markJobBrandReviewing(job: SearchJob, message: string) {
  job.progress.stage = "brand_review";
  job.progress.message = message;
  job.updatedAt = new Date().toISOString();
  saveJob(job);
}
