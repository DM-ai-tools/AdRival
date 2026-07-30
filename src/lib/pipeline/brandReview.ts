import { v4 as uuidv4 } from "uuid";
import {
  getFacebookProfile,
  getInstagramProfile,
  getLinkedInCompany,
  getTwitterProfile,
  getYoutubeChannel,
  googleSearch,
  normalizeList,
  searchCompanies,
} from "../sociavault/client";
import { resolveSocialIdentifiers } from "../openai/analyzer";
import type { BrandReview } from "../types";
import { normalizeWebsiteUrl } from "./linkGuards";

function safeNum(n: unknown): number | null {
  if (typeof n === "number" && Number.isFinite(n)) return n;
  if (typeof n === "string" && n.trim() && !Number.isNaN(Number(n))) {
    return Number(n);
  }
  return null;
}

/** Normalize any LinkedIn company URL to https://www.linkedin.com/company/{slug} */
export function normalizeLinkedInCompanyUrl(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    if (!u.hostname.includes("linkedin.com")) return null;
    const match = u.pathname.match(/\/company\/([^/?#]+)/i);
    if (!match?.[1]) return null;
    const slug = decodeURIComponent(match[1]).replace(/\/$/, "");
    if (!slug || slug === "company") return null;
    return `https://www.linkedin.com/company/${slug}`;
  } catch {
    return null;
  }
}

export function parseYouTubeFromUrl(url: string | null | undefined): {
  handle?: string;
  channelId?: string;
  url?: string;
} | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    if (!u.hostname.includes("youtube.com") && !u.hostname.includes("youtu.be")) {
      return null;
    }
    const handleMatch = u.pathname.match(/\/@([^/?#]+)/);
    if (handleMatch?.[1]) {
      return {
        handle: handleMatch[1],
        url: `https://www.youtube.com/@${handleMatch[1]}`,
      };
    }
    const channelMatch = u.pathname.match(/\/channel\/(UC[^/?#]+)/);
    if (channelMatch?.[1]) {
      return {
        channelId: channelMatch[1],
        url: `https://www.youtube.com/channel/${channelMatch[1]}`,
      };
    }
    const cMatch = u.pathname.match(/\/c\/([^/?#]+)/);
    if (cMatch?.[1]) {
      return {
        handle: cMatch[1],
        url: `https://www.youtube.com/c/${cMatch[1]}`,
      };
    }
    return { url: u.toString() };
  } catch {
    return null;
  }
}

function slugifyCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function discoverViaGoogle(
  pageName: string,
): Promise<{
  linkedinUrls: string[];
  youtube: ReturnType<typeof parseYouTubeFromUrl>;
  twitterHandle: string | null;
}> {
  const linkedinUrls: string[] = [];
  let youtube: ReturnType<typeof parseYouTubeFromUrl> = null;
  let twitterHandle: string | null = null;

  const queries = [
    `"${pageName}" site:linkedin.com/company`,
    `${pageName} linkedin company`,
    `"${pageName}" (site:twitter.com OR site:x.com)`,
    `${pageName} twitter OR "x.com"`,
    `"${pageName}" site:youtube.com`,
    `${pageName} youtube channel`,
  ];

  for (const q of queries) {
    if (linkedinUrls.length >= 3 && youtube && twitterHandle) break;
    try {
      const res = await googleSearch(q, "US");
      const results = normalizeList<{ url?: string; title?: string }>(
        res.data?.results,
      );
      for (const r of results) {
        const url = r.url || "";
        const li = normalizeLinkedInCompanyUrl(url);
        if (li && !linkedinUrls.includes(li)) linkedinUrls.push(li);
        if (!youtube) {
          const yt = parseYouTubeFromUrl(url);
          if (yt && (yt.handle || yt.channelId || yt.url)) youtube = yt;
        }
        if (!twitterHandle) {
          try {
            const u = new URL(url.startsWith("http") ? url : `https://${url}`);
            if (
              u.hostname.includes("twitter.com") ||
              u.hostname.includes("x.com")
            ) {
              const handle = u.pathname
                .split("/")
                .filter(Boolean)[0]
                ?.replace(/^@/, "");
              if (
                handle &&
                !/^(intent|share|i|home|search|explore)$/i.test(handle)
              ) {
                twitterHandle = handle;
              }
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // continue
    }
  }

  return { linkedinUrls, youtube, twitterHandle };
}

async function fetchLinkedInMetrics(
  urls: Array<string | null | undefined>,
): Promise<{
  url: string | null;
  employees: number | null;
  followers: number | null;
  website: string | null;
}> {
  const tried = new Set<string>();
  for (const raw of urls) {
    const url = normalizeLinkedInCompanyUrl(raw);
    if (!url || tried.has(url)) continue;
    tried.add(url);
    try {
      const li = await getLinkedInCompany(url);
      const employees = safeNum(li.data?.employeeCount);
      const followers = safeNum(li.data?.followers);
      const website = normalizeWebsiteUrl(
        typeof li.data?.website === "string" ? li.data.website : null,
      );
      if (employees != null || followers != null || li.data?.name) {
        return {
          url: li.data?.url ? String(li.data.url) : url,
          employees,
          followers,
          website,
        };
      }
    } catch {
      // try next
    }
  }
  return { url: null, employees: null, followers: null, website: null };
}

export async function runBrandReview(input: {
  pageId: string;
  pageName: string;
  pageProfileUri?: string | null;
  /** Seed values from the ad platform when Meta page lookup isn't available */
  websiteHint?: string | null;
  linkedinUrlHint?: string | null;
  youtubeUrlHint?: string | null;
  youtubeHandleHint?: string | null;
  instagramHandleHint?: string | null;
  categoryHint?: string | null;
  /** When set, avoid inventing cross-platform social links */
  sourcePlatform?: import("../platforms").AdPlatform | string;
}): Promise<BrandReview> {
  const brand: BrandReview = {};
  const isGoogleFamily =
    input.sourcePlatform === "google" || input.sourcePlatform === "youtube";
  const isLinkedInSource = input.sourcePlatform === "linkedin";

  if (input.websiteHint) {
    brand.website = normalizeWebsiteUrl(input.websiteHint);
  }
  if (input.categoryHint) brand.category = input.categoryHint;
  if (input.instagramHandleHint) {
    brand.instagramHandle = input.instagramHandleHint.replace(/^@/, "");
  }
  if (input.linkedinUrlHint) {
    brand.linkedinUrl = normalizeLinkedInCompanyUrl(input.linkedinUrlHint);
  }
  // Only seed YouTube from a real youtube.com / youtu.be URL
  if (input.youtubeUrlHint || input.youtubeHandleHint) {
    const yt = parseYouTubeFromUrl(input.youtubeUrlHint);
    if (yt?.url || yt?.handle || yt?.channelId) {
      brand.youtubeUrl = yt.url || input.youtubeUrlHint || null;
      brand.youtubeHandle =
        input.youtubeHandleHint?.replace(/^@/, "") || yt.handle || null;
    } else if (input.youtubeHandleHint) {
      brand.youtubeHandle = input.youtubeHandleHint.replace(/^@/, "");
    }
  }

  let companyMeta: {
    category?: string | null;
    likes?: number | null;
    ig_username?: string | null;
    ig_followers?: number | null;
  } = {};

  // Meta company search is unreliable for Google Transparency advertiser names —
  // skip it for Google/YouTube to avoid attaching the wrong Facebook page.
  if (!isGoogleFamily) {
    try {
      const companies = await searchCompanies(input.pageName);
      const results = normalizeList<{
        page_id?: string;
        name?: string;
        category?: string;
        likes?: number;
        ig_username?: string;
        ig_followers?: number;
      }>(companies.data?.searchResults);
      const match =
        results.find((c) => String(c.page_id) === String(input.pageId)) ??
        results.find(
          (c) =>
            c.name &&
            c.name.toLowerCase().trim() ===
              input.pageName.toLowerCase().trim(),
        ) ??
        null;
      if (match) {
        companyMeta = {
          category: match.category ?? null,
          likes: safeNum(match.likes),
          ig_username: match.ig_username ?? null,
          ig_followers: safeNum(match.ig_followers),
        };
        brand.category = companyMeta.category || brand.category;
        if (companyMeta.ig_username) {
          brand.instagramHandle =
            brand.instagramHandle || companyMeta.ig_username;
          brand.instagramFollowers = companyMeta.ig_followers;
        }
        if (companyMeta.likes != null) brand.facebookLikes = companyMeta.likes;
      }
    } catch {
      // continue without company metadata
    }
  }

  let website: string | null = brand.website ?? null;
  let pageIntro: string | null = null;

  // Only resolve Facebook when we have a real FB profile URI (not Google advertiser IDs)
  const fbUrl =
    input.pageProfileUri &&
    (input.pageProfileUri.includes("facebook.com") ||
      input.pageProfileUri.includes("fb.com"))
      ? input.pageProfileUri
      : !isGoogleFamily && !isLinkedInSource && String(input.pageId).match(/^\d+$/)
        ? `https://www.facebook.com/${input.pageId}`
        : null;

  if (fbUrl) {
    try {
      const fb = await getFacebookProfile(fbUrl);
      brand.facebookUrl = fb.data?.url || fbUrl;
      brand.facebookFollowers = safeNum(fb.data?.followerCount);
      brand.facebookLikes =
        safeNum(fb.data?.likeCount) ?? brand.facebookLikes ?? null;
      brand.category = fb.data?.category || brand.category;
      website = normalizeWebsiteUrl(fb.data?.website) ?? website;
      pageIntro = fb.data?.pageIntro ?? null;
      brand.website = website;
    } catch {
      // Don't keep a dead/guessed FB URL
      brand.facebookUrl = null;
    }
  }

  // 1) LLM guess — for Google family, only allow website / LinkedIn enrichment
  let ids: {
    facebookUrl?: string | null;
    instagramHandle?: string | null;
    twitterHandle?: string | null;
    youtubeHandle?: string | null;
    youtubeUrl?: string | null;
    youtubeChannelId?: string | null;
    linkedinUrl?: string | null;
    website?: string | null;
  };
  try {
    ids = await resolveSocialIdentifiers({
      pageName: input.pageName,
      pageId: input.pageId,
      pageProfileUri: brand.facebookUrl || input.pageProfileUri,
      website,
      category: brand.category,
      igUsername: brand.instagramHandle || companyMeta.ig_username,
      pageIntro,
    });
  } catch {
    ids = {
      facebookUrl: brand.facebookUrl,
      instagramHandle: brand.instagramHandle,
      website,
      linkedinUrl: brand.linkedinUrl,
      youtubeUrl: brand.youtubeUrl,
      youtubeHandle: brand.youtubeHandle,
    };
  }

  if (!isGoogleFamily) {
    brand.facebookUrl = ids.facebookUrl || brand.facebookUrl;
    brand.instagramHandle = ids.instagramHandle || brand.instagramHandle;
    brand.twitterHandle = ids.twitterHandle || null;
  } else {
    // Never adopt LLM-invented Facebook URLs for Transparency advertisers
    brand.facebookUrl = null;
    brand.twitterHandle = ids.twitterHandle || null;
  }

  // YouTube: only keep parseable youtube URLs (not random landing pages)
  const llmYt = parseYouTubeFromUrl(ids.youtubeUrl);
  if (llmYt?.url) {
    brand.youtubeUrl = brand.youtubeUrl || llmYt.url;
    brand.youtubeHandle = brand.youtubeHandle || llmYt.handle || null;
  } else if (ids.youtubeHandle && !isGoogleFamily) {
    brand.youtubeHandle = ids.youtubeHandle || brand.youtubeHandle;
  }

  brand.linkedinUrl =
    brand.linkedinUrl ||
    normalizeLinkedInCompanyUrl(ids.linkedinUrl) ||
    null;
  const llmWebsite = normalizeWebsiteUrl(ids.website);
  brand.website = normalizeWebsiteUrl(brand.website) || llmWebsite;

  // 2) Always Google-discover LinkedIn (+ X / YouTube as needed)
  const needYt =
    input.sourcePlatform === "youtube" &&
    !(brand.youtubeHandle || brand.youtubeUrl || ids.youtubeChannelId);
  const discovered = await discoverViaGoogle(input.pageName);
  const linkedinCandidates = [
    brand.linkedinUrl,
    ...discovered.linkedinUrls,
    normalizeLinkedInCompanyUrl(ids.linkedinUrl),
  ];
  if (!brand.twitterHandle && discovered.twitterHandle) {
    brand.twitterHandle = discovered.twitterHandle;
  }
  if (needYt && discovered.youtube) {
    brand.youtubeHandle = discovered.youtube.handle || brand.youtubeHandle;
    brand.youtubeUrl = discovered.youtube.url || brand.youtubeUrl;
    if (discovered.youtube.channelId) {
      ids = { ...ids, youtubeChannelId: discovered.youtube.channelId };
    }
  }

  // 3) Slug fallback last — only Meta, and only if discovery failed
  if (
    !linkedinCandidates.some(Boolean) &&
    !isGoogleFamily &&
    !isLinkedInSource
  ) {
    const slug = slugifyCompanyName(input.pageName);
    if (slug.length >= 3) {
      linkedinCandidates.push(`https://www.linkedin.com/company/${slug}`);
    }
  }

  if (brand.instagramHandle && brand.instagramFollowers == null) {
    try {
      const ig = await getInstagramProfile(brand.instagramHandle);
      brand.instagramFollowers = safeNum(
        ig.data?.data?.user?.edge_followed_by?.count,
      );
      if (!brand.website && ig.data?.data?.user?.external_url) {
        brand.website = normalizeWebsiteUrl(ig.data.data.user.external_url);
      }
    } catch {
      // ignore
    }
  }

  if (brand.twitterHandle) {
    try {
      const tw = await getTwitterProfile(brand.twitterHandle);
      brand.twitterFollowers = safeNum(tw.data?.legacy?.followers_count);
      if (tw.data?.core?.screen_name) {
        brand.twitterHandle = String(tw.data.core.screen_name).replace(
          /^@/,
          "",
        );
      }
    } catch {
      console.warn(
        "[brandReview] twitter profile failed for",
        brand.twitterHandle,
      );
    }
  }

  // YouTube metrics — only when we have a real YouTube identity
  const ytHandle = brand.youtubeHandle;
  const ytUrl = parseYouTubeFromUrl(brand.youtubeUrl)?.url || brand.youtubeUrl;
  const ytChannelId = ids.youtubeChannelId;
  const hasYtIdentity = Boolean(
    ytChannelId || ytHandle || parseYouTubeFromUrl(ytUrl || null),
  );
  if (
    hasYtIdentity &&
    (!isGoogleFamily || input.sourcePlatform === "youtube")
  ) {
    try {
      const yt = await getYoutubeChannel({
        channelId: ytChannelId || undefined,
        handle: ytHandle || undefined,
        url: ytUrl || undefined,
      });
      brand.youtubeSubscribers = safeNum(yt.data?.subscriberCount);
      brand.youtubeUrl =
        (yt.data?.url as string | undefined) ||
        (yt.data?.channel as string | undefined) ||
        brand.youtubeUrl;
      if (yt.data?.handle)
        brand.youtubeHandle = String(yt.data.handle).replace(/^@/, "");
    } catch {
      if (ytHandle && ytUrl) {
        try {
          const yt = await getYoutubeChannel({ handle: ytHandle });
          brand.youtubeSubscribers = safeNum(yt.data?.subscriberCount);
          if (yt.data?.handle) {
            brand.youtubeHandle = String(yt.data.handle).replace(/^@/, "");
          }
        } catch {
          // leave null
        }
      }
    }
  }

  // LinkedIn employees — try discovered URLs until one returns metrics
  const li = await fetchLinkedInMetrics(linkedinCandidates);
  if (li.url) {
    brand.linkedinUrl = li.url;
    brand.linkedinEmployees = li.employees;
    brand.linkedinFollowers = li.followers;
    if (!brand.website && li.website) brand.website = li.website;
  } else {
    brand.linkedinUrl = null;
    brand.linkedinEmployees = null;
    brand.linkedinFollowers = null;
    console.warn("[brandReview] LinkedIn company fetch empty for", input.pageName);
  }

  // Final website guard — never keep directories
  brand.website = normalizeWebsiteUrl(brand.website);

  return brand;
}

export function newId() {
  return uuidv4();
}
