import OpenAI from "openai";
import { z } from "zod";
import type {
  BusinessProfile,
  LandingContentBlock,
  LandingContentDraft,
  LandingPageOfferAnalysis,
  StoredPageArchive,
} from "../types";
import type { BrandLink, BrandSiteAssets } from "./brandAssets";
import {
  extractCompetitorPageTextSlots,
  type PageTextSlot,
} from "./extractPageTextSlots";
import { clipToCompletePhrase, lengthBudgetForRole } from "./slotTextBudget";

const DEFAULT_CONTENT_MODEL = "gpt-4.1";

export function getOpenAiContentModel(): string {
  return (
    process.env.OPENAI_CONTENT_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    DEFAULT_CONTENT_MODEL
  );
}

function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey: key });
}

const draftSchema = z.object({
  pageType: z.string().nullable().optional(),
  tone: z.string().nullable().optional(),
  differentiationSummary: z.string().nullable().optional(),
  blocks: z
    .array(
      z
        .object({
          id: z.union([z.string(), z.number()]).optional(),
          sectionIndex: z.number().optional().nullable(),
          sectionName: z.string().optional().nullable(),
          role: z.string().optional().nullable(),
          label: z.string().optional().nullable(),
          text: z.union([z.string(), z.number()]).optional().nullable(),
          targetLen: z.number().nullable().optional(),
          minLen: z.number().nullable().optional(),
          maxLen: z.number().nullable().optional(),
          href: z.string().nullable().optional(),
        })
        .passthrough(),
    )
    .optional()
    .default([]),
});

function coerceBlockText(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

type ScaffoldSlot = {
  id: string;
  sectionIndex: number;
  sectionName: string;
  role: string;
  label: string;
  purpose: string;
  targetLen: number;
  minLen?: number;
  maxLen?: number;
  originalText?: string | null;
  htmlRole?: string | null;
  href?: string | null;
  /** When set, model should keep this label unless improving slightly */
  seedText?: string | null;
};

/**
 * Normalize messy model JSON into scaffold-aligned blocks.
 * Missing label/role/section fields are filled from the scaffold by id.
 */
function normalizeModelBlocks(
  rawBlocks: z.infer<typeof draftSchema>["blocks"],
  scaffold: ScaffoldSlot[],
): Array<{
  id: string;
  sectionIndex: number;
  sectionName: string;
  role: string;
  label: string;
  text: string;
  targetLen?: number | null;
  minLen?: number | null;
  maxLen?: number | null;
  href?: string | null;
}> {
  const scaffoldById = new Map(scaffold.map((s) => [s.id, s]));
  const out: Array<{
    id: string;
    sectionIndex: number;
    sectionName: string;
    role: string;
    label: string;
    text: string;
    targetLen?: number | null;
    minLen?: number | null;
    maxLen?: number | null;
    href?: string | null;
  }> = [];

  for (const row of rawBlocks || []) {
    const id = row.id != null ? String(row.id).trim() : "";
    if (!id) continue;
    const slot = scaffoldById.get(id);
    const role = (row.role || slot?.role || "body").trim() || "body";
    const sectionName =
      (row.sectionName || slot?.sectionName || "Content").trim() || "Content";
    const label =
      (row.label || slot?.label || roleLabel(role, sectionName, out.length)).trim() ||
      role;
    out.push({
      id,
      sectionIndex:
        typeof row.sectionIndex === "number"
          ? row.sectionIndex
          : (slot?.sectionIndex ?? 0),
      sectionName,
      role,
      label,
      text: coerceBlockText(row.text) || coerceBlockText(slot?.seedText),
      targetLen: row.targetLen ?? slot?.targetLen ?? null,
      minLen: row.minLen ?? slot?.minLen ?? null,
      maxLen: row.maxLen ?? slot?.maxLen ?? null,
      href: row.href ?? slot?.href ?? null,
    });
  }
  return out;
}

function roleLabel(role: string, sectionName: string, index: number): string {
  const map: Record<string, string> = {
    meta_title: "Meta title",
    meta_description: "Meta description",
    eyebrow: "Eyebrow",
    h1: "Headline (H1)",
    h2: "Section heading (H2)",
    h3: "Subheading (H3)",
    body: "Body copy",
    bullet: "Bullet",
    cta: "Call to action",
    testimonial: "Testimonial",
    stat: "Stat / proof point",
    nav: "Nav link label",
    footer: "Footer disclaimer",
    footer_link: "Footer link label",
    social: "Social link label",
    internal_link: "Internal link label",
  };
  return map[role] || `${sectionName} · ${role} ${index + 1}`;
}

function uniqLinks(links: BrandLink[], max: number): BrandLink[] {
  const seen = new Set<string>();
  const out: BrandLink[] = [];
  for (const l of links) {
    const href = (l.href || "").trim();
    const label = (l.label || "").trim();
    if (!href || href === "#") continue;
    const key = href.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: label || href, href });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Brand link / meta / footer slots (not from competitor DOM).
 */
function buildBrandLinkSlots(input: {
  brandLinks?: {
    navLinks?: BrandLink[];
    footerLinks?: BrandLink[];
    socialLinks?: BrandLink[];
    servicePages?: BrandLink[];
    businessUrl?: string;
  } | null;
  sectionBase?: number;
}): ScaffoldSlot[] {
  const brandLinks = input.brandLinks;
  const linkSectionIndex = input.sectionBase ?? 90;
  const slots: ScaffoldSlot[] = [
    {
      id: "meta-title",
      sectionIndex: 0,
      sectionName: "SEO",
      role: "meta_title",
      label: "Meta title",
      purpose: "Browser / SERP title for the brand page",
      targetLen: 55,
      minLen: 40,
      maxLen: 65,
    },
    {
      id: "meta-description",
      sectionIndex: 0,
      sectionName: "SEO",
      role: "meta_description",
      label: "Meta description",
      purpose: "SERP description",
      targetLen: 150,
      minLen: 110,
      maxLen: 165,
    },
  ];

  const nav = uniqLinks(brandLinks?.navLinks || [], 10);
  const footer = uniqLinks(brandLinks?.footerLinks || [], 14);
  const social = uniqLinks(brandLinks?.socialLinks || [], 8);
  const services = uniqLinks(brandLinks?.servicePages || [], 12);
  const businessUrl = brandLinks?.businessUrl || "";

  if (nav.length) {
    nav.forEach((l, i) => {
      const len = Math.max(8, Math.min(40, l.label.length + 4));
      slots.push({
        id: `nav-${i}`,
        sectionIndex: linkSectionIndex,
        sectionName: "Navigation",
        role: "nav",
        label: `Nav · ${l.label}`,
        purpose: "Header/nav label (href locked)",
        targetLen: len,
        minLen: Math.max(4, len - 6),
        maxLen: len + 8,
        href: l.href,
        seedText: l.label,
      });
    });
  } else if (businessUrl) {
    slots.push({
      id: "nav-0",
      sectionIndex: linkSectionIndex,
      sectionName: "Navigation",
      role: "nav",
      label: "Nav · Home",
      purpose: "Primary nav home label",
      targetLen: 12,
      minLen: 4,
      maxLen: 20,
      href: businessUrl,
      seedText: "Home",
    });
  }

  if (services.length) {
    services.forEach((l, i) => {
      const len = Math.max(10, Math.min(48, l.label.length + 6));
      slots.push({
        id: `service-${i}`,
        sectionIndex: linkSectionIndex + 1,
        sectionName: "Service pages",
        role: "internal_link",
        label: `Service · ${l.label}`,
        purpose: "Service/product page link label (href locked)",
        targetLen: len,
        minLen: Math.max(6, len - 8),
        maxLen: len + 10,
        href: l.href,
        seedText: l.label,
      });
    });
  }

  if (footer.length) {
    footer.forEach((l, i) => {
      const len = Math.max(8, Math.min(40, l.label.length + 4));
      slots.push({
        id: `footer-link-${i}`,
        sectionIndex: linkSectionIndex + 2,
        sectionName: "Footer links",
        role: "footer_link",
        label: `Footer · ${l.label}`,
        purpose: "Footer page link label (href locked)",
        targetLen: len,
        minLen: Math.max(4, len - 6),
        maxLen: len + 8,
        href: l.href,
        seedText: l.label,
      });
    });
  }

  if (social.length) {
    social.forEach((l, i) => {
      const len = Math.max(6, Math.min(28, l.label.length + 4));
      slots.push({
        id: `social-${i}`,
        sectionIndex: linkSectionIndex + 3,
        sectionName: "Social links",
        role: "social",
        label: `Social · ${l.label}`,
        purpose: "Social network label (href locked)",
        targetLen: len,
        minLen: Math.max(3, len - 4),
        maxLen: len + 6,
        href: l.href,
        seedText: l.label,
      });
    });
  }

  slots.push({
    id: "footer-blurb",
    sectionIndex: linkSectionIndex + 4,
    sectionName: "Footer",
    role: "footer",
    label: "Footer disclaimer",
    purpose: "Short brand-safe legal/general-info line",
    targetLen: 140,
    minLen: 90,
    maxLen: 180,
  });

  return slots;
}

function pageSlotsToScaffold(slots: PageTextSlot[]): ScaffoldSlot[] {
  return slots.map((s) => {
    const faqSection = /faq/i.test(s.sectionName);
    let role = s.role;
    let label = s.label;
    if (faqSection) {
      if (role === "h2" || role === "h3" || role === "eyebrow") {
        role = "faq_question";
        label = "FAQ question";
      } else if (role === "body" || role === "bullet") {
        role = "faq_answer";
        label = "FAQ answer";
      }
    }
    return {
      id: s.id,
      sectionIndex: s.sectionIndex,
      sectionName: s.sectionName,
      role,
      label,
      purpose: s.purpose,
      targetLen: s.targetLen,
      minLen: s.minLen,
      maxLen: s.maxLen,
      originalText: s.originalText,
      htmlRole: s.htmlRole,
      href: s.href || null,
      seedText: s.seedText || null,
    };
  });
}

/** Shared scaffold for OpenAI slot drafting and Firecrawl/Claude document drafting. */
export function buildPageContentScaffold(input: {
  pageSlots?: PageTextSlot[] | null;
  brandLinks?: {
    navLinks?: BrandLink[];
    footerLinks?: BrandLink[];
    socialLinks?: BrandLink[];
    servicePages?: BrandLink[];
    businessUrl?: string;
  } | null;
}): ScaffoldSlot[] {
  const pageScaffold = pageSlotsToScaffold(input.pageSlots || []);
  const maxSection = pageScaffold.length
    ? Math.max(0, ...pageScaffold.map((s) => s.sectionIndex))
    : 0;
  const linkSlots = buildBrandLinkSlots({
    brandLinks: input.brandLinks,
    sectionBase: maxSection + 1,
  });
  return [
    ...linkSlots.filter((s) => s.sectionIndex === 0),
    ...pageScaffold,
    ...linkSlots.filter((s) => s.sectionIndex !== 0),
  ];
}

export type { ScaffoldSlot };

function clipToSlotBudget(text: string, slot: ScaffoldSlot): string {
  const maxLen = slot.maxLen ?? Math.ceil(slot.targetLen * 1.35);
  return clipToCompletePhrase(text, maxLen, {
    softMax: Math.max(maxLen + 16, Math.ceil(maxLen * 1.4)),
    role: slot.role,
  });
}

/**
 * Build a scaffold of slots from page analysis architecture + brand link inventory.
 * @deprecated Prefer real page text slots via extractCompetitorPageTextSlots.
 */
export function buildContentScaffold(
  analysis: LandingPageOfferAnalysis,
  brandLinks?: {
    navLinks?: BrandLink[];
    footerLinks?: BrandLink[];
    socialLinks?: BrandLink[];
    servicePages?: BrandLink[];
    businessUrl?: string;
  } | null,
): ScaffoldSlot[] {
  const sections = analysis.pageArchitecture?.sections?.length
    ? analysis.pageArchitecture.sections
    : [
        {
          name: "Hero",
          purpose: "Primary value proposition and main CTA",
          summary: "",
          keyElements: ["headline", "subcopy", "cta"],
        },
        {
          name: "Benefits",
          purpose: "Key reasons to choose the brand",
          summary: "",
          keyElements: ["heading", "bullets"],
        },
        {
          name: "Social proof",
          purpose: "Trust and credibility",
          summary: "",
          keyElements: ["heading", "testimonial"],
        },
        {
          name: "Final CTA",
          purpose: "Close with a clear next step",
          summary: "",
          keyElements: ["heading", "cta"],
        },
      ];

  const slots: ScaffoldSlot[] = [];

  sections.forEach((section, sectionIndex) => {
    const name = section.name || `Section ${sectionIndex + 1}`;
    const purpose = section.purpose || section.summary || "Page section";
    const elements = (section.keyElements || []).map((e) => e.toLowerCase());
    const push = (role: string, targetLen: number, suffix = "0") => {
      const id = `s${sectionIndex}-${role}-${suffix}`;
      const budget = lengthBudgetForRole(targetLen, role);
      slots.push({
        id,
        sectionIndex: sectionIndex + 1,
        sectionName: name,
        role,
        label: roleLabel(role, name, Number(suffix) || 0),
        purpose,
        targetLen,
        minLen: budget.minLen,
        maxLen: budget.maxLen,
      });
    };

    const isHero =
      /hero|banner|above.?fold|header/i.test(name) || sectionIndex === 0;
    if (isHero) {
      push("eyebrow", 36, "0");
      push("h1", 70, "0");
      push("body", 160, "0");
      push("cta", 28, "0");
      return;
    }

    if (/faq/i.test(name)) {
      push("h2", 48, "0");
      for (let i = 0; i < 4; i += 1) {
        push("h3", 55, String(i));
        push("body", 140, String(i));
      }
      return;
    }

    if (
      /testimonial|review|social.?proof/i.test(name) ||
      elements.some((e) => /testimonial|review/.test(e))
    ) {
      push("h2", 48, "0");
      push("testimonial", 160, "0");
      push("testimonial", 160, "1");
      return;
    }

    if (/cta|convert|contact|book|get.?started/i.test(name)) {
      push("h2", 48, "0");
      push("body", 120, "0");
      push("cta", 28, "0");
      return;
    }

    push("h2", 48, "0");
    push("body", 140, "0");
    push("body", 120, "1");
    if (elements.some((e) => /bullet|list|benefit|feature/.test(e))) {
      for (let i = 0; i < 3; i += 1) push("bullet", 70, String(i));
    }
    push("cta", 28, "0");
  });

  return [
    ...buildBrandLinkSlots({ brandLinks, sectionBase: sections.length + 1 }).filter(
      (s) => s.role === "meta_title" || s.role === "meta_description",
    ),
    ...slots,
    ...buildBrandLinkSlots({ brandLinks, sectionBase: sections.length + 1 }).filter(
      (s) => s.role !== "meta_title" && s.role !== "meta_description",
    ),
  ].slice(0, 100);
}

/**
 * Merge approved nav/footer/social labels + hrefs into BrandSiteAssets for design fit.
 */
export function brandAssetsFromContentDraft(
  draft: LandingContentDraft,
  base: BrandSiteAssets | null,
  businessUrl: string,
  brandName: string,
): BrandSiteAssets {
  const pick = (role: string): BrandLink[] =>
    draft.blocks
      .filter((b) => b.role === role && b.href)
      .map((b) => ({
        label: (b.text || b.label || "").trim() || b.href!,
        href: b.href!,
      }))
      .filter((l) => l.href && l.label);

  const navLinks = pick("nav");
  const footerLinks = pick("footer_link");
  const internalLinks = pick("internal_link");
  const socialLinks = pick("social");

  return {
    finalUrl: base?.finalUrl || businessUrl,
    siteName: base?.siteName || brandName,
    logoUrl: base?.logoUrl || null,
    faviconUrl: base?.faviconUrl || null,
    ogImageUrl: base?.ogImageUrl || null,
    navLinks: navLinks.length ? navLinks : base?.navLinks || [],
    footerLinks: footerLinks.length
      ? footerLinks
      : uniqLinks([...(base?.footerLinks || []), ...internalLinks], 14),
    socialLinks: socialLinks.length ? socialLinks : base?.socialLinks || [],
    servicePages: base?.servicePages || [],
    ctaLinks: base?.ctaLinks || [],
    images: base?.images || [],
    emails: base?.emails || [],
    phones: base?.phones || [],
  };
}

/**
 * Phase 1 — produce a full original content pack with OpenAI.
 * Driven by REAL competitor text placements (lengths + roles), not architecture guesses.
 */
export async function generateLandingContentDraft(input: {
  analysis: LandingPageOfferAnalysis;
  brandName: string;
  businessUrl: string;
  keyword: string;
  competitorName: string;
  competitorUrl: string;
  profile: BusinessProfile | null;
  siteAssets?: BrandSiteAssets | null;
  servicePages?: BrandLink[];
  userFeedback?: string | null;
}): Promise<{ draft: LandingContentDraft; sourceArchive: StoredPageArchive | null }> {
  const now = new Date().toISOString();
  const model = getOpenAiContentModel();
  const assets = input.siteAssets || input.profile?.brandAssets || null;
  const servicePages = uniqLinks(
    [
      ...(input.servicePages || []),
      ...(assets?.footerLinks || []).filter((l) =>
        /\/(services?|solutions?|products?|loans?|insurance|mortgage)/i.test(
          l.href,
        ),
      ),
    ],
    12,
  );

  const brandLinkOpts = {
    navLinks: assets?.navLinks || [],
    footerLinks: assets?.footerLinks || [],
    socialLinks: assets?.socialLinks || [],
    servicePages,
    businessUrl: input.businessUrl,
  };

  let slotSource: "page_text_slots" | "architecture_scaffold" =
    "page_text_slots";
  let scaffold: ScaffoldSlot[] = [];
  let slotNotes = "";
  let sourceArchive: StoredPageArchive | null = null;

  try {
    const extracted = await extractCompetitorPageTextSlots(
      input.competitorUrl || input.analysis.analyzedUrl || "",
    );
    sourceArchive = extracted.archive;
    const pageScaffold = pageSlotsToScaffold(extracted.slots);
    const maxSection = Math.max(
      0,
      ...pageScaffold.map((s) => s.sectionIndex),
    );
    const linkSlots = buildBrandLinkSlots({
      brandLinks: brandLinkOpts,
      sectionBase: maxSection + 1,
    });
    scaffold = [
      ...linkSlots.filter((s) => s.sectionIndex === 0),
      ...pageScaffold,
      ...linkSlots.filter((s) => s.sectionIndex !== 0),
    ];
    slotNotes = `Real page slots×${extracted.slots.length} via ${extracted.source} (${extracted.finalUrl})`;
  } catch (err) {
    console.warn(
      "[contentDraft] page slot extract failed; falling back to architecture scaffold",
      err,
    );
    slotSource = "architecture_scaffold";
    scaffold = buildContentScaffold(input.analysis, brandLinkOpts);
    slotNotes = `Architecture scaffold fallback: ${(err as Error).message}`;
  }

  const feedback = input.userFeedback?.trim() || "";

  const lockedKeywords = Array.from(
    new Set(
      [
        input.keyword,
        ...(input.profile?.competitorKeywords || []),
        ...(input.profile?.offerings || []).slice(0, 8),
      ]
        .map((k) => (k || "").trim())
        .filter((k) => k.length >= 2),
    ),
  ).slice(0, 16);

  const client = getClient();
  const system = `You write replacement landing-page copy for REAL text placements from a competitor page.

Each scaffold slot is one visible text node on the page (headline, paragraph, button, list item, etc.) with a character budget from the original placement.

Return ONLY JSON:
{
  "pageType": string|null,
  "tone": string|null,
  "differentiationSummary": string,
  "blocks": [
    { "id": "...", "text": "..." }
  ]
}

Hard rules:
1) Fill EVERY scaffold id exactly once. Prefer returning only {id, text} — other fields are already known.
2) COMPLETE COPY (critical): every text MUST be a finished phrase or sentence. Never end mid-thought (e.g. "…With Smarter" or "…so you" is INVALID). Prefer a slightly shorter complete line over a longer incomplete one.
3) LENGTH: aim near targetLen; stay between minLen and maxLen when possible. Soft ceiling — finishing the thought beats exact maxLen. Buttons/eyebrows stay short; body slots get full sentences.
4) originalText is the competitor's current copy at that placement — use it ONLY as topic/angle. STRONG paraphrase: new wording, new rhythm. Never keep 3+ consecutive content words from originalText (locked keywords are the only exception).
5) Never mention competitor "${input.competitorName}".
6) KEYWORDS LOCK: keep these EXACTLY when they appear:
${lockedKeywords.map((k) => `   - "${k}"`).join("\n") || `   - "${input.keyword}"`}
7) LINKS: roles nav, internal_link, footer_link, social have locked href + optional seedText. Keep href exactly; polish label only; stay within length budget.
8) Match role: h1 = one complete headline, h2/h3 = complete headings, cta = short action label, bullet = one complete benefit, body = full sentence(s) within budget, eyebrow = short complete line.
9) No fabricated regulated claims, fake endorsements, or invented licence numbers.
10) Footer disclaimer is brand-safe general info only.
11) Meta title/description unique and benefit-led within their budgets.
${feedback ? `12) HIGHEST PRIORITY user feedback:\n"""${feedback.slice(0, 2500)}"""` : ""}`;

  const brandPayload = {
    name: input.brandName,
    url: input.businessUrl,
    keyword: input.keyword,
    lockedKeywords,
    industry: input.profile?.industry || null,
    subIndustry: input.profile?.subIndustry || null,
    description: input.profile?.description || null,
    offerings: input.profile?.offerings || [],
    audience: input.profile?.targetAudience || null,
    positioning: input.profile?.positioningSummary || null,
  };

  // Batch large slot lists so the model respects every length budget
  const byId = new Map<string, { id: string; text: string }>();
  let differentiationSummary: string | null = null;
  let pageType: string | null = null;
  let tone: string | null = null;

  const BATCH = 40;
  for (let i = 0; i < scaffold.length; i += BATCH) {
    const batch = scaffold.slice(i, i + BATCH).map((s) => ({
      id: s.id,
      role: s.role,
      htmlRole: s.htmlRole || null,
      sectionName: s.sectionName,
      label: s.label,
      targetLen: s.targetLen,
      minLen: s.minLen ?? lengthBudgetForRole(s.targetLen, s.role).minLen,
      maxLen: s.maxLen ?? lengthBudgetForRole(s.targetLen, s.role).maxLen,
      originalText: s.originalText || null,
      seedText: s.seedText || null,
      href: s.href || null,
      purpose: s.purpose,
    }));

    const completion = await client.chat.completions.create({
      model,
      temperature: 0.85,
      max_tokens: 12000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify(
            {
              brand: brandPayload,
              avoidCompetitorName: input.competitorName,
              batchIndex: Math.floor(i / BATCH) + 1,
              batchTotal: Math.ceil(scaffold.length / BATCH),
              topicHints: {
                audience: input.analysis.audience || null,
                offer: input.analysis.offer || null,
                summary: input.analysis.summary || null,
              },
              scaffold: batch,
              userFeedback: feedback || null,
            },
            null,
            2,
          ),
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) continue;
    try {
      const json = JSON.parse(raw) as z.infer<typeof draftSchema>;
      const parsed = draftSchema.parse(json);
      if (parsed.differentiationSummary && !differentiationSummary) {
        differentiationSummary = parsed.differentiationSummary;
      }
      if (parsed.pageType && !pageType) pageType = parsed.pageType;
      if (parsed.tone && !tone) tone = parsed.tone;
      for (const row of parsed.blocks || []) {
        const id = row.id != null ? String(row.id).trim() : "";
        if (!id) continue;
        const text = coerceBlockText(row.text);
        if (text) byId.set(id, { id, text });
      }
    } catch (err) {
      console.warn("[contentDraft] batch parse failed", i, err);
    }
  }

  if (byId.size < 2) {
    throw new Error(
      "OpenAI content draft returned almost no usable text blocks. Try Regenerate content again.",
    );
  }

  const blocks: LandingContentBlock[] = scaffold.map((slot) => {
    const hit = byId.get(slot.id);
    let text = (hit?.text || slot.seedText || "")
      .replace(/\s+/g, " ")
      .trim();
    text = clipToSlotBudget(
      text || `[Draft needed: ${slot.label} for ${input.brandName}]`,
      slot,
    );
    return {
      id: slot.id,
      sectionIndex: slot.sectionIndex,
      sectionName: slot.sectionName,
      role: slot.role,
      label: slot.label,
      text,
      targetLen: slot.targetLen,
      minLen: slot.minLen ?? null,
      maxLen: slot.maxLen ?? null,
      originalText: slot.originalText || null,
      htmlRole: slot.htmlRole || null,
      href: slot.href || null,
    };
  });

  return {
    draft: {
      status: "ready",
      createdAt: now,
      updatedAt: now,
      model,
      pageType:
        pageType || input.analysis.pageArchitecture?.pageType || null,
      tone,
      differentiationSummary:
        differentiationSummary ||
        `${slotNotes}. Copy written to match real placement lengths.`,
      blocks,
      slotSource,
      slotCount: blocks.filter((b) => b.originalText).length,
      userFeedback: feedback || null,
      approvedAt: null,
      error: null,
    },
    sourceArchive,
  };
}

export function normalizeEditedContentDraft(
  draft: LandingContentDraft,
  edits: LandingContentBlock[],
): LandingContentDraft {
  const byId = new Map(edits.map((b) => [b.id, b]));
  const blocks = draft.blocks.map((b) => {
    const next = byId.get(b.id);
    if (!next) return b;
    let text = String(next.text || "").replace(/\s+/g, " ").trim();
    const maxLen = b.maxLen ?? null;
    if (maxLen && text.length > maxLen) {
      text = clipToCompletePhrase(text, maxLen, {
        softMax: Math.max(maxLen + 16, Math.ceil(maxLen * 1.35)),
        role: b.role,
      });
    }
    return {
      ...b,
      text,
      label: next.label || b.label,
      // Keep original href locked unless edit provides one and block already had href
      href: b.href || next.href || null,
      minLen: b.minLen,
      maxLen: b.maxLen,
      originalText: b.originalText,
      htmlRole: b.htmlRole,
      targetLen: b.targetLen,
    };
  });
  return {
    ...draft,
    blocks,
    updatedAt: new Date().toISOString(),
    status: draft.status === "approved" ? "ready" : draft.status,
    approvedAt: null,
  };
}
