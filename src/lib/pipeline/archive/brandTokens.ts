import type { BrandColors, BrandDesignSystem, BusinessProfile } from "../../types";
import {
  normalizeHex,
  parseCssColorToHex,
  rgbToHex,
} from "../brandColors";
import type { BrandSiteAssets } from "../brandAssets";
import { resolveBrandBundle } from "../resolveBrandBundle";
import { reconcilePaletteWithHtmlEvidence } from "../brandColorSources";
import {
  harmonizeBrandPalette,
  isJunkBrandHex,
  isWeakOrJunkPalette,
} from "../paletteHarmonize";
import type { ArchivedPage } from "./capturePage";
import { fetchRawLandingHtml } from "../htmlFetch";

export type BrandTokens = {
  colors: BrandColors;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  fonts: string[];
  borderRadii: string[];
  boxShadows: string[];
  socialLinks: Array<{ label: string; href: string }>;
  /** Full site asset scrape when available — used to rebuild footer. */
  siteAssets: BrandSiteAssets | null;
  /** Firecrawl design system (typography, spacing, button styles). */
  design: BrandDesignSystem | null;
  source: string;
  warnings: string[];
};

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url.replace(/^https?:\/\//i, "").split("/")[0] || url;
  }
}

function cssColorToHex(css: string): string | null {
  const direct = parseCssColorToHex(css);
  if (direct) return direct;
  const rgb = css.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i,
  );
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) === 0) return null;
    return rgbToHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  }
  return normalizeHex(css);
}

function isWeakSource(source?: string | null): boolean {
  const s = (source || "").toLowerCase();
  return !s || s === "fallback" || s.startsWith("llm") || s === "default";
}

function isSiteGroundedSource(source?: string | null): boolean {
  const s = (source || "").toLowerCase();
  return (
    s.startsWith("html") ||
    s.startsWith("firecrawl") ||
    s.startsWith("playwright") ||
    s.startsWith("deterministic") ||
    s.includes("html-evidence") ||
    s.startsWith("site") ||
    s.startsWith("css") ||
    s.startsWith("brandfetch")
  );
}

/**
 * Brandfetch Brand API — logos, palette, fonts.
 * Requires BRANDFETCH_API_KEY.
 */
async function fetchBrandfetch(domain: string): Promise<{
  colors: BrandColors | null;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  fonts: string[];
  socialLinks: Array<{ label: string; href: string }>;
} | null> {
  const key = process.env.BRANDFETCH_API_KEY?.trim();
  if (!key) return null;

  const res = await fetch(
    `https://api.brandfetch.io/v2/brands/domain/${encodeURIComponent(domain)}`,
    {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) {
    console.warn("[brandfetch]", res.status, await res.text().catch(() => ""));
    return null;
  }
  const data = (await res.json()) as {
    name?: string;
    logos?: Array<{
      type?: string;
      theme?: string | null;
      formats?: Array<{ src?: string; format?: string }>;
    }>;
    colors?: Array<{ hex?: string; type?: string; brightness?: number }>;
    fonts?: Array<{ name?: string; type?: string }>;
    links?: Array<{ name?: string; url?: string }>;
  };

  const hexes = (data.colors || [])
    .map((c) => normalizeHex(c.hex || ""))
    .filter((h): h is string => Boolean(h));

  const byType = (t: string) =>
    (data.colors || []).find((c) => (c.type || "").toLowerCase() === t);

  // Prefer brand/dark over accent — accent is often a highlight, not the site primary
  const primary =
    normalizeHex(byType("brand")?.hex || "") ||
    normalizeHex(byType("dark")?.hex || "") ||
    normalizeHex(byType("accent")?.hex || "") ||
    hexes[0] ||
    null;
  const secondary =
    normalizeHex(byType("dark")?.hex || "") ||
    hexes.find((h) => h !== primary) ||
    primary;
  const accent =
    normalizeHex(byType("accent")?.hex || "") ||
    normalizeHex(byType("light")?.hex || "") ||
    hexes.find((h) => h !== primary && h !== secondary) ||
    primary;

  const pickLogo = (theme: "light" | "dark" | null) => {
    const logos = data.logos || [];
    const preferred =
      logos.find((l) => l.type === "logo" && (theme ? l.theme === theme : true)) ||
      logos.find((l) => l.type === "logo") ||
      logos.find((l) => l.type === "symbol") ||
      logos[0];
    const formats = preferred?.formats || [];
    const svg = formats.find((f) => f.format === "svg" && f.src);
    const png = formats.find((f) => f.format === "png" && f.src);
    return svg?.src || png?.src || formats[0]?.src || null;
  };

  const colors: BrandColors | null = primary
    ? {
        primary,
        secondary: secondary || primary,
        accent: accent || primary,
        background: "#FFFFFF",
        text: "#0F172A",
        muted: "#64748B",
        source: `brandfetch:${domain}`,
      }
    : null;

  return {
    colors,
    logoUrl: pickLogo("light") || pickLogo(null),
    logoDarkUrl: pickLogo("dark"),
    fonts: (data.fonts || [])
      .map((f) => f.name || "")
      .filter(Boolean)
      .slice(0, 6),
    socialLinks: (data.links || [])
      .filter((l) => l.url && l.name)
      .map((l) => ({ label: String(l.name), href: String(l.url) })),
  };
}

/**
 * Extract brand tokens from the user's business URL.
 * Primary: Firecrawl branding (colors, fonts, logo, socials, spacing).
 * Brandfetch / competitor-computed tokens fill gaps only.
 */
export async function extractBrandTokens(input: {
  businessUrl: string;
  archivedCompetitor?: ArchivedPage | null;
  profileName?: string | null;
  profile?: BusinessProfile | null;
  /** Phase-1 stored palette — preferred when site-grounded */
  preferredColors?: BrandColors | null;
}): Promise<BrandTokens> {
  const warnings: string[] = [];
  const domain = domainOf(input.businessUrl);

  let brandfetch = null as Awaited<ReturnType<typeof fetchBrandfetch>>;
  try {
    brandfetch = await fetchBrandfetch(domain);
  } catch (err) {
    warnings.push(`Brandfetch failed: ${(err as Error).message}`);
  }

  const bundle = await resolveBrandBundle({
    businessUrl: input.businessUrl,
    profile: input.profile || null,
  });
  warnings.push(...bundle.warnings);

  const design =
    bundle.design || input.profile?.brandDesign || null;

  // Prefer Firecrawl / site-grounded palette
  let colors: BrandColors | null = null;
  let colorSource = "unknown";

  if (
    input.preferredColors &&
    !isWeakSource(input.preferredColors.source) &&
    !isWeakOrJunkPalette(input.preferredColors) &&
    isSiteGroundedSource(input.preferredColors.source)
  ) {
    colors = input.preferredColors;
    colorSource = `preferred:${input.preferredColors.source}`;
  } else if (
    bundle.colors &&
    !isWeakSource(bundle.colors.source) &&
    !isWeakOrJunkPalette(bundle.colors)
  ) {
    colors = bundle.colors;
    colorSource = `bundle:${bundle.colors.source}`;
  } else if (
    input.preferredColors &&
    !isWeakSource(input.preferredColors.source) &&
    !isWeakOrJunkPalette(input.preferredColors)
  ) {
    colors = input.preferredColors;
    colorSource = `preferred:${input.preferredColors.source}`;
  } else if (brandfetch?.colors && !isWeakOrJunkPalette(brandfetch.colors)) {
    colors = brandfetch.colors;
    colorSource = "brandfetch";
    try {
      const page = await fetchRawLandingHtml(input.businessUrl);
      colors = reconcilePaletteWithHtmlEvidence(
        colors,
        page.html,
        input.businessUrl,
      );
      colorSource = `brandfetch+html-evidence`;
    } catch {
      warnings.push("Could not reconcile Brandfetch colors with site HTML");
    }
  } else if (bundle.colors && !isWeakOrJunkPalette(bundle.colors)) {
    colors = bundle.colors;
    colorSource = `bundle-fallback:${bundle.colors.source}`;
  }

  if (!colors || isWeakOrJunkPalette(colors)) {
    throw new Error(
      `No real brand colors for ${input.businessUrl}. Re-analyze the business URL with Firecrawl enabled.`,
    );
  }

  // Keep Firecrawl branding roles; only light-clean junk accents
  if (!/^firecrawl-branding:/i.test(colors.source || "")) {
    colors = harmonizeBrandPalette(colors);
  }
  if (isJunkBrandHex(colors.accent)) {
    colors = { ...colors, accent: colors.primary };
  }
  if (isJunkBrandHex(colors.primary)) {
    throw new Error(
      `Brand primary for ${input.businessUrl} resolved to a junk CSS color. Re-analyze with Firecrawl.`,
    );
  }

  const computed = input.archivedCompetitor?.computedTokens;

  const firecrawlFonts = design?.fonts?.length
    ? design.fonts
    : design?.typography?.fontFamilies
      ? [
          design.typography.fontFamilies.heading,
          design.typography.fontFamilies.primary,
        ].filter((f): f is string => Boolean(f))
      : [];

  const borderRadii = [
    design?.spacing?.borderRadius,
    design?.components?.buttonPrimary?.borderRadius,
    ...(computed?.borderRadii || []),
  ].filter((r): r is string => Boolean(r));

  const siteAssets = bundle.assets
    ? {
        ...bundle.assets,
        logoUrl:
          bundle.assets.logoUrl || brandfetch?.logoUrl || null,
        socialLinks: bundle.assets.socialLinks?.length
          ? bundle.assets.socialLinks
          : brandfetch?.socialLinks || [],
      }
    : null;

  return {
    colors: {
      ...colors,
      source: `${colorSource}|${colors.source || domain}`,
    },
    logoUrl: bundle.assets?.logoUrl || brandfetch?.logoUrl || null,
    logoDarkUrl: brandfetch?.logoDarkUrl || null,
    fonts: firecrawlFonts.length
      ? firecrawlFonts
      : brandfetch?.fonts?.length
        ? brandfetch.fonts
        : computed?.fontFamilies || [],
    borderRadii: [...new Set(borderRadii)],
    boxShadows: computed?.boxShadows || [],
    socialLinks: bundle.assets?.socialLinks?.length
      ? bundle.assets.socialLinks
      : brandfetch?.socialLinks || [],
    siteAssets,
    design,
    source: colorSource,
    warnings,
  };
}

/** Map competitor painted CSS colors → user palette roles by area rank. */
export function buildColorMap(
  painted: Array<{ css: string; area: number }>,
  user: BrandColors,
): Map<string, string> {
  const map = new Map<string, string>();
  const targets = [
    user.primary,
    user.secondary,
    user.accent,
    user.primary,
    user.secondary,
  ];
  let ti = 0;
  for (const row of painted) {
    const hex = cssColorToHex(row.css);
    if (!hex) continue;
    const n = hex.replace("#", "");
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (lum > 0.92 || lum < 0.08) continue;
    if (Math.max(r, g, b) - Math.min(r, g, b) < 18) continue;
    if ([...map.keys()].some((k) => k.toUpperCase() === hex)) continue;
    map.set(hex, targets[Math.min(ti, targets.length - 1)]);
    map.set(row.css, targets[Math.min(ti, targets.length - 1)]);
    ti += 1;
    if (ti >= 24) break;
  }
  return map;
}
