import type { BrandColors } from "../../types";

export type DesignTokens = {
  primary: string;
  primaryInk: string;
  accent: string;
  page: string;
  ink: string;
  muted: string;
  surface: string;
  surfaceInk: string;
  contrast: string;
  contrastInk: string;
  border: string;
  radius: string;
  shadow: string;
  font: string;
  bodyFont: string;
  fontNote: string | null;
  fontHref: string | null;
};

function hexToRgb(hex: string): [number, number, number] | null {
  const raw = hex.trim().replace(/^#/, "");
  const value = raw.length === 3 ? raw.split("").map((part) => part + part).join("") : raw;
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  const n = Number.parseInt(value, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 1;
  const [r, g, b] = rgb.map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

/** Pick a readable foreground. Never force black onto a dark brand surface. */
export function mapPaintToBrand(paint: string | null | undefined, tokens: DesignTokens): { background: string; color: string } | null {
  if (!paint) return null;
  const rgb = paint.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  const hex = paint.trim().replace(/^#/, "");
  let r = 255;
  let g = 255;
  let b = 255;
  if (rgb) {
    r = Number(rgb[1]);
    g = Number(rgb[2]);
    b = Number(rgb[3]);
  } else if (/^[0-9a-f]{6}$/i.test(hex)) {
    r = Number.parseInt(hex.slice(0, 2), 16);
    g = Number.parseInt(hex.slice(2, 4), 16);
    b = Number.parseInt(hex.slice(4, 6), 16);
  } else {
    return null;
  }
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const sat = max === 0 ? 0 : (max - min) / max;
  if (lum > 0.92 && sat < 0.15) return null;
  if (lum < 0.45) return { background: tokens.surface, color: tokens.surfaceInk };
  if (sat > 0.35) return { background: tokens.primary, color: tokens.primaryInk };
  return null;
}

export function readableText(background: string, preferred: string): string {
  const light = "#f6f5f2";
  const dark = "#1a1a1a";
  const candidates = [preferred, luminance(background) < 0.42 ? light : dark, light, dark];
  return candidates.find((color) => contrastRatio(color, background) >= 4.5) || (luminance(background) < 0.42 ? light : dark);
}

function safeFontName(value: string | null | undefined): string {
  return (value || "").replace(/[^a-zA-Z0-9 \-]/g, "").trim();
}

export function designTokens(
  colors: BrandColors,
  fontFamily: string | null | undefined,
  options?: { bodyFont?: string | null; radius?: string | null },
): DesignTokens {
  const primary = colors.primary || "#1c1c1c";
  const page = colors.background || "#f6f5f2";
  const surface = colors.secondary || "#ffffff";
  const accent = colors.accent || primary;
  const contrast = luminance(primary) < 0.45 ? primary : surface;
  const preferred = colors.text || "#1a1a1a";
  const mutedPreferred = colors.muted || "#5c5c5c";
  const fontName = safeFontName(fontFamily);
  const bodyName = safeFontName(options?.bodyFont) || fontName;
  const names = [...new Set([fontName, bodyName].filter(Boolean))];
  const sans = /sans|inter|helvetica|arial|roboto|lato|montserrat|poppins|nunito|rubik|oswald|source sans/i.test(names.join(" ") || fontName);
  const fallback = sans ? "system-ui, sans-serif" : "Georgia, \"Times New Roman\", serif";
  const font = fontName ? `"${fontName}", ${fallback}` : fallback;
  const bodyFont = bodyName ? `"${bodyName}", ${fallback}` : font;
  const radius = (options?.radius || "").trim();
  const fontHref = names.length
    ? `https://fonts.googleapis.com/css2?${names.map((name) => `family=${encodeURIComponent(name).replace(/%20/g, "+")}:wght@400;600;700`).join("&")}&display=swap`
    : null;
  return {
    primary,
    primaryInk: readableText(primary, "#ffffff"),
    accent,
    page,
    ink: readableText(page, preferred),
    muted: readableText(page, mutedPreferred),
    surface,
    surfaceInk: readableText(surface, preferred),
    contrast,
    contrastInk: readableText(contrast, preferred),
    border: luminance(page) < 0.4 ? "rgba(255,255,255,.16)" : "rgba(20,20,20,.12)",
    radius: /^[\d.]+px$/.test(radius) ? radius : "0",
    shadow: "none",
    font,
    bodyFont,
    fontNote: fontName
      ? `Brand font “${fontName}” is requested from Google Fonts when online. ${fallback} is the same-category fallback if it does not load.`
      : "No brand font was stored. A same-category fallback was declared and not presented as the client’s face.",
    fontHref,
  };
}
