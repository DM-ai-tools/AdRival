const BASE_URL = "https://api.sociavault.com";

function getApiKey(): string {
  const key = process.env.SOCIAVAULT_API_KEY;
  if (!key) {
    throw new Error("SOCIAVAULT_API_KEY is not set");
  }
  return key;
}

async function svFetch<T>(
  path: string,
  params: Record<string, string | boolean | number | undefined | null> = {},
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    headers: {
      "X-API-Key": getApiKey(),
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      (json as { error?: string }).error ||
      `SociaVault request failed (${res.status}) for ${path}`;
    throw new Error(msg);
  }

  return json as T;
}

export interface AdLibrarySearchResult {
  ad_archive_id?: string;
  ad_id?: string | null;
  is_active?: boolean | string;
  page_id?: string;
  page_name?: string;
  start_date_string?: string;
  end_date_string?: string;
  start_date?: number | string;
  total_active_time?: number | string | null;
  publisher_platform?: string[] | Record<string, string> | string;
  snapshot?: {
    title?: string;
    body?: { text?: string } | string;
    cta_text?: string;
    cta_type?: string;
    caption?: string;
    link_url?: string | null;
    link_description?: string;
    page_profile_uri?: string;
    page_name?: string;
    page_categories?: string[] | Record<string, string>;
    extra_texts?: unknown;
    extra_links?: string[] | Record<string, string>;
    cards?: Array<{
      title?: string;
      body?: string;
      link_url?: string;
      link_description?: string;
      original_image_url?: string;
    }> | Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface AdLibrarySearchResponse {
  success?: boolean;
  data?: {
    searchResults?: AdLibrarySearchResult[];
    results?: AdLibrarySearchResult[];
    cursor?: string | null;
    searchResultsCount?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export async function searchAdLibrary(params: {
  query: string;
  cursor?: string | null;
  country?: string;
  status?: string;
  search_type?: string;
  sort_by?: string;
  language?: string;
  media_type?: string;
  trim?: boolean;
}): Promise<AdLibrarySearchResponse> {
  return svFetch<AdLibrarySearchResponse>(
    "/v1/scrape/facebook-ad-library/search",
    {
      query: params.query,
      cursor: params.cursor ?? undefined,
      country: params.country ?? "US",
      status: params.status ?? "ACTIVE",
      search_type: params.search_type ?? "keyword_unordered",
      language: params.language ?? "EN",
      sort_by: params.sort_by ?? "total_impressions",
      media_type: params.media_type ?? "ALL",
      trim: params.trim ?? false,
    },
  );
}

export async function getCompanyAds(params: {
  pageId: string;
  status?: string;
  country?: string;
  cursor?: string | null;
  language?: string;
  trim?: boolean;
}): Promise<AdLibrarySearchResponse> {
  return svFetch<AdLibrarySearchResponse>(
    "/v1/scrape/facebook-ad-library/company-ads",
    {
      pageId: params.pageId,
      country: params.country ?? "US",
      status: params.status ?? "ACTIVE",
      language: params.language ?? "EN",
      cursor: params.cursor ?? undefined,
      trim: params.trim ?? true,
    },
  );
}

export async function searchCompanies(query: string) {
  return svFetch<{
    success?: boolean;
    data?: {
      searchResults?: Array<{
        page_id?: string;
        name?: string;
        category?: string;
        likes?: number;
        verification?: string;
        ig_username?: string;
        ig_followers?: number;
        image_uri?: string;
        page_alias?: string;
        country?: string | null;
        [key: string]: unknown;
      }> | Record<string, unknown>;
    };
  }>("/v1/scrape/facebook-ad-library/search-companies", { query });
}

export function extractCompanies(
  response: Awaited<ReturnType<typeof searchCompanies>>,
): Array<{
  page_id?: string;
  name?: string;
  category?: string;
  likes?: number;
  verification?: string;
  ig_username?: string;
  ig_followers?: number;
  image_uri?: string;
  page_alias?: string;
  country?: string | null;
  [key: string]: unknown;
}> {
  return normalizeList(response.data?.searchResults);
}

export async function getAdDetails(id: string) {
  return svFetch<{ success?: boolean; data?: Record<string, unknown> }>(
    "/v1/scrape/facebook-ad-library/ad-details",
    { id, trim: true },
  );
}

export async function getFacebookProfile(url: string) {
  return svFetch<{
    success?: boolean;
    data?: {
      name?: string;
      url?: string;
      followerCount?: number;
      likeCount?: number;
      website?: string;
      category?: string;
      pageIntro?: string;
      [key: string]: unknown;
    };
  }>("/v1/scrape/facebook/profile", { url });
}

export async function getInstagramProfile(handle: string) {
  return svFetch<{
    success?: boolean;
    data?: {
      data?: {
        user?: {
          username?: string;
          edge_followed_by?: { count?: number };
          external_url?: string;
          biography?: string;
          [key: string]: unknown;
        };
      };
      [key: string]: unknown;
    };
  }>("/v1/scrape/instagram/profile", { handle, trim: true });
}

export async function getTwitterProfile(handle: string) {
  return svFetch<{
    success?: boolean;
    data?: {
      legacy?: { followers_count?: number; screen_name?: string };
      core?: { screen_name?: string; name?: string };
      [key: string]: unknown;
    };
  }>("/v1/scrape/twitter/profile", { handle });
}

export async function getYoutubeChannel(params: {
  handle?: string;
  url?: string;
  channelId?: string;
}) {
  return svFetch<{
    success?: boolean;
    data?: {
      name?: string;
      subscriberCount?: number;
      subscriberCountText?: string;
      handle?: string;
      url?: string;
      [key: string]: unknown;
    };
  }>("/v1/scrape/youtube/channel", params);
}

export async function getLinkedInCompany(url: string) {
  return svFetch<{
    success?: boolean;
    data?: {
      name?: string;
      employeeCount?: number;
      followers?: number;
      website?: string;
      handle?: string;
      url?: string;
      [key: string]: unknown;
    };
  }>("/v1/scrape/linkedin/company", { url });
}

export async function googleSearch(query: string, region = "US") {
  return svFetch<{
    success?: boolean;
    data?: {
      results?: Record<string, { title?: string; url?: string; description?: string }> | Array<{
        title?: string;
        url?: string;
        description?: string;
      }>;
      [key: string]: unknown;
    };
  }>("/v1/scrape/google/search", { query, region });
}

/**
 * SociaVault often returns list payloads as objects with numeric keys
 * ({ "0": {...}, "1": {...} }) instead of JSON arrays.
 */
export function normalizeList<T>(value: unknown): T[] {
  if (!value) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, T>)
      .filter(([k]) => /^\d+$/.test(k))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, v]) => v);
    if (entries.length > 0) return entries;
  }
  return [];
}

export function extractAds(
  response: AdLibrarySearchResponse,
): AdLibrarySearchResult[] {
  const data = response.data ?? {};
  const fromSearch = normalizeList<AdLibrarySearchResult>(data.searchResults);
  if (fromSearch.length > 0) return fromSearch;
  return normalizeList<AdLibrarySearchResult>(data.results);
}

export function extractCursor(
  response: AdLibrarySearchResponse,
): string | null {
  const cursor = response.data?.cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}

export function extractAdBody(
  snapshot?: AdLibrarySearchResult["snapshot"],
): string {
  if (!snapshot) return "";
  const body = snapshot.body;
  if (typeof body === "string") return body;
  if (body && typeof body === "object" && "text" in body) {
    return String((body as { text?: string }).text ?? "");
  }
  const cards = normalizeList<{ title?: string; body?: string }>(
    snapshot.cards,
  );
  return cards[0]?.body ? String(cards[0].body) : "";
}

export function extractAdTitle(
  snapshot?: AdLibrarySearchResult["snapshot"],
): string {
  if (!snapshot) return "";
  if (snapshot.title) return String(snapshot.title);
  const cards = normalizeList<{ title?: string; body?: string }>(
    snapshot.cards,
  );
  return cards[0]?.title ? String(cards[0].title) : "";
}

/**
 * Pull every usable text field from an ad creative for LLM review.
 * Headline/CTA alone are not enough — body, cards, link description, extras matter.
 */
export function extractFullAdCopy(
  snapshot?: AdLibrarySearchResult["snapshot"] & Record<string, unknown>,
): {
  title: string;
  body: string;
  ctaText: string | null;
  landingPageUrl: string | null;
  linkDescription: string | null;
  caption: string | null;
  pageCategories: string[];
  fullText: string;
} {
  const title = extractAdTitle(snapshot);
  const body = extractAdBody(snapshot);
  const ctaText = snapshot?.cta_text ? String(snapshot.cta_text) : null;
  const linkDescription = snapshot?.link_description
    ? String(snapshot.link_description)
    : null;
  const caption = snapshot?.caption ? String(snapshot.caption) : null;

  const cards = normalizeList<{
    title?: string;
    body?: string;
    link_url?: string;
    link_description?: string;
  }>(snapshot?.cards);

  const cardTexts = cards
    .map((c, i) => {
      const parts = [
        c.title ? `Card ${i + 1} title: ${c.title}` : "",
        c.body ? `Card ${i + 1} body: ${c.body}` : "",
        c.link_description
          ? `Card ${i + 1} link description: ${c.link_description}`
          : "",
        c.link_url ? `Card ${i + 1} link URL: ${c.link_url}` : "",
      ].filter(Boolean);
      return parts.join("\n");
    })
    .filter(Boolean);

  const extraTexts = normalizeList<string | { text?: string }>(
    snapshot?.extra_texts,
  )
    .map((t) => (typeof t === "string" ? t : t?.text ? String(t.text) : ""))
    .filter(Boolean);

  const pageCategories = normalizeList<string>(snapshot?.page_categories);
  const landingPageUrl = extractLandingPageUrl(snapshot);

  const sections = [
    title ? `Headline: ${title}` : "",
    body ? `Primary body:\n${body}` : "",
    linkDescription ? `Link description: ${linkDescription}` : "",
    caption ? `Caption / display URL: ${caption}` : "",
    ctaText ? `CTA: ${ctaText}` : "",
    landingPageUrl ? `Landing page URL: ${landingPageUrl}` : "",
    cardTexts.length ? `Carousel / cards:\n${cardTexts.join("\n\n")}` : "",
    extraTexts.length ? `Extra texts:\n${extraTexts.join("\n")}` : "",
    pageCategories.length
      ? `Page categories: ${pageCategories.join(", ")}`
      : "",
  ].filter(Boolean);

  return {
    title,
    body,
    ctaText,
    landingPageUrl,
    linkDescription,
    caption,
    pageCategories,
    fullText: sections.join("\n\n"),
  };
}

/**
 * Accept any real destination URL (website, WhatsApp, etc.).
 * Still reject empty / Meta short-link-only placeholders without a host.
 */
export function isLandingPageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (!/^https?:$/i.test(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return false;
  // Bare Meta redirectors with no useful destination
  if (host === "fb.me" || host === "l.facebook.com" || host === "lm.facebook.com") {
    return false;
  }
  return true;
}

/**
 * Prefer snapshot.link_url; if it's a Meta short link, fall back to extra_links / card links.
 */
export function extractLandingPageUrl(
  snapshot?: AdLibrarySearchResult["snapshot"] & Record<string, unknown>,
): string | null {
  if (!snapshot) return null;

  const candidates: string[] = [];
  if (snapshot.link_url) candidates.push(String(snapshot.link_url));

  const extras = normalizeList<string>(snapshot.extra_links);
  for (const e of extras) {
    if (e) candidates.push(String(e));
  }

  const cards = normalizeList<{ link_url?: string }>(snapshot.cards);
  for (const c of cards) {
    if (c.link_url) candidates.push(String(c.link_url));
  }

  // Caption sometimes holds a bare domain
  if (snapshot.caption && typeof snapshot.caption === "string") {
    const cap = snapshot.caption.trim();
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(cap)) {
      candidates.push(`https://${cap.replace(/^https?:\/\//i, "")}`);
    }
  }

  for (const raw of candidates) {
    const cleaned = raw.trim();
    if (!cleaned || cleaned.toLowerCase() === "null") continue;
    const withProto = /^https?:\/\//i.test(cleaned)
      ? cleaned
      : `https://${cleaned}`;
    if (isLandingPageUrl(withProto)) return withProto;
  }
  return null;
}

/** True if Meta ad runs on Instagram (publisher_platform list). */
export function adRunsOnInstagram(ad: AdLibrarySearchResult): boolean {
  const platforms = normalizeList<string>(ad.publisher_platform).map((p) =>
    String(p).toLowerCase(),
  );
  // Meta often omits publisher_platform — keep candidates so IG search isn't empty
  if (platforms.length === 0) return true;
  return platforms.some((p) => p.includes("instagram"));
}

/** True if Meta ad runs on Facebook feed/placements. */
export function adRunsOnFacebook(ad: AdLibrarySearchResult): boolean {
  const platforms = normalizeList<string>(ad.publisher_platform).map((p) =>
    String(p).toLowerCase(),
  );
  if (platforms.length === 0) return true; // default Meta search → treat as Facebook-eligible
  return platforms.some(
    (p) => p.includes("facebook") || p === "messenger" || p === "audience_network",
  );
}

/* ── Google Ads Transparency ── */

export interface GoogleAdvertiser {
  name?: string;
  advertiser_id?: string;
  region?: string;
  [key: string]: unknown;
}

export async function searchGoogleAdvertisers(query: string) {
  return svFetch<{
    success?: boolean;
    data?: {
      advertisers?: GoogleAdvertiser[] | Record<string, GoogleAdvertiser>;
      websites?: Array<{ domain?: string }> | Record<string, { domain?: string }>;
      [key: string]: unknown;
    };
  }>("/v1/scrape/google-ad-library/search-advertisers", { query });
}

export function extractGoogleAdvertisers(
  response: Awaited<ReturnType<typeof searchGoogleAdvertisers>>,
): GoogleAdvertiser[] {
  return normalizeList<GoogleAdvertiser>(response.data?.advertisers);
}

export function extractGoogleWebsites(
  response: Awaited<ReturnType<typeof searchGoogleAdvertisers>>,
): string[] {
  return normalizeList<{ domain?: string }>(response.data?.websites)
    .map((w) => w.domain)
    .filter((d): d is string => Boolean(d));
}

export interface GoogleAdCreative {
  advertiserId?: string;
  creativeId?: string;
  format?: string;
  adUrl?: string;
  advertiserName?: string;
  domain?: string;
  imageUrl?: string | null;
  firstShown?: string;
  lastShown?: string;
  [key: string]: unknown;
}

export async function getGoogleCompanyAds(params: {
  advertiser_id?: string;
  domain?: string;
  region?: string;
  topic?: string;
  start_date?: string;
  end_date?: string;
  cursor?: string | null;
}) {
  return svFetch<{
    success?: boolean;
    data?: {
      ads?: GoogleAdCreative[] | Record<string, GoogleAdCreative>;
      cursor?: string | null;
      [key: string]: unknown;
    };
  }>("/v1/scrape/google-ad-library/company-ads", {
    advertiser_id: params.advertiser_id,
    domain: params.domain,
    region: params.region ?? "US",
    topic: params.topic ?? "all",
    start_date: params.start_date,
    end_date: params.end_date,
    cursor: params.cursor ?? undefined,
  });
}

export function extractGoogleAds(
  response: Awaited<ReturnType<typeof getGoogleCompanyAds>>,
): GoogleAdCreative[] {
  return normalizeList<GoogleAdCreative>(response.data?.ads);
}

export function extractGoogleCursor(
  response: Awaited<ReturnType<typeof getGoogleCompanyAds>>,
): string | null {
  const c = response.data?.cursor;
  return c ? String(c) : null;
}

export async function getGoogleAdDetails(url: string) {
  return svFetch<{
    success?: boolean;
    data?: {
      format?: string;
      variations?: Array<{
        headline?: string;
        description?: string;
        destinationUrl?: string;
        visibleUrl?: string;
        youtubeUrl?: string | null;
        [key: string]: unknown;
      }> | Record<string, unknown>;
      [key: string]: unknown;
    };
  }>("/v1/scrape/google-ad-library/ad-details", { url });
}

/* ── LinkedIn Ad Library ── */

export interface LinkedInAd {
  id?: string;
  description?: string;
  headline?: string | null;
  poster?: string;
  adType?: string;
  advertiser?: string;
  advertiserLinkedinPage?: string;
  image?: string | null;
  video?: string | null;
  cta?: string | null;
  destinationUrl?: string | null;
  /** Human-readable run window, e.g. "Ran from Feb 6, 2026 to Feb 8, 2026" */
  adDuration?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  totalImpressions?: string | null;
  url?: string;
  targeting?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function searchLinkedInAds(params: {
  keyword?: string;
  company?: string;
  countries?: string;
  startDate?: string;
  endDate?: string;
  paginationToken?: string | null;
}) {
  return svFetch<{
    success?: boolean;
    data?: {
      ads?: LinkedInAd[] | Record<string, LinkedInAd>;
      paginationToken?: string | null;
      isLastPage?: boolean;
      [key: string]: unknown;
    };
  }>("/v1/scrape/linkedin-ad-library/search", {
    keyword: params.keyword,
    company: params.company,
    countries: params.countries ?? "US,AU",
    startDate: params.startDate,
    endDate: params.endDate,
    paginationToken: params.paginationToken ?? undefined,
  });
}

export function extractLinkedInAds(
  response: Awaited<ReturnType<typeof searchLinkedInAds>>,
): LinkedInAd[] {
  return normalizeList<LinkedInAd>(response.data?.ads);
}

export function extractLinkedInPagination(
  response: Awaited<ReturnType<typeof searchLinkedInAds>>,
): { token: string | null; isLastPage: boolean } {
  return {
    token: response.data?.paginationToken
      ? String(response.data.paginationToken)
      : null,
    isLastPage: Boolean(response.data?.isLastPage),
  };
}
