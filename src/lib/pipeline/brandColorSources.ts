import type { BrandColors, BrandDesignSystem } from "../types";
import {
  collectRankedColors,
  extractBrandColorsFromHtml,
  luminance,
  normalizeHex,
  type RankedColor,
} from "./brandColors";
import {
  firecrawlScrapeBranding,
  hasFirecrawlKey,
  type FirecrawlBrandingProfile,
} from "../firecrawl/client";
import {
  detectSocialNetwork,
  extractBrandAssetsFromHtml,
  type BrandSiteAssets,
} from "./brandAssets";
import {
  harmonizeBrandPalette,
  hueFamily,
  isJunkBrandHex,
  pickStrongestBrandHex,
} from "./paletteHarmonize";

function domainOf(url: string): string {
  try {
    return new URL(
      /^https?:\/\//i.test(url) ? url : `https://${url}`,
    ).hostname.replace(/^www\./i, "");
  } catch {
    return url.replace(/^https?:\/\//i, "").split("/")[0] || url;
  }
}

/** Captcha / bot-challenge shells are not usable brand HTML. */
export function isChallengeOrEmptyHtml(html: string | null | undefined): boolean {
  if (!html || html.length < 400) return true;
  return /sgcaptcha|cf-browser-verification|challenge-platform|just a moment|attention required|enable javascript|captcha/i.test(
    html,
  );
}

/**
 * Firecrawl often labels theme/link blues as `colors.primary` while the real
 * brand CTA lives on `buttonPrimary` (+ accent/link/text). Prefer the CTA when
 * it disagrees in hue and is backed by another branding field.
 */
function resolveFirecrawlPrimary(
  reported: string | null,
  btnBg: string | null,
  backing: Array<string | null>,
): string | null {
  if (!reported && !btnBg) return null;
  if (!reported) return btnBg;
  if (!btnBg || isJunkBrandHex(btnBg)) return reported;
  if (hueFamily(btnBg) === hueFamily(reported)) return reported;

  const supporters = backing.filter(
    (h): h is string =>
      Boolean(h) &&
      !isJunkBrandHex(h!) &&
      hueFamily(h!) === hueFamily(btnBg),
  ).length;

  // CTA + accent/link/text agree, or reported primary is a lone blue while CTA is not
  if (
    supporters >= 1 ||
    (hueFamily(reported) === "blue" && hueFamily(btnBg) !== "blue")
  ) {
    return btnBg;
  }
  return reported;
}

/**
 * Map Firecrawl branding.colors (+ button components) → BrandColors.
 * Prefer button CTA over mislabelled Firecrawl `colors.primary` when evidence agrees.
 */
export function colorsFromFirecrawlBranding(
  branding: FirecrawlBrandingProfile | null | undefined,
  sourceUrl: string,
): BrandColors | null {
  const c = branding?.colors;
  if (!c) return null;

  const btnBg = normalizeHex(
    branding?.components?.buttonPrimary?.background || "",
  );
  const reported =
    normalizeHex(c.primary || "") || normalizeHex(c.brand || "") || null;
  const accentField = normalizeHex(c.accent || "");
  const linkField = normalizeHex(c.link || "");
  const textField = normalizeHex(c.textPrimary || c.text || "");

  const primary =
    resolveFirecrawlPrimary(reported, btnBg, [
      accentField,
      linkField,
      textField,
    ]) ||
    accentField ||
    null;
  if (!primary || isJunkBrandHex(primary)) return null;

  const secondary = normalizeHex(c.secondary || "") || primary;

  // If we promoted the CTA to primary, keep Firecrawl's reported primary as accent
  // when it still differs; otherwise use accent/link/button as before.
  const accent =
    (primary === btnBg &&
    reported &&
    reported !== primary &&
    !isJunkBrandHex(reported)
      ? reported
      : null) ||
    accentField ||
    linkField ||
    (btnBg && btnBg !== primary ? btnBg : null) ||
    primary;

  const background = normalizeHex(c.background || "") || "#FFFFFF";
  const text =
    textField || (luminance(background) > 0.5 ? "#0F172A" : "#FFFFFF");
  const muted = normalizeHex(c.textSecondary || "") || "#64748B";

  const accentFinal =
    accent && accent !== primary && !isJunkBrandHex(accent)
      ? accent
      : btnBg && btnBg !== primary && !isJunkBrandHex(btnBg)
        ? btnBg
        : accent;

  return {
    primary,
    secondary: secondary && !isJunkBrandHex(secondary) ? secondary : primary,
    accent: accentFinal && !isJunkBrandHex(accentFinal) ? accentFinal : primary,
    background,
    text: text && !isJunkBrandHex(text) ? text : "#0F172A",
    muted: muted && !isJunkBrandHex(muted) ? muted : "#64748B",
    source: `firecrawl-branding:${sourceUrl}`,
  };
}

export function designFromFirecrawlBranding(
  branding: FirecrawlBrandingProfile | null | undefined,
  sourceUrl: string,
): BrandDesignSystem | null {
  if (!branding) return null;

  const fonts: string[] = [];
  const pushFont = (f?: string | null) => {
    const name = (f || "").trim();
    if (!name || fonts.includes(name)) return;
    fonts.push(name);
  };
  pushFont(branding.typography?.fontFamilies?.heading);
  pushFont(branding.typography?.fontFamilies?.primary);
  for (const f of branding.fonts || []) pushFont(f.family);
  pushFont(branding.typography?.fontFamilies?.code);

  const hasAnything =
    fonts.length > 0 ||
    branding.colorScheme ||
    branding.spacing?.borderRadius ||
    branding.components?.buttonPrimary ||
    branding.personality;

  if (!hasAnything) return null;

  return {
    colorScheme: branding.colorScheme || null,
    fonts: fonts.slice(0, 8),
    typography: branding.typography
      ? {
          fontFamilies: branding.typography.fontFamilies
            ? {
                primary: branding.typography.fontFamilies.primary,
                heading: branding.typography.fontFamilies.heading,
                code: branding.typography.fontFamilies.code,
              }
            : undefined,
          fontSizes: branding.typography.fontSizes,
          fontWeights: branding.typography.fontWeights,
        }
      : null,
    spacing: branding.spacing
      ? {
          baseUnit: branding.spacing.baseUnit,
          borderRadius: branding.spacing.borderRadius,
        }
      : null,
    components: branding.components
      ? {
          buttonPrimary: branding.components.buttonPrimary,
          buttonSecondary: branding.components.buttonSecondary,
        }
      : null,
    personality: branding.personality
      ? {
          tone: branding.personality.tone,
          energy: branding.personality.energy,
          targetAudience: branding.personality.targetAudience,
        }
      : null,
    source: `firecrawl-branding:${sourceUrl}`,
  };
}

function socialLinksFromUrls(
  links: string[] | null | undefined,
): Array<{ label: string; href: string }> {
  const out: Array<{ label: string; href: string }> = [];
  const seenNet = new Set<string>();
  for (const href of links || []) {
    if (!href) continue;
    let host = "";
    try {
      host = new URL(href).hostname.toLowerCase();
    } catch {
      continue;
    }
    // Only real social hosts — not /linkedin-ads/ service pages on the brand site
    let network: ReturnType<typeof detectSocialNetwork> = null;
    if (/facebook\.com|fb\.com|fb\.me$/i.test(host)) network = "facebook";
    else if (/instagram\.com|instagr\.am$/i.test(host)) network = "instagram";
    else if (/linkedin\.com$/i.test(host)) network = "linkedin";
    else if (/youtube\.com|youtu\.be$/i.test(host)) network = "youtube";
    else if (/tiktok\.com$/i.test(host)) network = "tiktok";
    else if (/^(twitter\.com|x\.com)$/i.test(host)) network = "twitter";
    else if (/pinterest\.com$/i.test(host)) network = "pinterest";
    else if (/threads\.net$/i.test(host)) network = "threads";
    if (!network || seenNet.has(network)) continue;
    seenNet.add(network);
    const labelMap: Record<string, string> = {
      facebook: "Facebook",
      instagram: "Instagram",
      linkedin: "LinkedIn",
      youtube: "YouTube",
      tiktok: "TikTok",
      twitter: "X / Twitter",
      pinterest: "Pinterest",
      threads: "Threads",
    };
    out.push({ label: labelMap[network] || network, href });
  }
  return out;
}

function assetsFromFirecrawl(input: {
  businessUrl: string;
  branding: FirecrawlBrandingProfile | null | undefined;
  html: string | null;
  links: string[] | null | undefined;
  title: string | null;
}): BrandSiteAssets {
  const finalUrl = input.businessUrl;
  let base: BrandSiteAssets = {
    finalUrl,
    siteName: input.title,
    logoUrl: null,
    faviconUrl: null,
    ogImageUrl: null,
    navLinks: [],
    footerLinks: [],
    socialLinks: socialLinksFromUrls(input.links),
    images: [],
    emails: [],
    phones: [],
  };

  if (input.html && !isChallengeOrEmptyHtml(input.html)) {
    try {
      const fromHtml = extractBrandAssetsFromHtml(input.html, finalUrl);
      base = {
        ...fromHtml,
        socialLinks: fromHtml.socialLinks.length
          ? fromHtml.socialLinks
          : base.socialLinks,
      };
    } catch {
      // keep branding-only assets
    }
  }

  const logo =
    input.branding?.logo ||
    input.branding?.images?.logo ||
    base.logoUrl ||
    null;
  const favicon = input.branding?.images?.favicon || base.faviconUrl || null;
  const ogImage = input.branding?.images?.ogImage || base.ogImageUrl || null;

  if (logo && !base.images.some((i) => i.src === logo)) {
    base.images = [
      { src: logo, alt: base.siteName || "Logo", kind: "logo" as const },
      ...base.images,
    ];
  }

  return {
    ...base,
    logoUrl: logo,
    faviconUrl: favicon,
    ogImageUrl: ogImage,
    siteName: base.siteName || input.title,
    socialLinks: base.socialLinks.length
      ? base.socialLinks
      : socialLinksFromUrls(input.links),
  };
}

/**
 * Reconcile candidate palette with HTML evidence.
 * Rejects off-family accents (e.g. default blue on an orange site).
 */
export function reconcilePaletteWithHtmlEvidence(
  candidate: BrandColors,
  html: string | null | undefined,
  sourceUrl: string,
): BrandColors {
  if (!html || isChallengeOrEmptyHtml(html)) {
    return harmonizeBrandPalette(candidate);
  }
  const ranked = collectRankedColors(html);
  const chromatic = ranked.filter((c) => {
    const fam = hueFamily(c.hex);
    return fam !== "other" || c.sat > 0.2;
  });

  const evidence = ranked.map((c) => c.hex);
  let next = harmonizeBrandPalette(candidate, evidence);

  if (chromatic.length < 2) return next;

  const weight = (fam: ReturnType<typeof hueFamily>) =>
    chromatic
      .filter((c) => hueFamily(c.hex) === fam)
      .reduce((s, c) => s + c.weight * (1 + c.sat), 0);

  const greenW = weight("green");
  const blueW = weight("blue");
  const orangeW = weight("orange") + weight("red") + weight("yellow");
  const candFam = hueFamily(next.primary);

  if (
    (candFam === "orange" || candFam === "red") &&
    greenW + blueW > orangeW * 2 &&
    (greenW > 2 || blueW > 2)
  ) {
    const preferred = pickFromRanked(chromatic, sourceUrl);
    if (preferred) return preferred;
  }

  if (orangeW > (greenW + blueW) * 1.5 && orangeW > 2) {
    next = harmonizeBrandPalette(
      {
        ...next,
        primary:
          pickStrongestBrandHex([
            next.primary,
            ...chromatic
              .filter((c) =>
                ["orange", "red", "yellow"].includes(hueFamily(c.hex)),
              )
              .map((c) => c.hex),
          ]) || next.primary,
      },
      evidence,
    );
  }

  return next;
}

function pickFromRanked(
  ranked: RankedColor[],
  sourceUrl: string,
): BrandColors | null {
  const chromatic = ranked.filter(
    (c) =>
      c.sat >= 0.12 &&
      c.lum > 0.08 &&
      c.lum < 0.92 &&
      !isJunkBrandHex(c.hex),
  );
  if (!chromatic.length) return null;

  const preferred = [...chromatic].sort((a, b) => {
    const score = (c: RankedColor) =>
      c.weight * (1 + c.sat * 3) * (1 - Math.abs(c.lum - 0.45));
    return score(b) - score(a);
  });

  const primary = preferred[0].hex;
  const secondary =
    preferred.find(
      (c) =>
        c.hex !== primary &&
        (c.lum < 0.25 || Math.abs(c.lum - preferred[0].lum) > 0.1),
    )?.hex ||
    preferred[1]?.hex ||
    primary;
  const accent =
    preferred.find(
      (c) =>
        c.hex !== primary &&
        c.hex !== secondary &&
        hueFamily(c.hex) === hueFamily(primary),
    )?.hex || primary;

  const bg = ranked.find((c) => c.lum > 0.9)?.hex || "#FFFFFF";
  const text =
    ranked.find((c) => c.lum < 0.2 && !isJunkBrandHex(c.hex))?.hex || "#0F172A";
  return harmonizeBrandPalette(
    {
      primary,
      secondary,
      accent,
      background: bg,
      text,
      muted:
        ranked.find(
          (c) =>
            c.sat < 0.2 &&
            c.lum > 0.35 &&
            c.lum < 0.7 &&
            !isJunkBrandHex(c.hex),
        )?.hex || "#64748B",
      source: `html-evidence:${sourceUrl}`,
    },
    ranked.map((c) => c.hex),
  );
}

export async function fetchBrandfetchColors(
  businessUrl: string,
): Promise<BrandColors | null> {
  const key = process.env.BRANDFETCH_API_KEY?.trim();
  if (!key) return null;
  const domain = domainOf(businessUrl);
  try {
    const res = await fetch(
      `https://api.brandfetch.io/v2/brands/domain/${encodeURIComponent(domain)}`,
      {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      colors?: Array<{ hex?: string; type?: string }>;
    };
    const hexes = (data.colors || [])
      .map((c) => normalizeHex(c.hex || ""))
      .filter((h): h is string => Boolean(h) && !isJunkBrandHex(h));
    if (!hexes.length) return null;
    const byType = (t: string) =>
      (data.colors || []).find((c) => (c.type || "").toLowerCase() === t);

    const primary =
      pickStrongestBrandHex([
        byType("brand")?.hex,
        byType("accent")?.hex,
        byType("dark")?.hex,
        ...hexes,
      ]) || null;
    if (!primary || isJunkBrandHex(primary)) return null;

    const secondary =
      normalizeHex(byType("dark")?.hex || "") ||
      hexes.find((h) => h !== primary && luminance(h) < 0.25) ||
      primary;
    const accent =
      pickStrongestBrandHex([
        byType("accent")?.hex,
        byType("light")?.hex,
        primary,
      ]) || primary;

    return harmonizeBrandPalette(
      {
        primary,
        secondary:
          secondary && !isJunkBrandHex(secondary) ? secondary : primary,
        accent: accent && !isJunkBrandHex(accent) ? accent : primary,
        background: "#FFFFFF",
        text:
          luminance(secondary || primary) < 0.35
            ? secondary || primary
            : "#0F172A",
        muted: "#64748B",
        source: `brandfetch:${domain}`,
      },
      hexes,
    );
  } catch {
    return null;
  }
}

export type FirecrawlBrandExtract = {
  colors: BrandColors | null;
  design: BrandDesignSystem | null;
  assets: BrandSiteAssets | null;
  html: string | null;
  markdown: string | null;
  links: string[];
  logoUrl: string | null;
  warnings: string[];
};

/**
 * Firecrawl branding + links — primary brand identity source.
 * @see https://docs.firecrawl.dev/features/scrape#extract-brand-identity
 */
export async function extractColorsViaFirecrawl(
  businessUrl: string,
): Promise<FirecrawlBrandExtract> {
  const warnings: string[] = [];
  if (!hasFirecrawlKey()) {
    return {
      colors: null,
      design: null,
      assets: null,
      html: null,
      markdown: null,
      links: [],
      logoUrl: null,
      warnings: ["FIRECRAWL_API_KEY not set — skipped Firecrawl branding"],
    };
  }
  try {
    const scraped = await firecrawlScrapeBranding(businessUrl);
    const html = scraped.data?.html || null;
    const markdown = scraped.data?.markdown || null;
    const links = scraped.data?.links || [];
    const branding = scraped.data?.branding || null;
    const title = scraped.data?.metadata?.title || null;
    const finalUrl =
      scraped.data?.metadata?.url ||
      scraped.data?.metadata?.sourceURL ||
      businessUrl;

    let colors = colorsFromFirecrawlBranding(branding, businessUrl);
    if (!colors && html && !isChallengeOrEmptyHtml(html)) {
      colors = await extractBrandColorsFromHtml(html, businessUrl);
      colors = {
        ...colors,
        source: `firecrawl-html:${businessUrl}`,
      };
    }

    const design = designFromFirecrawlBranding(branding, businessUrl);
    const assets = assetsFromFirecrawl({
      businessUrl: finalUrl,
      branding,
      html,
      links,
      title,
    });
    const logoUrl = assets.logoUrl;

    if (!colors) {
      warnings.push("Firecrawl branding returned no usable colors");
    } else {
      warnings.push(
        `Firecrawl branding colors: primary=${colors.primary} accent=${colors.accent}`,
      );
    }
    if (design?.fonts?.length) {
      warnings.push(`Firecrawl fonts: ${design.fonts.join(", ")}`);
    }
    if (assets.socialLinks.length) {
      warnings.push(
        `Firecrawl social links: ${assets.socialLinks.map((s) => s.label).join(", ")}`,
      );
    }

    return {
      colors,
      design,
      assets,
      html,
      markdown,
      links,
      logoUrl,
      warnings,
    };
  } catch (err) {
    return {
      colors: null,
      design: null,
      assets: null,
      html: null,
      markdown: null,
      links: [],
      logoUrl: null,
      warnings: [
        `Firecrawl branding failed: ${(err as Error).message || String(err)}`,
      ],
    };
  }
}
