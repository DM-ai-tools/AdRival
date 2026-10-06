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
import {
  getOpenAICompatClient,
  OPENROUTER_FAST_MODEL,
  resolveOpenAICompatModel,
} from "../openrouter/openaiCompat";
import { detectAgencySopRejectReason } from "../guardrails/industrySops";

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
  // Words every ad uses ("Call now", "Book a strategy call", "our team") —
  // as single tokens they matched unrelated advertisers. Whole keyword
  // phrases that contain them still match.
  "call",
  "calls",
  "book",
  "booking",
  "strategy",
  "management",
  "agency",
  "agencies",
  "marketing",
  "digital",
  "solution",
  "solutions",
  "expert",
  "experts",
  "team",
  "growth",
  "get",
  "now",
  "today",
  "more",
  "learn",
  "help",
  "plan",
  "results",
  "professional",
  "quality",
  "top",
  "leading",
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word test, allowing a plural ending ("audit" matches "audits", not "auditorium"). */
function hasWord(blob: string, token: string): boolean {
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(token)}(?:s|es)?(?![a-z0-9])`).test(blob);
}

/**
 * Ad copy only: drops the CTA, URL, display-URL and page-category lines the
 * ad mappers add to fullText, so "CTA: Call now" or a landing URL such as
 * "/what-is-seo" cannot count as the advertiser selling the service.
 */
export function adCopyForSignal(text: string): string {
  return String(text || "")
    .split("\n")
    .filter(
      (line) =>
        !/^\s*(cta|landing page url|caption \/ display url|page categories)\s*:/i.test(line) &&
        !/^\s*(https?:\/\/|www\.)\S*\s*$/i.test(line) &&
        !/^\s*[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?\s*$/i.test(line),
    )
    .join("\n")
    .replace(/https?:\/\/\S+/gi, " ");
}

/** 0–1 overlap of signal tokens present in ad copy (whole words only). */
export function serviceKeywordOverlapScore(
  text: string,
  options?: ServiceSignalOptions,
): number {
  const tokens = serviceSignalTokens(options);
  if (!tokens.length) return 0;
  const blob = text.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    if (hasWord(blob, t)) hits += 1;
  }
  return Math.min(1, hits / Math.min(4, tokens.length));
}

function getClient() {
  return getOpenAICompatClient();
}

async function jsonCompletion<T>(
  system: string,
  user: string,
  schemaHint: string,
  model = "gpt-4o",
): Promise<T> {
  const client = getClient();
  const completion = await client.chat.completions.create({
    model: resolveOpenAICompatModel(model),
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
  model: string = OPENROUTER_FAST_MODEL,
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
    // An agency's rivals advertise "SEO agency" / "SEO services"; the bare
    // word "SEO" mostly surfaces plugins, tools and how-to guides.
    const agency = isAgencySeed(businessProfile, geoOptions?.selectedCategory);
    const providerQueries = agency
      ? /\b(agency|agencies|services?|company|consultant|firm|specialists?)\b/i.test(keyword)
        ? [keyword]
        : [`${keyword} agency`, `${keyword} services`]
      : [];
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
Prefer precise service phrases from the seed keyword and offerings — avoid generic words like "business" or "online".
Queries must find businesses that SELL the service, not software, plugins, courses, guides or news about the topic.${
        isProductSeed(businessProfile, geoOptions?.selectedCategory)
          ? `\nThe business is an online store: write queries a shopper types to BUY the products (e.g. "buy <product> online", "<product> online store", "<product> shop", "<product> specialist"), not "best <product>" or review queries.`
          : ""
      }${
        agency
          ? `\nThe business is an agency: every query should name the provider, e.g. "<service> agency", "<service> services", "<service> company".`
          : ""
      }`,
      `Seed keyword: "${keyword}"
Also consider these suggested competitor keywords: ${businessProfile.competitorKeywords.join(", ")}
Return 4-6 high-yield search queries that tightly match the seed keyword / offerings.${wantLocal && locLabels.length ? ` Include 1-2 with city/suburb: ${locLabels.join(", ")}.` : ""}`,
      `{ "queries": string[] }`,
      model,
    );
    const parsed = queryExpansionSchema.safeParse(raw);
    const queries = parsed.success ? parsed.data.queries : [keyword];
    const geoSeeded =
      wantLocal && locLabels.length
        ? locLabels.slice(0, 2).flatMap((loc) => [
            `${agency ? providerQueries[0] : keyword} ${loc}`,
            categoryLabel ? `${categoryLabel} ${loc}` : "",
          ])
        : [];
    const seeded = agency
      ? [
          ...providerQueries,
          ...geoSeeded,
          ...queries,
          categoryLabel,
          ...businessProfile.competitorKeywords.slice(0, 3),
          keyword,
        ]
      : [
          keyword,
          categoryLabel,
          ...businessProfile.competitorKeywords.slice(0, 3),
          ...geoSeeded,
          ...queries,
        ];
    return Array.from(
      new Set(seeded.map((q) => q.trim()).filter(Boolean)),
    ).slice(0, 8);
  }

  const raw = await jsonCompletion<{ queries: string[] }>(
    `You help find Facebook Ads Library search queries for MARKETING AGENCIES only
(companies whose business is selling marketing services to other businesses).
Focus on agencies selling: Google Ads, SEO, AEO/GEO, and SMM.
Prefer queries with "agency", "marketing agency", "PPC agency", "SEO agency".
Avoid queries that surface random local businesses or product brands.`,
    `User keyword: "${keyword}"
Return 4-6 high-yield Ad Library search queries for agencies. Always include "${keyword} agency" and "${keyword} marketing agency".`,
    `{ "queries": string[] }`,
    model,
  );

  const parsed = queryExpansionSchema.safeParse(raw);
  const queries = parsed.success ? parsed.data.queries : [keyword];
  const seeded = [
    keyword,
    `${keyword} agency`,
    `${keyword} marketing agency`,
    "Google Ads agency",
    "PPC agency",
    "SEO agency",
    "Facebook ads agency",
    ...queries,
  ];
  const unique = Array.from(
    new Set(seeded.map((q) => q.trim()).filter(Boolean)),
  );
  return unique.slice(0, 8);
}

const adFilterSchema = z.object({
  relevant: z.boolean(),
  relevanceScore: z.number(),
  isMarketingAgency: z.boolean(),
  services: z.union([z.array(z.string()), z.string()]),
  bodyEvidence: z.string().optional().default(""),
  advertiserType: z.string().optional().default(""),
  reason: z.string(),
});

/** What kind of business the advertiser is, as judged from its ads. */
export const ADVERTISER_TYPES = [
  "agency",
  "service_provider",
  "software_tool",
  "physical_product",
  "education_or_content",
  "marketplace_or_directory",
  "media_or_publisher",
  "other",
] as const;
export type AdvertiserType = (typeof ADVERTISER_TYPES)[number];

export interface AdFilterResult {
  relevant: boolean;
  relevanceScore: number;
  isMarketingAgency: boolean;
  services: ServiceLabel[];
  bodyEvidence: string;
  reason: string;
  advertiserType?: AdvertiserType | null;
}

function normalizeAdvertiserType(raw: unknown): AdvertiserType | null {
  const t = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (ADVERTISER_TYPES as readonly string[]).includes(t) ? (t as AdvertiserType) : null;
}

/** True when the seed business itself sells marketing services. */
export function isAgencySeed(
  profile: BusinessProfile | null | undefined,
  selectedCategory?: BusinessCategory | null,
  searchKeywords: string[] = [],
): boolean {
  if (!profile) return true;
  return /agency|ppc|google ads|digital marketing|paid media|seo agency|marketing services/i.test(
    [
      profile.industry,
      profile.subIndustry,
      profile.positioningSummary,
      ...(profile.offerings || []),
      selectedCategory?.label || "",
      ...searchKeywords,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * Advertiser types that can never be a direct competitor of this seed.
 * A service business competes with other providers of that service, not with
 * the software, courses or publishers that talk about the same topic.
 */
export function blockedAdvertiserTypes(
  profile: BusinessProfile | null | undefined,
  selectedCategory?: BusinessCategory | null,
  searchKeywords: string[] = [],
): Set<AdvertiserType> {
  const nonProvider: AdvertiserType[] = [
    "software_tool",
    "physical_product",
    "education_or_content",
    "marketplace_or_directory",
    "media_or_publisher",
  ];
  if (isAgencySeed(profile, selectedCategory, searchKeywords)) return new Set(nonProvider);
  const seedText = [profile?.industry, profile?.subIndustry].filter(Boolean).join(" ");
  if (/\b(education|school|university|tutoring|training|academy|edtech|course)/i.test(seedText)) {
    return new Set(["media_or_publisher"]);
  }
  if (/\b(saas|software|app|platform|tech)\b/i.test(seedText)) {
    return new Set(["education_or_content", "media_or_publisher"]);
  }
  const serviceSeed =
    selectedCategory?.type === "service" ||
    (!selectedCategory && profile?.businessModel === "service");
  if (serviceSeed) return new Set(nonProvider);
  // An online store competes with stores and brands, not marketplaces, tools or content.
  if (isProductSeed(profile, selectedCategory)) {
    return new Set(["agency", "software_tool", "education_or_content", "marketplace_or_directory", "media_or_publisher"]);
  }
  return new Set(["education_or_content", "media_or_publisher", "agency"]);
}

/** Online stores compete with other stores selling the same products, not with service providers. */
export function isProductSeed(
  profile: BusinessProfile | null | undefined,
  selectedCategory?: BusinessCategory | null,
): boolean {
  if (!profile) return false;
  if (selectedCategory) return selectedCategory.type === "product";
  return profile.businessModel === "ecommerce" || profile.serviceDelivery === "n_a";
}

/** What an online store's competitor looks like, for the review and ranking prompts. */
export const PRODUCT_SEED_RULES = `The seed is an ONLINE STORE. Its competitors are other stores and direct-to-consumer brands that sell the same products online, and specialists whose range centres on those products (e.g. a mobility-aids store for wheelchairs, a suit shop for suits).
Not competitors: marketplaces (Amazon, eBay, Etsy, Catch, Kogan, Temu, AliExpress), department and general stores whose range is mostly other categories (Big W, Kmart, Target, Myer, David Jones, Walmart, Bunnings, Officeworks), price-comparison, deal, review and "best X" sites, blogs and magazines, and manufacturers that only sell through resellers.
Google Shopping and display ads often show only a product title, price or store name: a product title or store name that names the searched product counts as evidence.`;

export function advertiserTypeLabel(t: AdvertiserType): string {
  return (
    {
      agency: "a marketing agency",
      service_provider: "a service provider",
      software_tool: "a software tool",
      physical_product: "a product brand",
      education_or_content: "a course, guide or content brand",
      marketplace_or_directory: "a marketplace or directory",
      media_or_publisher: "a publisher",
      other: "another kind of business",
    } as Record<AdvertiserType, string>
  )[t];
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
    // Ad copy only, whole words only. No length-based soft pass: long copy
    // with no keyword in it is still an unrelated advertiser.
    const copy = adCopyForSignal(text);
    if (serviceKeywordOverlapScore(copy, options) > 0) return true;
    // Agencies often advertise the agency, not one service ("One agency,
    // every channel"); the AI review then checks what they sell.
    return (
      isAgencySeed(profile, options.selectedCategory, options.searchKeywords || []) &&
      hasAgencyPositioningSignal(copy)
    );
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
    /** Country the run searches in (ISO code, e.g. "AU"). */
    targetCountry?: string | null;
  },
): Promise<AdFilterResult> {
  const scoreFloor = options?.relaxed
    ? RELAXED_RELEVANCE_THRESHOLD
    : RELEVANCE_THRESHOLD;
  const profile = options?.businessProfile;
  const searchKeywords = options?.searchKeywords || [];
  const selectedCategory = options?.selectedCategory || null;
  const targetCountry = String(options?.targetCountry || "").trim().toUpperCase() || null;
  const agencySeed = isAgencySeed(profile, selectedCategory, searchKeywords);
  const blockedTypes = profile
    ? blockedAdvertiserTypes(profile, selectedCategory, searchKeywords)
    : new Set<AdvertiserType>(["software_tool", "physical_product", "education_or_content", "marketplace_or_directory", "media_or_publisher"]);
  const productSeed = !agencySeed && isProductSeed(profile, selectedCategory);
  const seedKind = agencySeed
    ? "a marketing agency (sells done-for-you marketing services to other businesses)"
    : productSeed
      ? "an online store"
      : blockedTypes.has("software_tool")
      ? "a service provider"
      : blockedTypes.has("agency")
        ? "a product brand"
        : "a business";
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
- The seed is ${seedKind}.${targetCountry ? `\n- Market: customers in ${targetCountry}` : ""}
- Search keywords the user is matching on: ${keywordList}

GOAL: Keep advertisers who SELL the SAME (or clearly competing) service/product to the same kind of customer.${productSeed ? `\n${PRODUCT_SEED_RULES}` : ""}
A competitor must be the same KIND of business as the seed. Mentioning the keyword is not enough:
a plugin, proxy, rank tracker or other software that "helps with SEO", a "what is SEO" guide, a course,
a blog, a news site or a directory is NOT a competitor of an SEO agency, even though its ad says "SEO".
Reject: unrelated industries, vague "local business" ads, pure marketing agencies (unless the seed is an agency), and ads that only share a broad vertical without the same offering.

advertiserType — what the ADVERTISER is (judge the company, not the topic of the ad):
- agency: sells marketing / advertising / SEO services to other businesses (agencies, consultants, freelancers)
- service_provider: sells a hands-on service it performs for the customer (clinic, trade, law firm, cleaner…)
- software_tool: software, SaaS, app, plugin, extension, proxy/VPN, data or tracking tool, AI tool, self-serve platform
- physical_product: sells goods
- education_or_content: courses, coaching, guides, blogs, ebooks, "learn …" content as the offer
- marketplace_or_directory: lists or matches many providers (marketplaces, directories, review/lead sites)
- media_or_publisher: news, magazines, podcasts, influencers
- other
This seed may only compete with: ${ADVERTISER_TYPES.filter((t) => !blockedTypes.has(t) && t !== "other").join(", ")}.${
      targetCountry
        ? `\nIf the ads clearly serve a different country than ${targetCountry} (another country's phone numbers, prices, addresses or domain), set relevant=false.`
        : ""
    }

CRITICAL READING RULES:
- Read fullCreativeText / primaryBody before deciding.
- Do NOT decide from headline + CTA alone.
- Quote bodyEvidence that proves the SAME service/keywords — not just the same city or industry umbrella.
- relevanceScore must reflect keyword/service overlap with: ${keywordList}

Qualification for relevant=true:
1) Ad copy clearly relates to "${keyword}" / selected category and seed offerings (score 0–1). Keyword match is mandatory — reject ads whose body does not mention or clearly imply the searched service/product.
2) Same or tightly adjacent competitor — not a distant cousin in a huge industry.
3) services: short tags for what THEY SELL (free-form OK), e.g. ["Dental implants","Invisalign"]. Name the actual product ("SEO plugin", "Residential proxies"), never the topic they mention.

Reject (relevant=false) when:
- Body is generic branding with no service/product match to the keywords
- They are a different specialty (e.g. orthodontics vs general dentistry when keywords are specific)
- They are a marketing agency advertising agency services (unless seed is an agency)
- The creative only shares geography/brand vibes without keyword-relevant offer
- For agency/PPC seeds: reject AI/SaaS ad tools, DIY platforms, workshops/courses/coaching that are NOT done-for-you agencies (e.g. "alternative to your ad agency", "AI fixed our ads")
- Case-study landing pages for a software tool's customer are NOT agency competitors

OUTPUT:
- isMarketingAgency=true only if they primarily sell marketing services to other businesses (agency, consultant, freelancer).
- advertiserType: one of ${ADVERTISER_TYPES.join(", ")}.
- relevant=true only for credible same-service competitors whose ads are keyword-relevant.`
    : `You qualify Facebook Ad Library advertisers for a MARKETING-AGENCY competitor finder.

GOAL: Keep ONLY true marketing agencies / marketing consultancies selling done-for-you services. Reject ordinary businesses, AI/SaaS ad tools, DIY platforms, workshops, webinars, and courses.

CRITICAL READING RULES:
- Read fullCreativeText / primaryBody before deciding.
- Do NOT decide from headline + CTA alone.
- Quote bodyEvidence that proves they sell marketing services TO other businesses.
- When unsure whether they are an agency vs a tool/course/normal business, REJECT (isMarketingAgency=false, relevant=false).

Qualification (ALL required for relevant=true):
1) Keyword relevance: their agency offer relates to the user keyword (semantic OK). Score 0–1 only.
2) MUST be a marketing agency (strict B2B positioning — managed ads / retainers / done-for-you).
3) Service focus: body copy promotes selling at least one of: Google Ads, SEO, AEO/GEO, SMM (as a client service).
   Map into these labels only: ${SERVICE_LABELS.join(", ")}.

HARD REJECTS (relevant=false, isMarketingAgency=false):
- AI ad tools / software ("alternative to your ad agency", "Blend's AI", SaaS free trial)
- Workshops, webinars, courses, coaching cohorts, DIY ad setup products
- Ordinary ecommerce or local businesses advertising themselves

OUTPUT:
- services MUST be a JSON array, e.g. ["Google Ads","SEO"].
- relevanceScore between 0 and 1.
- isMarketingAgency=true ONLY when the advertiser's business is providing marketing services to other businesses.
- advertiserType: one of ${ADVERTISER_TYPES.join(", ")} ("agency" for marketing agencies, "software_tool" for plugins/SaaS/proxies/AI tools, "education_or_content" for courses and guides).
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
    `{ "relevant": boolean, "relevanceScore": number, "isMarketingAgency": boolean, "advertiserType": string, "services": string[], "bodyEvidence": string, "reason": string }`,
    OPENROUTER_FAST_MODEL,
  );

  const parsed = adFilterSchema.safeParse(raw);
  const loose = raw as unknown as Record<string, unknown>;
  const services = normalizeServices(
    parsed.success
      ? parsed.data.services
      : ((loose.services as string[] | string | undefined) ?? []),
    Boolean(profile),
  );
  const score = normalizeScore(
    parsed.success ? parsed.data.relevanceScore : Number(loose.relevanceScore ?? 0),
  );
  const relevantFlag = parsed.success ? parsed.data.relevant : Boolean(loose.relevant);
  const isAgency = parsed.success
    ? parsed.data.isMarketingAgency
    : Boolean(loose.isMarketingAgency);
  const bodyEvidence = parsed.success
    ? parsed.data.bodyEvidence || ""
    : String(loose.bodyEvidence || "");
  const advertiserType = normalizeAdvertiserType(
    parsed.success ? parsed.data.advertiserType : loose.advertiserType,
  );
  const reason = parsed.success
    ? parsed.data.reason
    : String(loose.reason || "LLM response shape was invalid; applied soft parse");

  const creativeBlob = creatives
    .map((c) => c.fullCreativeText || "")
    .join("\n");
  // Judge copy only: URLs, CTA and display-URL lines are not evidence.
  const copyBlob = adCopyForSignal(creativeBlob);
  const hasBody = copyBlob.replace(/\s+/g, " ").trim().length >= 20;
  const agencySignal = hasAgencyPositioningSignal(copyBlob);
  const keywordOverlap = serviceKeywordOverlapScore(copyBlob, {
    businessProfile: profile,
    searchKeywords,
    selectedCategory,
  });

  let relevant: boolean;
  if (profile) {
    // Hard keyword gate: ad copy must overlap search terms / offerings
    const keywordOk =
      keywordOverlap >= (options?.relaxed ? 0.08 : 0.12) ||
      score >= Math.max(scoreFloor + 0.2, 0.65);
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

  // The advertiser must be the same kind of business as the seed: an SEO
  // agency does not compete with an SEO plugin, a proxy service or a guide.
  const wrongType = advertiserType && blockedTypes.has(advertiserType) ? advertiserType : null;
  // Agency seeds: the advertiser itself must sell marketing services.
  const notAgency = Boolean(profile) && agencySeed && !isAgency && advertiserType !== "agency";
  const toolOrEdu = agencySeed
    ? detectAgencySopRejectReason(
        `${copyBlob}\n${services.join(" ")}\n${ad.landingPageUrl || ""}\n${ad.pageName || ""}`,
      )
    : null;
  const diyService = services.some((s) => /\bdiy\b/i.test(s));
  if (wrongType || notAgency || (agencySeed && (toolOrEdu || diyService))) {
    relevant = false;
  }

  return {
    relevant,
    relevanceScore: score,
    isMarketingAgency: isAgency && !toolOrEdu && !diyService && wrongType !== "software_tool",
    services,
    bodyEvidence,
    advertiserType,
    reason: wrongType
      ? `${reason} (rejected: the advertiser is ${advertiserTypeLabel(wrongType)}, not the same kind of business)`
      : profile
        ? toolOrEdu || diyService
          ? `${reason} (rejected: ${toolOrEdu || "DIY positioning"} — not an agency competitor)`
          : notAgency
            ? `${reason} (rejected: not a marketing agency)`
            : !hasBody
              ? `${reason} (rejected: insufficient creative text)`
              : keywordOverlap <= 0 && score < Math.max(scoreFloor + 0.15, 0.55)
                ? `${reason} (rejected: weak keyword/service overlap in ad copy)`
                : reason
        : toolOrEdu || diyService
          ? `${reason} (rejected: ${toolOrEdu || "DIY positioning"} — tool/workshop not agency)`
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
    model?: string;
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
Exclude marketing agencies (unless the seed is an agency), directories, social networks, and unrelated e-commerce.${
        isProductSeed(profile) ? `\n${PRODUCT_SEED_RULES}\nKeep every specialist online store for these products — they are the competitors.` : ""
      }

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
    opts?.model,
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
