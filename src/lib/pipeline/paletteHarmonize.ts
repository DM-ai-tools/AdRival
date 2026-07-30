import type { BrandColors } from "../types";
import { luminance, normalizeHex, saturation } from "./brandColors";

export type HueFamily =
  | "orange"
  | "red"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "other";

/**
 * CSS / browser / framework junk — not real brand colors.
 * Pure primaries (#FF0000 etc.) show up in resets, error states, and named-color CSS.
 */
const JUNK_HEX = new Set(
  [
    "#FF0000",
    "#00FF00",
    "#0000FF",
    "#FFFF00",
    "#FF00FF",
    "#00FFFF",
    // Former AdRival hardcoded defaults that leaked into designs
    "#2B6CB0",
    "#0F7A6C",
    "#134E4A",
    "#F59E0B",
  ].map((h) => h.toUpperCase()),
);

export function isJunkBrandHex(hex: string | null | undefined): boolean {
  const n = normalizeHex(hex || "");
  if (!n) return true;
  if (JUNK_HEX.has(n)) return true;
  // Near-pure channel primaries (e.g. #FE0000, #FF0101)
  const h = n.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max >= 245 && min <= 12 && saturation(n) > 0.92) return true;
  return false;
}

export function hexHue(hex: string): number | null {
  const n = hex.replace("#", "");
  if (n.length !== 6) return null;
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.0001) return null;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

export function hueFamily(hex: string): HueFamily {
  const h = hexHue(hex);
  if (h == null) return "other";
  if (h < 15 || h >= 345) return "red";
  if (h >= 15 && h < 55) return "orange";
  if (h >= 55 && h < 75) return "yellow";
  if (h >= 75 && h < 170) return "green";
  if (h >= 170 && h < 260) return "blue";
  if (h >= 260 && h < 345) return "purple";
  return "other";
}

function sameFamily(a: string, b: string): boolean {
  const fa = hueFamily(a);
  const fb = hueFamily(b);
  if (fa === "other" || fb === "other") return false;
  const warm = new Set(["orange", "red", "yellow"]);
  if (warm.has(fa) && warm.has(fb)) return true;
  return fa === fb;
}

function isNearNeutral(hex: string): boolean {
  return saturation(hex) < 0.14 || luminance(hex) > 0.92 || luminance(hex) < 0.08;
}

function brandScore(hex: string): number {
  if (isJunkBrandHex(hex)) return -100;
  const sat = saturation(hex);
  const lum = luminance(hex);
  const mid = 1 - Math.abs(lum - 0.45) * 1.4;
  // Penalize extreme pure saturations (often CSS junk that slipped past)
  const purePenalty = sat > 0.95 && (lum < 0.35 || lum > 0.55) ? -1.5 : 0;
  return sat * 2.2 + Math.max(0, mid) + purePenalty;
}

/**
 * Pick the strongest real brand color from candidates (site / Firecrawl / Brandfetch).
 * Never invents colors.
 */
export function pickStrongestBrandHex(
  candidates: Array<string | null | undefined>,
): string | null {
  const scored = candidates
    .map((c) => normalizeHex(c || ""))
    .filter((h): h is string => Boolean(h))
    .filter((h) => !isJunkBrandHex(h))
    .filter((h) => !isNearNeutral(h) || saturation(h) >= 0.25)
    .map((hex) => ({ hex, score: brandScore(hex) }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.hex || null;
}

/**
 * Fill missing roles ONLY from evidence already on the site — never invent hexes.
 * Neutrals (bg/text/muted) may use white/near-black only when evidenced or as layout neutrals.
 */
export function harmonizeBrandPalette(
  colors: BrandColors,
  evidenceHexes?: string[],
): BrandColors {
  const evidence = (evidenceHexes || [])
    .map((h) => normalizeHex(h || ""))
    .filter((h): h is string => Boolean(h) && !isJunkBrandHex(h));

  const primary =
    pickStrongestBrandHex([
      colors.primary,
      colors.accent,
      colors.secondary,
      ...evidence,
    ]) ||
    normalizeHex(colors.primary || "") ||
    null;

  if (!primary) {
    // Caller must not ship this — keep structure but mark source
    return {
      ...colors,
      source: `${colors.source || "unknown"}|missing-primary`,
    };
  }

  const secondaryCandidate =
    normalizeHex(colors.secondary || "") ||
    evidence.find(
      (h) =>
        h !== primary &&
        !isJunkBrandHex(h) &&
        (sameFamily(h, primary) || luminance(h) < 0.25),
    ) ||
    null;

  let secondary = secondaryCandidate;
  if (
    secondary &&
    isJunkBrandHex(secondary)
  ) {
    secondary = null;
  }
  if (
    secondary &&
    saturation(secondary) >= 0.2 &&
    !sameFamily(secondary, primary) &&
    luminance(secondary) >= 0.12
  ) {
    secondary =
      evidence.find((h) => h !== primary && luminance(h) < 0.22) || null;
  }
  // Missing secondary → reuse primary (do NOT invent a darkened hex)
  if (!secondary) secondary = primary;

  let accent = normalizeHex(colors.accent || "") || null;
  if (!accent || isJunkBrandHex(accent)) {
    accent =
      evidence.find(
        (h) =>
          h !== primary &&
          h !== secondary &&
          sameFamily(h, primary) &&
          saturation(h) >= 0.2 &&
          !isJunkBrandHex(h),
      ) || primary;
  } else if (
    saturation(accent) >= 0.18 &&
    !sameFamily(accent, primary)
  ) {
    accent =
      evidence.find(
        (h) =>
          h !== primary &&
          sameFamily(h, primary) &&
          !isJunkBrandHex(h),
      ) || primary;
  }

  const background =
    normalizeHex(colors.background || "") ||
    evidence.find((h) => luminance(h) > 0.9) ||
    "#FFFFFF";
  const textFromEvidence =
    evidence.find((h) => luminance(h) < 0.18 && !isJunkBrandHex(h)) ||
    (luminance(secondary) < 0.25 ? secondary : null);
  const text =
    normalizeHex(colors.text || "") ||
    textFromEvidence ||
    "#0F172A";
  const muted =
    normalizeHex(colors.muted || "") ||
    evidence.find(
      (h) => saturation(h) < 0.2 && luminance(h) > 0.35 && luminance(h) < 0.7,
    ) ||
    "#64748B";

  return {
    primary,
    secondary,
    accent,
    background,
    text,
    muted,
    source: colors.source,
  };
}

/** True when palette looks like scraped junk (pure red primary, etc.). */
export function isWeakOrJunkPalette(colors: BrandColors | null | undefined): boolean {
  if (!colors?.primary) return true;
  if (isJunkBrandHex(colors.primary)) return true;
  if (isJunkBrandHex(colors.accent) && isJunkBrandHex(colors.secondary)) return true;
  if ((colors.source || "").includes("fallback")) return true;
  if ((colors.source || "").includes("missing-primary")) return true;
  return false;
}
