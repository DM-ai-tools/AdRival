import { v4 as uuidv4 } from "uuid";
import {
  googleSearch as sociavaultGoogleSearch,
  normalizeList,
} from "../sociavault/client";
import {
  firecrawlScrapeBranding,
  firecrawlSearch,
  flattenFirecrawlSearchResults,
  hasFirecrawlKey,
} from "../firecrawl/client";
import {
  detectSocialNetwork,
  extractBrandAssetsFromHtml,
} from "./brandAssets";
import { normalizeWebsiteUrl } from "./linkGuards";
import {
  extractInstagramHandle,
  extractTwitterHandle,
  extractYouTubeParams,
  socialLinksToSociavaultParams,
  type SociavaultSocialParams,
} from "./socialParams";
import { applyBrandScoresForJob, withBrandScore } from "./brandScore";
import {
  candidatesFromLinks,
  fetchCandidate,
  NEEDS_PROOF,
  profileMatchesBrand,
  type Candidate,
  type CandidateSource,
  type FetchedProfile,
} from "./brandProfiles";
import {
  getCompetitorsByRun,
  getJob,
  isSearchJobSuppressed,
  clearSearchJobSuppression,
  saveJob,
  saveJobProgress,
  updateCompetitor,
} from "../db";
import {
  getOpenAICompatClient,
  hasOpenAICompatKey,
  resolveOpenAICompatModel,
} from "../openrouter/openaiCompat";
import type { BrandReview, CompetitorRecord, SearchJob, SocialPlatform } from "../types";

export { normalizeLinkedInCompanyUrl, parseYouTubeFromUrl } from "./socialParams";

/** Competitors brand-reviewed at the same time in a batch run. */
const BRAND_REVIEW_CONCURRENCY = 3;

/** Most pages read for social links per brand (it stops early once 4 platforms are found). */
const MAX_SITE_PAGES = 8;
/** Firecrawl scrapes per brand, used only for pages that block a direct read. */
const MAX_FIRECRAWL_PAGES = 3;
/** Readable pages in a row that add no new platform before reading stops. */
const MAX_PAGES_WITHOUT_NEW = 3;

/**
 * Pages to read for a brand's social links, most likely first. Ads often
 * point at a campaign subdomain or deep link (enquire.brand.com.au/about-us)
 * whose page has no footer, or no longer exists: the brand's main site
 * (brand.com.au) and its contact/about pages come right after it.
 */
export function scrapeUrlCandidates(website: string): string[] {
  const normalized = normalizeWebsiteUrl(website);
  if (!normalized) return [];
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    if (!u) return;
    const clean = u.replace(/\/$/, "");
    if (!out.some((x) => x.toLowerCase() === clean.toLowerCase())) out.push(clean);
  };
  const socialPages = (origin: string) => {
    for (const path of ["/contact", "/contact-us", "/about", "/about-us"]) push(`${origin}${path}`);
  };
  try {
    const u = new URL(normalized);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const parts = host.split(".");
    // The registrable domain: brand.com.au / brand.co.uk / brand.com.
    const apexHost =
      /\.(com|co|net|org|gov|edu|asn|id)\.[a-z]{2}$/i.test(host) && parts.length >= 3
        ? parts.slice(-3).join(".")
        : parts.slice(-2).join(".");
    const onSubdomain = apexHost !== host;
    const apexOrigin = `${u.protocol}//${apexHost}`;

    push(`${u.origin}${u.pathname}`.replace(/\/$/, "") || u.origin);
    if (onSubdomain) {
      push(apexOrigin);
      socialPages(apexOrigin);
    }
    push(u.origin);
    socialPages(u.origin);
    if (!onSubdomain) push(`${u.origin}/company`);
  } catch {
    push(normalized);
  }
  return out.slice(0, MAX_SITE_PAGES);
}

function brandSlugFromHost(host: string): string | null {
  const h = host.replace(/^www\./i, "").toLowerCase();
  const parts = h.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  if (/\.(com|co|net|org|gov)\.[a-z]{2}$/i.test(h) && parts.length >= 3) {
    return parts[parts.length - 3] || null;
  }
  if (parts.length >= 3) {
    return parts[parts.length - 3] || parts[parts.length - 2] || null;
  }
  return parts[0] || null;
}

function extractSocialHrefsFromScrape(
  data: {
    links?: string[];
    html?: string | null;
    markdown?: string | null;
    branding?: Record<string, unknown> | null;
  } | null | undefined,
  baseUrl: string,
): string[] {
  const hrefs: string[] = [];
  if (!data) return hrefs;
  for (const raw of data.links || []) {
    if (typeof raw !== "string") continue;
    const href = raw.startsWith("http")
      ? raw
      : raw.startsWith("//")
        ? `https:${raw}`
        : detectSocialNetwork(raw)
          ? `https://${raw.replace(/^\/+/, "")}`
          : raw;
    if (detectSocialNetwork(href)) hrefs.push(href);
  }
  if (data.html) {
    try {
      const assets = extractBrandAssetsFromHtml(data.html, baseUrl);
      for (const s of assets.socialLinks || []) {
        if (s.href) hrefs.push(s.href);
      }
    } catch {
      /* ignore */
    }
  }
  const branding = data.branding;
  if (branding && typeof branding === "object") {
    for (const value of Object.values(branding)) {
      if (typeof value === "string" && detectSocialNetwork(value)) hrefs.push(value);
      if (value && typeof value === "object") {
        for (const nested of Object.values(value as Record<string, unknown>)) {
          if (typeof nested === "string" && detectSocialNetwork(nested)) {
            hrefs.push(nested);
          }
        }
      }
    }
  }
  const blob = `${data.markdown || ""}\n${typeof data.html === "string" ? data.html : ""}`;
  const urlRe =
    /https?:\/\/(?:www\.)?(?:facebook|fb\.com|instagram|twitter|x\.com|linkedin|youtube|youtu\.be)[\w./@%+-]*/gi;
  for (const match of blob.match(urlRe) || []) {
    const cleaned = match.split(/["'\s>)\]],/)[0];
    if (detectSocialNetwork(cleaned)) hrefs.push(cleaned);
  }
  const handleRe =
    /(?:instagram\.com|twitter\.com|x\.com|facebook\.com|linkedin\.com\/company|youtube\.com\/@)\/[A-Za-z0-9._%-]+/gi;
  for (const match of blob.match(handleRe) || []) {
    hrefs.push(`https://${match.replace(/^\/\//, "")}`);
  }
  return hrefs;
}

function platformCount(params: SociavaultSocialParams): number {
  return [
    params.facebook,
    params.instagram,
    params.twitter,
    params.youtube,
    params.linkedin,
  ].filter(Boolean).length;
}

function pushSocialUrlsFromText(blob: string, into: string[]): void {
  const urlRe =
    /https?:\/\/(?:www\.)?(?:facebook\.com|fb\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|youtu\.be)[\w./@%+-]*/gi;
  for (const match of blob.match(urlRe) || []) {
    into.push(match.split(/["'\s>)\]],/)[0]);
  }
  const handleRe =
    /(?:instagram\.com|twitter\.com|x\.com|facebook\.com|linkedin\.com\/company|youtube\.com\/(?:@|channel\/|c\/))\/?[A-Za-z0-9._%-]+/gi;
  for (const match of blob.match(handleRe) || []) {
    into.push(`https://${match.replace(/^\/\//, "")}`);
  }
}

const PLATFORMS: SocialPlatform[] = ["facebook", "instagram", "twitter", "youtube", "linkedin"];

/**
 * What the lookup managed to check. A platform counts as checked only when a
 * search for it ran: a website without an Instagram link is not proof the
 * brand has no Instagram.
 */
export type Lookup = {
  searched: Set<SocialPlatform>;
  siteRead: boolean;
  issues: Set<string>;
  /** Platforms found by web search (not on the brand's own site); their profile must not point at another website. */
  fromSearch: Set<SocialPlatform>;
};

export function newLookup(): Lookup {
  return { searched: new Set(), siteRead: false, issues: new Set(), fromSearch: new Set() };
}

/** A readable reason for a failed lookup call. */
function lookupIssue(service: "Firecrawl" | "SociaVault", err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/not set/i.test(message)) return `${service} is not configured`;
  if (/\b402\b|credit|quota|payment|insufficient|billing/i.test(message)) return `${service} is out of credits`;
  if (/\b429\b|rate/i.test(message)) return `${service} is rate-limiting requests`;
  if (/timed? ?out|abort/i.test(message)) return `${service} timed out`;
  return `${service} lookups failed`;
}

function paramsHave(params: SociavaultSocialParams, platform: SocialPlatform): boolean {
  return Boolean(params[platform]);
}

/** The brand's own website, read without Firecrawl (footer and header social links). */
async function fetchPageHtml(url: string): Promise<{ html: string; finalUrl: string } | { blocked: boolean } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    // A page that does not exist is not worth a Firecrawl call; a blocked one is.
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) return { blocked: true };
    if (!/html/i.test(res.headers.get("content-type") || "")) return null;
    return { html: (await res.text()).slice(0, 2_000_000), finalUrl: res.url || url };
  } catch {
    // Timeouts and refused connections: the site may block plain requests.
    return { blocked: true };
  }
}

/** Social links on a page as a browser renders it (for sites that add their links with JavaScript). */
async function renderedSocialLinks(url: string): Promise<string[]> {
  try {
    const { launchChromium } = await import("./content/playwrightRuntime");
    const browser = await launchChromium();
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
      await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
      const links = (await page.evaluate(
        "Array.from(document.querySelectorAll('a[href]')).map(function(a){ return a.href; })",
      )) as string[];
      return links.filter((href) => detectSocialNetwork(href));
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (err) {
    console.warn("[brandReview] rendered link read failed", (err as Error).message);
    return [];
  }
}

/** Search results as { url, title, description } rows from SociaVault's Google search. */
async function sociavaultSearchRows(query: string): Promise<Array<{ url?: string; title?: string; description?: string }>> {
  const res = await sociavaultGoogleSearch(query);
  const results = (res as { data?: { results?: unknown } })?.data?.results;
  return normalizeList<{ url?: string; title?: string; description?: string }>(results);
}

/**
 * Web search for the platforms still missing: Firecrawl first, SociaVault's
 * Google search when Firecrawl fails. Each platform searched successfully is
 * recorded in the lookup.
 */
async function searchSocialHrefs(
  pageName: string,
  website: string | null,
  current: SociavaultSocialParams,
  lookup: Lookup,
  shouldAbort?: () => boolean,
): Promise<string[]> {
  if (shouldAbort?.()) return [];
  const hrefs: string[] = [];
  let slug: string | null = null;
  try {
    if (website) slug = brandSlugFromHost(new URL(website).hostname);
  } catch {
    /* ignore */
  }
  const brand = pageName.replace(/[^\w\s&'-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!brand && !slug) return [];

  const site: Record<SocialPlatform, string> = {
    instagram: "site:instagram.com",
    twitter: "(site:twitter.com OR site:x.com)",
    youtube: "site:youtube.com",
    linkedin: "site:linkedin.com/company",
    facebook: "site:facebook.com",
  };
  const queries: Array<{ platform: SocialPlatform; q: string }> = [];
  for (const platform of PLATFORMS) {
    if (paramsHave(current, platform) || lookup.searched.has(platform)) continue;
    if (brand) queries.push({ platform, q: `"${brand}" ${site[platform]}` });
    // The domain name catches brands whose page name differs from their handle.
    if (slug && (platform === "instagram" || platform === "linkedin" || !brand)) queries.push({ platform, q: `${slug} ${site[platform]}` });
  }

  let firecrawlDown = !hasFirecrawlKey();
  if (firecrawlDown && queries.length) lookup.issues.add("Firecrawl is not configured");
  let sociavaultDown = false;
  for (const { platform, q } of queries) {
    if (shouldAbort?.()) break;
    // A platform already found by an earlier query needs no second one.
    if (paramsHave(socialLinksToSociavaultParams(hrefs), platform)) {
      lookup.searched.add(platform);
      continue;
    }
    let rows: Array<{ url?: string | null; title?: string | null; description?: string | null }> | null = null;
    if (!firecrawlDown) {
      try {
        rows = flattenFirecrawlSearchResults(await firecrawlSearch(q, { limit: 5 }));
      } catch (err) {
        lookup.issues.add(lookupIssue("Firecrawl", err));
        console.warn("[brandReview] Firecrawl social search failed:", q, (err as Error).message);
        // Out of credits or not configured: stop asking Firecrawl for this brand.
        if (/credits|not configured/.test(lookupIssue("Firecrawl", err))) firecrawlDown = true;
      }
    }
    if (!rows && !sociavaultDown) {
      try {
        rows = await sociavaultSearchRows(q);
      } catch (err) {
        lookup.issues.add(lookupIssue("SociaVault", err));
        console.warn("[brandReview] SociaVault social search failed:", q, (err as Error).message);
        if (/credits|not configured/.test(lookupIssue("SociaVault", err))) sociavaultDown = true;
      }
    }
    if (!rows) continue;
    lookup.searched.add(platform);
    const found: string[] = [];
    for (const row of rows) {
      if (row.url && detectSocialNetwork(row.url)) found.push(row.url);
      pushSocialUrlsFromText(`${row.title || ""} ${row.description || ""} ${row.url || ""}`, found);
    }
    // Keep only links for the platform this query was about, so a stray
    // result for another network does not stand in for that network's search.
    const forPlatform = found.filter((href) => paramsHave(socialLinksToSociavaultParams([href]), platform));
    hrefs.push(...forPlatform);
    if (forPlatform.length) lookup.fromSearch.add(platform);
  }
  return hrefs;
}

export async function collectSocialHrefsFromWebsite(
  website: string,
  lookup: Lookup,
  shouldAbort?: () => boolean,
): Promise<{ hrefs: string[]; markdown: string | null; canonicalWebsite: string | null }> {
  const hrefs: string[] = [];
  let markdown: string | null = null;
  let canonicalWebsite: string | null = normalizeWebsiteUrl(website);
  /** Whether the address the ad pointed at could be read at all (it may be a 404). */
  let landingRead = false;
  /** The first readable home page of the brand's site, used as its website when the landing page is gone. */
  let homePage: string | null = null;
  const found = () => platformCount(socialLinksToSociavaultParams(hrefs));
  const keepText = (html: string) => {
    if (markdown) return;
    const text = html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) markdown = text.slice(0, 12_000);
  };

  let firecrawlDown = !hasFirecrawlKey();
  let firecrawlUsed = 0;
  let readWithoutNew = 0;
  const candidates = scrapeUrlCandidates(website);
  for (const [index, url] of candidates.entries()) {
    if (shouldAbort?.()) break;
    const before = found();
    let read = false;

    // A direct read first: free, and it sees footer icon links Firecrawl sometimes drops.
    const fetched = await fetchPageHtml(url);
    const page = fetched && "html" in fetched ? fetched : null;
    if (page) {
      read = true;
      hrefs.push(...extractSocialHrefsFromScrape({ html: page.html }, page.finalUrl));
      keepText(page.html);
      if (index === 0) landingRead = true;
      try {
        const path = new URL(page.finalUrl).pathname;
        if (!homePage && (path === "/" || path === "")) homePage = normalizeWebsiteUrl(page.finalUrl);
      } catch {
        /* ignore */
      }
    }

    // Firecrawl only for a page that blocked the direct read (not for one that does not exist).
    if (!page && fetched && "blocked" in fetched && !firecrawlDown && firecrawlUsed < MAX_FIRECRAWL_PAGES) {
      firecrawlUsed += 1;
      try {
        const scraped = await firecrawlScrapeBranding(url);
        const data = scraped.data;
        if (data) {
          read = true;
          if (index === 0) landingRead = true;
          if (!markdown && typeof data.markdown === "string" && data.markdown.trim()) {
            markdown = data.markdown.slice(0, 12_000);
          }
          hrefs.push(
            ...extractSocialHrefsFromScrape(
              data as { links?: string[]; html?: string | null; markdown?: string | null; branding?: Record<string, unknown> | null },
              url,
            ),
          );
          if (index === 0 && data.metadata?.sourceURL) {
            canonicalWebsite = normalizeWebsiteUrl(String(data.metadata.sourceURL)) || canonicalWebsite;
          }
        }
      } catch (err) {
        lookup.issues.add(lookupIssue("Firecrawl", err));
        console.warn("[brandReview] Firecrawl scrape failed for", url, (err as Error).message);
        if (/credits|not configured/.test(lookupIssue("Firecrawl", err))) firecrawlDown = true;
      }
    }
    if (index === 0 && page) canonicalWebsite = normalizeWebsiteUrl(page.finalUrl) || canonicalWebsite;
    if (read) lookup.siteRead = true;
    if (found() >= 4) break;
    if (read) readWithoutNew = found() > before ? 0 : readWithoutNew + 1;
    if (found() > 0 && readWithoutNew >= MAX_PAGES_WITHOUT_NEW) break;
  }
  if (!hasFirecrawlKey()) lookup.issues.add("Firecrawl is not configured");

  // The ad's landing page is gone (404) or unreadable: the brand's main site is its website.
  if (!landingRead && homePage) canonicalWebsite = homePage;

  // A site that builds its links with JavaScript: render it once in a browser.
  if (!found() && !shouldAbort?.()) {
    hrefs.push(...(await renderedSocialLinks(homePage || canonicalWebsite || website)));
  }

  return { hrefs: Array.from(new Set(hrefs)), markdown, canonicalWebsite };
}

function hostSlug(url: unknown): string | null {
  const normalized = typeof url === "string" ? normalizeWebsiteUrl(url) : null;
  if (!normalized) return null;
  try {
    return brandSlugFromHost(new URL(normalized).hostname);
  } catch {
    return null;
  }
}

/**
 * A profile found by web search whose own website is a different business's
 * belongs to that business (a search for "Online Road" can return another
 * company's account). Link-in-bio pages and missing websites are not proof.
 */
export function pointsElsewhere(profileWebsite: unknown, siteWebsite: string | null | undefined): boolean {
  const theirs = hostSlug(profileWebsite);
  const ours = hostSlug(siteWebsite);
  if (!theirs || !ours) return false;
  if (/^(linktr|linkin|bio|beacons|lnk|taplink|msha|bit|tinyurl|instagram|facebook|wa|api|google|business|sites)$/i.test(theirs)) return false;
  return theirs !== ours;
}

function guessLinkedInFromWebsite(website: string | null | undefined): string | null {
  const normalized = normalizeWebsiteUrl(website);
  if (!normalized) return null;
  try {
    const host = new URL(normalized).hostname.replace(/^www\./i, "");
    const slug = brandSlugFromHost(host);
    if (
      !slug ||
      slug.length < 2 ||
      /^(bit|tinyurl|linktr|t|goo|ow|grow|app|www|m|digitalagency|blog|shop)$/i.test(
        slug,
      )
    ) {
      return null;
    }
    return `https://www.linkedin.com/company/${slug}`;
  } catch {
    return null;
  }
}

function revenueFromEmployees(employees: number | null): string | null {
  if (employees == null || employees <= 0) return null;
  if (employees < 5) return "<$500k";
  if (employees < 15) return "$500k–$2M";
  if (employees < 50) return "$1–5M";
  if (employees < 200) return "$5–25M";
  if (employees < 1000) return "$25–100M";
  return "$100M+";
}

async function estimateCompanyRevenue(input: {
  pageName: string;
  website: string | null;
  employees: number | null;
  category: string | null;
  markdown: string | null;
  facebookFollowers?: number | null;
}): Promise<{
  revenue: string | null;
  source: "llm" | "scrape" | "heuristic" | null;
}> {
  if (input.markdown) {
    const m = input.markdown.match(
      /(?:revenue|arr|annual\s+sales|turnover)[^\n$.]{0,40}(\$?\d[\d.,]*\s*(?:[kmb]|million|billion)?)/i,
    );
    if (m?.[1]) {
      return {
        revenue: m[1].trim().replace(/^["']|["']$/g, ""),
        source: "scrape",
      };
    }
  }

  if (hasOpenAICompatKey()) {
    try {
      const client = getOpenAICompatClient();
      const completion = await client.chat.completions.create({
        model: resolveOpenAICompatModel("gpt-4o-mini"),
        temperature: 0.2,
        max_tokens: 80,
        messages: [
          {
            role: "system",
            content:
              "Estimate approximate annual company revenue as a short range (e.g. $1–3M, $10–25M, <$500k, $100M+). Always provide a best-effort range using employees, followers, and industry. Reply with ONLY the range string, no quotes.",
          },
          {
            role: "user",
            content: JSON.stringify({
              company: input.pageName,
              website: input.website,
              linkedinEmployees: input.employees,
              facebookFollowers: input.facebookFollowers ?? null,
              category: input.category,
              siteExcerpt: (input.markdown || "").slice(0, 3500),
            }),
          },
        ],
      });
      let text = (completion.choices[0]?.message?.content || "")
        .trim()
        .replace(/^["'`]+|["'`]+$/g, "");
      if (text && !/^unknown$/i.test(text)) {
        return { revenue: text.slice(0, 48), source: "llm" };
      }
    } catch (err) {
      console.warn(
        "[brandReview] revenue estimate failed:",
        (err as Error).message,
      );
    }
  }

  const heuristic =
    revenueFromEmployees(input.employees) ||
    (input.facebookFollowers != null && input.facebookFollowers >= 100_000
      ? "$5–25M"
      : input.facebookFollowers != null && input.facebookFollowers >= 10_000
        ? "$1–5M"
        : input.facebookFollowers != null && input.facebookFollowers >= 1_000
          ? "$500k–$2M"
          : input.website
            ? "$1–3M"
            : "$500k–$2M");
  return { revenue: heuristic, source: "heuristic" };
}

function isBrandReviewIncomplete(brand: BrandReview | undefined): boolean {
  if (!brand) return true;
  // Platforms that could not be checked last time are retried.
  if (brand.uncheckedPlatforms?.length) return true;
  if (!brand.companyRevenue) return true;
  const handles = [
    brand.facebookUrl,
    brand.instagramHandle,
    brand.twitterHandle,
    brand.youtubeUrl || brand.youtubeHandle,
    brand.linkedinUrl,
  ].filter(Boolean).length;
  const metrics = [
    brand.facebookFollowers,
    brand.instagramFollowers,
    brand.twitterFollowers,
    brand.youtubeSubscribers,
    brand.linkedinFollowers,
    brand.linkedinEmployees,
  ].filter((n) => n != null).length;
  if (handles === 0) return true;
  if (metrics === 0) return true;
  if (
    brand.linkedinUrl &&
    brand.linkedinFollowers == null &&
    brand.linkedinEmployees == null
  ) {
    return true;
  }
  // Website exists but we never discovered any non-Facebook channel — retry scrape/search.
  if (
    brand.website &&
    !brand.instagramHandle &&
    !brand.twitterHandle &&
    !brand.youtubeUrl &&
    !brand.youtubeHandle &&
    !brand.linkedinUrl
  ) {
    return true;
  }
  return false;
}

/**
 * Brand review for one competitor (on-demand only):
 * 1) Firecrawl scrape of landing + root domain → social links
 * 2) Optional Firecrawl search to fill missing platforms
 * 3) SociaVault follower / employee fetches
 * 4) Revenue estimate (scrape / LLM / heuristic)
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
  /** What an earlier review found; each account is used only if its profile proves it is this brand's. */
  previous?: BrandReview | null;
  /** The ad's YouTube channel (YouTube ads). */
  adYoutubeUrl?: string | null;
  /** Return true to bail out of long scrapes (e.g. user hit Stop). */
  shouldAbort?: () => boolean;
}): Promise<BrandReview> {
  const abort = () => Boolean(input.shouldAbort?.());
  const brand: BrandReview = {
    website: normalizeWebsiteUrl(input.websiteHint) || null,
    category: input.categoryHint || null,
  };

  const lookup = newLookup();
  const candidates: Candidate[] = [];
  const addCandidates = (list: Candidate[]) => {
    for (const c of list) {
      if (candidates.some((x) => x.platform === c.platform && x.value.toLowerCase() === c.value.toLowerCase())) continue;
      candidates.push(c);
    }
  };

  // 1. The advertiser's own page on the ad platform.
  const metaAd = input.sourcePlatform !== "google" && input.sourcePlatform !== "youtube" && input.sourcePlatform !== "linkedin";
  addCandidates(candidatesFromLinks([input.pageProfileUri, input.adYoutubeUrl], "ad"));
  if (metaAd && /^\d+$/.test(String(input.pageId))) {
    addCandidates([{ platform: "facebook", value: `https://www.facebook.com/${input.pageId}`, source: "ad" }]);
  }
  for (const c of candidates) lookup.searched.add(c.platform);

  // 2. Links on the brand's own website (Firecrawl, then a direct read of the page).
  let siteMarkdown: string | null = null;
  if (brand.website && !abort()) {
    const collected = await collectSocialHrefsFromWebsite(brand.website, lookup, abort);
    siteMarkdown = collected.markdown;
    if (collected.canonicalWebsite) brand.website = collected.canonicalWebsite;
    addCandidates(candidatesFromLinks(collected.hrefs, "site"));
  }

  // 3. What an earlier review found: used only if the profile proves it is this brand's.
  const prev = input.previous || null;
  addCandidates(
    candidatesFromLinks(
      [
        prev?.facebookUrl || input.facebookUrlHint,
        (prev?.instagramHandle || input.instagramHandleHint) ? `https://www.instagram.com/${(prev?.instagramHandle || input.instagramHandleHint)!.replace(/^@/, "")}` : null,
        (prev?.twitterHandle || input.twitterHandleHint) ? `https://x.com/${(prev?.twitterHandle || input.twitterHandleHint)!.replace(/^@/, "")}` : null,
        prev?.youtubeUrl || input.youtubeUrlHint || ((prev?.youtubeHandle || input.youtubeHandleHint) ? `https://www.youtube.com/@${(prev?.youtubeHandle || input.youtubeHandleHint)!.replace(/^@/, "")}` : null),
        prev?.linkedinUrl || input.linkedinUrlHint,
      ],
      "previous",
    ),
  );

  if (abort()) {
    brand.website = normalizeWebsiteUrl(brand.website) || null;
    return brand;
  }

  // Each platform tries its candidates, most trusted first, until one
  // returns a real count. A candidate that needs proof must show it is this
  // brand's (its website or its name); a site link is dropped only when its
  // profile is clearly another business's.
  const RANK: Record<CandidateSource, number> = { ad: 0, site: 1, profile: 2, previous: 3, search: 4, guess: 5 };
  const tried = new Set<string>();
  const resolved = new Map<SocialPlatform, { candidate: Candidate; profile: FetchedProfile | null }>();
  const profileLinks: string[] = [];
  const brandRef = () => ({ name: input.pageName, website: brand.website || null });

  const resolvePlatform = async (platform: SocialPlatform) => {
    if (resolved.get(platform)?.profile?.count != null) return;
    const list = candidates
      .filter((c) => c.platform === platform && !tried.has(`${platform}|${c.value.toLowerCase()}`))
      .sort((a, b) => RANK[a.source] - RANK[b.source])
      .slice(0, 4);
    for (const c of list) {
      if (abort()) return;
      tried.add(`${platform}|${c.value.toLowerCase()}`);
      let profile: FetchedProfile;
      try {
        profile = await fetchCandidate(c);
      } catch (err) {
        lookup.issues.add(lookupIssue("SociaVault", err));
        console.warn(`[brandReview] ${platform} lookup failed for ${c.value}:`, (err as Error).message);
        // A link from the ad or the brand's own site is still the brand's account.
        if (!NEEDS_PROOF.has(c.source) && !resolved.has(platform)) resolved.set(platform, { candidate: c, profile: null });
        continue;
      }
      const match = profileMatchesBrand(profile, brandRef());
      const accept =
        c.source === "ad" ||
        (NEEDS_PROOF.has(c.source) ? match.site === "same" || (match.site !== "other" && match.name) : !(match.site === "other" && !match.name));
      if (!accept) continue;
      profileLinks.push(...profile.links);
      const current = resolved.get(platform);
      if (!current || current.profile?.count == null) resolved.set(platform, { candidate: c, profile });
      if (profile.count != null) return;
    }
  };
  const resolveAll = async () => {
    await Promise.all(PLATFORMS.map((p) => resolvePlatform(p)));
  };

  await resolveAll();

  // 4. Links on the brand's own profiles (a Facebook page listing its Instagram).
  if (!abort() && profileLinks.length) {
    addCandidates(candidatesFromLinks(profileLinks, "profile"));
    await resolveAll();
  }

  // 5. Web search for the platforms still missing.
  const missing = () => PLATFORMS.filter((p) => !resolved.has(p));
  if (!abort() && missing().length && input.pageName) {
    const known: SociavaultSocialParams = {};
    for (const p of PLATFORMS) if (resolved.has(p)) (known as Record<string, unknown>)[p] = { url: "known", handle: "known" };
    const found = await searchSocialHrefs(input.pageName, brand.website ?? null, known, lookup, abort);
    addCandidates(candidatesFromLinks(found, "search"));
    await resolveAll();
  }

  // 6. LinkedIn from the domain name, if it proves to be this company.
  if (!abort() && !resolved.has("linkedin")) {
    const guessed = guessLinkedInFromWebsite(brand.website);
    if (guessed) {
      addCandidates([{ platform: "linkedin", value: guessed, source: "guess" }]);
      await resolvePlatform("linkedin");
    }
  }

  for (const [platform, { candidate, profile }] of resolved) {
    if (profile) {
      Object.assign(brand, profile.fields);
      if (!brand.website && profile.website && !/facebook|instagram|twitter|x\.com|linkedin|youtube|linktr/i.test(profile.website)) {
        brand.website = normalizeWebsiteUrl(profile.website);
      }
      continue;
    }
    // Present, but SociaVault gave no data: keep the account so it shows as "Unavailable".
    if (platform === "facebook") brand.facebookUrl = candidate.value;
    if (platform === "instagram") brand.instagramHandle = extractInstagramHandle(candidate.value);
    if (platform === "twitter") brand.twitterHandle = extractTwitterHandle(candidate.value);
    if (platform === "youtube") {
      const yt = extractYouTubeParams(candidate.value);
      brand.youtubeUrl = yt?.url || candidate.value;
      brand.youtubeHandle = yt?.handle || null;
    }
    if (platform === "linkedin") brand.linkedinUrl = candidate.value;
  }

  // A missing platform is "not present" only when a search for it ran;
  // otherwise it is "not checked" and the next brand review retries it.
  const unchecked = PLATFORMS.filter((platform) => !resolved.has(platform) && !lookup.searched.has(platform));
  brand.uncheckedPlatforms = unchecked.length ? unchecked : null;
  brand.lookupIssues = lookup.issues.size ? [...lookup.issues] : null;

  if (!abort()) {
    const revenue = await estimateCompanyRevenue({
      pageName: input.pageName,
      website: brand.website ?? null,
      employees: brand.linkedinEmployees ?? null,
      category: brand.category ?? null,
      markdown: siteMarkdown,
      facebookFollowers: brand.facebookFollowers ?? null,
    });
    brand.companyRevenue = revenue.revenue;
    brand.companyRevenueSource =
      revenue.source === "heuristic" ? "llm" : revenue.source;
  }

  if (!brand.companyRevenue) {
    brand.companyRevenue =
      revenueFromEmployees(brand.linkedinEmployees ?? null) ||
      (brand.facebookFollowers != null && brand.facebookFollowers >= 10_000
        ? "$1–5M"
        : brand.website
          ? "$1–3M"
          : null);
    if (brand.companyRevenue) brand.companyRevenueSource = "llm";
  }

  brand.website = normalizeWebsiteUrl(brand.website) || null;
  return withBrandScore(brand);
}

/**
 * Runs whose brand review this app process is working on. A run whose saved
 * stage says "brand_review" but is not in here was interrupted (the app
 * restarted or was redeployed) and must not block a new start.
 */
function brandReviewsInProcess(): Set<string> {
  const g = globalThis as typeof globalThis & { __adrivalBrandReviews?: Set<string> };
  return (g.__adrivalBrandReviews ??= new Set<string>());
}

/** Called just before a batch is scheduled, so a second click does not start a duplicate. */
export function markBrandReviewRunning(jobId: string): void {
  brandReviewsInProcess().add(jobId);
}

export function markBrandReviewStopped(jobId: string): void {
  brandReviewsInProcess().delete(jobId);
}

export function isBrandReviewRunning(jobId: string): boolean {
  return brandReviewsInProcess().has(jobId);
}

/** Run brand review for every competitor in a finished search job. */
export async function runBrandReviewForJob(
  jobId: string,
  options?: { force?: boolean },
): Promise<{ updated: number; skipped: number; stopped?: boolean }> {
  markBrandReviewRunning(jobId);
  try {
    return await runBrandReviewBatch(jobId, options);
  } finally {
    markBrandReviewStopped(jobId);
  }
}

async function runBrandReviewBatch(
  jobId: string,
  options?: { force?: boolean },
): Promise<{ updated: number; skipped: number; stopped?: boolean }> {
  // Fresh run — clear any prior Stop so this batch can execute.
  clearSearchJobSuppression(jobId);

  const job = getJob(jobId);
  if (!job) return { updated: 0, skipped: 0 };

  const competitors = getCompetitorsByRun(jobId);
  let updated = 0;
  let skipped = 0;
  let stopped = false;
  /** Competitors left with platforms that could not be checked, and why. */
  let uncheckedCount = 0;
  const lookupIssues = new Set<string>();

  const total = competitors.length;
  job.progress.stage = "brand_review";
  job.progress.brandReviewDone = 0;
  job.progress.brandReviewTotal = total;
  job.progress.brandReviewCurrentName = null;
  job.progress.stopRequested = false;
  job.progress.message = `Brand review starting for ${total} competitors…`;
  job.updatedAt = new Date().toISOString();
  if (!saveJob(job)) return { updated: 0, skipped: 0 };

  // Competitors are independent (each review writes only its own record), so
  // a few run at once. Progress counts finished competitors.
  let done = 0;
  let next = 0;
  const inFlight = new Set<string>();
  const report = (message: string) => {
    job.progress.brandReviewDone = done;
    job.progress.brandReviewTotal = total;
    job.progress.brandReviewCurrentName = inFlight.size ? [...inFlight].join(", ") : null;
    job.progress.message = message;
    job.updatedAt = new Date().toISOString();
    saveJobProgress(job);
  };

  const reviewOne = async (c: CompetitorRecord) => {
    if (!options?.force && !isBrandReviewIncomplete(c.brand)) {
      skipped += 1;
      done += 1;
      report(`Brand review ${done}/${total}: ${c.pageName} (skipped — complete)`);
      return;
    }
    inFlight.add(c.pageName);
    report(`Brand review ${done + 1}/${total}: ${[...inFlight].join(", ")}…`);
    try {
      const brand = await runBrandReview({
        pageId: c.pageId,
        pageName: c.pageName,
        pageProfileUri: c.sampleAd?.advertiserPageUrl || null,
        websiteHint: c.brand?.website || c.sampleAd?.landingPageUrl || null,
        adYoutubeUrl: c.platform === "youtube" ? c.sampleAd?.advertiserPageUrl || null : null,
        previous: c.brand || null,
        categoryHint: c.brand?.category || null,
        sourcePlatform: c.platform,
        shouldAbort: () => isSearchJobSuppressed(jobId),
      });
      if (isSearchJobSuppressed(jobId)) {
        stopped = true;
        return;
      }
      const patch: Partial<CompetitorRecord> = { brand };
      if (brand.address && !c.locationLabel) {
        patch.locationLabel = brand.address;
        patch.locationSource = "sociavault";
        patch.locationStatus = c.locationStatus || "unknown";
      }
      updateCompetitor(c.id, patch);
      updated += 1;
      if (brand.uncheckedPlatforms?.length) uncheckedCount += 1;
      for (const issue of brand.lookupIssues || []) lookupIssues.add(issue);
    } catch (err) {
      console.warn(
        "[brandReview] failed for",
        c.pageName,
        (err as Error).message,
      );
    } finally {
      inFlight.delete(c.pageName);
    }
    done += 1;
    report(`Brand review ${done}/${total}: ${c.pageName} done`);
  };

  const worker = async () => {
    while (next < competitors.length) {
      if (isSearchJobSuppressed(jobId)) {
        stopped = true;
        return;
      }
      const c = competitors[next];
      next += 1;
      await reviewOne(c);
      if (stopped || isSearchJobSuppressed(jobId)) {
        stopped = true;
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BRAND_REVIEW_CONCURRENCY, competitors.length) }, worker),
  );

  const fresh = getJob(jobId);
  if (fresh) {
    if (stopped || isSearchJobSuppressed(jobId)) {
      fresh.progress.stage = "done";
      fresh.progress.brandReviewCurrentName = null;
      fresh.progress.message = `Brand review stopped · ${updated} updated`;
      fresh.progress.stopRequested = true;
    } else {
      fresh.progress.stage = "done";
      fresh.progress.brandReviewDone = total;
      fresh.progress.brandReviewTotal = total;
      fresh.progress.brandReviewCurrentName = null;
      fresh.progress.message =
        fresh.status === "failed"
          ? fresh.progress.message
          : `Found ${competitors.length} competitors · brand review ${updated} updated` +
            (skipped ? ` · ${skipped} skipped` : "") +
            (uncheckedCount
              ? ` · ${uncheckedCount} with platforms not checked${lookupIssues.size ? ` (${[...lookupIssues].join(", ")})` : ""}. Run brand review again to retry them.`
              : "");
    }
    fresh.updatedAt = new Date().toISOString();
    saveJob(fresh);
  }

  // Score from the metrics just saved. This does not scrape or re-run review.
  if (!stopped) applyBrandScoresForJob(jobId);

  return { updated, skipped, stopped };
}

/** Enrich a single competitor (history redo). */
/**
 * One-competitor checks in progress, per run. They do not mark the run as
 * working, so Stop reaches them through here.
 */
function singleReviewsInProcess(): Map<string, Set<AbortController>> {
  const g = globalThis as typeof globalThis & { __adrivalSingleReviews?: Map<string, Set<AbortController>> };
  return (g.__adrivalSingleReviews ??= new Map());
}

/** Stops every one-competitor check running for a run. Returns how many were stopped. */
export function stopSingleBrandReviews(runId: string): number {
  const list = singleReviewsInProcess().get(runId);
  if (!list?.size) return 0;
  for (const ctrl of list) ctrl.abort();
  return list.size;
}

/** Thrown when Stop cancels a one-competitor check; nothing is saved. */
export class BrandReviewStopped extends Error {
  constructor() {
    super("Brand review stopped");
    this.name = "BrandReviewStopped";
  }
}

export async function runBrandReviewForCompetitor(
  competitor: CompetitorRecord,
  options?: { signal?: AbortSignal },
): Promise<BrandReview> {
  const ctrl = new AbortController();
  const runs = singleReviewsInProcess();
  const mine = runs.get(competitor.runId) ?? new Set<AbortController>();
  mine.add(ctrl);
  runs.set(competitor.runId, mine);
  const stopped = () => ctrl.signal.aborted || Boolean(options?.signal?.aborted);
  try {
    return await reviewOneCompetitor(competitor, stopped);
  } finally {
    mine.delete(ctrl);
    if (!mine.size) runs.delete(competitor.runId);
  }
}

async function reviewOneCompetitor(
  competitor: CompetitorRecord,
  stopped: () => boolean,
): Promise<BrandReview> {
  const brand = await runBrandReview({
    pageId: competitor.pageId,
    pageName: competitor.pageName,
    pageProfileUri: competitor.sampleAd?.advertiserPageUrl || null,
    websiteHint:
      competitor.brand?.website ||
      competitor.sampleAd?.landingPageUrl ||
      null,
    adYoutubeUrl: competitor.platform === "youtube" ? competitor.sampleAd?.advertiserPageUrl || null : null,
    previous: competitor.brand || null,
    categoryHint: competitor.brand?.category || null,
    sourcePlatform: competitor.platform,
    shouldAbort: stopped,
  });
  // A stopped check is cut short; its partial result is not saved.
  if (stopped()) throw new BrandReviewStopped();
  const patch: Partial<CompetitorRecord> = { brand };
  if (brand.address && !competitor.locationLabel) {
    patch.locationLabel = brand.address;
    patch.locationSource = "sociavault";
  }
  updateCompetitor(competitor.id, patch);
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
