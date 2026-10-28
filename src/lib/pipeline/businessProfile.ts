import type { BusinessProfile } from "../types";
import { isCreditError } from "../accounting/errors";
import { analyzeBusinessUrl } from "../openrouter/businessAnalyzer";
import { analyzeServiceArea } from "../openrouter/serviceArea";
import { prefetchBrandBranding, resolveBrandBundle } from "./resolveBrandBundle";

/** The steps of the analysis (tests replace them). */
export type BusinessProfileSteps = {
  prefetchBrandBranding: typeof prefetchBrandBranding;
  analyzeBusinessUrl: typeof analyzeBusinessUrl;
  analyzeServiceArea: typeof analyzeServiceArea;
  resolveBrandBundle: typeof resolveBrandBundle;
};

const REAL_STEPS: BusinessProfileSteps = {
  prefetchBrandBranding,
  analyzeBusinessUrl,
  analyzeServiceArea,
  resolveBrandBundle,
};

/**
 * The full business profile of a website, as the New Search form makes it:
 * the business analysis, its service area, and its brand (colours, logo and
 * other assets, design). A failed brand read leaves the profile without
 * brand data; with `strictBrand` a credit error in the brand read is thrown
 * instead (a recreate build must not carry on past it). Provider calls bill
 * through the active billing context, so callers run it inside runBillable.
 */
export async function analyzeBusinessProfile(
  url: string,
  options: { strictBrand?: boolean } = {},
  steps: BusinessProfileSteps = REAL_STEPS,
): Promise<BusinessProfile> {
  // Reading the site's branding is slow and needs only the URL, so it
  // starts alongside the profile analysis instead of after it.
  const branding = steps.prefetchBrandBranding(url);
  const base = await steps.analyzeBusinessUrl(url);
  // Location, local-vs-national suggestion and search rings run
  // alongside the brand read; it never fails the analysis.
  const area = steps.analyzeServiceArea(base);

  // Brand identity via site branding (+ links) — colors, fonts, logo, socials
  let bundle: Awaited<ReturnType<typeof resolveBrandBundle>> | null = null;
  try {
    bundle = await steps.resolveBrandBundle({
      businessUrl: base.url || url,
      profile: base,
      prefetched: branding,
    });
  } catch (err) {
    if (options.strictBrand && isCreditError(err)) {
      await area.catch(() => undefined);
      throw err;
    }
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
 * The client-facing message for an analysis that failed because of setup
 * (missing key, rejected key, provider credit limit), or null for any other
 * failure (the site could not be read).
 */
export function analysisSetupMessage(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  if (/402|credits|max_tokens/i.test(message)) {
    return "URL analysis credit limit reached. Please try again later or contact support.";
  }
  if (/401|unauthorized|invalid.*key/i.test(message)) {
    return "URL analysis is not configured correctly. Please contact support.";
  }
  if (/OPENROUTER_API_KEY is not set|API_KEY is missing/i.test(message)) {
    return "URL analysis is not configured. Please contact support.";
  }
  return null;
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

/**
 * The analysis a recreate build runs for a website other than its search's
 * own (a test's stand-in when set): credit errors in the brand read are thrown.
 */
export function businessProfileAnalyzer(): ProfileAnalyzer {
  return analyzerOverride ?? ((url) => analyzeBusinessProfile(url, { strictBrand: true }));
}

/** Replaces the analysis builds run; null puts the real one back. */
export function setBusinessProfileAnalyzerForTests(fn: ProfileAnalyzer | null): void {
  analyzerOverride = fn;
}
