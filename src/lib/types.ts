export const SEARCH_COUNTRIES = ["US", "AU"] as const;
export type SearchCountry = (typeof SEARCH_COUNTRIES)[number];

export const TARGET_COMPETITORS = 10;
/** Facebook: prefer ads live at least this many days (relaxed further if under target). */
export const MIN_AD_DURATION_DAYS = 10;
/** Facebook: prefer advertisers with more than this many active ads. */
export const MIN_ACTIVE_ADS = 8;
/**
 * Instagram — ads must be active more than this many days.
 * Enforced as daysRunning > NEW_PLATFORM_MIN_AD_DURATION_DAYS.
 */
export const NEW_PLATFORM_MIN_AD_DURATION_DAYS = 20;
/** Instagram — minimum active ads required (>=). */
export const NEW_PLATFORM_MIN_ACTIVE_ADS = 15;
/** LinkedIn / Google / YouTube — looser active-ads floor (>=). */
export const LOOSE_PLATFORM_MIN_ACTIVE_ADS = 3;
/** Total Ad Library result pages across all queries/countries. */
export const MAX_SEARCH_PAGES = 120;
/** Cap pages spent on a single query+country before rotating. */
export const MAX_PAGES_PER_QUERY = 8;
export const RELEVANCE_THRESHOLD = 0.35;
/** Softer bar used when filling remaining slots near end of run. */
export const RELAXED_RELEVANCE_THRESHOLD = 0.25;
export const RELAXED_MIN_ACTIVE_ADS = 3;
export const RELAXED_MIN_AD_DURATION_DAYS = 5;

export const SERVICE_LABELS = [
  "Google Ads",
  "SEO",
  "AEO/GEO",
  "SMM",
] as const;

export type ServiceLabel = (typeof SERVICE_LABELS)[number];

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
  /** Market where the qualifying ad was found (US or AU) */
  country: SearchCountry | string;
  /** Ad platform this competitor was found on */
  platform?: import("./platforms").AdPlatform | string;
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
  createdAt: string;
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
