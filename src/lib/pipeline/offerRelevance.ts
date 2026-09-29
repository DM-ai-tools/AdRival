/**
 * Relevance rules for the offers report: which competitor ads and landing
 * pages are worth analysing for the service the user searched.
 *
 * Used only by the offers phase. The competitor search keeps its own scoring
 * (serviceKeywordOverlapScore), so nothing here changes which competitors a
 * search finds.
 */
import { familiesInText, type ServiceFocus } from "./offerServiceFocus";

/** Pages that never carry an offer: jobs, legal, social profiles, link hubs. */
const JUNK_PATH =
  /\/(careers?|jobs?|vacanc(?:y|ies)|hiring|join-our-team|work-with-us|privacy(?:-policy)?|terms(?:-of-(?:use|service))?|cookie(?:-policy)?|legal|disclaimer|sitemap)(?:[/?#.]|$)/i;
const JUNK_HOST =
  /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|linkedin\.com|twitter\.com|x\.com|tiktok\.com|pinterest\.com|threads\.net|wa\.me|whatsapp\.com|t\.me|linktr\.ee|lnk\.bio|beacons\.ai)$/i;
/** Hiring and company news: real ads, but they sell no service. */
const JUNK_COPY =
  /\b(we(?:'|’)re hiring|we are hiring|now hiring|join our team|job opening|apply for (?:this|the) (?:role|job|position)|careers at|acquisition of|has acquired|merger)\b/i;

function hostAndPath(url: string | null | undefined): { host: string; path: string } | null {
  if (!url) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return { host: parsed.hostname.replace(/^www\./i, "").toLowerCase(), path: parsed.pathname || "/" };
  } catch {
    return null;
  }
}

/** Why a destination URL is not worth analysing, or null if it is fine. */
export function junkLandingReason(url: string | null | undefined): string | null {
  const parts = hostAndPath(url);
  if (!parts) return null;
  if (JUNK_HOST.test(parts.host)) return "social profile or link page, not an offer page";
  if (JUNK_PATH.test(parts.path)) return "jobs or legal page, not an offer page";
  return null;
}

export function isHomepageUrl(url: string | null | undefined): boolean {
  const parts = hostAndPath(url);
  return Boolean(parts && (parts.path === "/" || parts.path === ""));
}

export function hostOf(url: string | null | undefined): string | null {
  return hostAndPath(url)?.host ?? null;
}

export function isJunkAdCopy(text: string): boolean {
  return JUNK_COPY.test(text);
}

function wordHit(hay: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}(s|es)?([^a-z0-9]|$)`, "i").test(hay);
}

/**
 * How well a piece of text (ad copy, URL, page offer) matches the searched
 * service. Range -1..1: positive names the service or its keywords, negative
 * names only a different service, 0 says nothing either way. Text that names
 * the service among several others (a generic "we do everything" page) is
 * capped low so a specific offer ranks above it.
 */
export function offerRelevance(text: string, focus: ServiceFocus): number {
  if (!focus.families.length && !focus.tokens.length) return 0;
  const hay = text.toLowerCase();
  const found = familiesInText(text);
  const targetHit = found.some((f) => focus.families.includes(f));
  const others = found.filter((f) => !focus.families.includes(f));
  const tokenHits = focus.tokens.filter((t) => wordHit(hay, t)).length;
  const tokenScore = focus.tokens.length
    ? Math.min(1, tokenHits / Math.min(focus.tokens.length, 3))
    : 0;

  if (!targetHit && others.length && tokenHits === 0) return -0.6;
  let score = (targetHit ? 0.6 : 0) + tokenScore * 0.4;
  if (targetHit && others.length >= 2) score = Math.min(score, 0.35);
  else if (others.length) score -= 0.15;
  return Math.max(-1, Math.min(1, score));
}
