export const AD_PLATFORMS = [
  "facebook",
  "instagram",
  "google",
  "youtube",
  "linkedin",
] as const;

export type AdPlatform = (typeof AD_PLATFORMS)[number];

export type HistoryKind = "search" | "lookup";

export const PLATFORM_META: Record<
  AdPlatform,
  {
    label: string;
    short: string;
    source: string;
    description: string;
  }
> = {
  facebook: {
    label: "Facebook Ads",
    short: "Facebook",
    source: "Meta Ad Library",
    description: "Active Facebook placements from Meta Ad Library",
  },
  instagram: {
    label: "Instagram Ads",
    short: "Instagram",
    source: "Meta Ad Library",
    description: "Ads serving on Instagram (filtered from Meta Ad Library)",
  },
  google: {
    label: "Google Ads",
    short: "Google",
    source: "Google Ads Transparency",
    description: "Search, display, and network creatives from Google Transparency",
  },
  youtube: {
    label: "YouTube Ads",
    short: "YouTube",
    source: "Google Ads Transparency",
    description: "Video creatives from Google Transparency (YouTube-oriented)",
  },
  linkedin: {
    label: "LinkedIn Ads",
    short: "LinkedIn",
    source: "LinkedIn Ad Library",
    description: "Sponsored content from LinkedIn Ad Library",
  },
};

/** Parse multi-keyword input: commas, newlines, or pipes */
export function parseKeywords(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input.join("\n") : input;
  const parts = raw
    .split(/[\n,|;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).slice(0, 12);
}

export function isMetaPlatform(p: AdPlatform): boolean {
  return p === "facebook" || p === "instagram";
}

export function isGoogleFamily(p: AdPlatform): boolean {
  return p === "google" || p === "youtube";
}

/** Platforms that use the stricter 15 ads / >20 days rules (everything except Facebook). */
export function usesNewPlatformThresholds(p: AdPlatform): boolean {
  return p !== "facebook";
}

export type PlatformAdThresholds = {
  /** Reject when daysRunning is known and fails this check (ignored when skipDuration) */
  minDaysExclusive: number;
  /** Minimum active ads required */
  minActiveAds: number;
  /** When true, require daysRunning > minDaysExclusive; Facebook uses >= */
  requireDaysGreaterThan: boolean;
  /** Skip duration filtering entirely (LinkedIn, Google, YouTube) */
  skipDuration: boolean;
  /** When true, need activeCount >= minActiveAds; Facebook uses > */
  activeAdsInclusive: boolean;
};

export function getPlatformAdThresholds(p: AdPlatform): PlatformAdThresholds {
  if (p === "facebook") {
    return {
      minDaysExclusive: 7,
      minActiveAds: 5,
      requireDaysGreaterThan: false,
      skipDuration: false,
      activeAdsInclusive: false,
    };
  }
  // LinkedIn: ≥2 ads, no duration rule
  if (p === "linkedin") {
    return {
      minDaysExclusive: 0,
      minActiveAds: 2,
      requireDaysGreaterThan: false,
      skipDuration: true,
      activeAdsInclusive: true,
    };
  }
  // Google / YouTube: one public creative is enough to consider the advertiser
  if (p === "google" || p === "youtube") {
    return {
      minDaysExclusive: 0,
      minActiveAds: 1,
      requireDaysGreaterThan: false,
      skipDuration: true,
      activeAdsInclusive: true,
    };
  }
  // Instagram: aligned closer to Facebook relaxed tiers
  return {
    minDaysExclusive: 10,
    minActiveAds: 5,
    requireDaysGreaterThan: true,
    skipDuration: false,
    activeAdsInclusive: true,
  };
}

/** Days between two date strings (or start → now). Returns -1 if unknown. */
export function daysFromDateRange(
  start?: string | null,
  end?: string | null,
): number {
  if (!start) return -1;
  const startMs = Date.parse(String(start));
  if (Number.isNaN(startMs)) return -1;
  let endMs = Date.now();
  if (end) {
    const parsed = Date.parse(String(end));
    if (!Number.isNaN(parsed)) endMs = parsed;
  }
  return Math.max(0, Math.floor((endMs - startMs) / (1000 * 60 * 60 * 24)));
}

/**
 * Parse LinkedIn Ad Library `adDuration` strings, e.g.
 * "Ran from Feb 6, 2026 to Feb 8, 2026"
 */
export function parseLinkedInAdDuration(adDuration?: string | null): {
  start: string | null;
  end: string | null;
  days: number;
} {
  if (!adDuration || !String(adDuration).trim()) {
    return { start: null, end: null, days: -1 };
  }
  const text = String(adDuration).trim();
  const range = text.match(/from\s+(.+?)\s+to\s+(.+)$/i);
  if (range) {
    const startMs = Date.parse(range[1].trim());
    const endMs = Date.parse(range[2].trim());
    if (!Number.isNaN(startMs)) {
      const end = Number.isNaN(endMs) ? Date.now() : endMs;
      return {
        start: new Date(startMs).toISOString(),
        end: new Date(end).toISOString(),
        days: Math.max(
          0,
          Math.floor((end - startMs) / (1000 * 60 * 60 * 24)),
        ),
      };
    }
  }
  const since = text.match(/(?:since|from)\s+(.+)$/i);
  if (since) {
    const startMs = Date.parse(since[1].trim());
    if (!Number.isNaN(startMs)) {
      return {
        start: new Date(startMs).toISOString(),
        end: null,
        days: Math.max(
          0,
          Math.floor((Date.now() - startMs) / (1000 * 60 * 60 * 24)),
        ),
      };
    }
  }
  return { start: null, end: null, days: -1 };
}

/** Resolve LinkedIn days from ISO dates and/or adDuration text. */
export function linkedInDaysRunning(ad: {
  startDate?: string | null;
  endDate?: string | null;
  adDuration?: string | null;
}): { days: number; start: string | null; end: string | null } {
  const fromIso = daysFromDateRange(ad.startDate, ad.endDate);
  if (fromIso >= 0) {
    return {
      days: fromIso,
      start: ad.startDate ? String(ad.startDate) : null,
      end: ad.endDate ? String(ad.endDate) : null,
    };
  }
  const parsed = parseLinkedInAdDuration(ad.adDuration);
  return {
    days: parsed.days,
    start: parsed.start || (ad.startDate ? String(ad.startDate) : null),
    end: parsed.end || (ad.endDate ? String(ad.endDate) : null),
  };
}

export function meetsDurationThreshold(
  daysRunning: number,
  thresholds: PlatformAdThresholds,
): boolean {
  if (thresholds.skipDuration) return true;
  // Unknown duration: allow through (same as Meta finder)
  if (daysRunning < 0) return true;
  if (thresholds.requireDaysGreaterThan) {
    return daysRunning > thresholds.minDaysExclusive;
  }
  return daysRunning >= thresholds.minDaysExclusive;
}

export function meetsActiveAdsThreshold(
  activeCount: number,
  thresholds: PlatformAdThresholds,
): boolean {
  if (thresholds.activeAdsInclusive) {
    return activeCount >= thresholds.minActiveAds;
  }
  // Facebook legacy: need more than MIN_ACTIVE_ADS
  return activeCount > thresholds.minActiveAds;
}

/** Display helper — never show raw -1 in the UI. */
export function formatDaysLive(days?: number | null): string {
  if (days == null || days < 0) return "—";
  return String(days);
}
