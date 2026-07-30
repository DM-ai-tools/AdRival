export const SEARCH_COUNTRIES = ["US", "AU"] as const;
export type SearchCountry = (typeof SEARCH_COUNTRIES)[number] | string;

export const TARGET_COMPETITORS = 10;
/** Facebook: prefer ads live at least this many days (relaxed further if under target). */
export const MIN_AD_DURATION_DAYS = 7;
/** Facebook: prefer advertisers with more than this many active ads. */
export const MIN_ACTIVE_ADS = 5;
/**
 * Instagram — ads must be active more than this many days.
 * Enforced as daysRunning > NEW_PLATFORM_MIN_AD_DURATION_DAYS.
 */
export const NEW_PLATFORM_MIN_AD_DURATION_DAYS = 10;
/** Instagram — minimum active ads required (>=). */
export const NEW_PLATFORM_MIN_ACTIVE_ADS = 5;
/** LinkedIn / Google / YouTube — looser active-ads floor (>=). */
export const LOOSE_PLATFORM_MIN_ACTIVE_ADS = 3;
/** Total Ad Library result pages across all queries/countries. */
export const MAX_SEARCH_PAGES = 220;
/** Cap pages spent on a single query+country before rotating. */
export const MAX_PAGES_PER_QUERY = 16;
export const RELEVANCE_THRESHOLD = 0.42;
/** Softer bar used when filling remaining slots near end of run. */
export const RELAXED_RELEVANCE_THRESHOLD = 0.3;
/** Prefer local rivals; only fill with clear geo mismatches after this many matched/unknown. */
export const PREFER_LOCAL_BEFORE_MISMATCH = 4;
export const RELAXED_MIN_ACTIVE_ADS = 3;
export const RELAXED_MIN_AD_DURATION_DAYS = 5;

export const SERVICE_LABELS = [
  "Google Ads",
  "SEO",
  "AEO/GEO",
  "SMM",
] as const;

/** Free-form service / category tags (legacy marketing labels still supported). */
export type ServiceLabel = (typeof SERVICE_LABELS)[number] | string;

export type BusinessModel = "service" | "ecommerce" | "hybrid";
export type ServiceDelivery = "onsite" | "offsite" | "mixed" | "n_a";
export type SearchGeoMode =
  | "countrywide"
  | "company_locations"
  | "keyword_location";

export interface BusinessCategory {
  id: string;
  label: string;
  /** service offering vs product category */
  type: "service" | "product";
}

export interface BusinessLocation {
  label: string;
  city: string;
  suburb?: string | null;
  region?: string | null;
  countryCode?: string | null;
  isPrimary?: boolean;
}

export type CompetitorLocationStatus = "matched" | "unknown" | "mismatch";
export type CompetitorLocationSource = "sociavault" | "perplexity" | "none";

/** Industry profile produced by OpenRouter / Perplexity from a business URL. */
export interface BusinessProfile {
  url: string;
  businessName: string;
  industry: string;
  subIndustry?: string | null;
  description: string;
  offerings: string[];
  targetAudience?: string | null;
  competitorKeywords: string[];
  positioningSummary: string;
  /** service vs ecommerce vs both */
  businessModel?: BusinessModel | null;
  /** Selectable services (service biz) or product categories (ecom) */
  categories?: BusinessCategory[] | null;
  /** Where the service is delivered — drives local keyword strategy */
  serviceDelivery?: ServiceDelivery | null;
  /** HQ + branches (city/suburb level when known) */
  locations?: BusinessLocation[] | null;
  /** ISO country code for default Ad Library market */
  primaryMarketCountry?: string | null;
  /** Brand palette extracted from the site HTML/CSS */
  brandColors?: BrandColors | null;
  /**
   * Snapshot of logo/links/socials pulled from the business site.
   * Stored so recreation still works if a later live fetch is blocked (403).
   */
  brandAssets?: {
    finalUrl: string;
    siteName: string | null;
    logoUrl: string | null;
    faviconUrl: string | null;
    ogImageUrl: string | null;
    navLinks: Array<{ label: string; href: string }>;
    footerLinks: Array<{ label: string; href: string }>;
    socialLinks: Array<{ label: string; href: string }>;
    images: Array<{
      src: string;
      alt?: string;
      kind: "logo" | "hero" | "content" | "icon" | "og";
    }>;
    emails: string[];
    phones: string[];
  } | null;
  /**
   * Firecrawl branding design system (fonts, spacing, components, personality).
   * Used when recreating competitor landing pages in the user's brand.
   */
  brandDesign?: BrandDesignSystem | null;
  analyzedAt?: string;
}

export interface BrandColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  muted?: string;
  source?: string;
}

/** Subset of Firecrawl BrandingProfile useful for landing-page recreation. */
export interface BrandDesignSystem {
  colorScheme?: string | null;
  fonts: string[];
  typography?: {
    fontFamilies?: {
      primary?: string;
      heading?: string;
      code?: string;
    };
    fontSizes?: Record<string, string>;
    fontWeights?: Record<string, number | string>;
  } | null;
  spacing?: {
    baseUnit?: number;
    borderRadius?: string;
  } | null;
  components?: {
    buttonPrimary?: {
      background?: string;
      textColor?: string;
      borderRadius?: string;
      borderColor?: string;
    };
    buttonSecondary?: {
      background?: string;
      textColor?: string;
      borderRadius?: string;
      borderColor?: string;
    };
  } | null;
  personality?: {
    tone?: string;
    energy?: string;
    targetAudience?: string;
  } | null;
  source?: string;
}

export interface AdCandidate {
  adArchiveId: string;
  pageId: string;
  pageName: string;
  pageProfileUri?: string | null;
  isActive: boolean;
  startDateString?: string | null;
  endDateString?: string | null;
  daysRunning: number;
  title: string;
  body: string;
  /** Combined creative copy for LLM: body, cards, link description, caption, extras */
  fullText: string;
  ctaText?: string | null;
  landingPageUrl?: string | null;
  linkDescription?: string | null;
  caption?: string | null;
  pageCategories?: string[];
  country?: SearchCountry;
  snapshot?: Record<string, unknown>;
}

export interface BrandReview {
  facebookUrl?: string | null;
  facebookFollowers?: number | null;
  facebookLikes?: number | null;
  instagramHandle?: string | null;
  instagramFollowers?: number | null;
  twitterHandle?: string | null;
  twitterFollowers?: number | null;
  youtubeHandle?: string | null;
  youtubeUrl?: string | null;
  youtubeSubscribers?: number | null;
  linkedinUrl?: string | null;
  linkedinEmployees?: number | null;
  linkedinFollowers?: number | null;
  website?: string | null;
  category?: string | null;
}

export interface CompetitorRecord {
  id: string;
  runId: string;
  pageId: string;
  pageName: string;
  /** Ad-library market where the qualifying ad was found */
  country: SearchCountry | string;
  /** Ad platform this competitor was found on */
  platform?: import("./platforms").AdPlatform | string;
  /** Resolved company HQ / branch location (city/suburb) */
  locationLabel?: string | null;
  locationCity?: string | null;
  locationSuburb?: string | null;
  locationCountry?: string | null;
  locationStatus?: CompetitorLocationStatus | null;
  locationSource?: CompetitorLocationSource | null;
  activeAdsCount: number;
  services: ServiceLabel[];
  sampleAd: {
    adArchiveId: string;
    title: string;
    body: string;
    /** -1 when unknown */
    daysRunning: number;
    adLibraryUrl: string;
    ctaText?: string | null;
    landingPageUrl?: string | null;
    /** Platform-specific creative fields from SociaVault */
    format?: string | null;
    imageUrl?: string | null;
    videoUrl?: string | null;
    youtubeUrl?: string | null;
    domain?: string | null;
    visibleUrl?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    impressions?: string | null;
    advertiserPageUrl?: string | null;
  };
  brand: BrandReview;
  /** Landing-page offer + architecture analysis (persisted for history) */
  pageAnalysis?: LandingPageOfferAnalysis | null;
  /** Recreated landing page HTML for the user's brand (separate viewer page) */
  recreatedPage?: RecreatedLandingPage | null;
  createdAt: string;
}

export type JobStatus = "running" | "completed" | "failed" | "partial";

export interface JobProgress {
  stage: string;
  scannedAds: number;
  scannedPages: number;
  accepted: number;
  target: number;
  rejected: number;
  message: string;
  /** Breakdown so we can see where candidates die */
  rejectReasons?: {
    inactive: number;
    shortDuration: number;
    noServiceSignal: number;
    nonEnglish: number;
    noLandingPage: number;
    llmReject: number;
    llmError: number;
    lowActiveAds: number;
    countError: number;
  };
}

export interface SearchJob {
  id: string;
  keyword: string;
  /** Multi-keyword input (keyword remains a display join for older rows) */
  keywords?: string[];
  platform?: import("./platforms").AdPlatform | string;
  /** Geography / country code chosen for this run (e.g. US, AU, all) */
  geo?: string | null;
  /**
   * How local vs national competitor matching should work.
   * keyword_location is set automatically when keywords contain a city/suburb.
   */
  geoMode?: SearchGeoMode | null;
  /** User-selected service / product category from analyze */
  selectedCategory?: BusinessCategory | null;
  /** Cities/suburbs used for competitor location matching */
  targetLocations?: BusinessLocation[] | null;
  /** Parsed location token from keywords when present */
  keywordLocation?: string | null;
  /** Countries actually queried (Meta / LinkedIn) */
  countries?: string[];
  /** Business website URL entered for this search (always saved for history) */
  businessUrl?: string | null;
  /** Industry context from business URL analysis */
  businessProfile?: BusinessProfile | null;
  status: JobStatus;
  progress: JobProgress;
  competitorIds: string[];
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type HistoryRunSummary = SearchJob & {
  competitorCount: number;
};

/** Candidate Facebook Ad Library page from search-companies */
export interface LookupPageCandidate {
  pageId: string;
  name: string;
  category?: string | null;
  likes?: number | null;
  verification?: string | null;
  igUsername?: string | null;
  igFollowers?: number | null;
  pageAlias?: string | null;
  imageUri?: string | null;
  country?: string | null;
  raw?: Record<string, unknown>;
}

export interface LookupJobProgress {
  stage: string;
  message: string;
  candidatesFound: number;
  adsFetched: number;
  pagesScanned: number;
}

export interface LookupJob {
  id: string;
  queryName: string;
  platform?: import("./platforms").AdPlatform | string;
  status: JobStatus;
  progress: LookupJobProgress;
  selectedPage?: LookupPageCandidate | null;
  candidates: LookupPageCandidate[];
  llmReason?: string | null;
  llmConfidence?: number | null;
  adIds: string[];
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LookupAdRecord {
  id: string;
  lookupId: string;
  adArchiveId: string;
  pageId: string;
  pageName: string;
  country: string;
  isActive: boolean;
  /** Flattened highlight fields for UI/Excel */
  title: string;
  body: string;
  ctaText?: string | null;
  landingPageUrl?: string | null;
  startDateString?: string | null;
  endDateString?: string | null;
  daysRunning?: number;
  adLibraryUrl: string;
  format?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  youtubeUrl?: string | null;
  domain?: string | null;
  visibleUrl?: string | null;
  impressions?: string | null;
  advertiserPageUrl?: string | null;
  /** Full SociaVault ad object as returned */
  raw: Record<string, unknown>;
  /** Landing-page offer + architecture analysis (persisted for history) */
  pageAnalysis?: LandingPageOfferAnalysis | null;
  createdAt: string;
}

export interface LandingPageSection {
  name: string;
  purpose: string;
  summary: string;
  keyElements?: string[];
}

/** One Meta/Google ad that shares the analyzed landing page URL. */
export interface SameLandingPageAd {
  adArchiveId: string;
  adLibraryUrl: string;
  /** Attention-grabbing opening line / headline from the creative */
  hook: string;
  /** What the ad is pitching (offer angle), distinct from page-level offer when possible */
  offer: string;
  title?: string | null;
  bodySnippet?: string | null;
  ctaText?: string | null;
  isActive?: boolean | null;
  daysRunning?: number | null;
  startDate?: string | null;
  country?: string | null;
}

/** Ads from the same advertiser that point at the analyzed landing page. */
export interface SameLandingPageAdsSummary {
  /** Canonical landing URL used for matching */
  landingUrl: string;
  /** Total ads scanned for this advertiser */
  scannedAds: number;
  /** Ads whose destination matches this landing page */
  matchingAds: number;
  /** Unique hook+offer creatives shown in the UI */
  ads: SameLandingPageAd[];
  /** Optional note (e.g. platform unsupported, fetch partial) */
  note?: string | null;
}

export interface LandingPageOfferAnalysis {
  status: "pending" | "completed" | "failed";
  analyzedUrl: string;
  analyzedAt: string;
  offer?: {
    headline?: string | null;
    primaryOffer: string;
    pricing?: string | null;
    cta?: string | null;
    guarantees?: string[];
    urgency?: string | null;
    uniqueValueProps?: string[];
  } | null;
  pageArchitecture?: {
    pageType?: string | null;
    sections: LandingPageSection[];
  } | null;
  audience?: string | null;
  trustSignals?: string[];
  conversionElements?: string[];
  techNotes?: string[];
  summary?: string | null;
  error?: string | null;
  /** Ads using this same landing page + their hooks / offers */
  sameLandingPageAds?: SameLandingPageAdsSummary | null;
}

/** One editable copy block produced before design fit. */
export type LandingContentBlockRole =
  | "meta_title"
  | "meta_description"
  | "eyebrow"
  | "h1"
  | "h2"
  | "h3"
  | "body"
  | "bullet"
  | "cta"
  | "testimonial"
  | "stat"
  | "nav"
  | "footer"
  | "footer_link"
  | "social"
  | "internal_link";

export interface LandingContentBlock {
  id: string;
  sectionIndex: number;
  sectionName: string;
  role: LandingContentBlockRole | string;
  label: string;
  text: string;
  /** Target character length from the competitor placement */
  targetLen?: number | null;
  /** Hard min length from competitor slot (± budget) */
  minLen?: number | null;
  /** Hard max length from competitor slot (± budget) */
  maxLen?: number | null;
  /** Competitor's original text at this placement (for 1:1 design paste) */
  originalText?: string | null;
  /** Underlying HTML tag when sourced from a real page slot */
  htmlRole?: string | null;
  /** Locked URL for nav / footer / social / internal links */
  href?: string | null;
}

/** Phase-1 content pack — reviewed/approved before HTML design fit. */
export interface LandingContentDraft {
  status: "pending" | "ready" | "approved" | "failed";
  createdAt: string;
  updatedAt: string;
  model: string;
  pageType?: string | null;
  tone?: string | null;
  differentiationSummary?: string | null;
  blocks: LandingContentBlock[];
  /** How page slots were extracted for this draft */
  slotSource?: "page_text_slots" | "architecture_scaffold" | null;
  slotCount?: number | null;
  /** CID paste coverage from last design fit (0–1) */
  cidCoverage?: number | null;
  /** Nodes left unmapped on last design fit */
  unmatchedCidCount?: number | null;
  userFeedback?: string | null;
  approvedAt?: string | null;
  error?: string | null;
}

/** Playwright/fetch archive captured at content phase — reused for design CIDs. */
export interface StoredPageArchive {
  /** HTML already stamped with data-cid (same ids as content blocks) */
  html: string;
  finalUrl: string;
  title: string | null;
  capturedAt: string;
  source: "playwright" | "fetch";
  nodeCount: number;
}

/** AI-generated photo that replaced a competitor image slot in the design. */
export interface GeneratedLandingImage {
  id: string;
  label: string;
  kind: "hero" | "content" | "team" | "product" | "background";
  /** Prompt used for Runway GPT Image 2 */
  prompt: string;
  /** GPT Image 2 ratio string (e.g. 1920:1088 or auto) */
  ratio: string;
  /** Absolute URL under /generated/{competitorId}/{id}.png */
  publicUrl: string;
  runwayTaskId?: string | null;
  width?: number | null;
  height?: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Generated HTML landing page for the user's brand, inspired by a competitor. */
export interface RecreatedLandingPage {
  /**
   * pending — job started
   * content_ready — OpenAI content draft ready for review
   * design_pending — fitting approved content into layout
   * completed — HTML ready
   * failed — error
   */
  status:
    | "pending"
    | "content_ready"
    | "design_pending"
    | "completed"
    | "failed";
  createdAt: string;
  updatedAt: string;
  businessUrl: string;
  businessName?: string | null;
  keyword: string;
  sourceCompetitorName: string;
  sourceAnalyzedUrl: string;
  brandColors: BrandColors;
  /** Phase-1 approved/ready content (before or alongside HTML) */
  contentDraft?: LandingContentDraft | null;
  /**
   * Competitor page archive from content phase (stamped CIDs).
   * Design must reuse this so text placements match.
   */
  sourceArchive?: StoredPageArchive | null;
  /** Full self-contained HTML document (after design fit) */
  html?: string | null;
  /** Runway GPT Image 2 photos embedded into the design */
  generatedImages?: GeneratedLandingImage[] | null;
  /** Short notes on how content was differentiated */
  differentiationNotes?: string | null;
  /** Last user feedback applied during regenerate (if any) */
  userFeedback?: string | null;
  /** Publish readiness from last design fit */
  publishReady?: boolean | null;
  publishBlockers?: string[] | null;
  error?: string | null;
}

export type LookupHistorySummary = LookupJob & {
  adCount: number;
};

export interface DatabaseShape {
  jobs: SearchJob[];
  competitors: CompetitorRecord[];
  seenPageIds: string[];
  lookupJobs?: LookupJob[];
  lookupAds?: LookupAdRecord[];
}
