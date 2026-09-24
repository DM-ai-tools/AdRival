import { v4 as uuidv4 } from "uuid";
import {
  getFacebookProfile,
  getInstagramProfile,
  getLinkedInCompany,
  getTwitterProfile,
  getYoutubeChannel,
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
  extractFacebookUrl,
  extractInstagramHandle,
  extractLinkedInCompanyUrl,
  extractTwitterHandle,
  extractYouTubeParams,
  socialLinksToSociavaultParams,
  type SociavaultSocialParams,
} from "./socialParams";
import { applyBrandScoresForJob, withBrandScore } from "./brandScore";
import {
  getCompetitorsByRun,
  getJob,
  isSearchJobSuppressed,
  clearSearchJobSuppression,
  saveJob,
  updateCompetitor,
} from "../db";
import {
  getOpenAICompatClient,
  hasOpenAICompatKey,
  resolveOpenAICompatModel,
} from "../openrouter/openaiCompat";
import type { BrandReview, CompetitorRecord, SearchJob } from "../types";

export { normalizeLinkedInCompanyUrl, parseYouTubeFromUrl } from "./socialParams";

function safeNum(n: unknown): number | null {
  if (typeof n === "number" && Number.isFinite(n)) return Math.round(n);
  if (typeof n === "string" && n.trim()) {
    const cleaned = n.replace(/,/g, "").trim();
    const asNum = Number(cleaned);
    if (!Number.isNaN(asNum) && Number.isFinite(asNum)) return Math.round(asNum);
    const range = cleaned.match(/([\d.]+)\s*[–-]\s*([\d.]+)/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (Number.isFinite(a) && Number.isFinite(b)) return Math.round((a + b) / 2);
    }
    const m = cleaned.match(/([\d.]+)\s*([kmb])\b/i);
    if (m) {
      const base = Number(m[1]);
      if (!Number.isFinite(base)) return null;
      const mult =
        m[2].toLowerCase() === "k"
          ? 1_000
          : m[2].toLowerCase() === "m"
            ? 1_000_000
            : 1_000_000_000;
      return Math.round(base * mult);
    }
    const plus = cleaned.match(/([\d.]+)\s*\+/);
    if (plus) return Math.round(Number(plus[1]));
  }
  return null;
}

function digNum(root: unknown, paths: string[][]): number | null {
  for (const path of paths) {
    let cur: unknown = root;
    for (const key of path) {
      if (!cur || typeof cur !== "object") {
        cur = null;
        break;
      }
      cur = (cur as Record<string, unknown>)[key];
    }
    const n = safeNum(cur);
    if (n != null) return n;
  }
  return null;
}

function unwrapSvData(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const root = payload as Record<string, unknown>;
  const inner = root.data;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const nested = inner as Record<string, unknown>;
    if (
      "followerCount" in nested ||
      "followers" in nested ||
      "employeeCount" in nested ||
      "subscriberCount" in nested ||
      "legacy" in nested ||
      "user" in nested
    ) {
      return nested;
    }
  }
  return root;
}

function digAnyFollowerCount(root: unknown, depth = 0): number | null {
  if (!root || typeof root !== "object" || depth > 4) return null;
  const obj = root as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (/follower/i.test(key) && !/following/i.test(key)) {
      const n = safeNum(value);
      if (n != null && n >= 0) return n;
      if (typeof value === "string") {
        const m = value.match(/([\d,.]+)\s*[kmb]?/i);
        if (m) {
          const parsed = safeNum(m[0]);
          if (parsed != null) return parsed;
        }
      }
    }
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = digAnyFollowerCount(value, depth + 1);
      if (nested != null) return nested;
    }
  }
  return null;
}

/** Landing deep-links often hide footer socials — also scrape origin, apex, contact/about. */
function scrapeUrlCandidates(website: string): string[] {
  const normalized = normalizeWebsiteUrl(website);
  if (!normalized) return [];
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    if (!u) return;
    const clean = u.replace(/\/$/, "");
    if (!out.includes(clean)) out.push(clean);
  };
  const pushWithSocialPages = (origin: string) => {
    push(origin);
    for (const path of ["/contact", "/about", "/about-us", "/company"]) {
      push(`${origin}${path}`);
    }
  };
  try {
    const u = new URL(normalized);
    push(`${u.origin}${u.pathname}`.replace(/\/$/, "") || u.origin);
    pushWithSocialPages(u.origin);
    const host = u.hostname.replace(/^www\./i, "");
    const parts = host.split(".");
    if (parts.length >= 3) {
      let apexHost: string | null = null;
      if (/\.(com|co|net|org|gov)\.[a-z]{2}$/i.test(host) || parts.length >= 4) {
        apexHost = parts.slice(-3).join(".");
      } else if (parts.length === 3) {
        apexHost = parts.slice(-2).join(".");
      }
      if (apexHost && apexHost !== host) {
        pushWithSocialPages(`${u.protocol}//${apexHost}`);
      }
      const parent = parts.slice(1).join(".");
      if (parent && parent !== host && parent !== apexHost) {
        pushWithSocialPages(`${u.protocol}//${parent}`);
      }
    }
  } catch {
    push(normalized);
  }
  return out.slice(0, 5);
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

async function searchSocialHrefs(
  pageName: string,
  website: string | null,
  current: SociavaultSocialParams,
  shouldAbort?: () => boolean,
): Promise<string[]> {
  if (!hasFirecrawlKey()) return [];
  if (shouldAbort?.()) return [];
  const hrefs: string[] = [];
  let slug: string | null = null;
  try {
    if (website) {
      slug = brandSlugFromHost(new URL(website).hostname);
    }
  } catch {
    /* ignore */
  }
  const brand = pageName.replace(/[^\w\s&'-]/g, " ").trim().slice(0, 80);
  if (!brand && !slug) return [];

  const queries: string[] = [];
  const add = (need: boolean, q: string) => {
    if (need && q.trim()) queries.push(q);
  };
  add(!current.instagram, `"${brand}" site:instagram.com`);
  add(!current.twitter, `"${brand}" (site:twitter.com OR site:x.com)`);
  add(!current.youtube, `"${brand}" site:youtube.com`);
  add(!current.linkedin, `"${brand}" site:linkedin.com/company`);
  add(!current.facebook, `"${brand}" site:facebook.com`);
  if (slug) {
    add(!current.instagram, `${slug} site:instagram.com`);
    add(!current.linkedin, `${slug} site:linkedin.com/company`);
  }

  const uniqueQueries = Array.from(new Set(queries)).slice(0, 4);
  for (const q of uniqueQueries) {
    if (shouldAbort?.()) break;
    try {
      const search = await firecrawlSearch(q, { limit: 4 });
      for (const row of flattenFirecrawlSearchResults(search)) {
        if (row.url && detectSocialNetwork(row.url)) hrefs.push(row.url);
        pushSocialUrlsFromText(
          `${row.title || ""} ${row.description || ""} ${row.url || ""}`,
          hrefs,
        );
      }
    } catch (err) {
      console.warn(
        "[brandReview] Firecrawl social search failed:",
        q,
        (err as Error).message,
      );
    }
  }
  return hrefs;
}

async function collectSocialHrefsFromWebsite(
  website: string,
  pageName?: string | null,
  shouldAbort?: () => boolean,
): Promise<{ hrefs: string[]; markdown: string | null; canonicalWebsite: string | null }> {
  const hrefs: string[] = [];
  let markdown: string | null = null;
  let canonicalWebsite: string | null = normalizeWebsiteUrl(website);
  if (!hasFirecrawlKey()) return { hrefs, markdown, canonicalWebsite };

  const candidates = scrapeUrlCandidates(website);
  for (const url of candidates) {
    if (shouldAbort?.()) break;
    try {
      const scraped = await firecrawlScrapeBranding(url);
      const data = scraped.data;
      if (!markdown && typeof data?.markdown === "string" && data.markdown.trim()) {
        markdown = data.markdown.slice(0, 12_000);
      }
      if (data?.metadata?.sourceURL) {
        canonicalWebsite =
          normalizeWebsiteUrl(String(data.metadata.sourceURL)) || canonicalWebsite;
      } else if (!canonicalWebsite) {
        canonicalWebsite = normalizeWebsiteUrl(url);
      }
      hrefs.push(
        ...extractSocialHrefsFromScrape(
          data as {
            links?: string[];
            html?: string | null;
            markdown?: string | null;
            branding?: Record<string, unknown> | null;
          },
          url,
        ),
      );
      if (platformCount(socialLinksToSociavaultParams(hrefs)) >= 4) break;
    } catch (err) {
      console.warn(
        "[brandReview] Firecrawl scrape failed for",
        url,
        (err as Error).message,
      );
    }
  }

  const partial = socialLinksToSociavaultParams(hrefs);
  if (platformCount(partial) < 4 && pageName && !shouldAbort?.()) {
    hrefs.push(
      ...(await searchSocialHrefs(
        pageName,
        canonicalWebsite || website,
        partial,
        shouldAbort,
      )),
    );
  }

  return {
    hrefs: Array.from(new Set(hrefs)),
    markdown,
    canonicalWebsite,
  };
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

async function fetchMetricsFromParams(
  params: SociavaultSocialParams,
  brand: BrandReview,
  options?: { linkedinIsGuess?: boolean },
): Promise<void> {
  const tasks: Array<Promise<void>> = [];

  if (params.facebook?.url) {
    brand.facebookUrl = params.facebook.url;
    tasks.push(
      (async () => {
        try {
          const fb = await getFacebookProfile(params.facebook!.url);
          const data = unwrapSvData(fb.data || fb);
          brand.facebookUrl =
            (typeof data.url === "string" && data.url) || params.facebook!.url;
          brand.facebookFollowers = digNum(data, [
            ["followerCount"],
            ["followers"],
            ["fan_count"],
            ["page_followers"],
          ]);
          brand.facebookLikes = digNum(data, [["likeCount"], ["likes"]]);
          brand.category =
            (typeof data.category === "string" && data.category) || brand.category;
          if (!brand.website && data.website) {
            brand.website = normalizeWebsiteUrl(String(data.website));
          }
          if (typeof data.address === "string" && data.address.trim()) {
            brand.address = data.address.trim();
          }
          const introBits = [
            typeof data.pageIntro === "string" ? data.pageIntro : "",
            typeof data.about === "string" ? data.about : "",
            typeof data.website === "string" ? data.website : "",
          ].join("\n");
          if (introBits.trim()) {
            const found: string[] = [];
            pushSocialUrlsFromText(introBits, found);
            for (const href of found) {
              if (!brand.instagramHandle) {
                const ig = extractInstagramHandle(href);
                if (ig) brand.instagramHandle = ig;
              }
              if (!brand.twitterHandle) {
                const tw = extractTwitterHandle(href);
                if (tw) brand.twitterHandle = tw;
              }
              if (!brand.youtubeUrl && !brand.youtubeHandle) {
                const yt = extractYouTubeParams(href);
                if (yt) {
                  brand.youtubeUrl = yt.url || brand.youtubeUrl;
                  brand.youtubeHandle = yt.handle || brand.youtubeHandle;
                }
              }
              if (!brand.linkedinUrl) {
                const li = extractLinkedInCompanyUrl(href);
                if (li) brand.linkedinUrl = li;
              }
            }
          }
        } catch (err) {
          console.warn(
            "[brandReview] Facebook profile failed:",
            (err as Error).message,
          );
        }
      })(),
    );
  }

  if (params.instagram?.handle) {
    const handle = params.instagram.handle.replace(/^@/, "");
    brand.instagramHandle = handle;
    tasks.push(
      (async () => {
        try {
          const ig = await getInstagramProfile(handle);
          const root = unwrapSvData(ig.data || ig);
          brand.instagramFollowers = digNum(root, [
            ["data", "user", "edge_followed_by", "count"],
            ["user", "edge_followed_by", "count"],
            ["edge_followed_by", "count"],
            ["follower_count"],
            ["followers"],
          ]);
          if (brand.instagramFollowers == null) {
            const edge = (root as { edge_followed_by?: { count?: number } })
              .edge_followed_by;
            brand.instagramFollowers = safeNum(edge?.count);
          }
          const username =
            (root as { data?: { user?: { username?: string } } })?.data?.user
              ?.username ||
            (root as { user?: { username?: string } })?.user?.username ||
            (root as { username?: string }).username;
          if (typeof username === "string" && username.trim()) {
            brand.instagramHandle = username.replace(/^@/, "");
          }
          const external =
            (root as { data?: { user?: { external_url?: string } } })?.data?.user
              ?.external_url ||
            (root as { user?: { external_url?: string } })?.user?.external_url;
          if (!brand.website && external) {
            brand.website = normalizeWebsiteUrl(String(external));
          }
        } catch (err) {
          console.warn(
            "[brandReview] Instagram profile failed:",
            (err as Error).message,
          );
        }
      })(),
    );
  }

  if (params.twitter?.handle) {
    const handle = params.twitter.handle.replace(/^@/, "");
    brand.twitterHandle = handle;
    tasks.push(
      (async () => {
        try {
          const tw = await getTwitterProfile(handle);
          const data = unwrapSvData(tw.data || tw);
          brand.twitterFollowers = digNum(data, [
            ["legacy", "followers_count"],
            ["followers_count"],
            ["followers"],
            ["normal_followers_count"],
          ]);
          const screen =
            (data.core as { screen_name?: string } | undefined)?.screen_name ||
            (data.legacy as { screen_name?: string } | undefined)?.screen_name;
          if (screen) brand.twitterHandle = String(screen).replace(/^@/, "");
        } catch (err) {
          console.warn(
            "[brandReview] Twitter profile failed:",
            (err as Error).message,
          );
        }
      })(),
    );
  }

  if (
    params.youtube &&
    (params.youtube.channelId || params.youtube.handle || params.youtube.url)
  ) {
    brand.youtubeHandle = params.youtube.handle
      ? params.youtube.handle.replace(/^@/, "")
      : brand.youtubeHandle;
    brand.youtubeUrl = params.youtube.url || brand.youtubeUrl;
    tasks.push(
      (async () => {
        try {
          const yt = await getYoutubeChannel({
            channelId: params.youtube!.channelId,
            handle: params.youtube!.handle
              ? params.youtube!.handle.replace(/^@/, "")
              : undefined,
            url: params.youtube!.url,
          });
          const data = unwrapSvData(yt.data || yt);
          brand.youtubeSubscribers =
            digNum(data, [["subscriberCount"], ["subscribers"]]) ??
            safeNum(data.subscriberCountText);
          brand.youtubeUrl =
            (typeof data.url === "string" && data.url) ||
            (typeof data.channel === "string" && data.channel) ||
            brand.youtubeUrl;
          if (data.handle) {
            brand.youtubeHandle = String(data.handle).replace(/^@/, "");
          }
          const links = data.links;
          const linkList: string[] = Array.isArray(links)
            ? links.filter((x): x is string => typeof x === "string")
            : links && typeof links === "object"
              ? Object.values(links).filter(
                  (x): x is string => typeof x === "string",
                )
              : [];
          for (const key of ["twitter", "instagram", "facebook", "linkedin"] as const) {
            const v = data[key];
            if (typeof v === "string") linkList.push(v);
          }
          for (const href of linkList) {
            if (!brand.instagramHandle) {
              const ig = extractInstagramHandle(href);
              if (ig) brand.instagramHandle = ig;
            }
            if (!brand.twitterHandle) {
              const tw = extractTwitterHandle(href);
              if (tw) brand.twitterHandle = tw;
            }
            if (!brand.facebookUrl) {
              const fb = extractFacebookUrl(href);
              if (fb) brand.facebookUrl = fb;
            }
            if (!brand.linkedinUrl) {
              const li = extractLinkedInCompanyUrl(href);
              if (li) brand.linkedinUrl = li;
            }
          }
        } catch (err) {
          console.warn(
            "[brandReview] YouTube channel failed:",
            (err as Error).message,
          );
        }
      })(),
    );
  }

  if (params.linkedin?.url) {
    brand.linkedinUrl = params.linkedin.url;
    tasks.push(
      (async () => {
        try {
          const li = await getLinkedInCompany(params.linkedin!.url);
          const data = unwrapSvData(li.data || li);
          brand.linkedinUrl =
            (typeof data.url === "string" && data.url) || params.linkedin!.url;
          brand.linkedinEmployees =
            digNum(data, [["employeeCount"], ["staffCount"], ["employees"]]) ??
            safeNum(data.size);
          brand.linkedinFollowers =
            digNum(data, [
              ["followers"],
              ["followerCount"],
              ["follower_count"],
              ["companyFollowers"],
              ["numFollowers"],
            ]) ?? digAnyFollowerCount(data);
          if (!brand.website && data.website) {
            brand.website = normalizeWebsiteUrl(String(data.website));
          }
          if (!brand.address) {
            if (
              typeof data.headquarters === "string" &&
              data.headquarters.trim()
            ) {
              brand.address = data.headquarters.trim();
            } else if (data.location && typeof data.location === "object") {
              const loc = data.location as {
                city?: string;
                state?: string;
                country?: string;
              };
              const label = [loc.city, loc.state, loc.country]
                .filter(Boolean)
                .join(", ");
              if (label) brand.address = label;
            } else if (
              typeof data.location === "string" &&
              data.location.trim()
            ) {
              brand.address = data.location.trim();
            }
          }
          if (
            options?.linkedinIsGuess &&
            brand.linkedinEmployees == null &&
            brand.linkedinFollowers == null
          ) {
            brand.linkedinUrl = null;
          }
        } catch (err) {
          console.warn(
            "[brandReview] LinkedIn company failed:",
            (err as Error).message,
          );
          if (options?.linkedinIsGuess) brand.linkedinUrl = null;
        }
      })(),
    );
  }

  await Promise.all(tasks);
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
  /** Return true to bail out of long scrapes (e.g. user hit Stop). */
  shouldAbort?: () => boolean;
}): Promise<BrandReview> {
  const abort = () => Boolean(input.shouldAbort?.());
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
  let siteMarkdown: string | null = null;
  if (brand.website && !abort()) {
    const collected = await collectSocialHrefsFromWebsite(
      brand.website,
      input.pageName,
      abort,
    );
    siteMarkdown = collected.markdown;
    if (collected.canonicalWebsite) {
      brand.website = collected.canonicalWebsite;
    }
    firecrawlParams = socialLinksToSociavaultParams(collected.hrefs);
  } else if (input.pageName && !abort()) {
    const found = await searchSocialHrefs(
      input.pageName,
      null,
      hintParams,
      abort,
    );
    firecrawlParams = socialLinksToSociavaultParams(found);
  }

  if (abort()) {
    brand.website = normalizeWebsiteUrl(brand.website) || null;
    return brand;
  }

  const params = mergeParams(firecrawlParams, hintParams);

  let linkedinIsGuess = false;
  if (!params.linkedin) {
    const guessed = guessLinkedInFromWebsite(brand.website);
    if (guessed) {
      params.linkedin = { url: guessed };
      linkedinIsGuess = true;
    }
  }

  if (
    input.sourcePlatform === "google" ||
    input.sourcePlatform === "youtube"
  ) {
    params.facebook = firecrawlParams.facebook || hintParams.facebook || null;
  }

  await fetchMetricsFromParams(params, brand, { linkedinIsGuess });
  if (abort()) {
    brand.website = normalizeWebsiteUrl(brand.website) || null;
    return brand;
  }

  const followUp: SociavaultSocialParams = {};
  if (brand.instagramHandle && brand.instagramFollowers == null) {
    followUp.instagram = { handle: brand.instagramHandle };
  }
  if (brand.twitterHandle && brand.twitterFollowers == null) {
    followUp.twitter = { handle: brand.twitterHandle };
  }
  if (brand.facebookUrl && brand.facebookFollowers == null) {
    followUp.facebook = { url: brand.facebookUrl };
  }
  if (
    brand.linkedinUrl &&
    brand.linkedinEmployees == null &&
    brand.linkedinFollowers == null
  ) {
    followUp.linkedin = { url: brand.linkedinUrl };
  }
  if (brand.youtubeUrl && brand.youtubeSubscribers == null) {
    followUp.youtube = extractYouTubeParams(brand.youtubeUrl);
  }
  if (
    followUp.facebook ||
    followUp.instagram ||
    followUp.twitter ||
    followUp.linkedin ||
    followUp.youtube
  ) {
    await fetchMetricsFromParams(followUp, brand);
  }

  const stillThin =
    !abort() &&
    (!brand.instagramHandle ||
      !brand.twitterHandle ||
      !(brand.youtubeUrl || brand.youtubeHandle) ||
      !brand.linkedinUrl);
  if (stillThin) {
    const current: SociavaultSocialParams = {
      facebook: brand.facebookUrl ? { url: brand.facebookUrl } : null,
      instagram: brand.instagramHandle
        ? { handle: brand.instagramHandle }
        : null,
      twitter: brand.twitterHandle ? { handle: brand.twitterHandle } : null,
      youtube:
        brand.youtubeUrl || brand.youtubeHandle
          ? extractYouTubeParams(brand.youtubeUrl || brand.youtubeHandle || "")
          : null,
      linkedin: brand.linkedinUrl ? { url: brand.linkedinUrl } : null,
    };
    // Search only — avoid a second full multi-page scrape (that was hanging the UI).
    const searched = await searchSocialHrefs(
      input.pageName,
      brand.website ?? null,
      current,
      abort,
    );
    const more = socialLinksToSociavaultParams(searched);
    const gap: SociavaultSocialParams = {};
    if (more.instagram && !brand.instagramHandle) gap.instagram = more.instagram;
    if (more.twitter && !brand.twitterHandle) gap.twitter = more.twitter;
    if (more.youtube && !brand.youtubeUrl && !brand.youtubeHandle) {
      gap.youtube = more.youtube;
    }
    if (more.linkedin && !brand.linkedinUrl) gap.linkedin = more.linkedin;
    if (more.facebook && !brand.facebookUrl) gap.facebook = more.facebook;
    if (
      !abort() &&
      (gap.instagram ||
        gap.twitter ||
        gap.youtube ||
        gap.linkedin ||
        gap.facebook)
    ) {
      await fetchMetricsFromParams(gap, brand);
    }
  }

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

/** Run brand review for every competitor in a finished search job. */
export async function runBrandReviewForJob(
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

  const total = competitors.length;
  job.progress.stage = "brand_review";
  job.progress.brandReviewDone = 0;
  job.progress.brandReviewTotal = total;
  job.progress.brandReviewCurrentName = null;
  job.progress.stopRequested = false;
  job.progress.message = `Brand review starting for ${total} competitors…`;
  job.updatedAt = new Date().toISOString();
  if (!saveJob(job)) return { updated: 0, skipped: 0 };

  for (let i = 0; i < competitors.length; i++) {
    if (isSearchJobSuppressed(jobId)) {
      stopped = true;
      break;
    }
    const c = competitors[i];
    if (!options?.force && !isBrandReviewIncomplete(c.brand)) {
      skipped += 1;
      job.progress.brandReviewDone = i + 1;
      job.progress.brandReviewCurrentName = c.pageName;
      job.progress.message = `Brand review ${i + 1}/${total}: ${c.pageName} (skipped — complete)`;
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
        shouldAbort: () => isSearchJobSuppressed(jobId),
      });
      if (isSearchJobSuppressed(jobId)) {
        stopped = true;
        break;
      }
      const patch: Partial<CompetitorRecord> = { brand };
      if (brand.address && !c.locationLabel) {
        patch.locationLabel = brand.address;
        patch.locationSource = "sociavault";
        patch.locationStatus = c.locationStatus || "unknown";
      }
      updateCompetitor(c.id, patch);
      updated += 1;
    } catch (err) {
      console.warn(
        "[brandReview] failed for",
        c.pageName,
        (err as Error).message,
      );
    }

    if (isSearchJobSuppressed(jobId)) {
      stopped = true;
      break;
    }

    job.progress.brandReviewDone = i + 1;
    job.progress.brandReviewCurrentName = c.pageName;
    job.progress.message = `Brand review ${i + 1}/${total}: ${c.pageName} done`;
    job.updatedAt = new Date().toISOString();
    saveJob(job);
  }

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
            (skipped ? ` · ${skipped} skipped` : "");
    }
    fresh.updatedAt = new Date().toISOString();
    saveJob(fresh);
  }

  // Score from the metrics just saved. This does not scrape or re-run review.
  if (!stopped) applyBrandScoresForJob(jobId);

  return { updated, skipped, stopped };
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
