import type { BrandColors, BrandDesignSystem, BusinessProfile } from "../../types";
import type { BrandSiteAssets } from "../brandAssets";
import type { ClientEvidenceRecord } from "../content/model";
import type { PageInventory } from "../content/inventory";
import type { PageLayoutEvidence } from "../design/layoutEvidence";

export type UnifiedBrief = {
  text: string;
  imageTiles: Array<{
    id: string;
    mediaType: "image/jpeg" | "image/png" | "image/webp";
    data: string;
  }>;
  sectionCount: number;
  assetCount: number;
  compact: boolean;
};

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function compositionHint(section: {
  heading?: string | null;
  purpose?: string | null;
  order: number;
}): string {
  const hay = `${section.heading || ""} ${section.purpose || ""}`.toLowerCase();
  if (section.order === 0 || /hero|intro|hook|headline/i.test(hay)) {
    return "Match the competitor screenshot hero exactly (split vs stacked, badge placement, CTA row, media side) — never a generic SaaS template.";
  }
  if (/problem|pain|challenge|agitat/i.test(hay)) {
    return "Match competitor problem-band density and emphasis from the screenshot — not a stock three-column layout.";
  }
  if (/feature|benefit|service|solution|capabilit/i.test(hay)) {
    return "Mirror competitor feature/service composition from the screenshot (grid count, media mix, spacing).";
  }
  if (/how|process|step|work/i.test(hay)) {
    return "Mirror competitor process/steps layout from the screenshot.";
  }
  if (/proof|testimonial|trust|client|logo|partner/i.test(hay)) {
    return "Mirror competitor proof strip / quotes from the screenshot — only authorised client logos.";
  }
  if (/faq|question/i.test(hay)) return "Mirror competitor FAQ presentation from the screenshot.";
  if (/pricing|offer|plan/i.test(hay)) return "Mirror competitor offer/pricing panel from the screenshot.";
  if (/cta|contact|book|final/i.test(hay)) {
    return "Mirror competitor final CTA band from the screenshot (same CTA concept as campaignOffer).";
  }
  if (/footer/i.test(hay)) return "Mirror competitor footer density from the screenshot.";
  return "Match this section's visual rhythm from the competitor screenshots — do not invent a standard template.";
}

/** Derive readable text shade from a brand hex (simple darken/lighten). */
function readableOn(bgHex: string, brandHex: string): { onLight: string; onBrand: string } {
  const parse = (hex: string) => {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const n = Number.parseInt(full.slice(0, 6), 16);
    if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };
  const lum = (hex: string) => {
    const { r, g, b } = parse(hex);
    const to = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * to(r) + 0.7152 * to(g) + 0.0722 * to(b);
  };
  const brand = parse(brandHex);
  const darken = `#${[brand.r, brand.g, brand.b]
    .map((c) => Math.max(0, Math.round(c * 0.45)).toString(16).padStart(2, "0"))
    .join("")}`;
  const onBrand = lum(brandHex) > 0.55 ? "#0B1220" : "#FFFFFF";
  const onLight = lum(brandHex) < 0.35 ? brandHex : darken;
  void bgHex;
  return { onLight, onBrand };
}

export type CompetitorCampaignOffer = {
  headline?: string | null;
  primaryOffer?: string | null;
  cta?: string | null;
  pricing?: string | null;
  uniqueValueProps?: string[];
  guarantees?: string[];
  urgency?: string | null;
};

export function buildUnifiedBrief(input: {
  competitorUrl: string;
  competitorName: string;
  clientUrl: string;
  clientName: string;
  keyword: string;
  inventory: PageInventory;
  layout: PageLayoutEvidence | null;
  evidence: ClientEvidenceRecord;
  colors: BrandColors;
  assets: BrandSiteAssets | null;
  design: BrandDesignSystem | null;
  profile: BusinessProfile | null;
  userFeedback?: string | null;
  imageBudget: number;
  tileBase64: Array<{
    id: string;
    data: string;
    mediaType?: "image/jpeg" | "image/png" | "image/webp";
  }>;
  compact?: boolean;
  /** Already-embedded identity logo data URI when available. */
  identityLogoDataUri?: string | null;
  /** Authorised proof/partner logos as data URIs or https URLs. */
  proofLogos?: Array<{ src: string; alt: string }>;
  /** Competitor page-analysis offer — mandatory campaign focus for CTA/headline. */
  campaignOffer?: CompetitorCampaignOffer | null;
  /** True when competitor screenshot tiles are attached for vision. */
  hasCompetitorScreenshots?: boolean;
}): UnifiedBrief {
  const compact = Boolean(input.compact);
  const maxSections = compact ? 8 : 14;
  const maxComponents = compact ? 5 : 10;
  const maxFacts = compact ? 20 : 40;
  const textClip = compact ? 160 : 260;

  const sections = input.inventory.sections.slice(0, maxSections).map((section) => ({
    id: section.id,
    order: section.order,
    heading: clip(section.sourceHeading || section.internalLabel, 90),
    purpose: clip(section.purpose, 140),
    compositionHint: compositionHint({
      heading: section.sourceHeading,
      purpose: section.purpose,
      order: section.order,
    }),
    components: section.components.slice(0, maxComponents).map((component) => ({
      id: component.id,
      kind: component.kind,
      text: clip(component.text, textClip),
      items: component.items.slice(0, 5).map((item) => clip(item, 100)),
    })),
  }));

  const layoutSections = (input.layout?.sections || []).slice(0, maxSections).map((section) => ({
    id: section.id,
    composition: section.composition,
    columns: section.columns.slice(0, 4).map((column) => ({
      fraction: column.fraction,
      role: column.role,
    })),
    media: section.media,
    backgroundRole: section.backgroundRole,
    fullWidth: section.fullWidth,
  }));

  const facts = input.evidence.facts.slice(0, maxFacts).map((fact) => ({
    id: fact.id,
    category: fact.category,
    value: clip(fact.value, textClip),
    status: fact.status,
  }));

  const textSafe = readableOn(input.colors.background || "#FFFFFF", input.colors.primary);
  const assets = {
    identityLogo: {
      src: input.identityLogoDataUri || input.assets?.logoUrl || null,
      alt: `${input.clientName} logo`,
      role: "company",
      note: "Use ONLY this as header/footer identity. object-fit:contain; never stretch.",
    },
    proofLogos: (input.proofLogos || []).slice(0, 8),
    navLinks: (input.assets?.navLinks || []).slice(0, 8),
    footerLinks: (input.assets?.footerLinks || []).slice(0, 10),
    ctaLinks: (input.assets?.ctaLinks || []).slice(0, 5),
    socialLinks: (input.assets?.socialLinks || []).slice(0, 5),
    emails: (input.assets?.emails || []).slice(0, 2),
    phones: (input.assets?.phones || []).slice(0, 2),
  };

  const tiles = compact ? [] : input.tileBase64.slice(0, 3);
  const imageBudget = Math.min(input.imageBudget, compact ? 2 : 4);
  const hasShots = Boolean(input.hasCompetitorScreenshots && tiles.length);

  const campaign = input.campaignOffer || null;
  const campaignOffer = campaign
    ? {
        headline: campaign.headline ? clip(campaign.headline, 160) : null,
        primaryOffer: campaign.primaryOffer ? clip(campaign.primaryOffer, 220) : null,
        ctaConcept: campaign.cta ? clip(campaign.cta, 80) : null,
        pricing: campaign.pricing ? clip(campaign.pricing, 120) : null,
        uniqueValueProps: (campaign.uniqueValueProps || []).slice(0, 6).map((v) => clip(v, 140)),
        guarantees: (campaign.guarantees || []).slice(0, 4).map((v) => clip(v, 120)),
        urgency: campaign.urgency ? clip(campaign.urgency, 100) : null,
        instruction:
          "MANDATORY campaign focus from competitor page analysis. Rewrite for the client brand in original words, but KEEP the same offer type and CTA concept (e.g. strategy call + Google Ads management). Do NOT invent a different lead magnet from clientFacts (no free growth audits, SEO audits, or unrelated homepage offers).",
      }
    : {
        headline: null,
        primaryOffer: null,
        ctaConcept: null,
        pricing: null,
        uniqueValueProps: [] as string[],
        guarantees: [] as string[],
        urgency: null,
        instruction:
          "No structured campaignOffer was saved — infer offer/CTA only from competitorSections CTA/headline components, never from clientFacts homepage offers.",
      };

  const payload = {
    task: "Rebuild an original client landing page that CLONES the competitor VISUAL STRUCTURE (from screenshots) + CAMPAIGN OFFER and DISCARDS their identity/copy.",
    visualReference: hasShots
      ? {
          attached: true,
          note: "Attached images are Firecrawl screenshots of the competitor page. Clone layout rhythm, section composition, hero structure, and CTA placement from them. Do NOT invent a generic agency/SaaS template.",
        }
      : {
          attached: false,
          note: "No screenshots attached — still clone competitorSections and campaignOffer; avoid generic templates.",
        },
    brandBrief: {
      name: input.clientName,
      whatTheyDo: clip(input.profile?.description || input.profile?.positioningSummary || "", 220),
      url: input.clientUrl,
      palette: {
        primary: input.colors.primary,
        secondary: input.colors.secondary,
        accent: input.colors.accent,
        background: input.colors.background,
        text: input.colors.text,
        textOnBrand: textSafe.onBrand,
        textSafePrimary: textSafe.onLight,
      },
      fonts: (input.design?.fonts || []).slice(0, 4),
      typography: input.design?.typography || null,
      components: input.design?.components || null,
    },
    designSystemRules: [
      "Declare ALL colours, radii, shadows, fonts as CSS variables on :root. No raw hex in later rules.",
      "Apply CLIENT brand colours/fonts to a COMPETITOR-shaped layout — never a stock landing-page template.",
      "When screenshots are attached, section layouts must visually rhyme with those shots (columns, media side, density, CTA placement).",
      "Build a surface ladder: --bg-page, --bg-section, --bg-card with borders so sections alternate like the competitor.",
      "Use text-safe shades for small text/links; pure brand hex for fills, large type, borders.",
      "Text on brand fills: use brandBrief.palette.textOnBrand (often black on lime/amber).",
      "Never use one universal text/image split for every section — vary per screenshot / compositionHint.",
      "Header brand must be hero-level: logo + name visible; do not hide identity in tiny nav text only.",
      "Logo: <img data-logo-role=\"company\" src=\"{identityLogo.src}\"> with max-height ~40px; object-fit:contain; height:auto. Prefer the provided data URI.",
      "Proof logos only from assetRegistry.proofLogos with data-logo-role=\"proof\". Never use proof as identity.",
      "Never redraw logos as SVG/text approximations.",
      "Illustrative images: data-adrival-slot + transparent 1x1 data URI; prompts must say no logos/no readable text.",
      "Only approved claims from clientFacts. Mark missing stats as [[PLACEHOLDER]] in unresolvedRequirements.",
      "Mobile: 16px gutters, no horizontal overflow at 390px; prefer translateY motion over translateX.",
      "Complete self-contained HTML with inline <style> and minimal <script>. No trackers.",
    ],
    rules: [
      "Clone section order, narrative arc, image-led vs copy-led balance, and conversion points FROM THE SCREENSHOTS + competitorSections.",
      "Discard competitor colours, type, verbatim copy, claims, testimonials, client names, and imagery.",
      "Hero badge, headline angle, service focus, and primary CTA MUST follow campaignOffer (same offer type + CTA concept visible in the fold screenshot). clientFacts must NOT replace campaignOffer.",
      "Write original client-specific copy in a concrete, professional voice. No emoji/exclamation spam.",
      "Do not invent statistics, awards, named clients, or people.",
      `At most ${imageBudget} illustrative imageSlots.`,
      "Return JSON only with a complete </html>.",
    ],
    competitor: {
      url: input.competitorUrl,
      name: input.competitorName,
      campaignKeyword: input.keyword,
      note: "Screenshots + campaignOffer are authoritative for structure/CTA — never copy identity or sentences.",
    },
    campaignOffer,
    competitorSections: sections,
    measuredLayout: layoutSections.length
      ? { sections: layoutSections, incomplete: Boolean(input.layout?.incomplete) }
      : {
          sections: [],
          incomplete: true,
          note: hasShots
            ? "Prefer screenshot composition over inventing measured columns."
            : "Use compositionHint on each section; avoid generic templates.",
        },
    clientFacts: facts,
    assetRegistry: assets,
    destinationRegistry: {
      homepage: input.clientUrl,
      nav: assets.navLinks,
      footer: assets.footerLinks,
      cta: assets.ctaLinks,
      social: assets.socialLinks,
      emails: assets.emails.map((email) => `mailto:${email}`),
      phones: assets.phones.map((phone) => `tel:${phone.replace(/\s+/g, "")}`),
    },
    imageBudget,
    userFeedback: input.userFeedback ? clip(input.userFeedback, 800) : null,
    outputContract: {
      html: "Complete HTML document with :root tokens, doctype, inline style, optional script",
      imageSlots: "[{id,sectionId,purpose,prompt,aspectRatio,alt,kind:illustrative,priority}]",
      sections: "[{id,heading,purpose}]",
      warnings: "string[]",
      unresolvedRequirements: "string[]",
      title: "string",
      description: "string",
    },
  };

  return {
    text: JSON.stringify(payload),
    imageTiles: tiles.map((tile) => ({
      id: tile.id,
      mediaType: (tile.mediaType || "image/jpeg") as "image/jpeg" | "image/png" | "image/webp",
      data: tile.data,
    })),
    sectionCount: sections.length,
    assetCount:
      (assets.identityLogo.src ? 1 : 0) +
      assets.proofLogos.length +
      assets.navLinks.length +
      assets.footerLinks.length,
    compact,
  };
}
