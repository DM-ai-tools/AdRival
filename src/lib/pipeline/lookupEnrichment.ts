import {
  getFacebookProfile,
  getInstagramProfile,
  getLinkedInCompany,
  getYoutubeChannel,
  normalizeList,
  searchCompanies,
} from "../sociavault/client";
import type { LookupPageCandidate } from "../types";
import type { AdPlatform } from "../platforms";
import {
  normalizeLinkedInCompanyUrl,
  parseYouTubeFromUrl,
} from "./brandReview";

function safeNum(n: unknown): number | null {
  if (typeof n === "number" && Number.isFinite(n)) return n;
  if (typeof n === "string" && n.trim() && !Number.isNaN(Number(n))) {
    return Number(n);
  }
  return null;
}

/**
 * Fill FB likes / IG followers (and related profile fields) for a lookup match.
 * Meta lookups already get some of this from search-companies; Google/YouTube/
 * LinkedIn need an extra Meta company + profile pass.
 */
export async function enrichLookupPageMetrics(
  candidate: LookupPageCandidate,
  opts?: {
    platform?: AdPlatform | string;
    websiteHint?: string | null;
    linkedinUrlHint?: string | null;
  },
): Promise<LookupPageCandidate> {
  const next: LookupPageCandidate = { ...candidate };
  const platform = opts?.platform;
  const isMeta = platform === "facebook" || platform === "instagram";
  const isLinkedIn = platform === "linkedin";

  // 1) Meta Ad Library company search → likes + IG handle/followers
  try {
    const companies = await searchCompanies(next.name);
    const results = normalizeList<{
      page_id?: string;
      name?: string;
      category?: string;
      likes?: number | string;
      verification?: string;
      ig_username?: string;
      ig_followers?: number | string;
      page_alias?: string;
      image_uri?: string;
    }>(companies.data?.searchResults);

    const needle = next.name.toLowerCase().trim();
    const match =
      (String(next.pageId).match(/^\d+$/)
        ? results.find((c) => String(c.page_id) === String(next.pageId))
        : null) ??
      results.find((c) => (c.name || "").toLowerCase().trim() === needle) ??
      results.find((c) =>
        (c.name || "").toLowerCase().includes(needle.split(/\s+/)[0] || needle),
      ) ??
      null;

    if (match) {
      if (next.likes == null) next.likes = safeNum(match.likes);
      if (!next.igUsername && match.ig_username) {
        next.igUsername = String(match.ig_username).replace(/^@/, "");
      }
      if (next.igFollowers == null) {
        next.igFollowers = safeNum(match.ig_followers);
      }
      if (!next.category && match.category) next.category = match.category;
      if (!next.verification && match.verification) {
        next.verification = match.verification;
      }
      if (!next.pageAlias && match.page_alias) {
        next.pageAlias = match.page_alias;
      }
      if (!next.imageUri && match.image_uri) {
        next.imageUri = match.image_uri;
      }
      // Remember Meta page id for profile fetch
      if (match.page_id && !next.raw?.metaPageId) {
        next.raw = {
          ...(next.raw || {}),
          metaPageId: String(match.page_id),
        };
      }
    }
  } catch {
    // continue
  }

  // 2) Facebook profile endpoint for likes / followers
  const metaPageId =
    (next.raw?.metaPageId != null ? String(next.raw.metaPageId) : null) ||
    (String(next.pageId).match(/^\d+$/) ? String(next.pageId) : null);
  const fbUrl = metaPageId
    ? `https://www.facebook.com/${metaPageId}`
    : next.pageAlias
      ? `https://www.facebook.com/${next.pageAlias}`
      : null;

  if (fbUrl && (isMeta || next.likes == null || next.igFollowers == null)) {
    try {
      const fb = await getFacebookProfile(fbUrl);
      const likes = safeNum(fb.data?.likeCount);
      const followers = safeNum(fb.data?.followerCount);
      if (likes != null) next.likes = likes;
      if (followers != null && next.likes == null) next.likes = followers;
      if (fb.data?.category && !next.category) next.category = fb.data.category;
      next.raw = {
        ...(next.raw || {}),
        facebookUrl: fb.data?.url || fbUrl,
        facebookFollowers: followers,
      };
    } catch {
      // ignore
    }
  }

  // 3) Instagram profile endpoint when we have a handle
  if (next.igUsername) {
    try {
      const ig = await getInstagramProfile(next.igUsername.replace(/^@/, ""));
      const followers = safeNum(
        ig.data?.data?.user?.edge_followed_by?.count,
      );
      if (followers != null) next.igFollowers = followers;
    } catch {
      // ignore
    }
  }

  // 4) LinkedIn company metrics when we have a real company URL
  const liUrl =
    normalizeLinkedInCompanyUrl(opts?.linkedinUrlHint) ||
    normalizeLinkedInCompanyUrl(
      next.raw?.advertiserPageUrl != null
        ? String(next.raw.advertiserPageUrl)
        : null,
    ) ||
    normalizeLinkedInCompanyUrl(
      next.raw?.linkedinUrl != null ? String(next.raw.linkedinUrl) : null,
    );

  if (liUrl) {
    try {
      const li = await getLinkedInCompany(liUrl);
      const followers = safeNum(li.data?.followers);
      const employees = safeNum(li.data?.employeeCount);
      next.raw = {
        ...(next.raw || {}),
        linkedinUrl: liUrl,
        linkedinFollowers: followers,
        linkedinEmployees: employees,
      };
      if (isLinkedIn && next.likes == null && followers != null) {
        next.likes = followers;
      }
    } catch {
      // ignore
    }
  }

  // 5) YouTube subscribers when we have a channel hint
  const ytHint =
    (next.raw?.youtubeUrl != null ? String(next.raw.youtubeUrl) : null) ||
    null;
  const yt = parseYouTubeFromUrl(ytHint);
  if (yt?.handle || yt?.channelId || yt?.url) {
    try {
      const channel = await getYoutubeChannel({
        handle: yt.handle,
        channelId: yt.channelId,
        url: yt.url,
      });
      const subs = safeNum(channel.data?.subscriberCount);
      if (subs != null) {
        next.raw = { ...(next.raw || {}), youtubeSubscribers: subs };
      }
    } catch {
      // ignore
    }
  }

  return next;
}
