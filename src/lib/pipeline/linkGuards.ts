import type { BrandReview } from "../types";
import type { AdPlatform } from "../platforms";

export function isYouTubeUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return (
      u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")
    );
  } catch {
    return false;
  }
}

export function isFacebookUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return (
      u.hostname.includes("facebook.com") || u.hostname.includes("fb.com")
    );
  } catch {
    return false;
  }
}

export function isLinkedInCompanyUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return (
      u.hostname.includes("linkedin.com") &&
      /\/company\//i.test(u.pathname)
    );
  } catch {
    return false;
  }
}

export function isGoogleAdsTransparencyUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.includes("adstransparency.google.com");
  } catch {
    return false;
  }
}

const DIRECTORY_HOST_RE =
  /(^|\.)(clutch\.co|g2\.com|capterra\.com|getapp\.com|softwareadvice\.com|trustpilot\.com|yelp\.com|yellowpages\.|productreview\.com\.au|birdeye\.com|sitejabber\.com|bbb\.org|glassdoor\.com|crunchbase\.com|wikipedia\.org|facebook\.com|fb\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|tiktok\.com|wa\.me|whatsapp\.com|bit\.ly|linktr\.ee|godaddy\.com|wix\.com|squarespace\.com)/i;

/** Directory / social / review sites that must never be the company website. */
export function isDirectoryOrJunkWebsite(url?: string | null): boolean {
  if (!url) return true;
  try {
    const withProto = url.startsWith("http") ? url : `https://${url}`;
    const u = new URL(withProto);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (DIRECTORY_HOST_RE.test(host)) return true;
    if (isYouTubeUrl(withProto)) return true;
    if (isFacebookUrl(withProto)) return true;
    if (isLinkedInCompanyUrl(withProto)) return true;
    if (isGoogleAdsTransparencyUrl(withProto)) return true;
    return false;
  } catch {
    return true;
  }
}

export function normalizeWebsiteUrl(url?: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const withProto = trimmed.startsWith("http")
      ? trimmed
      : `https://${trimmed}`;
    const u = new URL(withProto);
    if (!u.hostname.includes(".")) return null;
    if (isDirectoryOrJunkWebsite(withProto)) return null;
    return withProto;
  } catch {
    return null;
  }
}

/**
 * Drop guessed social links for Google/YouTube advertisers.
 * Keep only: verified website domain, real YouTube creative URLs, and
 * LinkedIn URLs that returned employee/follower metrics.
 */
export function sanitizeBrandForPlatform(
  brand: BrandReview,
  platform: AdPlatform | string,
  opts?: {
    websiteHint?: string | null;
    creativeYoutubeUrl?: string | null;
  },
): BrandReview {
  const next: BrandReview = { ...brand };
  const website =
    normalizeWebsiteUrl(opts?.websiteHint) ||
    normalizeWebsiteUrl(brand.website);
  next.website = website;

  const creativeYt = isYouTubeUrl(opts?.creativeYoutubeUrl)
    ? opts!.creativeYoutubeUrl!
    : null;
  const brandYt = isYouTubeUrl(brand.youtubeUrl) ? brand.youtubeUrl! : null;

  if (platform === "google" || platform === "youtube") {
    // Never keep inventing FB pages for Transparency advertisers
    next.facebookUrl = null;
    next.facebookFollowers = null;
    next.facebookLikes = null;

    // YouTube link: only real youtube.com URLs (prefer creative)
    if (platform === "youtube") {
      next.youtubeUrl = creativeYt || brandYt || null;
      if (!next.youtubeUrl) {
        next.youtubeHandle = null;
        next.youtubeSubscribers = null;
      }
    } else {
      // Google Ads search — don't show a YT channel unless it's the creative's video
      next.youtubeUrl = creativeYt;
      if (!creativeYt) {
        next.youtubeHandle = null;
        next.youtubeSubscribers = null;
      }
    }

    // LinkedIn only if we actually got metrics back (verified fetch)
    if (
      next.linkedinEmployees == null &&
      next.linkedinFollowers == null
    ) {
      next.linkedinUrl = null;
    } else if (!isLinkedInCompanyUrl(next.linkedinUrl)) {
      next.linkedinUrl = null;
      next.linkedinEmployees = null;
      next.linkedinFollowers = null;
    }
  } else if (platform === "linkedin") {
    if (!isLinkedInCompanyUrl(next.linkedinUrl)) {
      // keep advertiser page if provided elsewhere
    }
    // Don't invent FB for LinkedIn-sourced rows unless it's a real FB URL
    if (!isFacebookUrl(next.facebookUrl)) {
      next.facebookUrl = null;
      next.facebookFollowers = null;
      next.facebookLikes = null;
    }
    if (!isYouTubeUrl(next.youtubeUrl)) {
      next.youtubeUrl = null;
      next.youtubeHandle = null;
      next.youtubeSubscribers = null;
    }
  } else {
    // Meta: keep FB only if it looks like facebook
    if (!isFacebookUrl(next.facebookUrl)) {
      next.facebookUrl = null;
    }
    if (!isYouTubeUrl(next.youtubeUrl)) {
      next.youtubeUrl = null;
    }
    if (
      next.linkedinUrl &&
      !isLinkedInCompanyUrl(next.linkedinUrl) &&
      next.linkedinEmployees == null &&
      next.linkedinFollowers == null
    ) {
      next.linkedinUrl = null;
    }
  }

  return next;
}
