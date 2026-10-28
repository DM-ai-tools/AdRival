import type { BusinessProfile } from "../types";
import { analyzeBusinessUrl } from "../openrouter/businessAnalyzer";
import { analyzeServiceArea } from "../openrouter/serviceArea";
import { prefetchBrandBranding, resolveBrandBundle } from "./resolveBrandBundle";

/**
 * The full business profile of a website, as the New Search form makes it:
 * the business analysis, its service area, and its brand (colours, logo and
 * other assets, design). The brand read never fails the analysis. Provider
 * calls bill through the active billing context, so callers run it inside
 * runBillable.
 */
export async function analyzeBusinessProfile(url: string): Promise<BusinessProfile> {
  // Reading the site's branding is slow and needs only the URL, so it
  // starts alongside the profile analysis instead of after it.
  const branding = prefetchBrandBranding(url);
  const base = await analyzeBusinessUrl(url);
  // Location, local-vs-national suggestion and search rings run
  // alongside the brand read; it never fails the analysis.
  const area = analyzeServiceArea(base);

  // Brand identity via site branding (+ links) — colors, fonts, logo, socials
  let bundle: Awaited<ReturnType<typeof resolveBrandBundle>> | null = null;
  try {
    bundle = await resolveBrandBundle({
      businessUrl: base.url || url,
      profile: base,
      prefetched: branding,
    });
  } catch (err) {
    console.warn("[business/analyze] brand bundle failed", err);
  }
  const analyzed = await area;
  if (bundle) {
    analyzed.brandColors = bundle.colors;
    analyzed.brandAssets = bundle.assets;
    analyzed.brandDesign = bundle.design;
    if (bundle.warnings.length) {
      console.warn("[business/analyze] brand warnings", bundle.warnings);
    }
  }
  return analyzed;
}

/**
 * A website reduced to what makes it the same site: lowercase host without
 * `www.` and the path without a trailing slash. Scheme, query and fragment
 * are ignored. Null when it is not a web address.
 */
export function websiteKey(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!host) return null;
    return `${host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Whether two addresses are the same website (see websiteKey). */
export function sameWebsite(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = websiteKey(a);
  return ka !== null && ka === websiteKey(b);
}

type ProfileAnalyzer = (url: string) => Promise<BusinessProfile>;

let analyzerOverride: ProfileAnalyzer | null = null;

/** The analysis a recreate build runs for a website other than its search's own (a test's stand-in when set). */
export function businessProfileAnalyzer(): ProfileAnalyzer {
  return analyzerOverride ?? analyzeBusinessProfile;
}

/** Replaces the analysis builds run; null puts the real one back. */
export function setBusinessProfileAnalyzerForTests(fn: ProfileAnalyzer | null): void {
  analyzerOverride = fn;
}
