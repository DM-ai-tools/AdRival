import type { BrandDesignSpec, BrandColors } from "../../types";
import type { BrandTokens } from "../archive/brandTokens";

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) {
    const s = (v || "").trim();
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Build a BrandDesignSpec from extracted BrandTokens (user brand site only).
 * Competitor layout is never a source for colors/fonts/logos here.
 */
export function buildBrandDesignSpec(input: {
  tokens: BrandTokens;
  brandName: string;
  businessUrl: string;
  competitorName?: string | null;
}): BrandDesignSpec {
  const { tokens, brandName, businessUrl } = input;
  const competitorName = input.competitorName?.trim() || null;
  const design = tokens.design;
  const colors: BrandColors & { icon?: string } = {
    ...tokens.colors,
    icon: tokens.colors.accent || tokens.colors.primary,
  };

  const headingFont =
    design?.typography?.fontFamilies?.heading ||
    tokens.fonts[0] ||
    null;
  const bodyFont =
    design?.typography?.fontFamilies?.primary ||
    tokens.fonts[1] ||
    tokens.fonts[0] ||
    null;

  const primaryRadius =
    design?.components?.buttonPrimary?.borderRadius ||
    design?.spacing?.borderRadius ||
    tokens.borderRadii[0] ||
    null;
  const secondaryRadius =
    design?.components?.buttonSecondary?.borderRadius ||
    primaryRadius;

  const sampleSubjects = uniqueStrings(
    (tokens.siteAssets?.images || [])
      .filter((i) => i.kind === "hero" || i.kind === "content")
      .map((i) => i.alt || null)
      .slice(0, 8),
  );

  const rules = [
    "All visual identity (colors, fonts, logos, buttons, radii, shadows, icon colors) MUST come from this design spec — never from the competitor page.",
    "The competitor archive supplies layout only: section order, grids, cards, image placement, spacing rhythm, interactions, and popups.",
    "Replace competitor logos/wordmarks with the brand logos listed below.",
    "Do not invent new brand colors or fonts that are not listed here.",
    ...(competitorName
      ? [
          `Do not use colors, fonts, logos, or naming from competitor “${competitorName}”.`,
        ]
      : []),
  ];

  return {
    brandName,
    businessUrl,
    extractedAt: new Date().toISOString(),
    competitorName,
    colors,
    logos: {
      primary: tokens.logoUrl || tokens.siteAssets?.logoUrl || null,
      dark: tokens.logoDarkUrl || null,
      favicon: tokens.siteAssets?.faviconUrl || null,
    },
    fonts: uniqueStrings([
      headingFont,
      bodyFont,
      ...(tokens.fonts || []),
      ...(design?.fonts || []),
    ]),
    typography: {
      headingFont,
      bodyFont,
      fontSizes: design?.typography?.fontSizes || null,
      fontWeights: design?.typography?.fontWeights || null,
    },
    buttons: {
      primary: {
        background:
          design?.components?.buttonPrimary?.background ||
          colors.accent ||
          colors.primary,
        textColor:
          design?.components?.buttonPrimary?.textColor || "#FFFFFF",
        borderRadius: primaryRadius,
        borderColor:
          design?.components?.buttonPrimary?.borderColor ||
          design?.components?.buttonPrimary?.background ||
          colors.accent ||
          colors.primary,
      },
      secondary: {
        background:
          design?.components?.buttonSecondary?.background || null,
        textColor:
          design?.components?.buttonSecondary?.textColor ||
          colors.accent ||
          colors.primary,
        borderRadius: secondaryRadius,
        borderColor:
          design?.components?.buttonSecondary?.borderColor ||
          colors.accent ||
          colors.primary,
      },
    },
    borderRadii: uniqueStrings([
      primaryRadius,
      design?.spacing?.borderRadius,
      ...tokens.borderRadii,
    ]),
    boxShadows: uniqueStrings(tokens.boxShadows || []),
    spacing: {
      baseUnit: design?.spacing?.baseUnit ?? null,
      borderRadius: design?.spacing?.borderRadius || primaryRadius,
    },
    sectionBackgrounds: {
      page: colors.background,
      surface: colors.background,
      muted: colors.muted || null,
    },
    imagery: {
      styleNotes: [
        "Prefer photorealistic marketing photography that fits the brand industry and palette.",
        "Never treat site logos as AI photo slots — logos come from logos.primary / logos.dark.",
        "Icon and UI chrome colors should use colors.icon (or accent/primary).",
        design?.personality?.tone
          ? `Brand tone: ${design.personality.tone}.`
          : null,
        design?.personality?.energy
          ? `Brand energy: ${design.personality.energy}.`
          : null,
      ].filter((s): s is string => Boolean(s)),
      sampleSubjects,
    },
    links: {
      nav: tokens.siteAssets?.navLinks || [],
      footer: tokens.siteAssets?.footerLinks || [],
      social: tokens.socialLinks?.length
        ? tokens.socialLinks
        : tokens.siteAssets?.socialLinks || [],
      cta: tokens.siteAssets?.ctaLinks || [],
    },
    rules,
    design,
    source: tokens.source,
    warnings: tokens.warnings || [],
  };
}

/**
 * Project BrandDesignSpec back into BrandTokens for deterministic HTML apply.
 * Ensures applyBrandDeterministic consumes the same SSOT as design.md.
 */
export function brandTokensFromDesignSpec(
  spec: BrandDesignSpec,
  previous?: BrandTokens | null,
): BrandTokens {
  const design: BrandTokens["design"] = {
    ...(spec.design || { fonts: spec.fonts }),
    fonts: spec.fonts.length ? spec.fonts : spec.design?.fonts || [],
    typography: {
      ...(spec.design?.typography || {}),
      fontFamilies: {
        ...(spec.design?.typography?.fontFamilies || {}),
        heading: spec.typography.headingFont || undefined,
        primary: spec.typography.bodyFont || undefined,
      },
      fontSizes:
        spec.typography.fontSizes ||
        spec.design?.typography?.fontSizes ||
        undefined,
      fontWeights:
        spec.typography.fontWeights ||
        spec.design?.typography?.fontWeights ||
        undefined,
    },
    spacing: {
      ...(spec.design?.spacing || {}),
      baseUnit: spec.spacing.baseUnit ?? spec.design?.spacing?.baseUnit,
      borderRadius:
        spec.spacing.borderRadius ||
        spec.design?.spacing?.borderRadius ||
        undefined,
    },
    components: {
      ...(spec.design?.components || {}),
      buttonPrimary: {
        background: spec.buttons.primary.background,
        textColor: spec.buttons.primary.textColor,
        borderRadius: spec.buttons.primary.borderRadius || undefined,
        borderColor: spec.buttons.primary.borderColor || undefined,
      },
      buttonSecondary: {
        background: spec.buttons.secondary.background || undefined,
        textColor: spec.buttons.secondary.textColor,
        borderRadius: spec.buttons.secondary.borderRadius || undefined,
        borderColor: spec.buttons.secondary.borderColor || undefined,
      },
    },
    source: `design-md:${spec.source}`,
  };

  return {
    colors: {
      primary: spec.colors.primary,
      secondary: spec.colors.secondary,
      accent: spec.colors.accent,
      background: spec.colors.background,
      text: spec.colors.text,
      muted: spec.colors.muted,
      source: `design-md:${spec.colors.source || spec.source}`,
    },
    logoUrl: spec.logos.primary,
    logoDarkUrl: spec.logos.dark,
    fonts: spec.fonts,
    borderRadii: spec.borderRadii,
    boxShadows: spec.boxShadows,
    socialLinks: spec.links.social,
    siteAssets: previous?.siteAssets
      ? {
          ...previous.siteAssets,
          logoUrl: spec.logos.primary || previous.siteAssets.logoUrl,
          faviconUrl: spec.logos.favicon || previous.siteAssets.faviconUrl,
          socialLinks: spec.links.social.length
            ? spec.links.social
            : previous.siteAssets.socialLinks,
          navLinks: spec.links.nav.length
            ? spec.links.nav
            : previous.siteAssets.navLinks,
          footerLinks: spec.links.footer.length
            ? spec.links.footer
            : previous.siteAssets.footerLinks,
        }
      : null,
    design,
    source: `design-md:${spec.source}`,
    warnings: spec.warnings,
  };
}
