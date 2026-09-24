import { getCompetitorsByRun, updateCompetitor } from "../db";
import type { BrandReview } from "../types";

const AUDIENCE_CAP = 2_000_000;
const EMPLOYEE_CAP = 5_000;
const REVENUE_CAP = 500_000_000;

const CHANNELS: Array<{ key: keyof BrandReview; label: string }> = [
  { key: "facebookFollowers", label: "Facebook" },
  { key: "instagramFollowers", label: "Instagram" },
  { key: "twitterFollowers", label: "X" },
  { key: "youtubeSubscribers", label: "YouTube" },
  { key: "linkedinFollowers", label: "LinkedIn" },
];

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Midpoint of a revenue string such as "$1–5M" or "<$500k". */
export function revenueMidpoint(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = raw.toLowerCase().replace(/[$,]/g, " ");
  const unit = /\bbillion\b|\db\b/.test(text)
    ? 1e9
    : /\bmillion\b|\dm\b/.test(text)
      ? 1e6
      : /\bthousand\b|\dk\b/.test(text)
        ? 1e3
        : null;
  const nums = [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  if (!nums.length) return null;
  const scaled = unit ? nums.map((n) => n * unit) : nums[0] >= 1000 ? nums : null;
  if (!scaled) return null;
  if (scaled.length === 1) return scaled[0];
  return (scaled[0] + scaled[1]) / 2;
}

function logPoints(value: number, cap: number, points: number): number {
  if (value <= 0) return 0;
  const ratio = Math.log10(value + 1) / Math.log10(cap + 1);
  return Math.min(points, points * ratio);
}

function compactCount(n: number): string {
  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

export function hasBrandSizeSignal(brand: BrandReview | null | undefined): boolean {
  if (!brand) return false;
  if (CHANNELS.some((channel) => asCount(brand[channel.key]) != null)) return true;
  if (asCount(brand.linkedinEmployees) != null) return true;
  return Boolean(brand.companyRevenue);
}

export function scoreBrandReview(brand: BrandReview): {
  brandScore: number;
  brandScoreSummary: string;
  brandScoreAt: string;
} {
  const present = CHANNELS.flatMap((channel) => {
    const count = asCount(brand[channel.key]);
    return count == null ? [] : [{ label: channel.label, count }];
  });
  const audience = present.reduce((sum, channel) => sum + channel.count, 0);
  const employees = asCount(brand.linkedinEmployees);
  const revenue = revenueMidpoint(brand.companyRevenue);

  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        logPoints(audience, AUDIENCE_CAP, 55) +
          logPoints(employees ?? 0, EMPLOYEE_CAP, 25) +
          logPoints(revenue ?? 0, REVENUE_CAP, 20),
      ),
    ),
  );

  const tier =
    score >= 80
      ? "a major brand"
      : score >= 60
        ? "a large brand"
        : score >= 40
          ? "an established brand"
          : score >= 20
            ? "a growing brand"
            : "a smaller or lightly documented brand";

  const bits: string[] = [];
  if (present.length) {
    bits.push(
      `${compactCount(audience)} followers and subscribers on ${present.map((channel) => channel.label).join(", ")}`,
    );
  }
  if (employees != null) bits.push(`${employees.toLocaleString()} LinkedIn employees`);
  if (brand.companyRevenue) bits.push(`estimated revenue ${brand.companyRevenue.replace(/^["']|["']$/g, "")}`);

  let brandScoreSummary = bits.length
    ? `${bits.join("; ")}. That reads as ${tier}.`
    : "No public follower or company-size metrics were found, so this score stays low.";
  if (present.length > 0 && present.length < 3) {
    brandScoreSummary += " Networks without a public count were left out.";
  }

  return {
    brandScore: score,
    brandScoreSummary,
    brandScoreAt: new Date().toISOString(),
  };
}

export function withBrandScore(brand: BrandReview): BrandReview {
  if (!hasBrandSizeSignal(brand)) {
    return {
      ...brand,
      brandScore: null,
      brandScoreSummary: null,
      brandScoreAt: null,
    };
  }
  return { ...brand, ...scoreBrandReview(brand) };
}

/**
 * Recompute scores from follower and size metrics already stored on each competitor.
 * Does not scrape socials or call the brand-review pipeline.
 */
export function applyBrandScoresForJob(jobId: string): { scored: number; skipped: number } {
  const competitors = getCompetitorsByRun(jobId);
  let scored = 0;
  let skipped = 0;
  for (const competitor of competitors) {
    const brand = competitor.brand;
    if (!hasBrandSizeSignal(brand)) {
      skipped += 1;
      continue;
    }
    updateCompetitor(competitor.id, { brand: withBrandScore(brand) });
    scored += 1;
  }
  return { scored, skipped };
}
