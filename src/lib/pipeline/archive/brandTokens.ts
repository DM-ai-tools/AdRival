import type { BrandColors } from "../../types";
import {
  normalizeHex,
  parseCssColorToHex,
  rgbToHex,
} from "../brandColors";
import type { BrandSiteAssets } from "../brandAssets";
import { resolveBrandBundle } from "../resolveBrandBundle";
import type { ArchivedPage } from "./capturePage";

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

  const primary =
    normalizeHex(byType("accent")?.hex || "") ||
    normalizeHex(byType("brand")?.hex || "") ||
    hexes[0] ||
    null;
  const secondary =
    normalizeHex(byType("dark")?.hex || "") ||
    hexes.find((h) => h !== primary) ||
    primary;
  const accent =
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
 * Prefer Brandfetch; supplement with Playwright computed tokens + HTML/CSS.
 */
export async function extractBrandTokens(input: {
  businessUrl: string;
  archivedCompetitor?: ArchivedPage | null;
  profileName?: string | null;
}): Promise<BrandTokens> {
  const warnings: string[] = [];
  const domain = domainOf(input.businessUrl);

  let brandfetch = null as Awaited<ReturnType<typeof fetchBrandfetch>>;
  try {
    brandfetch = await fetchBrandfetch(domain);
  } catch (err) {
    warnings.push(`Brandfetch failed: ${(err as Error).message}`);
  }
  if (!brandfetch && !process.env.BRANDFETCH_API_KEY) {
    warnings.push("BRANDFETCH_API_KEY not set — using HTML/CSS + CDN fallbacks");
  }

  // Our existing HTML/CSS resolver (handles 403 sites with fallbacks)
  const bundle = await resolveBrandBundle({
    businessUrl: input.businessUrl,
    profile: null,
  });
  warnings.push(...bundle.warnings);

  const colors =
    brandfetch?.colors ||
    bundle.colors;

  const computed = input.archivedCompetitor?.computedTokens;

  const siteAssets = bundle.assets
    ? {
        ...bundle.assets,
        logoUrl:
          brandfetch?.logoUrl || bundle.assets.logoUrl || null,
        socialLinks:
          brandfetch?.socialLinks?.length
            ? brandfetch.socialLinks
            : bundle.assets.socialLinks || [],
      }
    : null;

  return {
    colors: {
      ...(colors || {
        primary: "#0F7A6C",
        secondary: "#134E4A",
        accent: "#F59E0B",
        background: "#FFFFFF",
        text: "#0F172A",
        muted: "#64748B",
        source: "fallback",
      }),
      source: brandfetch?.colors?.source || colors?.source || input.businessUrl,
    },
    logoUrl: brandfetch?.logoUrl || bundle.assets?.logoUrl || null,
    logoDarkUrl: brandfetch?.logoDarkUrl || null,
    fonts:
      brandfetch?.fonts?.length
        ? brandfetch.fonts
        : computed?.fontFamilies || [],
    borderRadii: computed?.borderRadii || [],
    boxShadows: computed?.boxShadows || [],
    socialLinks:
      brandfetch?.socialLinks?.length
        ? brandfetch.socialLinks
        : bundle.assets?.socialLinks || [],
    siteAssets,
    source: brandfetch ? "brandfetch+site" : "site",
    warnings,
  };
}

/** Map competitor painted CSS colors → user palette roles by area rank. */
export function buildColorMap(
  painted: Array<{ css: string; area: number }>,
  user: BrandColors,
): Map<string, string> {
  const map = new Map<string, string>();
  const targets = [user.primary, user.secondary, user.accent];
  let ti = 0;
  for (const row of painted) {
    const hex = cssColorToHex(row.css);
    if (!hex) continue;
    // skip near-white / near-black surfaces
    const n = hex.replace("#", "");
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (lum > 0.92 || lum < 0.08) continue;
    if (Math.max(r, g, b) - Math.min(r, g, b) < 18) continue; // gray
    if ([...map.keys()].some((k) => k.toUpperCase() === hex)) continue;
    map.set(hex, targets[Math.min(ti, targets.length - 1)]);
    // also map the original css form
    map.set(row.css, targets[Math.min(ti, targets.length - 1)]);
    ti += 1;
    if (ti >= 12) break;
  }
  return map;
}
