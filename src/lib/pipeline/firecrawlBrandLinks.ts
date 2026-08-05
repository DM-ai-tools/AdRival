import type { BrandLink, BrandSiteAssets } from "./brandAssets";
import { detectSocialNetwork } from "./brandAssets";
import {
  firecrawlMapSite,
  firecrawlScrapePage,
  hasFirecrawlKey,
} from "../firecrawl/client";

export type FirecrawlBrandLinkPack = {
  finalUrl: string;
  siteName: string | null;
  navLinks: BrandLink[];
  footerLinks: BrandLink[];
  socialLinks: BrandLink[];
  servicePages: BrandLink[];
  ctaLinks: BrandLink[];
  warnings: string[];
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function absolutize(baseUrl: string, value: string): string | null {
  const v = (value || "").trim();
  if (
    !v ||
    v.startsWith("#") ||
    v.startsWith("javascript:") ||
    v.startsWith("mailto:") ||
    v.startsWith("tel:")
  ) {
    return null;
  }
  try {
    return new URL(v, baseUrl).toString();
  } catch {
    return null;
  }
}

function isHomepage(href: string, businessUrl: string): boolean {
  try {
    const u = new URL(href);
    const b = new URL(businessUrl);
    if (
      u.hostname.replace(/^www\./i, "").toLowerCase() !==
      b.hostname.replace(/^www\./i, "").toLowerCase()
    ) {
      return false;
    }
    const path = u.pathname.replace(/\/$/, "") || "/";
    // Treat bare origin / hash / query-only as homepage
    return path === "/" || path === "";
  } catch {
    return false;
  }
}

function labelFromUrl(href: string): string {
  try {
    const u = new URL(href);
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || u.hostname;
    return decodeURIComponent(last)
      .replace(/[-_]+/g, " ")
      .replace(/\.\w+$/, "")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim()
      .slice(0, 48);
  } catch {
    return href.slice(0, 40);
  }
}

function uniqLinks(links: BrandLink[], max: number): BrandLink[] {
  const seen = new Set<string>();
  const out: BrandLink[] = [];
  for (const l of links) {
    const href = (l.href || "").trim();
    if (!href) continue;
    const key = href.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: (l.label || labelFromUrl(href)).trim().slice(0, 60) || labelFromUrl(href),
      href,
    });
    if (out.length >= max) break;
  }
  return out;
}

function looksServicePath(href: string): boolean {
  return /\/(services?|solutions?|products?|offerings?|what-we-do|loans?|mortgage|insurance|refinance|home-loans?|personal-loans?|car-loans?|business|pricing|packages?|plans?|programs?|treatments?)(\/|$)/i.test(
    href,
  );
}

function looksFooterPath(href: string): boolean {
  return /\/(about|contact|privacy|terms|cookie|disclaimer|complaints?|licence|license|team|careers?|faq|help|support|blog|resources?|guides?)(\/|$)/i.test(
    href,
  );
}

function looksCtaPath(href: string): boolean {
  return /\/(contact|book|booking|schedule|appoint|consultation|apply|signup|sign-up|get-started|getstarted|quote|enquiry|inquiry|demo|trial|register)(\/|$)/i.test(
    href,
  );
}

function looksCtaLabel(label: string): boolean {
  return /^(contact|book|schedule|apply|get started|start|try|demo|quote|enquire|inquire|sign up|register)\b/i.test(
    (label || "").trim(),
  );
}

function asLinkList(raw: unknown, baseUrl: string): BrandLink[] {
  if (!Array.isArray(raw)) return [];
  const out: BrandLink[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as { label?: string; href?: string; url?: string };
    const href = absolutize(baseUrl, r.href || r.url || "");
    if (!href) continue;
    out.push({
      label: (r.label || labelFromUrl(href)).trim(),
      href,
    });
  }
  return out;
}

/**
 * Scrape + map the business site with Firecrawl to collect real
 * nav / footer / social / service links (not homepage-collapsed).
 */
export async function extractBrandLinksWithFirecrawl(
  businessUrl: string,
): Promise<FirecrawlBrandLinkPack> {
  const warnings: string[] = [];
  if (!hasFirecrawlKey()) {
    return {
      finalUrl: businessUrl,
      siteName: null,
      navLinks: [],
      footerLinks: [],
      socialLinks: [],
      servicePages: [],
      ctaLinks: [],
      warnings: ["FIRECRAWL_API_KEY not set — skipped Firecrawl link scrape"],
    };
  }

  let finalUrl = businessUrl;
  const nav: BrandLink[] = [];
  const footer: BrandLink[] = [];
  const social: BrandLink[] = [];
  const services: BrandLink[] = [];
  const ctas: BrandLink[] = [];
  const allInternal: BrandLink[] = [];
  let siteName: string | null = null;

  // 1) Homepage scrape (links + structured JSON)
  try {
    const scraped = await firecrawlScrapePage(businessUrl);
    const data = scraped.data;
    finalUrl =
      data?.metadata?.sourceURL ||
      data?.metadata?.url ||
      businessUrl;
    siteName = data?.metadata?.title || null;

    const extracted = (data?.json || {}) as {
      siteName?: string;
      navLinks?: unknown;
      footerLinks?: unknown;
      socialLinks?: unknown;
      servicePages?: unknown;
      ctaLinks?: unknown;
    };
    if (extracted.siteName) siteName = extracted.siteName;

    nav.push(...asLinkList(extracted.navLinks, finalUrl));
    footer.push(...asLinkList(extracted.footerLinks, finalUrl));
    social.push(...asLinkList(extracted.socialLinks, finalUrl));
    services.push(...asLinkList(extracted.servicePages, finalUrl));
    ctas.push(...asLinkList(extracted.ctaLinks, finalUrl));

    for (const raw of data?.links || []) {
      const href = absolutize(finalUrl, raw);
      if (!href) continue;
      const net = detectSocialNetwork(href);
      if (net) {
        social.push({
          label: net.charAt(0).toUpperCase() + net.slice(1),
          href,
        });
        continue;
      }
      const h = hostOf(href);
      const base = hostOf(finalUrl);
      if (!h || !base || h !== base) continue;
      if (isHomepage(href, finalUrl)) continue;
      const label = labelFromUrl(href);
      allInternal.push({ label, href });
      if (looksCtaPath(href) || looksCtaLabel(label)) {
        ctas.push({ label, href });
      }
      if (looksServicePath(href)) {
        services.push({ label, href });
      } else if (looksFooterPath(href)) {
        footer.push({ label, href });
      }
    }
  } catch (err) {
    warnings.push(
      `Firecrawl scrape failed: ${(err as Error).message || String(err)}`,
    );
  }

  // 2) Site map for deeper service / page discovery
  try {
    const mapped = await firecrawlMapSite(businessUrl, { limit: 80 });
    for (const row of mapped) {
      const href = absolutize(finalUrl, row.url);
      if (!href) continue;
      if (detectSocialNetwork(href)) {
        social.push({
          label: (row.title || labelFromUrl(href)).slice(0, 40),
          href,
        });
        continue;
      }
      const h = hostOf(href);
      const base = hostOf(finalUrl);
      if (!h || !base || h !== base) continue;
      if (isHomepage(href, finalUrl)) continue;
      const label = (row.title || labelFromUrl(href)).trim().slice(0, 60);
      allInternal.push({ label, href });
      if (looksCtaPath(href) || looksCtaLabel(label)) {
        ctas.push({ label, href });
      }
      if (looksServicePath(href)) services.push({ label, href });
      else if (looksFooterPath(href)) footer.push({ label, href });
      else if (/\/(services?|solutions?|products?)\b/i.test(href)) {
        services.push({ label, href });
      }
    }
  } catch (err) {
    warnings.push(
      `Firecrawl map failed: ${(err as Error).message || String(err)}`,
    );
  }

  // Prefer non-home internals for nav if JSON nav was empty/homepaged
  const navClean = uniqLinks(
    nav.filter((l) => !isHomepage(l.href, finalUrl)),
    12,
  );
  const navFallback = uniqLinks(
    allInternal.filter(
      (l) =>
        !isHomepage(l.href, finalUrl) &&
        !/privacy|terms|cookie|disclaimer|complaints?/i.test(l.href),
    ),
    10,
  );

  const footerClean = uniqLinks(
    [
      ...footer.filter((l) => !isHomepage(l.href, finalUrl)),
      ...allInternal.filter((l) => looksFooterPath(l.href)),
    ],
    16,
  );

  const serviceClean = uniqLinks(
    services.filter((l) => !isHomepage(l.href, finalUrl)),
    14,
  );

  const ctaClean = uniqLinks(
    [
      ...ctas.filter((l) => !isHomepage(l.href, finalUrl)),
      ...allInternal.filter(
        (l) =>
          !isHomepage(l.href, finalUrl) &&
          (looksCtaPath(l.href) || looksCtaLabel(l.label)),
      ),
      ...serviceClean.filter((l) => looksCtaPath(l.href)),
    ],
    10,
  );

  // If footer still thin, promote service pages into footer inventory
  const footerMerged = uniqLinks(
    [
      ...footerClean,
      ...serviceClean.slice(0, 8),
      ...navFallback.slice(0, 6),
    ].filter((l) => !isHomepage(l.href, finalUrl)),
    16,
  );

  const socialClean = uniqLinks(
    social.filter((l) => Boolean(detectSocialNetwork(l.href, l.label))),
    10,
  );

  if (
    !navClean.length &&
    !footerMerged.length &&
    !serviceClean.length &&
    !socialClean.length &&
    !ctaClean.length
  ) {
    warnings.push(
      "Firecrawl returned no usable non-homepage links — check the business URL / site structure",
    );
  }

  return {
    finalUrl,
    siteName,
    navLinks: navClean.length ? navClean : navFallback.slice(0, 8),
    footerLinks: footerMerged,
    socialLinks: socialClean,
    servicePages: serviceClean,
    ctaLinks: ctaClean,
    warnings,
  };
}

/** Merge Firecrawl pack into existing BrandSiteAssets (Firecrawl wins on non-empty buckets). */
export function mergeFirecrawlIntoBrandAssets(
  base: BrandSiteAssets | null,
  pack: FirecrawlBrandLinkPack,
  businessUrl: string,
): BrandSiteAssets {
  const fallback: BrandSiteAssets = base || {
    finalUrl: pack.finalUrl || businessUrl,
    siteName: pack.siteName,
    logoUrl: null,
    faviconUrl: null,
    ogImageUrl: null,
    navLinks: [],
    footerLinks: [],
    socialLinks: [],
    images: [],
    emails: [],
    phones: [],
  };

  const serviceAsNav = pack.servicePages.slice(0, 6);
  return {
    ...fallback,
    finalUrl: pack.finalUrl || fallback.finalUrl || businessUrl,
    siteName: pack.siteName || fallback.siteName,
    navLinks: uniqLinks(
      [
        ...(pack.navLinks.length ? pack.navLinks : fallback.navLinks),
        ...serviceAsNav,
      ].filter((l) => !isHomepage(l.href, businessUrl)),
      12,
    ),
    footerLinks: uniqLinks(
      [
        ...(pack.footerLinks.length ? pack.footerLinks : fallback.footerLinks),
        ...pack.servicePages,
      ].filter((l) => !isHomepage(l.href, businessUrl)),
      16,
    ),
    socialLinks: uniqLinks(
      pack.socialLinks.length ? pack.socialLinks : fallback.socialLinks,
      10,
    ),
    servicePages: uniqLinks(
      [
        ...(pack.servicePages.length
          ? pack.servicePages
          : fallback.servicePages || []),
      ].filter((l) => !isHomepage(l.href, businessUrl)),
      14,
    ),
    ctaLinks: uniqLinks(
      [
        ...(pack.ctaLinks.length ? pack.ctaLinks : fallback.ctaLinks || []),
        ...pack.servicePages.filter((l) => looksCtaPath(l.href)),
      ].filter((l) => !isHomepage(l.href, businessUrl)),
      10,
    ),
  };
}
