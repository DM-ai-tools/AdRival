/**
 * Normalize social URLs / handles into Sociavault query-parameter formats.
 *
 * Instagram: handle
 * Twitter/X: handle
 * YouTube: channelId | handle | url
 * Facebook: full profile/page url
 * LinkedIn company: https://www.linkedin.com/company/{slug}
 */

export type SociavaultSocialParams = {
  facebook?: { url: string } | null;
  instagram?: { handle: string } | null;
  twitter?: { handle: string } | null;
  youtube?: {
    channelId?: string;
    handle?: string;
    url?: string;
  } | null;
  linkedin?: { url: string } | null;
};

const SKIP_TWITTER_PATHS = new Set([
  "intent",
  "share",
  "i",
  "home",
  "search",
  "explore",
  "hashtag",
  "settings",
  "login",
  "signup",
]);

function absolutize(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith("//")) return `https:${t}`;
  return `https://${t.replace(/^\/+/, "")}`;
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

/** Instagram → handle (docs: required `handle`, e.g. "opi") */
export function extractInstagramHandle(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^@/, "");
  if (!trimmed) return null;
  if (!/[./]/.test(trimmed) && /^[a-zA-Z0-9._]{1,30}$/.test(trimmed)) {
    return trimmed;
  }
  try {
    const u = new URL(absolutize(trimmed));
    if (!/instagram\.com|instagr\.am/i.test(u.hostname)) return null;
    const part = u.pathname.split("/").filter(Boolean)[0];
    if (
      !part ||
      /^(p|reel|reels|stories|explore|accounts|tv|direct)$/i.test(part)
    ) {
      return null;
    }
    return part.replace(/^@/, "");
  } catch {
    return null;
  }
}

/** Twitter/X → handle (docs: required `handle`, e.g. "Austen") */
export function extractTwitterHandle(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^@/, "");
  if (!trimmed) return null;
  if (!/[./]/.test(trimmed) && /^[a-zA-Z0-9_]{1,15}$/.test(trimmed)) {
    return trimmed;
  }
  try {
    const u = new URL(absolutize(trimmed));
    const host = u.hostname.replace(/^www\./, "");
    if (!/^(twitter\.com|x\.com)$/i.test(host)) return null;
    const part = u.pathname.split("/").filter(Boolean)[0]?.replace(/^@/, "");
    if (!part || SKIP_TWITTER_PATHS.has(part.toLowerCase())) return null;
    return part;
  } catch {
    return null;
  }
}

/** Facebook → full profile URL (docs: required `url`) */
export function extractFacebookUrl(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  try {
    const u = new URL(absolutize(raw.trim()));
    if (!/facebook\.com|fb\.com|fb\.me/i.test(u.hostname)) return null;
    const path = u.pathname.replace(/\/+$/, "");
    if (!path || path === "/") return null;
    if (/\/(sharer|share|login|dialog)\b/i.test(path)) return null;
    u.hash = "";
    u.search = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** YouTube → channelId / handle / url (docs accept any of these) */
export function extractYouTubeParams(
  raw: string | null | undefined,
): { channelId?: string; handle?: string; url?: string } | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^@/, "");
  if (!trimmed) return null;
  if (!/[./]/.test(trimmed) && /^[A-Za-z0-9._-]{2,}$/.test(trimmed)) {
    return {
      handle: trimmed,
      url: `https://www.youtube.com/@${trimmed}`,
    };
  }
  if (/^UC[\w-]{20,}$/.test(trimmed)) {
    return {
      channelId: trimmed,
      url: `https://www.youtube.com/channel/${trimmed}`,
    };
  }
  const parsed = parseYouTubeFromUrl(trimmed);
  if (!parsed) return null;
  if (!parsed.handle && !parsed.channelId && !parsed.url) return null;
  return {
    channelId: parsed.channelId,
    handle: parsed.handle,
    url: parsed.url,
  };
}

/** LinkedIn company → canonical company URL */
export function extractLinkedInCompanyUrl(
  raw: string | null | undefined,
): string | null {
  return normalizeLinkedInCompanyUrl(raw);
}

/**
 * Map a list of social hrefs (from Firecrawl branding/links) into Sociavault params.
 */
export function socialLinksToSociavaultParams(
  hrefs: Array<string | null | undefined>,
): SociavaultSocialParams {
  const out: SociavaultSocialParams = {};
  for (const href of hrefs) {
    if (!href) continue;
    if (!out.facebook) {
      const fb = extractFacebookUrl(href);
      if (fb) out.facebook = { url: fb };
    }
    if (!out.instagram) {
      const ig = extractInstagramHandle(href);
      if (ig) out.instagram = { handle: ig };
    }
    if (!out.twitter) {
      const tw = extractTwitterHandle(href);
      if (tw) out.twitter = { handle: tw };
    }
    if (!out.youtube) {
      const yt = extractYouTubeParams(href);
      if (yt) out.youtube = yt;
    }
    if (!out.linkedin) {
      const li = extractLinkedInCompanyUrl(href);
      if (li) out.linkedin = { url: li };
    }
  }
  return out;
}
