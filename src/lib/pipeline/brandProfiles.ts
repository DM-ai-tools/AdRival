import {
  getFacebookProfile,
  getInstagramProfile,
  getLinkedInCompany,
  getTwitterProfile,
  getYoutubeChannel,
} from "../sociavault/client";
import { normalizeWebsiteUrl } from "./linkGuards";
import {
  extractFacebookUrl,
  extractInstagramHandle,
  extractLinkedInCompanyUrl,
  extractTwitterHandle,
  extractYouTubeParams,
} from "./socialParams";
import type { BrandReview, SocialPlatform } from "../types";

/**
 * One brand's account on one platform: where the link came from, and what
 * SociaVault says about it. Brand review tries a platform's candidates in
 * order of trust until one returns a real follower count.
 */

/**
 * Where a candidate account came from, most trusted first:
 * ad — the advertiser's own page on the ad platform;
 * site — linked from the brand's own website;
 * profile — linked from one of the brand's own profiles;
 * previous — found by an earlier brand review;
 * search — found by web search;
 * guess — built from the domain name (LinkedIn only).
 */
export type CandidateSource = "ad" | "site" | "profile" | "previous" | "search" | "guess";

export type Candidate = { platform: SocialPlatform; value: string; source: CandidateSource };

/** Sources that need the profile itself to show it is this brand's. */
export const NEEDS_PROOF: ReadonlySet<CandidateSource> = new Set(["previous", "search", "guess"]);

export type FetchedProfile = {
  /** The follower (or subscriber / employee) count; null when SociaVault gave none. */
  count: number | null;
  /** Fields to store on the brand review when this candidate is used. */
  fields: Partial<BrandReview>;
  /** The profile's display name and handle, for matching to the brand. */
  names: string[];
  /** The website the profile links to, if any. */
  website: string | null;
  /** Other social links on the profile (bio, about, links section). */
  links: string[];
};

function safeNum(n: unknown): number | null {
  if (typeof n === "number" && Number.isFinite(n)) return Math.round(n);
  if (typeof n === "string" && n.trim()) {
    const cleaned = n.replace(/,/g, "").trim();
    const asNum = Number(cleaned);
    if (!Number.isNaN(asNum) && Number.isFinite(asNum)) return Math.round(asNum);
    const m = cleaned.match(/([\d.]+)\s*([kmb])\b/i);
    if (m) {
      const base = Number(m[1]);
      const mult = m[2].toLowerCase() === "k" ? 1_000 : m[2].toLowerCase() === "m" ? 1_000_000 : 1_000_000_000;
      return Number.isFinite(base) ? Math.round(base * mult) : null;
    }
    const lead = cleaned.match(/^([\d.]+)/);
    if (lead) return Math.round(Number(lead[1]));
  }
  return null;
}

function dig(root: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    let cur: unknown = root;
    for (const key of path) {
      if (!cur || typeof cur !== "object") {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[key];
    }
    if (cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return null;
}

function digNum(root: unknown, paths: string[][]): number | null {
  for (const path of paths) {
    const n = safeNum(dig(root, [path]));
    if (n != null) return n;
  }
  return null;
}

/** Any "...follower..." count in the payload (not "following"), a few levels deep. */
function anyCount(root: unknown, keyPattern: RegExp, depth = 0): number | null {
  if (!root || typeof root !== "object" || depth > 4) return null;
  const obj = root as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (keyPattern.test(key) && !/following|followed_?by_?viewer/i.test(key)) {
      const n = safeNum(value && typeof value === "object" ? (value as { count?: unknown }).count : value);
      if (n != null && n >= 0) return n;
    }
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const n = anyCount(value, keyPattern, depth + 1);
      if (n != null) return n;
    }
  }
  return null;
}

/** SociaVault wraps payloads as { success, data: {...} }, sometimes twice. */
function payload(res: unknown): Record<string, unknown> {
  let cur: unknown = res;
  for (let i = 0; i < 2; i += 1) {
    if (cur && typeof cur === "object" && "data" in (cur as object)) {
      const inner = (cur as { data?: unknown }).data;
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        cur = inner;
        continue;
      }
    }
    break;
  }
  return (cur && typeof cur === "object" ? cur : {}) as Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Social links written in free text (a bio or an about section). */
export function socialUrlsInText(text: string): string[] {
  const out: string[] = [];
  const urlRe = /https?:\/\/(?:www\.)?(?:facebook\.com|fb\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|youtu\.be)[\w./@%+?=&-]*/gi;
  for (const m of text.match(urlRe) || []) out.push(m.split(/["'\s>)\]],/)[0]);
  return out;
}

function linkValues(v: unknown): string[] {
  if (!v) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(linkValues);
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).flatMap(linkValues);
  return [];
}

/** Look up one candidate on SociaVault. Throws when SociaVault fails. */
export async function fetchCandidate(c: Candidate): Promise<FetchedProfile> {
  switch (c.platform) {
    case "facebook": {
      const data = payload(await getFacebookProfile(c.value));
      const followers =
        digNum(data, [["followerCount"], ["followers"], ["follower_count"], ["fan_count"], ["page_followers"]]) ?? anyCount(data, /follower/i);
      const likes = digNum(data, [["likeCount"], ["likes"], ["like_count"]]);
      const website = str(data.website);
      return {
        count: followers ?? likes,
        fields: {
          facebookUrl: str(data.url) || c.value,
          facebookFollowers: followers ?? likes,
          facebookLikes: likes,
          ...(str(data.category) ? { category: str(data.category) } : {}),
          ...(str(data.address) ? { address: str(data.address) } : {}),
        },
        names: [str(data.name), str(data.username)].filter((x): x is string => Boolean(x)),
        website,
        links: [...linkValues(data.links), ...socialUrlsInText([data.pageIntro, data.about, data.website].map((x) => str(x) || "").join("\n"))],
      };
    }
    case "instagram": {
      const data = payload(await getInstagramProfile(c.value));
      const user = (dig(data, [["user"], ["data", "user"]]) || data) as Record<string, unknown>;
      const followers =
        digNum(user, [["edge_followed_by", "count"], ["follower_count"], ["followers_count"], ["followers"], ["followerCount"]]) ??
        anyCount(data, /follow(er|ed_by)/i);
      const username = str(user.username) || c.value;
      const website = str(user.external_url) || str((user as { bio_links?: Array<{ url?: string }> }).bio_links?.[0]?.url);
      return {
        count: followers,
        fields: { instagramHandle: username.replace(/^@/, ""), instagramFollowers: followers },
        names: [str(user.full_name), username].filter((x): x is string => Boolean(x)),
        website,
        links: [...linkValues(user.bio_links), ...socialUrlsInText(String(user.biography || ""))],
      };
    }
    case "twitter": {
      const data = payload(await getTwitterProfile(c.value));
      const legacy = (data.legacy || {}) as Record<string, unknown>;
      const followers =
        digNum(data, [["legacy", "followers_count"], ["followers_count"], ["followers"], ["normal_followers_count"]]) ?? anyCount(data, /follower/i);
      const screen = str((data.core as { screen_name?: string } | undefined)?.screen_name) || str(legacy.screen_name) || c.value;
      const expanded = dig(legacy, [["entities", "url", "urls", "0", "expanded_url"]]);
      return {
        count: followers,
        fields: { twitterHandle: screen.replace(/^@/, ""), twitterFollowers: followers },
        names: [str((data.core as { name?: string } | undefined)?.name), str(legacy.name), screen].filter((x): x is string => Boolean(x)),
        website: str(expanded) || null,
        links: socialUrlsInText(String(legacy.description || "")),
      };
    }
    case "youtube": {
      const params = extractYouTubeParams(c.value) || { url: c.value };
      const data = payload(
        await getYoutubeChannel({ channelId: params.channelId, handle: params.handle?.replace(/^@/, ""), url: params.url }),
      );
      const subscribers = digNum(data, [["subscriberCount"], ["subscribers"], ["subscriber_count"]]) ?? safeNum(data.subscriberCountText);
      const links = [
        ...linkValues(data.links),
        ...["twitter", "instagram", "facebook", "linkedin"].map((k) => str(data[k]) || "").filter(Boolean),
      ];
      return {
        count: subscribers,
        fields: {
          youtubeUrl: str(data.url) || str(data.channel) || params.url || null,
          youtubeHandle: (str(data.handle) || params.handle || "").replace(/^@/, "") || null,
          youtubeSubscribers: subscribers,
        },
        names: [str(data.name), str(data.title), str(data.handle), params.handle || null].filter((x): x is string => Boolean(x)),
        website: links.find((l) => !/facebook|instagram|twitter|x\.com|linkedin|youtube|youtu\.be/i.test(l)) || null,
        links,
      };
    }
    case "linkedin": {
      const data = payload(await getLinkedInCompany(c.value));
      const employees = digNum(data, [["employeeCount"], ["staffCount"], ["employees"], ["employee_count"]]) ?? safeNum(data.size);
      const followers =
        digNum(data, [["followers"], ["followerCount"], ["follower_count"], ["companyFollowers"], ["numFollowers"]]) ?? anyCount(data, /follower/i);
      const loc = data.location;
      const address =
        str(data.headquarters) ||
        (loc && typeof loc === "object"
          ? [(loc as { city?: string }).city, (loc as { state?: string }).state, (loc as { country?: string }).country].filter(Boolean).join(", ") || null
          : str(loc));
      return {
        count: followers ?? employees,
        fields: {
          linkedinUrl: str(data.url) || c.value,
          linkedinEmployees: employees,
          linkedinFollowers: followers,
          ...(address ? { address } : {}),
        },
        names: [str(data.name), str(data.handle), str(data.universalName)].filter((x): x is string => Boolean(x)),
        website: str(data.website),
        links: [],
      };
    }
  }
}

/** Letters and digits only, lower case ("S&A Landscapes" → "salandscapes"). */
export function compact(text: string | null | undefined): string {
  return String(text || "").toLowerCase().replace(/&/g, "").replace(/[^a-z0-9]+/g, "");
}

function siteSlug(site: string | null | undefined): string | null {
  const normalized = site ? normalizeWebsiteUrl(site) : null;
  if (!normalized) return null;
  try {
    const host = new URL(normalized).hostname.replace(/^www\./i, "").toLowerCase();
    const parts = host.split(".");
    if (/\.(com|co|net|org|gov)\.[a-z]{2}$/i.test(host) && parts.length >= 3) return parts[parts.length - 3];
    return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  } catch {
    return null;
  }
}

const LINK_IN_BIO = /^(linktr|linkin|bio|beacons|lnk|taplink|msha|bit|tinyurl|instagram|facebook|wa|api|google|business|sites|youtube|youtu|twitter|x|linkedin|tiktok)$/i;

/**
 * How a profile relates to the brand: does it link to the brand's website
 * ("same"), to another business's ("other"), or to none; and does its name
 * or handle carry the brand's name or domain.
 */
export function profileMatchesBrand(
  profile: Pick<FetchedProfile, "names" | "website">,
  brand: { name: string; website: string | null },
): { site: "same" | "other" | "none"; name: boolean } {
  const ours = siteSlug(brand.website);
  const theirs = siteSlug(profile.website);
  const site = theirs && ours && !LINK_IN_BIO.test(theirs) ? (theirs === ours ? "same" : "other") : "none";
  const keys = [compact(brand.name), ours ? compact(ours) : ""].filter((k) => k.length >= 4);
  const name = profile.names.some((raw) => {
    const n = compact(raw);
    return n.length >= 3 && keys.some((k) => n.includes(k) || (n.length >= 5 && k.includes(n)));
  });
  return { site, name };
}

/** Candidates for every platform found in a list of links. */
export function candidatesFromLinks(links: Array<string | null | undefined>, source: CandidateSource): Candidate[] {
  const out: Candidate[] = [];
  const push = (platform: SocialPlatform, value: string | null | undefined) => {
    if (!value) return;
    if (out.some((c) => c.platform === platform && c.value.toLowerCase() === value.toLowerCase())) return;
    out.push({ platform, value, source });
  };
  for (const link of links) {
    if (!link) continue;
    push("facebook", extractFacebookUrl(link));
    push("instagram", extractInstagramHandle(/[./]/.test(link) ? link : null));
    push("twitter", extractTwitterHandle(/[./]/.test(link) ? link : null));
    const yt = /youtu/i.test(link) ? extractYouTubeParams(link) : null;
    // Channels only: a video or playlist link is not an account.
    if (yt && (yt.handle || yt.channelId || /youtube\.com\/(user|c)\//i.test(link))) push("youtube", yt.url || link);
    push("linkedin", extractLinkedInCompanyUrl(link));
  }
  return out;
}
