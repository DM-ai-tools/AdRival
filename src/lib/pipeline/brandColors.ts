import type { BrandColors } from "../types";
import { fetchRawLandingHtml } from "./htmlFetch";
import {
  harmonizeBrandPalette,
  isJunkBrandHex,
} from "./paletteHarmonize";

export type RankedColor = { hex: string; weight: number; sat: number; lum: number };

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function normalizeHex(raw: string): string | null {
  const s = raw.trim();
  const short = s.match(/^#([0-9a-fA-F]{3})$/);
  if (short) {
    const [r, g, b] = short[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  const full = s.match(/^#([0-9a-fA-F]{6})$/i);
  if (full) return `#${full[1]}`.toUpperCase();
  return null;
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((v) => clampByte(v).toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (h < 60) [rp, gp, bp] = [c, x, 0];
  else if (h < 120) [rp, gp, bp] = [x, c, 0];
  else if (h < 180) [rp, gp, bp] = [0, c, x];
  else if (h < 240) [rp, gp, bp] = [0, x, c];
  else if (h < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return rgbToHex((rp + m) * 255, (gp + m) * 255, (bp + m) * 255);
}

export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function saturation(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

function isNearWhiteOrBlack(hex: string): boolean {
  const l = luminance(hex);
  return l > 0.93 || l < 0.07;
}

function isGrayish(hex: string): boolean {
  return saturation(hex) < 0.12;
}

/**
 * Collect weighted brand-ish colors from HTML + CSS text.
 */
export function collectRankedColors(cssOrHtml: string): RankedColor[] {
  const found = new Map<string, number>();

  const bump = (raw: string, weight = 1) => {
    const n = normalizeHex(raw);
    if (!n || isNearWhiteOrBlack(n)) return;
    if (isJunkBrandHex(n)) return; // skip CSS pure red/blue/green junk
    found.set(n, (found.get(n) || 0) + weight);
  };

  // theme-color
  for (const m of cssOrHtml.matchAll(
    /name=["']theme-color["'][^>]*content=["']([^"']+)["']/gi,
  )) {
    bump(m[1], 20);
  }
  for (const m of cssOrHtml.matchAll(
    /content=["']([^"']+)["'][^>]*name=["']theme-color["']/gi,
  )) {
    bump(m[1], 20);
  }

  // CSS variables that look branded
  for (const m of cssOrHtml.matchAll(
    /--[\w-]*(primary|brand|accent|main|secondary|cta|button|link|theme|color)[\w-]*\s*:\s*([^;!}{]+)/gi,
  )) {
    const val = m[2].trim();
    const hex = parseCssColorToHex(val);
    if (hex) bump(hex, 14);
  }

  // Hex literals
  for (const m of cssOrHtml.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    bump(`#${m[1]}`, 1);
  }

  // rgb / rgba
  for (const m of cssOrHtml.matchAll(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+)?\s*\)/gi,
  )) {
    bump(rgbToHex(Number(m[1]), Number(m[2]), Number(m[3])), 1);
  }

  // hsl / hsla
  for (const m of cssOrHtml.matchAll(
    /hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%(?:\s*,\s*[\d.]+)?\s*\)/gi,
  )) {
    bump(hslToHex(Number(m[1]), Number(m[2]), Number(m[3])), 1);
  }

  return [...found.entries()]
    .map(([hex, weight]) => ({
      hex,
      weight,
      sat: saturation(hex),
      lum: luminance(hex),
    }))
    .sort((a, b) => {
      // Prefer saturated brand colors with higher weight
      const scoreA = a.weight * (1 + a.sat * 2);
      const scoreB = b.weight * (1 + b.sat * 2);
      return scoreB - scoreA;
    });
}

export function parseCssColorToHex(value: string): string | null {
  const v = value.trim();
  const asHex = normalizeHex(v);
  if (asHex) return asHex;
  const rgb = v.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+)?\s*\)$/i,
  );
  if (rgb) return rgbToHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  const hsl = v.match(
    /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%(?:\s*,\s*[\d.]+)?\s*\)$/i,
  );
  if (hsl) return hslToHex(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
  return null;
}

function pickPalette(ranked: RankedColor[], source: string): BrandColors {
  const chromatic = ranked.filter(
    (c) => !isGrayish(c.hex) && !isJunkBrandHex(c.hex),
  );
  const pool = chromatic.length
    ? chromatic
    : ranked.filter((c) => !isJunkBrandHex(c.hex));

  if (!pool.length) {
    throw new Error(
      `No usable brand colors found in page CSS/HTML for ${source}`,
    );
  }

  const byBrandStrength = [...pool].sort((a, b) => {
    const score = (c: RankedColor) =>
      c.weight * (1 + c.sat * 3) * (1 - Math.abs(c.lum - 0.45));
    return score(b) - score(a);
  });
  const primary = byBrandStrength[0].hex;

  const secondary =
    pool.find(
      (c) =>
        c.hex !== primary &&
        !isJunkBrandHex(c.hex) &&
        (c.lum < 0.25 || Math.abs(c.lum - byBrandStrength[0].lum) > 0.12),
    )?.hex ||
    pool.find((c) => c.hex !== primary && !isJunkBrandHex(c.hex))?.hex ||
    primary;

  const accent =
    pool.find(
      (c) =>
        c.hex !== primary &&
        c.hex !== secondary &&
        !isJunkBrandHex(c.hex) &&
        c.sat >= 0.2,
    )?.hex || primary;

  const bgCandidate = ranked.find((c) => c.lum > 0.85 && isGrayish(c.hex));
  const textCandidate = ranked.find(
    (c) => c.lum < 0.25 && !isJunkBrandHex(c.hex),
  );
  const mutedCandidate = ranked.find(
    (c) =>
      isGrayish(c.hex) && c.lum > 0.35 && c.lum < 0.7 && !isJunkBrandHex(c.hex),
  );

  return harmonizeBrandPalette(
    {
      primary,
      secondary,
      accent,
      background: bgCandidate?.hex || "#FFFFFF",
      text: textCandidate?.hex || "#0F172A",
      muted: mutedCandidate?.hex || "#64748B",
      source,
    },
    ranked.map((c) => c.hex),
  );
}

async function fetchLinkedStylesheets(
  html: string,
  baseUrl: string,
  limit = 8,
): Promise<string> {
  const hrefs: string[] = [];
  for (const m of html.matchAll(
    /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi,
  )) {
    hrefs.push(m[1]);
  }
  for (const m of html.matchAll(
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']stylesheet["']/gi,
  )) {
    hrefs.push(m[1]);
  }

  const unique = [...new Set(hrefs)].slice(0, limit);
  const chunks: string[] = [];
  await Promise.all(
    unique.map(async (href) => {
      try {
        const url = new URL(href, baseUrl).toString();
        const res = await fetch(url, {
          redirect: "follow",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            Accept: "text/css,*/*;q=0.1",
            "Accept-Language": "en-US,en;q=0.9",
            Referer: baseUrl,
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return;
        const css = (await res.text()).slice(0, 120_000);
        chunks.push(css);
      } catch {
        // ignore stylesheet failures
      }
    }),
  );
  return chunks.join("\n");
}

/**
 * Derive brand palette from already-fetched HTML (and optional linked CSS).
 */
export async function extractBrandColorsFromHtml(
  html: string,
  baseUrl: string,
): Promise<BrandColors> {
  const linkedCss = await fetchLinkedStylesheets(html, baseUrl);
  const ranked = collectRankedColors(`${html}\n${linkedCss}`);
  return pickPalette(ranked, baseUrl);
}

/**
 * Fetch a business website and derive a brand palette from HTML + linked CSS.
 * Throws if the site cannot be fetched — callers should use resolveBrandBundle for fallbacks.
 */
export async function extractBrandColors(
  urlInput: string,
): Promise<BrandColors> {
  const url = /^https?:\/\//i.test(urlInput.trim())
    ? urlInput.trim()
    : `https://${urlInput.trim()}`;

  const fetched = await fetchRawLandingHtml(url);
  return extractBrandColorsFromHtml(fetched.html, fetched.finalUrl);
}

/**
 * Rank competitor colors for remapping onto the user's palette.
 */
export function collectCompetitorBrandColors(html: string): string[] {
  return collectRankedColors(html)
    .filter((c) => !isGrayish(c.hex))
    .slice(0, 10)
    .map((c) => c.hex);
}
