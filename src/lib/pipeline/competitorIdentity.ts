import * as cheerio from "cheerio";
import { isCreditError } from "../accounting/errors";
import { firecrawlSearch, flattenFirecrawlSearchResults, hasFirecrawlKey } from "../firecrawl/client";
import { getFacebookProfile, getLinkedInCompany, googleSearch, normalizeList } from "../sociavault/client";
import { fetchRawLandingHtml } from "./htmlFetch";
import type { LookupIdentity } from "../types";

/**
 * Competitor lookup accepts a name, a website, or a Facebook, Instagram or
 * LinkedIn page link. This works out, once, who the competitor is — name,
 * website and social pages — so each ad library is searched with what it
 * finds best: Facebook by the exact page, Google by the website domain,
 * LinkedIn by the exact company name.
 */
export type CompetitorIdentity = LookupIdentity;

const SOCIAL_OR_DIRECTORY =
  /(^|\.)(facebook|fb|instagram|linkedin|youtube|youtu|twitter|x|tiktok|pinterest|google|wikipedia|yelp|yellowpages|truelocal|hotfrog|localsearch|crunchbase|bloomberg|zoominfo|glassdoor|indeed|seek|productreview|trustpilot|clutch|g2|capterra|reddit|quora|amazon|ebay|gumtree|apple|bing|yahoo|abr\.business|abn)\.[a-z.]+$/i;

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

function pathSlug(url: string, pattern: RegExp): string | null {
  const m = url.match(pattern);
  return m ? decodeURIComponent(m[1]).replace(/\/+$/, "") : null;
}

/** "push-mobility" → "Push Mobility". */
function slugToName(slug: string): string {
  return slug
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function classifyLookupInput(raw: string): Pick<CompetitorIdentity, "inputKind" | "domain" | "facebookUrl" | "facebookHandle" | "instagramHandle" | "linkedinUrl"> {
  const value = raw.trim();
  const url = /^https?:\/\//i.test(value) ? value : /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(value) ? `https://${value}` : null;
  const empty = { domain: null, facebookUrl: null, facebookHandle: null, instagramHandle: null, linkedinUrl: null };
  if (!url) return { inputKind: "name", ...empty };
  const host = hostOf(url) || "";
  if (/(^|\.)(facebook|fb)\.com$/.test(host)) {
    const handle = pathSlug(url, /facebook\.com\/(?:pg\/)?([^/?#]+)/i);
    const id = url.match(/[?&]id=(\d+)/)?.[1] || null;
    return { ...empty, inputKind: "facebook", facebookUrl: url, facebookHandle: handle === "profile.php" ? id : handle };
  }
  if (/(^|\.)instagram\.com$/.test(host)) {
    return { ...empty, inputKind: "instagram", instagramHandle: pathSlug(url, /instagram\.com\/([^/?#]+)/i) };
  }
  if (/(^|\.)linkedin\.com$/.test(host)) {
    return { ...empty, inputKind: "linkedin", linkedinUrl: url };
  }
  return { ...empty, inputKind: "website", domain: host };
}

/** Name and social links from the competitor's own homepage. */
async function readWebsite(domain: string): Promise<{ name: string | null; facebookUrl: string | null; linkedinUrl: string | null; instagramHandle: string | null }> {
  try {
    const page = await fetchRawLandingHtml(`https://${domain}`);
    const $ = cheerio.load(page.html);
    const site = ($('meta[property="og:site_name"]').attr("content") || "").trim();
    const title = (page.title || $("title").first().text() || "").split(/\s+[|–—-]\s+|\s+·\s+/)[0].trim();
    const links = $("a[href]")
      .map((_, a) => String($(a).attr("href") || ""))
      .get();
    const find = (re: RegExp) => links.find((h) => re.test(h) && !/sharer|share\.php|intent|\/plugins\//i.test(h)) || null;
    const ig = find(/instagram\.com\/[^/?#]+/i);
    return {
      name: site || (title.length >= 2 && title.length <= 60 ? title : null),
      facebookUrl: find(/facebook\.com\/(?!sharer)[^/?#]+/i),
      linkedinUrl: find(/linkedin\.com\/company\/[^/?#]+/i),
      instagramHandle: ig ? pathSlug(ig, /instagram\.com\/([^/?#]+)/i) : null,
    };
  } catch (err) {
    if (isCreditError(err)) throw err;
    return { name: null, facebookUrl: null, linkedinUrl: null, instagramHandle: null };
  }
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 3 && !["the", "and", "pty", "ltd", "inc", "llc", "group", "company", "australia"].includes(w));

/** The business's own website for a name: the first search result that names it and is not a social or directory site. */
async function findWebsite(name: string, country?: string | null): Promise<string | null> {
  const query = `${name} official website`;
  let hits: Array<{ url?: string; title?: string | null }> = [];
  if (hasFirecrawlKey()) {
    try {
      hits = flattenFirecrawlSearchResults(await firecrawlSearch(query, { limit: 8, country: country || undefined }));
    } catch (err) {
      console.warn("[identity] Firecrawl search failed; using SociaVault search", (err as Error).message);
    }
  }
  if (!hits.length) {
    try {
      const res = await googleSearch(query, country || "US");
      hits = normalizeList<{ url?: string; title?: string }>(res.data?.results);
    } catch (err) {
      if (isCreditError(err)) throw err;
      return null;
    }
  }
  return pickOwnWebsite(name, hits);
}

/** The first result that names the business and is not a social, directory or review site. */
export function pickOwnWebsite(name: string, hits: Array<{ url?: string; title?: string | null }>): string | null {
  const nameWords = words(name);
  const squashed = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const hit of hits.slice(0, 8)) {
    const host = hostOf(hit.url);
    if (!host || SOCIAL_OR_DIRECTORY.test(host)) continue;
    const hostBare = host.replace(/\.(com|net|org|co|io|biz)(\.[a-z]{2})?$|\.[a-z]{2}$/i, "").replace(/[^a-z0-9]/g, "");
    const titleWords = new Set(words(hit.title || ""));
    const named =
      (squashed.length >= 4 && (hostBare.includes(squashed) || squashed.includes(hostBare))) ||
      (nameWords.length > 0 && nameWords.filter((w) => titleWords.has(w) || hostBare.includes(w)).length >= Math.ceil(nameWords.length * 0.6));
    if (named) return host;
  }
  return null;
}

export async function resolveCompetitorIdentity(
  input: string,
  options: { country?: string | null } = {},
): Promise<CompetitorIdentity> {
  const kind = classifyLookupInput(input);
  const identity: CompetitorIdentity = {
    input,
    name: kind.inputKind === "name" ? input.trim() : "",
    linkedinName: null,
    notes: [],
    ...kind,
  };

  // A page link: its profile gives the business name and website.
  if (identity.inputKind === "facebook" && identity.facebookUrl) {
    try {
      const fb = (await getFacebookProfile(identity.facebookUrl)).data;
      if (fb?.name) identity.name = fb.name.trim();
      if (fb?.website) identity.domain = hostOf(fb.website);
    } catch (err) {
      if (isCreditError(err)) throw err;
    }
    if (!identity.name && identity.facebookHandle && !/^\d+$/.test(identity.facebookHandle)) identity.name = slugToName(identity.facebookHandle);
  }
  if (identity.inputKind === "linkedin" && identity.linkedinUrl) {
    try {
      const li = (await getLinkedInCompany(identity.linkedinUrl)).data;
      if (li?.name) {
        identity.name = li.name.trim();
        identity.linkedinName = li.name.trim();
      }
      if (li?.website) identity.domain = hostOf(li.website);
    } catch (err) {
      if (isCreditError(err)) throw err;
    }
    const slug = pathSlug(identity.linkedinUrl, /linkedin\.com\/company\/([^/?#]+)/i);
    if (!identity.name && slug) identity.name = slugToName(slug);
  }
  if (identity.inputKind === "instagram" && identity.instagramHandle) {
    identity.name = slugToName(identity.instagramHandle);
  }

  // A name: find its website.
  if (!identity.domain && identity.name) {
    identity.domain = await findWebsite(identity.name, options.country);
    if (identity.domain) identity.notes.push(`website ${identity.domain}`);
  }

  // The website: its own name and social links.
  if (identity.domain) {
    const site = await readWebsite(identity.domain);
    if (!identity.name && site.name) identity.name = site.name;
    identity.facebookUrl ||= site.facebookUrl;
    if (!identity.facebookHandle && site.facebookUrl) identity.facebookHandle = pathSlug(site.facebookUrl, /facebook\.com\/(?:pg\/)?([^/?#]+)/i);
    identity.instagramHandle ||= site.instagramHandle;
    identity.linkedinUrl ||= site.linkedinUrl;
  }
  if (!identity.name) identity.name = identity.domain ? slugToName(identity.domain.split(".")[0]) : input.trim();
  if (identity.facebookHandle) identity.notes.push(`Facebook page ${identity.facebookHandle}`);
  if (identity.linkedinUrl && !identity.linkedinName) {
    const slug = pathSlug(identity.linkedinUrl, /linkedin\.com\/company\/([^/?#]+)/i);
    if (slug) identity.notes.push(`LinkedIn company ${slug}`);
  }
  return identity;
}
