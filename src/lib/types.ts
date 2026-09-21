export const SEARCH_COUNTRIES = ["US", "AU"] as const;
export type SearchCountry = (typeof SEARCH_COUNTRIES)[number] | string;

export const TARGET_COMPETITORS = 10;
/** Facebook: prefer ads live at least this many days (relaxed further if under target). */
export const MIN_AD_DURATION_DAYS = 7;
/** Facebook: prefer advertisers with at least this many active ads. */
export const MIN_ACTIVE_ADS = 10;
/**
 * Instagram — ads must be active more than this many days.
 * Enforced as daysRunning > NEW_PLATFORM_MIN_AD_DURATION_DAYS.
 */
export const NEW_PLATFORM_MIN_AD_DURATION_DAYS = 10;
/** Instagram — minimum active ads required (>=). */
export const NEW_PLATFORM_MIN_ACTIVE_ADS = 10;
/** LinkedIn / Google / YouTube — looser active-ads floor (>=). */
export const LOOSE_PLATFORM_MIN_ACTIVE_ADS = 3;
/**
 * Total Ad Library result pages across all queries/countries.
 * Kept modest so keyword search finishes in minutes, not ~30m.
 */
export const MAX_SEARCH_PAGES = 64;
/** Cap pages spent on a single query+country before rotating. */
export const MAX_PAGES_PER_QUERY = 6;
/** Max expanded queries per platform (seed + LLM expansions). */
export const MAX_SEARCH_QUERIES_META = 12;
export const MAX_SEARCH_QUERIES_GOOGLE = 10;
export const MAX_SEARCH_QUERIES_LINKEDIN = 10;
export const RELEVANCE_THRESHOLD = 0.48;
/** Softer bar used when filling remaining slots near end of run. */
export const RELAXED_RELEVANCE_THRESHOLD = 0.38;
/** Prefer local rivals; only fill with clear geo mismatches after this many matched/unknown. */
export const PREFER_LOCAL_BEFORE_MISMATCH = 4;
export const RELAXED_MIN_ACTIVE_ADS = 10;
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

/**
 * Structured brand visual identity for one landing-page recreation run.
 * Serialized to ephemeral `design.md` and used as SSOT for styling decisions.
 */
export interface BrandDesignSpec {
  brandName: string;
  businessUrl: string;
  extractedAt: string;
  /** Competitor whose layout is reused — never copy their brand chrome */
  competitorName?: string | null;
  colors: BrandColors & { icon?: string };
  logos: {
    primary: string | null;
    dark: string | null;
    favicon: string | null;
  };
  fonts: string[];
  typography: {
    headingFont: string | null;
    bodyFont: string | null;
    fontSizes?: Record<string, string> | null;
    fontWeights?: Record<string, number | string> | null;
  };
  buttons: {
    primary: {
      background: string;
      textColor: string;
      borderRadius: string | null;
      borderColor: string | null;
    };
    secondary: {
      background: string | null;
      textColor: string;
      borderRadius: string | null;
      borderColor: string | null;
    };
  };
  borderRadii: string[];
  boxShadows: string[];
  spacing: {
    baseUnit?: number | null;
    borderRadius?: string | null;
  };
  sectionBackgrounds: {
    page: string;
    surface: string;
    muted: string | null;
  };
  imagery: {
    styleNotes: string[];
    sampleSubjects: string[];
  };
  links: {
    nav: Array<{ label: string; href: string }>;
    footer: Array<{ label: string; href: string }>;
    social: Array<{ label: string; href: string }>;
    cta: Array<{ label: string; href: string }>;
  };
  /** Explicit implementor rules (do-not-use competitor brand, etc.) */
  rules: string[];
  design: BrandDesignSystem | null;
  source: string;
  warnings: string[];
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
  /** Set by Stop — durable across Next.js module duplicates; pipelines must halt. */
  stopRequested?: boolean;
  /** Batch brand-review progress (set while stage === brand_review) */
  brandReviewDone?: number;
  brandReviewTotal?: number;
  brandReviewCurrentName?: string | null;
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
    /** Industry SOP / guardrail agent rejects */
    guardrailReject?: number;
  };
  /** Offers analysis progress when stage === "analyzing_offers" */
  offersPhase?: string | null;
  offersDone?: number;
  offersTotal?: number;
  offersCurrentName?: string | null;
  /** 0–100 overall offers analysis percent */
  offersPct?: number;
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
  /** When true, industry SOP guardrails are not applied */
  skipGuardrails?: boolean;
  /** Manual override: seek specific competitor types / relax SOP excludes */
  guardrailOverride?: {
    enabled: boolean;
    seekCompetitors?: string | null;
    notes?: string | null;
  } | null;
  /**
   * Optional report: unique ad-copy hooks/offers + unique landing-page offers
   * across accepted keyword-search competitors.
   */
  offersReport?: LookupOffersReport | null;
  /** Competitor ids selected for the latest offers dashboard run (fresh searches). */
  offersCompetitorIds?: string[] | null;
  status: JobStatus;
  progress: JobProgress;
  competitorIds: string[];
  /**
   * Owning user. Absent on rows created before multi-user support — those stay
   * invisible to everyone until an admin assigns an owner.
   */
  ownerUserId?: string | null;
  /**
   * Client project space this run belongs to. Sharing and deletion happen on
   * the space, so every run with the same spaceId moves together.
   */
  spaceId?: string | null;
  archivedAt?: string | null;
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
  /** Set by Stop — durable across Next.js module duplicates; pipelines must halt. */
  stopRequested?: boolean;
  /** Offers analysis progress when stage === "analyzing_offers" */
  offersPhase?: string | null;
  offersDone?: number;
  offersTotal?: number;
  offersCurrentName?: string | null;
  /** 0–100 overall offers analysis percent */
  offersPct?: number;
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
  /**
   * User brand website for landing-page recreation (content + design).
   * Same role as SearchJob.businessUrl.
   */
  businessUrl?: string | null;
  /** Brand colors / assets / design tokens from business URL analyze */
  businessProfile?: BusinessProfile | null;
  /**
   * Optional report: unique ad-copy hooks/offers + unique landing-page offers.
   * Built only when the user runs offers analysis (not during ad fetch).
   * Per-ad landing analysis still runs via “Get offer & page details”.
   */
  offersReport?: LookupOffersReport | null;
  /** Deep location resolved during offers intelligence (not during ad fetch) */
  locationLabel?: string | null;
  locationCity?: string | null;
  locationSuburb?: string | null;
  locationCountry?: string | null;
  locationStatus?: CompetitorLocationStatus | null;
  locationSource?: CompetitorLocationSource | null;
  /** Internal synthetic rows hidden from history UI. */
  internalOnly?: boolean;
  /** See SearchJob.ownerUserId — absent means legacy/unassigned. */
  ownerUserId?: string | null;
  /**
   * Client project space this run belongs to. Sharing and deletion happen on
   * the space, so every run with the same spaceId moves together.
   */
  spaceId?: string | null;
  archivedAt?: string | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One unique creative cluster (same/similar ad copy). */
export type FunnelStage = "TOFU" | "MOFU" | "BOFU" | "unknown";
export type OfferTicketTier = "low" | "mid" | "high" | "unknown";

/** Ad leaf used under landing-page / service trees. */
export interface LookupOfferAdLeaf {
  creativeId: string;
  hook: string;
  offer: string;
  cta: string | null;
  serviceTargeted: string | null;
  funnelStage: FunnelStage;
  adCount: number;
  sampleAdIds: string[];
  sampleCopy?: string | null;
  landingPageUrl?: string | null;
}

export interface LookupUniqueAdCreative {
  id: string;
  hook: string;
  offer: string;
  /** Short sample of the creative body */
  sampleCopy: string;
  adCount: number;
  sampleAdIds: string[];
  landingPageUrl?: string | null;
  cta?: string | null;
  serviceTargeted?: string | null;
  funnelStage?: FunnelStage;
}

/** One unique landing-page destination with its analyzed offer. */
export interface LookupUniqueLandingPage {
  url: string;
  matchKey: string;
  adCount: number;
  status: "completed" | "failed" | "skipped";
  headline?: string | null;
  primaryOffer?: string | null;
  pricing?: string | null;
  cta?: string | null;
  uniqueValueProps?: string[];
  summary?: string | null;
  error?: string | null;
  sampleAdId?: string | null;
  funnelStage?: FunnelStage;
  serviceTargeted?: string | null;
  /** Ads (creative clusters) that use this landing page */
  ads?: LookupOfferAdLeaf[];
}

/** Deduped offer line appearing across creatives or LPs. */
export interface LookupUniqueOfferLine {
  offer: string;
  source: "ad_copy" | "landing_page" | "both";
  adCount: number;
  urls?: string[];
  sampleHooks?: string[];
  funnelStage?: FunnelStage;
  ticketTier?: OfferTicketTier;
  cta?: string | null;
  pricing?: string | null;
}

/** Service → landing pages → ads tree node. */
export interface LookupServiceOfferingNode {
  service: string;
  adCount: number;
  landingPageCount: number;
  funnelStages?: Partial<Record<FunnelStage, number>>;
  landingPages: Array<{
    url: string;
    matchKey: string;
    adCount: number;
    primaryOffer?: string | null;
    funnelStage?: FunnelStage;
    cta?: string | null;
    ads: LookupOfferAdLeaf[];
  }>;
}

/**
 * One core offer value ladder.
 * Core = unique landing-page offer; adOffers = mapped ad-copy offers for that core.
 */
export interface LookupCoreOfferLadder {
  id: string;
  rank: number;
  /** Unique landing-page offer (the core) */
  coreOffer: string;
  details: string;
  cta: string | null;
  ticketTier: OfferTicketTier;
  pricing: string | null;
  funnelStage: FunnelStage;
  landingPageUrl: string | null;
  /** Ads that land on this core offer’s page(s) */
  adCount: number;
  /** Relevant ad-copy offers mapped under this core */
  adOffers: LookupOfferAdLeaf[];
  /** Present when no relevant ad-copy offers map to this core */
  emptyMessage?: string | null;
  /** Search mode: which competitors contributed to this ladder */
  sourceCompetitors?: string[];
  /** Search mode: sample ad references for traceability */
  sourceAdRefs?: Array<{
    adId: string;
    lookupAdId?: string;
    adArchiveId?: string;
    competitorId: string;
    competitorName: string;
    adLibraryUrl?: string | null;
    title?: string | null;
    body?: string | null;
    ctaText?: string | null;
    landingPageUrl?: string | null;
  }>;
}

/** @deprecated Prefer LookupCoreOfferLadder — kept for older stored reports */
export interface LookupValueLadderStep {
  id: string;
  rank: number;
  offer: string;
  details: string;
  cta: string | null;
  ticketTier: OfferTicketTier;
  pricing: string | null;
  funnelStage: FunnelStage;
  source: "ad_copy" | "landing_page" | "both";
  adCount: number;
}

export interface LookupOffersReport {
  status: "pending" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  error?: string | null;
  /** Short narrative for the UI */
  summary?: string | null;
  adsAnalyzed: number;
  adCopy: {
    uniqueCreatives: number;
    creatives: LookupUniqueAdCreative[];
    uniqueOffers: LookupUniqueOfferLine[];
  };
  landingPages: {
    uniqueUrls: number;
    analyzed: number;
    failed: number;
    pages: LookupUniqueLandingPage[];
    uniqueOffers: LookupUniqueOfferLine[];
  };
  services?: {
    uniqueServices: number;
    nodes: LookupServiceOfferingNode[];
  };
  valueLadder?: {
    /** One ladder per unique landing-page (core) offer */
    ladders: LookupCoreOfferLadder[];
    summary?: string | null;
    /** Legacy flat steps (older reports only) */
    steps?: LookupValueLadderStep[];
  };
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
  /**
   * Bridge to the shared recreate pipeline (CompetitorRecord id under a synthetic
   * search job). Set when content/design recreation is started from lookup.
   */
  recreationCompetitorId?: string | null;
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
  /**
   * Unified page document from Firecrawl markdown + Claude
   * (presented together in the content UI, not as micro-blocks).
   */
  document?: LandingContentDocument | null;
  /** How page slots were extracted for this draft */
  slotSource?:
    | "page_text_slots"
    | "architecture_scaffold"
    | "firecrawl_markdown"
    | null;
  slotCount?: number | null;
  /** CID paste coverage from last design fit (0–1) */
  cidCoverage?: number | null;
  /** Nodes left unmapped on last design fit */
  unmatchedCidCount?: number | null;
  userFeedback?: string | null;
  approvedAt?: string | null;
  error?: string | null;
}

/** Coherent landing-page content plan (section-level, not micro-slots). */
export type LandingContentSectionKind =
  | "meta"
  | "hero"
  | "features"
  | "faq"
  | "cta"
  | "testimonials"
  | "links"
  | "logos"
  | "body"
  | "other";

export interface LandingContentDocSection {
  id: string;
  kind: LandingContentSectionKind | string;
  title: string;
  /** Unified section copy for review */
  body: string;
  faqs?: Array<{ question: string; answer: string; qBlockId?: string; aBlockId?: string }>;
  links?: Array<{ label: string; href: string; role?: string | null }>;
  logos?: Array<{ label: string; note?: string | null }>;
  /** CID block ids that this section feeds into design paste */
  blockIds?: string[];
}

export interface LandingContentDocument {
  pageType?: string | null;
  tone?: string | null;
  summary?: string | null;
  meta?: { title: string; description: string } | null;
  sections: LandingContentDocSection[];
  sourceMarkdownChars?: number | null;
  competitorUrl?: string | null;
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
  /** Construction pipeline: planned → generating → validating → ready / failed / reused */
  slotState?: "planned" | "generating" | "validating" | "ready" | "failed" | "reused";
  provider?: string | null;
  model?: string | null;
  reused?: boolean;
  validation?: string | null;
}

export type RecreationProgressDetails = {
  sectionsIdentified?: number;
  brandAssetsCollected?: number;
  imagesCompleted?: number;
  imagesPlanned?: number;
  imagesSkippedCredits?: number;
  captureRetry?: boolean;
  logoEmbedded?: boolean;
  logoWarnings?: string[];
  screenshotWarnings?: string[];
};

export type RecreationProgressStage = {
  id: string;
  label: string;
  status: "pending" | "active" | "done" | "skipped" | "blocked" | "indeterminate";
  detail?: string | null;
  weight?: number;
};

/** Generated HTML landing page for the user's brand, inspired by a competitor. */
export interface RecreatedLandingPage {
  /**
   * pending — job started
   * content_ready — legacy content draft ready for review
   * design_pending — unified generation or design in flight
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
  /**
   * Ephemeral brand design.md markdown generated for this run (SSOT for styling).
   * File under data/recreate/{id}/design.md is deleted after a successful design build;
   * this string is kept on the record for audit / UI until the next run.
   */
  designMd?: string | null;
  /** Publish readiness from last design fit */
  publishReady?: boolean | null;
  publishBlockers?: string[] | null;
  /** Canonical evidence-backed content. Design builds load approvedSnapshot only. */
  contentPack?: import("./pipeline/content/model").ContentPack | null;
  /** Approved revision used by the current HTML, if a design exists. */
  designContentRevision?: number | null;
  /** Token for the in-flight or completed construction build. Older jobs must not overwrite a newer token. */
  designBuildId?: string | null;
  designRendererVersion?: string | null;
  /** unified-1 = content+HTML in one Anthropic call; absent/legacy = older split pipeline */
  pipelineVersion?: string | null;
  /** Live progress while content/design is running (polled by UI) */
  progress?: {
    phase: string;
    message: string;
    pct: number;
    stages?: RecreationProgressStage[] | null;
    indeterminate?: boolean;
    details?: RecreationProgressDetails | null;
  } | null;
  error?: string | null;
}

export type LookupHistorySummary = LookupJob & {
  adCount: number;
};

export interface DatabaseShape {
  /** Bumped by src/lib/db.ts migrations; see docs/MULTI_USER.md. */
  schemaVersion?: number;
  jobs: SearchJob[];
  competitors: CompetitorRecord[];
  seenPageIds: string[];
  lookupJobs?: LookupJob[];
  lookupAds?: LookupAdRecord[];
  searchCompetitorAds?: SearchCompetitorAdRecord[];
  users?: AppUser[];
  appSettings?: AppSettings;
  conversionRuleSets?: ConversionRuleSet[];
  creditPeriods?: CreditPeriod[];
  creditLedger?: CreditLedgerEntry[];
  creditReservations?: CreditReservation[];
  providerCalls?: ProviderCallRecord[];
  projectMemberships?: ProjectMembership[];
  projectSpaces?: ProjectSpace[];
  spaceMemberships?: SpaceMembership[];
  auditLogs?: AuditLogEntry[];
  adminAlerts?: AdminAlert[];
  loginAttempts?: LoginAttemptRecord[];
  ledgerSeq?: number;
  auditSeq?: number;
}

export type UserRole = "admin" | "user";
export type UserStatus = "active" | "suspended" | "deleted";

/** Stored in data/store.json — passwordHash never sent to clients. */
export interface AppUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  /**
   * Bumped on password change, admin reset, suspension and deletion.
   * Session cookies carry the epoch they were minted with, so bumping it
   * invalidates every existing session for the user.
   */
  sessionEpoch: number;
  /** Set by an admin password reset — blocks all other work until changed. */
  mustChangePassword: boolean;
  /** null inherits AppSettings.maxConcurrentRunsPerUser */
  maxConcurrentRuns?: number | null;
  /** null allows every provider not globally disabled */
  allowedProviders?: ProviderId[] | null;
  blockedModels?: string[] | null;
  createdAt: string;
  updatedAt: string;
  createdByUserId?: string | null;
  suspendedAt?: string | null;
  deletedAt?: string | null;
}

export type AppUserPublic = Pick<
  AppUser,
  | "id"
  | "username"
  | "displayName"
  | "role"
  | "status"
  | "mustChangePassword"
  | "createdAt"
>;

/* ─────────────────────────── Projects & sharing ─────────────────────────── */

/** A "project" is one run row: a keyword search job or a competitor lookup job. */
export type ProjectKind = "search" | "lookup";
export type ProjectRole = "owner" | "editor" | "viewer";
/** view = read, edit = mutate stored data, run = start billable provider work. */
export type ProjectAction = "view" | "edit" | "run";

export interface ProjectMembership {
  id: string;
  projectKind: ProjectKind;
  projectId: string;
  userId: string;
  role: Exclude<ProjectRole, "owner">;
  grantedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A named client workspace. Search and lookup runs live inside it. Admins
 * share or delete the space, which covers every run in it — not one history
 * row at a time.
 */
export interface ProjectSpace {
  id: string;
  clientName: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

export interface SpaceMembership {
  id: string;
  spaceId: string;
  userId: string;
  role: Exclude<ProjectRole, "owner">;
  grantedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/* ──────────────────────── Provider usage accounting ─────────────────────── */

export const PROVIDER_IDS = [
  "sociavault",
  "openrouter",
  "openai",
  "anthropic",
  "firecrawl",
  "brandfetch",
  "runway",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Measurable provider usage. Only fields the provider actually reported are
 * populated — an absent field means "not reported", never zero.
 */
export interface ProviderUsageUnits {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  images?: number;
}

/**
 * confirmed              — units came back from the provider
 * estimated              — units came from a configured estimate
 * pending_reconciliation — call may have been billed; usage unknown
 */
export type UsageConfidence =
  | "confirmed"
  | "estimated"
  | "pending_reconciliation";

export type ProviderCallStatus =
  | "succeeded"
  | "failed"
  | "timeout"
  | "not_billable"
  | "blocked";

export interface ProviderCallRecord {
  id: string;
  /** Settlement is keyed on this so retries cannot double-charge. */
  idempotencyKey: string;
  initiatedByUserId: string;
  chargedUserId: string;
  projectKind: ProjectKind | null;
  projectId: string | null;
  runId: string | null;
  provider: ProviderId;
  /** Model id for LLMs, null for plain HTTP providers. */
  model: string | null;
  /** API path for HTTP providers. */
  endpoint: string | null;
  operation: string;
  providerRequestId: string | null;
  usage: ProviderUsageUnits;
  usageConfidence: UsageConfidence;
  /** Integer credit subunits. */
  creditsCharged: number;
  /** Integer micro-USD, or null when no price is configured for this rate. */
  estimatedCostUsdMicros: number | null;
  conversionRuleVersion: number;
  status: ProviderCallStatus;
  /** Sanitized message safe to render to the charged user. */
  errorMessage: string | null;
  reservationId: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  settledAt: string | null;
}

/** Credit subunits charged per unit of provider usage. */
export interface ProviderRate {
  perRequest?: number;
  perThousandInputTokens?: number;
  perThousandOutputTokens?: number;
  perImage?: number;
  /** Optional monetary price. Omit entirely when no price is configured. */
  usdMicrosPerRequest?: number;
  usdMicrosPerThousandInputTokens?: number;
  usdMicrosPerThousandOutputTokens?: number;
  usdMicrosPerImage?: number;
  /** Labeled fallback used only when the provider reports no usage. */
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export interface ConversionRuleSet {
  version: number;
  createdAt: string;
  createdByUserId: string | null;
  note: string | null;
  /** provider id -> ("default" | model/endpoint key) -> rate */
  rates: Record<string, Record<string, ProviderRate>>;
  /** Conservative per-call hold, in subunits, keyed by provider id. */
  perCallReservationCeiling: Record<string, number>;
}

/* ───────────────────────── Allowances & the ledger ──────────────────────── */

export type ResetCadence = "none" | "monthly";

export interface CreditPeriod {
  id: string;
  userId: string;
  startsAt: string;
  /** null while the period is current */
  endsAt: string | null;
  /** null when resetCadence is "none" */
  nextResetAt: string | null;
  resetCadence: ResetCadence;
  /** All amounts are integer credit subunits. */
  allowanceSubunits: number;
  consumedSubunits: number;
  reservedSubunits: number;
  status: "current" | "closed";
  createdAt: string;
  updatedAt: string;
}

export type LedgerEntryType =
  | "period_open"
  | "period_close"
  | "allowance_set"
  | "allowance_added"
  | "adjustment"
  | "charge"
  | "reservation_hold"
  | "reservation_release";

/** Append-only. Rows are never updated or deleted. */
export interface CreditLedgerEntry {
  id: string;
  seq: number;
  userId: string;
  periodId: string | null;
  type: LedgerEntryType;
  /** Signed subunits. Negative reduces the user's available credits. */
  deltaSubunits: number;
  /** Available credits after the entry, for audit reconstruction. */
  balanceAfterSubunits: number | null;
  reason: string | null;
  actorUserId: string | null;
  providerCallId: string | null;
  reservationId: string | null;
  projectKind: ProjectKind | null;
  projectId: string | null;
  runId: string | null;
  provider: ProviderId | null;
  conversionRuleVersion: number | null;
  idempotencyKey: string | null;
  createdAt: string;
}

export type ReservationStatus =
  | "open"
  | "settled"
  | "released"
  | "expired"
  | "pending_reconciliation";

export interface CreditReservation {
  id: string;
  userId: string;
  periodId: string;
  projectKind: ProjectKind | null;
  projectId: string | null;
  runId: string | null;
  operation: string;
  /** Currently held subunits (decreases as the reservation is settled). */
  amountSubunits: number;
  /** Total already charged against this reservation. */
  settledSubunits: number;
  status: ReservationStatus;
  /** Heartbeat deadline used to recover reservations abandoned by a crash. */
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  note: string | null;
}

/* ──────────────────────────── Audit & settings ──────────────────────────── */

export interface AdminAlert {
  id: string;
  kind: "provider_credits_exhausted";
  userId: string;
  username: string;
  displayName: string;
  provider: ProviderId;
  runId: string | null;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  seq: number;
  actorUserId: string | null;
  actorUsername: string | null;
  action: string;
  targetUserId?: string | null;
  projectKind?: ProjectKind | null;
  projectId?: string | null;
  /** Small non-sensitive diff. Never credentials or prompt content. */
  details?: Record<string, string | number | boolean | null> | null;
  createdAt: string;
}

export interface AppSettings {
  publicSignupEnabled: boolean;
  defaultAllowanceSubunits: number;
  defaultResetCadence: ResetCadence;
  lowCreditWarningSubunits: number;
  maxConcurrentRunsPerUser: number;
  /** Hard ceiling on a single run's reservation, in subunits. */
  maxRunReservationSubunits: number;
  disabledProviders: ProviderId[];
  disabledModels: string[];
  activeConversionRuleVersion: number;
  updatedAt: string;
  updatedByUserId: string | null;
}

export interface LoginAttemptRecord {
  /** Lowercased username. */
  key: string;
  attempts: number;
  firstAttemptAt: string;
  lockedUntil: string | null;
}

/** Cached ads fetched for keyword-search competitors (SociaVault reuse). */
export interface SearchCompetitorAdRecord {
  id: string;
  runId: string;
  competitorId: string;
  pageId: string;
  pageName: string;
  platform: import("./platforms").AdPlatform | string;
  adArchiveId: string;
  country: string;
  isActive: boolean;
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
  raw: Record<string, unknown>;
  createdAt: string;
}
