import type { BrandColors, BrandDesignSystem, BusinessProfile } from "../../types";
import type { BrandSiteAssets } from "../brandAssets";
import type { ClientEvidenceRecord } from "../content/model";
import type { PageInventory } from "../content/inventory";
import type { PageLayoutEvidence } from "../design/layoutEvidence";
import { buildRecreateChromeLinks, type CompetitorChrome } from "./recreateChrome";

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

/** Structured brief payload (JSON inside UnifiedBrief.text). */
export type UnifiedBriefPayload = Record<string, unknown>;

export function parseUnifiedBriefPayload(brief: UnifiedBrief): UnifiedBriefPayload {
  try {
    return JSON.parse(brief.text) as UnifiedBriefPayload;
  } catch {
    return { rawText: brief.text };
  }
}

function asSections(payload: UnifiedBriefPayload): Array<Record<string, unknown>> {
  return Array.isArray(payload.competitorSections)
    ? (payload.competitorSections as Array<Record<string, unknown>>)
    : [];
}

function isHeroSection(section: Record<string, unknown>, index: number): boolean {
  const hay = `${section.heading || ""} ${section.purpose || ""} ${section.id || ""}`.toLowerCase();
  return index === 0 || /hero|intro|hook|headline|nav|header/i.test(hay);
}

export function splitBriefSections(payload: UnifiedBriefPayload): {
  heroSections: Array<Record<string, unknown>>;
  bodySections: Array<Record<string, unknown>>;
} {
  const all = asSections(payload);
  if (!all.length) return { heroSections: [], bodySections: [] };
  const heroSections: Array<Record<string, unknown>> = [];
  const bodySections: Array<Record<string, unknown>> = [];
  all.forEach((section, index) => {
    if (isHeroSection(section, index) && heroSections.length < 2) {
      heroSections.push(section);
    } else {
      bodySections.push(section);
    }
  });
  // Always keep at least the first inventory section for the hero pass.
  if (!heroSections.length && all[0]) {
    heroSections.push(all[0]);
    bodySections.splice(0, bodySections[0] === all[0] ? 1 : 0);
  }
  return { heroSections, bodySections };
}

function briefFromPayload(
  base: UnifiedBrief,
  payload: UnifiedBriefPayload,
  imageTiles: UnifiedBrief["imageTiles"] = [],
): UnifiedBrief {
  return {
    ...base,
    text: JSON.stringify(payload),
    imageTiles,
    sectionCount: Array.isArray(payload.competitorSections)
      ? payload.competitorSections.length
      : base.sectionCount,
  };
}

const IDENTITY_LOGO_PLACEHOLDER = "{{ADRIVAL_IDENTITY_LOGO}}";
const PROOF_LOGO_PLACEHOLDER = "{{ADRIVAL_PROOF_LOGO}}";

/** Never send multi-KB data URIs to Claude — they inflate input tokens into the hundreds of thousands. */
export function leanAssetSrc(src: string | null | undefined, kind: "identity" | "proof" = "identity"): string | null {
  const value = (src || "").trim();
  if (!value) return null;
  if (value.startsWith("data:")) {
    return kind === "identity" ? IDENTITY_LOGO_PLACEHOLDER : PROOF_LOGO_PLACEHOLDER;
  }
  // Keep full https(s) logo URLs from Firecrawl/HTML — truncation breaks embeds.
  if (/^https?:\/\//i.test(value)) return value;
  if (value.length > 480) return value.slice(0, 480);
  return value;
}

export function leanAssetRegistry(registry: unknown): Record<string, unknown> {
  const raw = (registry && typeof registry === "object" ? registry : {}) as Record<string, unknown>;
  const identity = (raw.identityLogo && typeof raw.identityLogo === "object"
    ? raw.identityLogo
    : {}) as Record<string, unknown>;
  const proof = Array.isArray(raw.proofLogos) ? raw.proofLogos : [];
  return {
    identityLogo: {
      src: leanAssetSrc(typeof identity.src === "string" ? identity.src : null, "identity"),
      alt: typeof identity.alt === "string" ? identity.alt : "Company logo",
      role: "company",
      note: "Use data-logo-role=\"company\". Real logo bytes are injected after generation — put placeholder src if needed.",
    },
    proofLogos: proof.slice(0, 8).map((item, index) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return {
        src: leanAssetSrc(typeof row.src === "string" ? row.src : null, "proof") || `${PROOF_LOGO_PLACEHOLDER}-${index + 1}`,
        alt: typeof row.alt === "string" ? row.alt : "Partner logo",
      };
    }),
    navLinks: Array.isArray(raw.navLinks) ? raw.navLinks.slice(0, 6) : [],
    footerLinks: Array.isArray(raw.footerLinks) ? raw.footerLinks.slice(0, 6) : [],
    ctaLinks: Array.isArray(raw.ctaLinks) ? raw.ctaLinks.slice(0, 4) : [],
    socialLinks: Array.isArray(raw.socialLinks) ? raw.socialLinks.slice(0, 4) : [],
    emails: Array.isArray(raw.emails) ? raw.emails.slice(0, 2) : [],
    phones: Array.isArray(raw.phones) ? raw.phones.slice(0, 2) : [],
  };
}

/** Free Pass A — no Claude call. Locked brand tokens + empty chrome. */
export function buildDeterministicSpine(base: UnifiedBrief): { css: string; shellHtml: string } {
  const payload = parseUnifiedBriefPayload(base);
  const brand = (payload.brandBrief && typeof payload.brandBrief === "object"
    ? payload.brandBrief
    : {}) as Record<string, unknown>;
  const palette = (brand.palette && typeof brand.palette === "object"
    ? brand.palette
    : {}) as Record<string, unknown>;
  const fonts = Array.isArray(brand.fonts) ? brand.fonts.map(String).filter(Boolean) : [];
  const primary = String(palette.primary || "#0F7A6C");
  const secondary = String(palette.secondary || "#134E4A");
  const accent = String(palette.accent || "#F59E0B");
  const background = String(palette.background || "#FFFFFF");
  const text = String(palette.text || "#0F172A");
  const textOnBrand = String(palette.textOnBrand || "#FFFFFF");
  const textSafe = String(palette.textSafePrimary || secondary);
  const fontStack = fonts.length
    ? fonts.map((f) => `"${f.replace(/"/g, "")}"`).join(", ") + ", system-ui, sans-serif"
    : "Georgia, \"Times New Roman\", serif";
  const name = String(brand.name || "Brand").replace(/[<>&]/g, "");

  const css = `:root{
  --primary:${primary};
  --secondary:${secondary};
  --accent:${accent};
  --bg-page:${background};
  --bg-section:color-mix(in srgb, ${background} 92%, ${secondary} 8%);
  --bg-card:${background};
  --text:${text};
  --text-muted:${textSafe};
  --text-on-brand:${textOnBrand};
  --border:color-mix(in srgb, ${text} 12%, transparent);
  --radius:12px;
  --shadow:0 10px 30px color-mix(in srgb, ${text} 10%, transparent);
  --font:${fontStack};
  --container:1120px;
  --gutter:16px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg-page);color:var(--text);font-family:var(--font);line-height:1.5}
img{max-width:100%;height:auto;display:block}
a{color:inherit}
.adr-page{min-height:100vh}
.adr-container{width:min(100% - (var(--gutter) * 2), var(--container));margin-inline:auto}
header,footer{background:var(--bg-page)}
main#adr-sections{display:block}
@media (max-width:720px){.adr-container{width:min(100% - 32px, var(--container))}}`;

  const shellHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>${css}</style>
</head>
<body class="adr-page">
<header></header>
<main id="adr-sections"></main>
<footer></footer>
</body>
</html>`;

  return { css, shellHtml };
}

/** Pass A — brand tokens + empty chrome only (no screenshot). Kept for tests / fallback. */
export function buildSpineBrief(base: UnifiedBrief): UnifiedBrief {
  const payload = parseUnifiedBriefPayload(base);
  return briefFromPayload(base, {
    task: "Pass A — Design spine only. Emit locked :root CSS tokens and an empty HTML shell.",
    brandBrief: payload.brandBrief,
    designSystemRules: payload.designSystemRules,
    assetRegistry: leanAssetRegistry(payload.assetRegistry),
    destinationRegistry: payload.destinationRegistry,
    rules: [
      "Return JSON only: { css, shellHtml }.",
      "css must declare ALL brand colours, radii, shadows, fonts on :root (surface ladder: --bg-page, --bg-section, --bg-card).",
      "shellHtml must be a complete HTML document with <!DOCTYPE>, <head>, <body>, placeholder <header></header>, <main id=\"adr-sections\"></main>, and <footer></footer>.",
      "Do NOT write marketing copy, hero content, or section bodies.",
      "No trackers. Prefer compact CSS.",
    ],
    outputContract: {
      css: "string — :root tokens + global layout primitives",
      shellHtml: "Complete HTML shell with empty <main id=\"adr-sections\"></main>",
    },
  }, []);
}

/** Pass B — screenshot hero + header/footer chrome. */
export function buildHeroBrief(base: UnifiedBrief, spineCss: string): UnifiedBrief {
  const payload = parseUnifiedBriefPayload(base);
  const { heroSections } = splitBriefSections(payload);
  const measured = payload.measuredLayout as { sections?: unknown[] } | undefined;
  return briefFromPayload(base, {
    task: "Pass B — Clone the above-the-fold screenshot into header + hero. Use locked spine CSS only.",
    visualReference: payload.visualReference,
    brandBrief: {
      ...(payload.brandBrief as object),
      // Drop heavy design component dumps — palette + fonts are enough.
      components: undefined,
      typography: undefined,
    },
    designSystemRules: [
      "LOCKED CSS is authoritative. Do NOT redefine :root colours/fonts with new hex values.",
      "You may add hero/header-scoped rules that only reference existing CSS variables.",
    ],
    lockedCss: spineCss.slice(0, 4_000),
    campaignOffer: payload.campaignOffer,
    competitor: payload.competitor,
    competitorSections: heroSections,
    measuredLayout: measured
      ? {
          ...measured,
          sections: Array.isArray(measured.sections) ? measured.sections.slice(0, 2) : [],
        }
      : payload.measuredLayout,
    clientFacts: Array.isArray(payload.clientFacts) ? payload.clientFacts.slice(0, 8) : [],
    assetRegistry: leanAssetRegistry(payload.assetRegistry),
    destinationRegistry: payload.destinationRegistry,
    imageBudget: Math.min(Number(payload.imageBudget) || 1, 1),
    userFeedback: payload.userFeedback || null,
    rules: [
      "Screenshot (when attached) is AUTHORITATIVE for nav/hero composition — never a generic SaaS template.",
      "Hero badge, headline angle, service focus, and primary CTA MUST follow campaignOffer.",
      "clientFacts must NOT replace campaignOffer.",
      "Discard competitor identity/copy/colours; restyle with client brand via locked CSS vars.",
      "headerHtml REQUIRED: flex row with (1) company logo via data-logo-role=company + {{ADRIVAL_IDENTITY_LOGO}}, (2) ONLY destinationRegistry.nav labels (short menu items — never headlines/slogans like 'Black Friday' or 'Amazing growth'), (3) one primary CTA from destinationRegistry.cta. If nav is empty, logo+CTA only. No invented ratings.",
      "footerHtml REQUIRED: multi-column footer matching competitor density with destinationRegistry.footer ONLY (valid short links), contact phones/emails, social when present.",
      "If competitorSections includes a form component OR campaign requires a lead form, include exactly one <form id=\"adr-lead-form\"> built from competitorForm fields (same count/types/layout) — never a hardcoded Name/Email/Phone-only template.",
      "Return headerHtml (<header>…</header>), heroHtml (<section data-section-id=…>…</section>), footerHtml (<footer>…</footer>) matching destinationRegistry.footerColumns when present.",
      "Illustrative images: data-adrival-slot + transparent 1x1 data URI; prompts say no logos/no readable text.",
      `Company logo: <img data-logo-role="company" src="${IDENTITY_LOGO_PLACEHOLDER}" style="max-height:56px;max-width:240px;width:auto;height:auto;object-fit:contain"> — keep that exact src placeholder; do not crop the mark.`,
      "Header has exactly one CTA button with finished styles. Hero has at most one primary CTA (or the single form).",
      "Keep CSS compact. Prefer short class names.",
    ],
    outputContract: {
      headerHtml: "<header>…</header> with logo + nav + CTA",
      heroHtml: "<section data-section-id>…</section>",
      footerHtml: "<footer>…</footer> required multi-column",
      imageSlots: "[{id,sectionId,purpose,prompt,aspectRatio,alt,kind:illustrative,priority}]",
      title: "string",
      description: "string",
      warnings: "string[]",
      unresolvedRequirements: "string[]",
    },
  }, base.imageTiles.slice(0, 2));
}

/** Pass C — body sections (no screenshot). Prefer one batch for all remaining sections. */
export function buildBodyBatchBrief(input: {
  base: UnifiedBrief;
  spineCss: string;
  batchSections: Array<Record<string, unknown>>;
  priorSectionSummaries: Array<{ id: string; heading?: string }>;
  heroHeading?: string | null;
  remainingImageBudget: number;
  batchIndex: number;
  batchCount: number;
}): UnifiedBrief {
  const payload = parseUnifiedBriefPayload(input.base);
  const measured = payload.measuredLayout as { sections?: Array<Record<string, unknown>> } | undefined;
  const batchIds = new Set(input.batchSections.map((s) => String(s.id || "")));
  const measuredSlice = Array.isArray(measured?.sections)
    ? measured!.sections.filter((s) => batchIds.has(String(s.id || "")))
    : [];
  return briefFromPayload(input.base, {
    task: `Pass C — Body sections batch ${input.batchIndex + 1}/${input.batchCount}. Emit HTML fragments only.`,
    brandBrief: {
      name: (payload.brandBrief as Record<string, unknown> | undefined)?.name,
      url: (payload.brandBrief as Record<string, unknown> | undefined)?.url,
      palette: (payload.brandBrief as Record<string, unknown> | undefined)?.palette,
    },
    lockedCss: input.spineCss.slice(0, 3_000),
    designSystemRules: [
      "LOCKED CSS is authoritative. Do NOT add new :root hex colours.",
      "Match compositionHint / measuredLayout for each section — competitor-shaped, not a stock template.",
      "Vary layout per section; keep CSS short.",
    ],
    campaignOffer: {
      note: "campaignOffer already locked in the hero. Do NOT invent a different primary offer. Final CTA bands may echo the same CTA concept.",
      ctaConcept: (payload.campaignOffer as Record<string, unknown> | undefined)?.ctaConcept || null,
    },
    continuity: {
      heroHeading: input.heroHeading || null,
      priorSections: input.priorSectionSummaries.slice(-6),
    },
    competitorSections: input.batchSections,
    measuredLayout: { sections: measuredSlice, incomplete: Boolean((measured as { incomplete?: boolean } | undefined)?.incomplete) },
    clientFacts: Array.isArray(payload.clientFacts) ? payload.clientFacts.slice(0, 10) : [],
    assetRegistry: leanAssetRegistry({
      ...(payload.assetRegistry as object),
      proofLogos: ((payload.assetRegistry as Record<string, unknown> | undefined)?.proofLogos as unknown[])?.slice?.(0, 8) || [],
    }),
    destinationRegistry: payload.destinationRegistry,
    imageBudget: Math.max(0, input.remainingImageBudget),
    userFeedback: payload.userFeedback || null,
    rules: [
      "Return JSON: { sections: [{ id, html, heading, purpose, imageSlots }] }.",
      "Each html must be a single <section data-section-id=\"{id}\">…</section> fragment — NOT a full HTML document.",
      "MUST return exactly one sections[] entry for EVERY id in competitorSections — never omit, merge, or skip any.",
      "Match competitor section density: full copy blocks, lists, and CTAs per compositionHint so page length rhymes with the competitor. Keep comparable word count to competitorSections text/items — do not thin multi-line cards into one short sentence.",
      "Clone competitor visual rhythm via compositionHint; discard competitor copy/identity. Do not invent unrelated service sections (e.g. SEO) that are absent from competitorSections.",
      "Do NOT emit a <form> unless this batch's competitorSections entry has kind=form — and never more than one form on the page. When emitting a form, use competitorForm fields (same count/types/layout), never a generic 3-field template.",
      "Do NOT add extra primary CTA buttons in body sections; prefer text links. CTA buttons must have finished padding/background styles.",
      "Only approved claims from clientFacts; mark missing stats in unresolvedRequirements.",
      `At most ${Math.max(0, input.remainingImageBudget)} illustrative imageSlots across this batch.`,
      "Proof/trust logos: use assetRegistry.proofLogos https or placeholder srcs with data-logo-role=\"proof\". Never invent logo marks.",
    ],
    outputContract: {
      sections: "[{id,html,heading,purpose,imageSlots}]",
      warnings: "string[]",
      unresolvedRequirements: "string[]",
    },
  }, []);
}

/** Pass E — seam polish only. */
export function buildPolishBrief(base: UnifiedBrief, assembledHtml: string): UnifiedBrief {
  const payload = parseUnifiedBriefPayload(base);
  // Prefer abridged polish payload: CSS + section outlines to keep tokens low.
  const styleMatch = assembledHtml.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i);
  const css = styleMatch ? styleMatch[1].slice(0, 8_000) : "";
  const sectionOutlines: string[] = [];
  const sectionRe = /<section\b[^>]*>[\s\S]*?<\/section>/gi;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = sectionRe.exec(assembledHtml)) && i < 14) {
    const chunk = match[0];
    const id = chunk.match(/data-section-id=["']([^"']+)["']/i)?.[1] || `section-${i + 1}`;
    sectionOutlines.push(`<!-- ${id} len=${chunk.length} -->\n${chunk.slice(0, 1200)}${chunk.length > 1200 ? "\n…" : ""}`);
    i += 1;
  }
  return briefFromPayload(base, {
    task: "Pass E — Continuity polish ONLY. Fix seams; do not rewrite offer or invent new layout.",
    brandBrief: payload.brandBrief,
    campaignOffer: payload.campaignOffer,
    lockedCss: css,
    sectionOutlines,
    fullHtmlAbridged: assembledHtml.slice(0, 40_000),
    rules: [
      "Return JSON with complete html document (same page, polished).",
      "ALLOWED: CSS seam fixes, gutters, surface ladder consistency, landmark fixes, logo/slot attribute consistency.",
      "FORBIDDEN: rewriting headlines/CTAs/offer, inventing new sections, changing campaignOffer, generic template restyle.",
      "Preserve all data-adrival-slot and data-logo-role attributes and section order.",
    ],
    outputContract: {
      html: "Complete polished HTML document",
      imageSlots: "preserve existing slots if listed; else []",
      warnings: "string[]",
      unresolvedRequirements: "string[]",
    },
  }, []);
}

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
  if (/form|sign[\s-]?up|register|lead|contact\s*us/i.test(hay)) {
    return "If this is the SINGLE form section: include one <form id=\"adr-lead-form\">. Do NOT add forms in other sections.";
  }
  if (/cta|contact|book|final/i.test(hay)) {
    return "Mirror competitor final CTA band — one finished primary button (padding, brand fill, readable label). Do not spray extra CTAs.";
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
  /** Real header/footer chrome harvested from the competitor HTML. */
  competitorChrome?: CompetitorChrome | null;
}): UnifiedBrief {
  const compact = Boolean(input.compact);
  // Cover the full competitor inventory so page length matches (batched in generatePage).
  const inventoryCount = input.inventory.sections.length;
  const maxSections = compact
    ? Math.min(inventoryCount || 12, 12)
    : Math.min(inventoryCount || 20, 20);
  const maxComponents = compact ? 6 : 14;
  const maxFacts = compact ? 16 : 40;
  // Keep enough competitor copy so rebuilds match section density (was truncating to ~240 chars).
  const textClip = compact ? 220 : 520;

  const sections = input.inventory.sections.slice(0, maxSections).map((section) => ({
    id: section.id,
    order: section.order,
    heading: clip(section.sourceHeading || section.internalLabel, 120),
    purpose: clip(section.purpose, 200),
    compositionHint: compositionHint({
      heading: section.sourceHeading,
      purpose: section.purpose,
      order: section.order,
    }),
    components: section.components.slice(0, maxComponents).map((component) => ({
      id: component.id,
      kind: component.kind,
      text: clip(component.text, component.kind === "form" ? 200 : textClip),
      items: component.items.slice(0, component.kind === "form" ? 16 : 10).map((item) => clip(item, 160)),
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
  const hasForm =
    Boolean(input.competitorChrome?.hasForm) ||
    sections.some((section) => section.components.some((component) => component.kind === "form"));
  const chrome = buildRecreateChromeLinks({
    clientUrl: input.clientUrl,
    sections: sections.map((section) => ({
      id: section.id,
      heading: section.heading,
      purpose: section.purpose,
    })),
    campaignOffer: input.campaignOffer || null,
    keyword: input.keyword,
    assets: input.assets,
    hasForm,
    competitorChrome: input.competitorChrome || null,
  });
  const assets = {
    identityLogo: {
      src: leanAssetSrc(input.identityLogoDataUri || input.assets?.logoUrl || null, "identity"),
      alt: `${input.clientName} logo`,
      role: "company",
      note: "Use data-logo-role=\"company\". Real logo bytes are injected after generation.",
    },
    proofLogos: (input.proofLogos || []).slice(0, 8).map((logo, index) => ({
      src: leanAssetSrc(logo.src, "proof") || `${PROOF_LOGO_PLACEHOLDER}-${index + 1}`,
      alt: logo.alt || "Partner logo",
    })),
    navLinks: chrome.navLinks,
    footerLinks: chrome.footerLinks,
    ctaLinks: chrome.ctaLinks,
    socialLinks: (input.assets?.socialLinks || []).slice(0, 5),
    emails: (input.assets?.emails || []).slice(0, 2),
    phones: (input.assets?.phones || []).slice(0, 2),
  };

  const tiles = compact ? [] : input.tileBase64.slice(0, 3);
  const imageBudget = Math.min(input.imageBudget, compact ? 2 : 4);
  const hasShots = Boolean(input.hasCompetitorScreenshots && tiles.length);
  const formSpec = input.competitorChrome?.formSpec || null;

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
          note: "Attached images are competitor page screenshots. Clone layout rhythm, section composition, hero structure, and CTA placement from them. Do NOT invent a generic agency/SaaS template.",
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
      "Logo: <img data-logo-role=\"company\" src=\"{{ADRIVAL_IDENTITY_LOGO}}\"> with max-height:56px; max-width:240px; width:auto; height:auto; object-fit:contain — never crop the wordmark.",
      "Proof logos only from assetRegistry.proofLogos (https URLs or placeholders) with data-logo-role=\"proof\". Never use proof as identity.",
      "Never redraw logos as SVG/text approximations — embed the provided logo links as <img src>.",
      "Include EVERY competitorSections id in the page; match competitor page length and section count.",
      "Header/footer nav MUST use destinationRegistry.nav/footer ONLY — short valid menu labels from the competitor chrome. NEVER put marketing headlines, slogans, proof lines, or section H2s into the header/footer.",
      "If destinationRegistry.nav is empty/short, the competitor header is logo+CTA only — do not invent extra nav items.",
      "FORMS: at most ONE <form id=\"adr-lead-form\"> on the entire page when a form component exists — never repeat forms in every section.",
      "CTAs: match competitor density — typically 1 header CTA + 1 hero CTA + optional 1 final CTA. Finish every CTA with full button styles (padding, brand background, contrast text). No bare unfinished links.",
      "Illustrative images: data-adrival-slot + transparent 1x1 data URI; prompts must say no logos/no readable text.",
      "Only approved claims from clientFacts. Mark missing stats as [[PLACEHOLDER]] in unresolvedRequirements.",
      "Mobile: 16px gutters, no horizontal overflow at 390px; prefer translateY motion over translateX.",
      "Complete self-contained HTML with inline <style> and minimal <script>. No trackers.",
      "Keep CSS compact — avoid huge utility dumps.",
    ],
    rules: [
      "Clone section order, narrative arc, image-led vs copy-led balance, and conversion points FROM THE SCREENSHOTS + competitorSections.",
      "CONTENT DENSITY: each section's copy length must rhyme with the competitor — full sentences matching competitorSections component text/items. Do NOT shrink cards to one thin line when the competitor shows multi-line pain points or feature blurbs.",
      "List/card sections: emit the SAME item count as competitorSections items (or keyElements). Keep comparable word count per card.",
      "Each section's layout must follow its compositionHint and measuredLayout — do not collapse distinct competitor sections into generic feature grids.",
      "Emit the full competitorSections list — do not drop mid/lower-page sections; page length must rhyme with the competitor.",
      "Discard competitor colours, type, verbatim copy, claims, testimonials, client names, and imagery.",
      "Hero badge, headline angle, service focus, and primary CTA MUST follow campaignOffer (same offer type + CTA concept visible in the fold screenshot). clientFacts must NOT replace campaignOffer.",
      "Nav labels must match destinationRegistry exactly (competitor menu shape). Do NOT invent SEO links or paste body headlines into the header.",
      "Footer must follow destinationRegistry.footerColumns when present (same column headings + link density as the competitor).",
      "Write original client-specific copy in a concrete, professional voice. No emoji/exclamation spam.",
      "Do not invent statistics, awards, named clients, or people.",
      "Use destinationRegistry.phones/emails for real tel:/mailto: CTAs when present — avoid fake placeholders when a real value exists.",
      "Embed company + proof logos from assetRegistry using their https/placeholder srcs — never invent logo artwork.",
      hasForm
        ? "ONE FORM ONLY: rebuild from competitorForm fields (same count/types/layout). Never substitute a hardcoded Name/Email/Phone form when competitorForm lists more fields."
        : "Do NOT add any <form> — the competitor page has no lead form.",
      "CTA LIMIT: at most 3 prominent CTA buttons on the whole page (header + hero + final). Feature/list sections may use text links, not extra primary buttons.",
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
    competitorForm: formSpec
      ? {
          fieldCount: formSpec.fields.length,
          layout: formSpec.layout,
          submitLabel: formSpec.submitLabel,
          heading: formSpec.heading,
          intro: formSpec.intro,
          fields: formSpec.fields.map((f) => ({
            label: f.label,
            name: f.name,
            type: f.type,
            required: f.required,
            placeholder: f.placeholder || null,
            options: f.options || null,
          })),
          instruction:
            "Rebuild ONE form that mirrors this competitorForm exactly: same field count/order/types/labels (client-branded wording ok), same layout (single vs two-column), same submit concept. Do NOT use a generic 3-field Name/Email/Phone template when more fields are listed.",
        }
      : null,
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
      footerColumns: chrome.footerColumns,
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
