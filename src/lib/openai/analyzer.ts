import OpenAI from "openai";
import { z } from "zod";
import {
  RELAXED_RELEVANCE_THRESHOLD,
  RELEVANCE_THRESHOLD,
  SERVICE_LABELS,
  type AdCandidate,
  type BusinessCategory,
  type BusinessLocation,
  type BusinessProfile,
  type SearchGeoMode,
  type ServiceLabel,
} from "../types";

const KEYWORD_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "as",
  "is",
  "are",
  "be",
  "with",
  "from",
  "that",
  "this",
  "your",
  "ours",
  "their",
  "about",
  "into",
  "over",
  "under",
  "than",
  "then",
  "when",
  "what",
  "which",
  "while",
  "where",
  "have",
  "has",
  "been",
  "were",
  "will",
  "would",
  "could",
  "should",
  "service",
  "services",
  "business",
  "company",
  "online",
  "local",
  "best",
  "free",
  "near",
  "area",
  "city",
  "town",
]);

function tokenizeSignal(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !KEYWORD_STOPWORDS.has(t));
}

export type ServiceSignalOptions = {
  businessProfile?: BusinessProfile | null;
  searchKeywords?: string[] | null;
  selectedCategory?: BusinessCategory | null;
  /** When true, allow longer creatives without token hit (fill/relaxed only). */
  softPass?: boolean;
};

/** Tokens used for cheap keyword/service gates and sample-ad scoring. */
export function serviceSignalTokens(options?: ServiceSignalOptions): string[] {
  const parts: string[] = [
    ...(options?.searchKeywords || []),
    options?.selectedCategory?.label || "",
    options?.businessProfile?.industry || "",
    options?.businessProfile?.subIndustry || "",
    ...(options?.businessProfile?.offerings || []),
    ...(options?.businessProfile?.competitorKeywords || []),
  ];
  return Array.from(new Set(tokenizeSignal(parts.join(" "))));
}

/** 0–1 overlap of signal tokens present in ad copy. */
export function serviceKeywordOverlapScore(
  text: string,
  options?: ServiceSignalOptions,
): number {
  const tokens = serviceSignalTokens(options);
  if (!tokens.length) return 0;
  const blob = text.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    if (blob.includes(t)) hits += 1;
  }
  return Math.min(1, hits / Math.min(4, tokens.length));
}

function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey: key });
}

async function jsonCompletion<T>(
  system: string,
  user: string,
  schemaHint: string,
): Promise<T> {
  const client = getClient();
  const completion = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `${system}\n\nRespond with a single JSON object matching: ${schemaHint}`,
      },
      { role: "user", content: user },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Empty OpenAI response");
  return JSON.parse(content) as T;
}

const queryExpansionSchema = z.object({
  queries: z.array(z.string()).min(1),
});

export async function expandKeywordQueries(
  keyword: string,
  businessProfile?: BusinessProfile | null,
  geoOptions?: {
    geoMode?: SearchGeoMode | null;
    targetLocations?: BusinessLocation[] | null;
    selectedCategory?: BusinessCategory | null;
  },
): Promise<string[]> {
  const locLabels = (geoOptions?.targetLocations || [])
    .map((l) => l.suburb || l.city || l.label)
    .filter(Boolean)
    .slice(0, 4) as string[];
  const wantLocal =
    geoOptions?.geoMode === "company_locations" ||
    geoOptions?.geoMode === "keyword_location";
  const categoryLabel = geoOptions?.selectedCategory?.label || "";

  if (businessProfile) {
    const raw = await jsonCompletion<{ queries: string[] }>(
      `You expand Ad Library / ads-transparency search queries to find DIRECT competitors
for a business in a specific industry (NOT marketing agencies unless the business itself is an agency).

Industry context:
- Business: ${businessProfile.businessName}
- Industry: ${businessProfile.industry}${businessProfile.subIndustry ? ` / ${businessProfile.subIndustry}` : ""}
- Offerings: ${(businessProfile.offerings || []).join(", ") || "n/a"}
- Selected category: ${categoryLabel || "n/a"}
- Positioning: ${businessProfile.positioningSummary}
${wantLocal && locLabels.length ? `- Target markets: ${locLabels.join(", ")} — include location-qualified queries` : ""}

Return queries that surface rivals in the SAME industry advertising similar products/services.
Prefer precise service phrases from the seed keyword and offerings — avoid generic words like "business" or "online".`,
      `Seed keyword: "${keyword}"
Also consider these suggested competitor keywords: ${businessProfile.competitorKeywords.join(", ")}
Return 8-12 high-yield search queries.${wantLocal && locLabels.length ? ` Include several with city/suburb: ${locLabels.join(", ")}.` : ""}`,
      `{ "queries": string[] }`,
    );
    const parsed = queryExpansionSchema.safeParse(raw);
    const queries = parsed.success ? parsed.data.queries : [keyword];
    const geoSeeded =
      wantLocal && locLabels.length
        ? locLabels.flatMap((loc) => [
            `${keyword} ${loc}`,
            categoryLabel ? `${categoryLabel} ${loc}` : "",
            `${businessProfile.industry} ${loc}`,
          ])
        : [];
    const seeded = [
      keyword,
      categoryLabel,
      ...businessProfile.competitorKeywords,
      ...geoSeeded,
      ...queries,
    ];
    return Array.from(
      new Set(seeded.map((q) => q.trim()).filter(Boolean)),
    ).slice(0, 20);
  }

  const raw = await jsonCompletion<{ queries: string[] }>(
    `You help find Facebook Ads Library search queries for MARKETING AGENCIES only
(companies whose business is selling marketing services to other businesses).
Focus on agencies selling: Google Ads, SEO, AEO/GEO, and SMM.
Prefer queries with "agency", "marketing agency", "PPC agency", "SEO agency".
Avoid queries that surface random local businesses or product brands.`,
    `User keyword: "${keyword}"
Return 5-8 high-yield Ad Library search queries for agencies. Always include "${keyword} agency" and "${keyword} marketing agency".`,
    `{ "queries": string[] }`,
  );

  const parsed = queryExpansionSchema.safeParse(raw);
  const queries = parsed.success ? parsed.data.queries : [keyword];
  const seeded = [
    keyword,
    `${keyword} agency`,
    `${keyword} marketing agency`,
    "Google Ads agency",
    "Google Ads audit agency",
    "PPC agency",
    "PPC audit agency",
    "SEO agency",
    "social media marketing agency",
    "Facebook ads agency",
    ...queries,
  ];
  const unique = Array.from(
    new Set(seeded.map((q) => q.trim()).filter(Boolean)),
  );
  return unique.slice(0, 14);
}

const adFilterSchema = z.object({
  relevant: z.boolean(),
  relevanceScore: z.number(),
  isMarketingAgency: z.boolean(),
  services: z.union([z.array(z.string()), z.string()]),
  bodyEvidence: z.string().optional().default(""),
  reason: z.string(),
});

export interface AdFilterResult {
  relevant: boolean;
  relevanceScore: number;
  isMarketingAgency: boolean;
  services: ServiceLabel[];
  bodyEvidence: string;
  reason: string;
}

const SERVICE_ALIASES: Record<string, ServiceLabel> = {
  "google ads": "Google Ads",
  "google adwords": "Google Ads",
  ppc: "Google Ads",
  "paid search": "Google Ads",
  "search ads": "Google Ads",
  "google ads audit": "Google Ads",
  "ads audit": "Google Ads",
  seo: "SEO",
  "search engine optimization": "SEO",
  "local seo": "SEO",
  gmb: "SEO",
  "google business profile": "SEO",
  "google maps": "SEO",
  aeo: "AEO/GEO",
  geo: "AEO/GEO",
  "aeo/geo": "AEO/GEO",
  "answer engine": "AEO/GEO",
  "generative engine": "AEO/GEO",
  smm: "SMM",
  "social media": "SMM",
  "social media marketing": "SMM",
  "social media management": "SMM",
  "meta ads": "SMM",
  "facebook ads": "SMM",
  "instagram ads": "SMM",
};

function normalizeServices(
  raw: string[] | string,
  allowFreeform = false,
): ServiceLabel[] {
  const list = Array.isArray(raw)
    ? raw
    : String(raw || "")
        .split(/[,|]/)
        .map((s) => s.trim())
        .filter(Boolean);
  const out = new Set<ServiceLabel>();
  for (const s of list) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if ((SERVICE_LABELS as readonly string[]).includes(trimmed)) {
      out.add(trimmed as ServiceLabel);
      continue;
    }
    const mapped = SERVICE_ALIASES[trimmed.toLowerCase()];
    if (mapped) {
      out.add(mapped);
      continue;
    }
    if (allowFreeform) out.add(trimmed);
  }
  return Array.from(out);
}

/** If model returns 0-10 or 0-100, normalize to 0-1 */
function normalizeScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score > 1 && score <= 10) return score / 10;
  if (score > 10) return Math.min(1, score / 100);
  return Math.max(0, Math.min(1, score));
}

/**
 * Cheap gate so we don't spend LLM credits on unrelated creatives.
 * With a business profile / search keywords, require real token overlap —
 * not a soft pass on long copy (that let wrong industries through).
 */
export function hasServiceKeywordSignal(
  text: string,
  businessProfileOrOptions?: BusinessProfile | null | ServiceSignalOptions,
): boolean {
  const options: ServiceSignalOptions =
    businessProfileOrOptions &&
    typeof businessProfileOrOptions === "object" &&
    ("businessProfile" in businessProfileOrOptions ||
      "searchKeywords" in businessProfileOrOptions ||
      "selectedCategory" in businessProfileOrOptions ||
      "softPass" in businessProfileOrOptions)
      ? (businessProfileOrOptions as ServiceSignalOptions)
      : { businessProfile: businessProfileOrOptions as BusinessProfile | null };

  const profile = options.businessProfile;
  const hasSearchContext =
    Boolean(profile) ||
    Boolean(options.searchKeywords?.length) ||
    Boolean(options.selectedCategory);

  if (hasSearchContext) {
    const overlap = serviceKeywordOverlapScore(text, options);
    if (overlap > 0) return true;
    // Soft pass only when explicitly filling / relaxed — never the default gate
    if (options.softPass && text.trim().length >= 120) return true;
    return false;
  }
  return /google\s*ads|adwords|\bppc\b|paid search|paid media|media buying|seo\b|search engine|aeo|geo\b|answer engine|generative engine|\bsmm\b|social media marketing|social media management|meta ads|facebook ads|instagram ads|gmb|google business|google maps|digital marketing|marketing agency|advertising agency|lead gen|lead generation|performance marketing|growth agency|ads agency|ads audit|free audit/i.test(
    text,
  );
}

/**
 * Signals that the advertiser is selling agency/consulting services to other businesses,
 * not just a regular business promoting itself.
 */
export function hasAgencyPositioningSignal(text: string): boolean {
  return /\b(agency|agencies|consultancy|consultant|freelanc(?:e|er)|done[\s-]?for[\s-]?you|dfy|we (?:help|manage|run|grow|scale|optimize)|we(?:'ll| will) (?:run|manage|optimize|handle)|our (?:clients|client|team|experts|agency)|for (?:your )?(?:business|brand|company|clients?)|marketing (?:agency|services|team)|performance marketing|media buying|retainer|managed (?:ads|campaigns|services)|ads? (?:management|managers?|audit)|seo (?:agency|services|audit)|ppc (?:agency|management|audit)|hire (?:us|an?)|book a (?:free )?(?:call|audit|strategy)|free (?:ads? |ppc |seo )?audit|get (?:you |your )?(?:more )?leads|grow your (?:business|brand)|scale your (?:ads|business|brand))\b/i.test(
    text,
  );
}

/**
 * Analyze one advertiser using the FULL creative text from one or more ads.
 * Must read primary body / cards — never decide from headline + CTA alone.
 * When businessProfile is set, qualify industry peers (any vertical) instead of agencies-only.
 */
export async function analyzeAdCandidate(
  keyword: string,
  ad: AdCandidate,
  pageCategory?: string | null,
  extraAds: AdCandidate[] = [],
  options?: {
    relaxed?: boolean;
    businessProfile?: BusinessProfile | null;
    searchKeywords?: string[] | null;
    selectedCategory?: BusinessCategory | null;
  },
): Promise<AdFilterResult> {
  const scoreFloor = options?.relaxed
    ? RELAXED_RELEVANCE_THRESHOLD
    : RELEVANCE_THRESHOLD;
  const profile = options?.businessProfile;
  const searchKeywords = options?.searchKeywords || [];
  const selectedCategory = options?.selectedCategory || null;
  const creatives = [ad, ...extraAds].map((a, i) => ({
    index: i + 1,
    daysRunning: a.daysRunning,
    headline: a.title,
    cta: a.ctaText,
    landingPageUrl: a.landingPageUrl,
    primaryBody: a.body,
    linkDescription: a.linkDescription,
    caption: a.caption,
    pageCategories: a.pageCategories,
    fullCreativeText: a.fullText || a.body || a.title,
  }));

  const combinedLength = creatives.reduce(
    (n, c) => n + (c.fullCreativeText?.length || 0),
    0,
  );

  const keywordList = Array.from(
    new Set(
      [keyword, ...searchKeywords, selectedCategory?.label || ""].filter(Boolean),
    ),
  ).join(", ");

  const industrySystem = profile
    ? `You qualify Ad Library advertisers as DIRECT COMPETITORS for a specific business.

SEED BUSINESS:
- Name: ${profile.businessName}
- URL: ${profile.url}
- Industry: ${profile.industry}${profile.subIndustry ? ` / ${profile.subIndustry}` : ""}
- Offerings: ${(profile.offerings || []).join(", ") || "n/a"}
- Selected category: ${selectedCategory?.label || "n/a"}
- Audience: ${profile.targetAudience || "n/a"}
- Positioning: ${profile.positioningSummary}
- Search keywords the user is matching on: ${keywordList}

GOAL: Keep advertisers who sell the SAME (or clearly competing) service/product category.
Reject: unrelated industries, vague "local business" ads, pure marketing agencies (unless the seed is an agency), and ads that only share a broad vertical without the same offering.

CRITICAL READING RULES:
- Read fullCreativeText / primaryBody before deciding.
- Do NOT decide from headline + CTA alone.
- Quote bodyEvidence that proves the SAME service/keywords — not just the same city or industry umbrella.
- relevanceScore must reflect keyword/service overlap with: ${keywordList}

Qualification for relevant=true:
1) Ad copy clearly relates to "${keyword}" / selected category and seed offerings (score 0–1).
2) Same or tightly adjacent competitor — not a distant cousin in a huge industry.
3) services: short tags for what they sell (free-form OK), e.g. ["Dental implants","Invisalign"].

Reject (relevant=false) when:
- Body is generic branding with no service/product match to the keywords
- They are a different specialty (e.g. orthodontics vs general dentistry when keywords are specific)
- They are a marketing agency advertising agency services (unless seed is an agency)

OUTPUT:
- isMarketingAgency=true only if they are primarily a marketing agency.
- relevant=true only for credible same-service competitors.`
    : `You qualify Facebook Ad Library advertisers for a MARKETING-AGENCY competitor finder.

GOAL: Keep ONLY true marketing agencies / marketing consultancies. Reject ordinary businesses that merely run ads to promote themselves.

CRITICAL READING RULES:
- Read fullCreativeText / primaryBody before deciding.
- Do NOT decide from headline + CTA alone.
- Quote bodyEvidence that proves they sell marketing services TO other businesses.
- When unsure whether they are an agency vs a normal business advertising itself, REJECT (isMarketingAgency=false, relevant=false).

Qualification (ALL required for relevant=true):
1) Keyword relevance: their agency offer relates to the user keyword (semantic OK). Score 0–1 only.
2) MUST be a marketing agency (strict B2B positioning).
3) Service focus: body copy promotes selling at least one of: Google Ads, SEO, AEO/GEO, SMM (as a client service).
   Map into these labels only: ${SERVICE_LABELS.join(", ")}.

OUTPUT:
- services MUST be a JSON array, e.g. ["Google Ads","SEO"].
- relevanceScore between 0 and 1.
- isMarketingAgency=true ONLY when the advertiser's business is providing marketing services to other businesses.
- relevant=true ONLY when all three pass AND isMarketingAgency=true.`;

  const raw = await jsonCompletion<{
    relevant: boolean;
    relevanceScore: number;
    isMarketingAgency: boolean;
    services: string[] | string;
    bodyEvidence?: string;
    reason: string;
  }>(
    industrySystem,
    JSON.stringify(
      {
        keyword,
        searchKeywords,
        selectedCategory: selectedCategory?.label || null,
        pageName: ad.pageName,
        pageCategory: pageCategory ?? null,
        combinedCreativeChars: combinedLength,
        creatives,
      },
      null,
      2,
    ),
    `{ "relevant": boolean, "relevanceScore": number, "isMarketingAgency": boolean, "services": string[], "bodyEvidence": string, "reason": string }`,
  );

  const parsed = adFilterSchema.safeParse(raw);
  const services = normalizeServices(
    parsed.success
      ? parsed.data.services
      : ((raw as { services?: string[] | string }).services ?? []),
    Boolean(profile),
  );
  const score = normalizeScore(
    parsed.success
      ? parsed.data.relevanceScore
      : Number((raw as { relevanceScore?: number }).relevanceScore ?? 0),
  );
  const relevantFlag = parsed.success
    ? parsed.data.relevant
    : Boolean((raw as { relevant?: boolean }).relevant);
  const isAgency = parsed.success
    ? parsed.data.isMarketingAgency
    : Boolean((raw as { isMarketingAgency?: boolean }).isMarketingAgency);
  const bodyEvidence = parsed.success
    ? parsed.data.bodyEvidence || ""
    : String((raw as { bodyEvidence?: string }).bodyEvidence || "");
  const reason = parsed.success
    ? parsed.data.reason
    : String(
        (raw as { reason?: string }).reason ||
          "LLM response shape was invalid; applied soft parse",
      );

  const hasBody =
    combinedLength >= 20 ||
    Boolean(ad.body && ad.body.trim().length >= 20) ||
    bodyEvidence.length > 6;

  const creativeBlob = creatives
    .map((c) => c.fullCreativeText || "")
    .join("\n");
  const agencySignal = hasAgencyPositioningSignal(creativeBlob);
  const keywordOverlap = serviceKeywordOverlapScore(creativeBlob, {
    businessProfile: profile,
    searchKeywords,
    selectedCategory,
  });

  let relevant: boolean;
  if (profile) {
    // Require some keyword/service overlap unless score is clearly high
    const keywordOk =
      keywordOverlap > 0 || score >= Math.max(scoreFloor + 0.15, 0.55);
    relevant =
      relevantFlag &&
      services.length > 0 &&
      score >= scoreFloor &&
      hasBody &&
      keywordOk;
  } else {
    relevant =
      relevantFlag &&
      isAgency &&
      services.length > 0 &&
      score >= scoreFloor &&
      hasBody &&
      (agencySignal || score >= Math.max(scoreFloor, 0.55));
  }

  return {
    relevant,
    relevanceScore: score,
    isMarketingAgency: isAgency,
    services,
    bodyEvidence,
    reason: profile
      ? !hasBody
        ? `${reason} (rejected: insufficient creative text)`
        : keywordOverlap <= 0 && score < Math.max(scoreFloor + 0.15, 0.55)
          ? `${reason} (rejected: weak keyword/service overlap in ad copy)`
          : reason
      : !isAgency
        ? `${reason} (rejected: not a marketing agency)`
        : !hasBody
          ? `${reason} (rejected: insufficient creative text)`
          : !agencySignal && score < 0.55
            ? `${reason} (rejected: weak agency positioning in ad copy)`
            : reason,
  };
}

const socialIdsSchema = z.object({
  facebookUrl: z.string().nullable().optional(),
  instagramHandle: z.string().nullable().optional(),
  twitterHandle: z.string().nullable().optional(),
  youtubeHandle: z.string().nullable().optional(),
  youtubeUrl: z.string().nullable().optional(),
  youtubeChannelId: z.string().nullable().optional(),
  linkedinUrl: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
});

export type SocialIdentifiers = z.infer<typeof socialIdsSchema>;

export async function resolveSocialIdentifiers(input: {
  pageName: string;
  pageId: string;
  pageProfileUri?: string | null;
  website?: string | null;
  category?: string | null;
  igUsername?: string | null;
  pageIntro?: string | null;
}): Promise<SocialIdentifiers> {
  const raw = await jsonCompletion<SocialIdentifiers>(
    `Resolve public social profile identifiers for a company so we can call SociaVault APIs.
Be practical and proactive — marketing agencies almost always have LinkedIn company pages and often YouTube.
Strict input formats:
- facebookUrl: full Facebook page URL (https://www.facebook.com/...)
- instagramHandle: username only, no @
- twitterHandle: username only, no @
- youtubeHandle: channel handle without @ if possible
- youtubeUrl: full YouTube channel URL if known (prefer https://www.youtube.com/@handle)
- youtubeChannelId: UC... id if known
- linkedinUrl: full LinkedIn company page URL like https://www.linkedin.com/company/slug (never a /in/ person URL)
- website: company website if known
If pageProfileUri is a Facebook URL, use it as facebookUrl.
If website domain is known, derive likely linkedin slug from the brand/domain when reasonable.
Only return null when you truly cannot form a plausible public identifier.`,
    JSON.stringify(input, null, 2),
    `{ "facebookUrl": string|null, "instagramHandle": string|null, "twitterHandle": string|null, "youtubeHandle": string|null, "youtubeUrl": string|null, "youtubeChannelId": string|null, "linkedinUrl": string|null, "website": string|null }`,
  );

  const parsed = socialIdsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      facebookUrl: input.pageProfileUri ?? null,
      instagramHandle: input.igUsername ?? null,
      website: input.website ?? null,
    };
  }

  const cleanHandle = (h?: string | null) =>
    h ? h.replace(/^@/, "").trim() || null : null;

  return {
    ...parsed.data,
    facebookUrl:
      parsed.data.facebookUrl ||
      input.pageProfileUri ||
      (input.pageId
        ? `https://www.facebook.com/${input.pageId}`
        : null),
    instagramHandle:
      cleanHandle(parsed.data.instagramHandle) ||
      cleanHandle(input.igUsername) ||
      null,
    twitterHandle: cleanHandle(parsed.data.twitterHandle),
    youtubeHandle: cleanHandle(parsed.data.youtubeHandle),
  };
}

const companyPickSchema = z.object({
  selectedPageId: z.string().nullable(),
  confidence: z.number(),
  reason: z.string(),
});

export async function pickCompanyPageMatch(
  queryName: string,
  candidates: Array<{
    pageId: string;
    name: string;
    category?: string | null;
    likes?: number | null;
    verification?: string | null;
    igUsername?: string | null;
    pageAlias?: string | null;
  }>,
): Promise<{
  selectedPageId: string | null;
  confidence: number;
  reason: string;
}> {
  if (candidates.length === 0) {
    return {
      selectedPageId: null,
      confidence: 0,
      reason: "No Facebook Ad Library pages found for this name.",
    };
  }
  if (candidates.length === 1) {
    return {
      selectedPageId: candidates[0].pageId,
      confidence: 0.9,
      reason: "Only one Ad Library page matched this name.",
    };
  }

  const raw = await jsonCompletion<{
    selectedPageId: string | null;
    confidence: number;
    reason: string;
  }>(
    `You pick the correct Facebook Ad Library advertiser page for a competitor lookup.
Multiple pages can share similar names. Choose the single best match for the user's company name.
Prefer: exact/closest name match, verified pages, higher likes, matching page alias / Instagram handle, marketing-agency-like categories when relevant.
If none are a reasonable match, return selectedPageId=null.
confidence must be 0–1.`,
    JSON.stringify({ queryName, candidates }, null, 2),
    `{ "selectedPageId": string|null, "confidence": number, "reason": string }`,
  );

  const parsed = companyPickSchema.safeParse(raw);
  const selectedPageId = parsed.success
    ? parsed.data.selectedPageId
    : (raw.selectedPageId ?? null);
  const confidence = parsed.success
    ? normalizeScore(parsed.data.confidence)
    : normalizeScore(Number(raw.confidence ?? 0));
  const reason = parsed.success
    ? parsed.data.reason
    : String(raw.reason || "LLM selected a page match");

  const validIds = new Set(candidates.map((c) => c.pageId));
  if (selectedPageId && !validIds.has(selectedPageId)) {
    return {
      selectedPageId: candidates[0].pageId,
      confidence: 0.4,
      reason: `${reason} (fallback: LLM returned unknown pageId; used top result)`,
    };
  }

  return { selectedPageId, confidence, reason };
}

const googleDomainPickSchema = z.object({
  domains: z.array(z.string()),
  reason: z.string(),
});

function normalizeDomain(raw: string): string | null {
  try {
    let s = raw.trim().toLowerCase();
    if (!s) return null;
    if (s.includes("/") || s.includes("://")) {
      const u = new URL(s.startsWith("http") ? s : `https://${s}`);
      s = u.hostname;
    }
    s = s.replace(/^www\./, "").replace(/\/$/, "");
    if (!s.includes(".") || s.length < 4) return null;
    if (
      /^(facebook|instagram|linkedin|youtube|google|twitter|x|tiktok|wikipedia)\./i.test(
        s,
      )
    ) {
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

/**
 * Rank domains (from web search and/or Transparency) most likely to be
 * relevant advertisers for the keyword / seed business.
 */
export async function pickGoogleAdDomains(
  keyword: string,
  domains: string[],
  advertisers: Array<{ name: string; region?: string | null }>,
  opts?: {
    platform?: "google" | "youtube";
    limit?: number;
    webSnippets?: Array<{ title?: string; url?: string; description?: string }>;
    businessProfile?: BusinessProfile | null;
  },
): Promise<{ domains: string[]; reason: string }> {
  const limit = opts?.limit ?? 12;
  const profile = opts?.businessProfile || null;
  const unique = Array.from(
    new Set(
      domains
        .map((d) => normalizeDomain(d))
        .filter((d): d is string => Boolean(d)),
    ),
  );
  if (unique.length === 0) {
    return { domains: [], reason: "No candidate domains to rank." };
  }
  if (unique.length <= Math.min(limit, 6) && !opts?.webSnippets?.length) {
    return {
      domains: unique.slice(0, limit),
      reason: "Using all candidate domains.",
    };
  }

  const platform = opts?.platform || "google";
  const system = profile
    ? `You select website domains of DIRECT COMPETITORS for a seed business that are MOST LIKELY to run ${platform === "youtube" ? "YouTube video" : "Google"} ads.

SEED BUSINESS:
- Name: ${profile.businessName}
- Industry: ${profile.industry}${profile.subIndustry ? ` / ${profile.subIndustry}` : ""}
- Offerings: ${(profile.offerings || []).join(", ") || "n/a"}
- Positioning: ${profile.positioningSummary}

Prefer domains of rivals in the SAME industry / offerings as the seed (e.g. lenders, brokers, clinics — whatever matches).
Prefer domains that appear in Google Ads Transparency results for the keyword.
Exclude marketing agencies (unless the seed is an agency), directories, social networks, and unrelated e-commerce.

Return up to ${limit} domains EXACTLY as they appear in the candidate list (hostname only).`
    : `You select website domains for marketing agencies / PPC / SEO / SMM / AEO firms that are MOST LIKELY to run ${platform === "youtube" ? "YouTube video" : "Google"} ads related to the user's keyword.

Use BOTH the candidate domain list AND any web-search snippets provided.
Prefer agency / digital marketing / ads consultancy domains that match the keyword intent.
Exclude product brands, directories, social networks, and irrelevant e-commerce.

Return up to ${limit} domains EXACTLY as they appear in the candidate list (normalize to hostname only).`;

  const raw = await jsonCompletion<{ domains: string[]; reason: string }>(
    system,
    JSON.stringify(
      {
        keyword,
        platform,
        candidateDomains: unique,
        sampleAdvertisers: advertisers.slice(0, 20),
        webSnippets: (opts?.webSnippets || []).slice(0, 24),
        seedBusiness: profile
          ? {
              name: profile.businessName,
              industry: profile.industry,
              offerings: profile.offerings,
            }
          : null,
      },
      null,
      2,
    ),
    `{ "domains": string[], "reason": string }`,
  );

  const parsed = googleDomainPickSchema.safeParse(raw);
  const picked = (parsed.success ? parsed.data.domains : raw.domains || [])
    .map((d) => normalizeDomain(String(d)))
    .filter((d): d is string => Boolean(d) && unique.includes(d!));

  const reason = parsed.success
    ? parsed.data.reason
    : String(raw.reason || "LLM selected domains");

  if (picked.length === 0) {
    return {
      domains: unique.slice(0, limit),
      reason: `${reason} (fallback: used first ${limit} candidates)`,
    };
  }

  return { domains: Array.from(new Set(picked)).slice(0, limit), reason };
}

/**
 * Propose competitor / advertiser domains when web search returns few results.
 */
export async function proposeAgencyDomains(
  keyword: string,
  platform: "google" | "youtube",
  limit = 10,
  businessProfile?: BusinessProfile | null,
): Promise<{ domains: string[]; reason: string }> {
  const system = businessProfile
    ? `Propose real competitor website domains (hostname only) likely running ${platform === "youtube" ? "YouTube" : "Google"} ads against this seed business.
Seed: ${businessProfile.businessName} (${businessProfile.industry}) — offerings: ${(businessProfile.offerings || []).join(", ") || "n/a"}.
Return well-known or plausible SAME-INDUSTRY competitor domains in English-speaking markets (prefer AU/US/UK when relevant).
Do NOT invent fake TLDs. Do NOT propose marketing agencies unless the seed is an agency.
Return up to ${limit} domains.`
    : `Propose real marketing-agency website domains (hostname only) that are likely running ${platform === "youtube" ? "YouTube" : "Google"} ads for the keyword.
Return well-known or plausible agency domains in English-speaking markets (US/AU/UK).
Do NOT invent fake TLDs. Prefer .com agency sites.
Return up to ${limit} domains.`;

  const raw = await jsonCompletion<{ domains: string[]; reason: string }>(
    system,
    JSON.stringify({
      keyword,
      platform,
      seed: businessProfile
        ? {
            name: businessProfile.businessName,
            industry: businessProfile.industry,
            offerings: businessProfile.offerings,
            url: businessProfile.url,
          }
        : null,
    }),
    `{ "domains": string[], "reason": string }`,
  );
  const parsed = googleDomainPickSchema.safeParse(raw);
  const domains = (parsed.success ? parsed.data.domains : raw.domains || [])
    .map((d) => normalizeDomain(String(d)))
    .filter((d): d is string => Boolean(d))
    .slice(0, limit);
  return {
    domains,
    reason: parsed.success
      ? parsed.data.reason
      : String(raw.reason || "LLM proposed domains"),
  };
}
