import { z } from "zod";
import type {
  BusinessProfile,
  LandingContentBlock,
  LandingContentDocSection,
  LandingContentDocument,
  LandingContentDraft,
  LandingPageOfferAnalysis,
  StoredPageArchive,
} from "../types";
import {
  firecrawlScrapeForContent,
  hasFirecrawlKey,
} from "../firecrawl/client";
import { getAnthropicClient, getAnthropicModel } from "../anthropic/client";
import type { BrandLink, BrandSiteAssets } from "./brandAssets";
import { extractCompetitorPageTextSlots } from "./extractPageTextSlots";
import { clipToCompletePhrase } from "./slotTextBudget";
import {
  buildPageContentScaffold,
  generateLandingContentDraft,
  type ScaffoldSlot,
} from "./contentDraft";

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] || raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Claude content draft returned no JSON object");
  }
  return body.slice(start, end + 1);
}

const faqSchema = z.object({
  question: z.string(),
  answer: z.string(),
  qBlockId: z.string().optional().nullable(),
  aBlockId: z.string().optional().nullable(),
});

const sectionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string().optional().nullable(),
  faqs: z.array(faqSchema).optional().nullable(),
  links: z
    .array(
      z.object({
        label: z.string(),
        href: z.string(),
        role: z.string().optional().nullable(),
      }),
    )
    .optional()
    .nullable(),
  logos: z
    .array(
      z.object({
        label: z.string(),
        note: z.string().optional().nullable(),
      }),
    )
    .optional()
    .nullable(),
  blockIds: z.array(z.string()).optional().nullable(),
});

const claudeDraftSchema = z.object({
  pageType: z.string().nullable().optional(),
  tone: z.string().nullable().optional(),
  differentiationSummary: z.string().nullable().optional(),
  document: z.object({
    summary: z.string().nullable().optional(),
    meta: z
      .object({
        title: z.string(),
        description: z.string(),
      })
      .nullable()
      .optional(),
    sections: z.array(sectionSchema).default([]),
  }),
  blocks: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]),
        text: z.union([z.string(), z.number()]).optional().nullable(),
      }),
    )
    .optional()
    .default([]),
});

function uniqLinks(links: BrandLink[], limit: number): BrandLink[] {
  const seen = new Set<string>();
  const out: BrandLink[] = [];
  for (const l of links) {
    const href = (l.href || "").trim();
    if (!href || seen.has(href)) continue;
    seen.add(href);
    out.push({ label: (l.label || href).trim(), href });
    if (out.length >= limit) break;
  }
  return out;
}

function clipToSlotBudget(text: string, slot: ScaffoldSlot): string {
  const maxLen = slot.maxLen ?? Math.ceil(slot.targetLen * 1.35);
  if (text.length <= maxLen) return text;
  return clipToCompletePhrase(text, maxLen, {
    softMax: Math.max(maxLen + 16, Math.ceil(maxLen * 1.4)),
    role: slot.role,
  });
}

/**
 * Push document field edits into CID blocks used by the design paste step.
 */
export function syncDocumentIntoBlocks(
  document: LandingContentDocument,
  blocks: LandingContentBlock[],
): LandingContentBlock[] {
  const byId = new Map(blocks.map((b) => [b.id, { ...b }]));

  if (document.meta) {
    const title = byId.get("meta-title");
    const desc = byId.get("meta-description");
    if (title && document.meta.title) title.text = normalize(document.meta.title);
    if (desc && document.meta.description) {
      desc.text = normalize(document.meta.description);
    }
  }

  for (const section of document.sections || []) {
    if (section.faqs?.length) {
      for (const faq of section.faqs) {
        if (faq.qBlockId && byId.has(faq.qBlockId)) {
          byId.get(faq.qBlockId)!.text = normalize(faq.question);
        }
        if (faq.aBlockId && byId.has(faq.aBlockId)) {
          byId.get(faq.aBlockId)!.text = normalize(faq.answer);
        }
      }
    }

    if (section.links?.length) {
      for (const link of section.links) {
        const hit = [...byId.values()].find(
          (b) =>
            b.href &&
            normalize(b.href).toLowerCase() ===
              normalize(link.href).toLowerCase(),
        );
        if (hit && link.label) hit.text = normalize(link.label);
      }
    }

    const ids = section.blockIds?.filter((id) => byId.has(id)) || [];
    if (!ids.length || section.kind === "faq" || section.kind === "links") {
      continue;
    }

    const parts = (section.body || "")
      .split(/\n+/)
      .map((p) => normalize(p))
      .filter(Boolean);
    if (!parts.length) continue;

    const contentIds = ids.filter((id) => {
      const role = byId.get(id)?.role || "";
      return !/^(nav|footer_link|social|meta_)/.test(role);
    });
    if (contentIds.length === 1) {
      byId.get(contentIds[0])!.text = normalize(section.body || parts.join(" "));
    } else {
      contentIds.forEach((id, i) => {
        if (parts[i]) byId.get(id)!.text = parts[i];
      });
    }
  }

  return blocks.map((b) => byId.get(b.id) || b);
}

function documentFromParsed(
  parsed: z.infer<typeof claudeDraftSchema>,
  opts: {
    competitorUrl: string;
    markdownChars: number;
    pageType: string | null;
    tone: string | null;
  },
): LandingContentDocument {
  const sections: LandingContentDocSection[] = (
    parsed.document.sections || []
  ).map((s) => ({
    id: s.id,
    kind: s.kind,
    title: s.title,
    body: normalize(s.body || ""),
    faqs: (s.faqs || []).map((f) => ({
      question: normalize(f.question),
      answer: normalize(f.answer),
      qBlockId: f.qBlockId || undefined,
      aBlockId: f.aBlockId || undefined,
    })),
    links: (s.links || []).map((l) => ({
      label: normalize(l.label),
      href: l.href,
      role: l.role || null,
    })),
    logos: (s.logos || []).map((l) => ({
      label: normalize(l.label),
      note: l.note || null,
    })),
    blockIds: s.blockIds || [],
  }));

  return {
    pageType: parsed.pageType || opts.pageType,
    tone: parsed.tone || opts.tone,
    summary: parsed.document.summary || null,
    meta: parsed.document.meta
      ? {
          title: normalize(parsed.document.meta.title),
          description: normalize(parsed.document.meta.description),
        }
      : null,
    sections,
    sourceMarkdownChars: opts.markdownChars,
    competitorUrl: opts.competitorUrl,
  };
}

/**
 * Firecrawl markdown → Claude section analysis + brand rewrite →
 * unified document for UI + CID blocks for design paste.
 */
export async function generateMarkdownContentDraft(input: {
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
  if (!hasFirecrawlKey()) {
    throw new Error("FIRECRAWL_API_KEY is not set");
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const now = new Date().toISOString();
  const model = getAnthropicModel();
  const competitorUrl =
    input.competitorUrl || input.analysis.analyzedUrl || "";
  const assets: BrandSiteAssets | null = input.siteAssets || null;
  const servicePages = uniqLinks(
    [
      ...(input.servicePages || []),
      ...(assets?.servicePages || []),
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

  const [scrape, extracted] = await Promise.all([
    firecrawlScrapeForContent(competitorUrl),
    extractCompetitorPageTextSlots(competitorUrl).catch((err) => {
      console.warn("[markdownContentDraft] CID slot extract failed", err);
      return null;
    }),
  ]);

  const markdown = (scrape.data?.markdown || "").trim();
  if (markdown.length < 80) {
    throw new Error(
      "Firecrawl returned too little markdown to draft landing content",
    );
  }

  const sourceArchive = extracted?.archive || null;
  const scaffold = buildPageContentScaffold({
    pageSlots: extracted?.slots || null,
    brandLinks: brandLinkOpts,
  });

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

  const mdBudget = markdown.slice(0, 55_000);
  const cidInventory = scaffold.map((s) => ({
    id: s.id,
    role: s.role,
    sectionName: s.sectionName,
    sectionIndex: s.sectionIndex,
    label: s.label,
    targetLen: s.targetLen,
    minLen: s.minLen,
    maxLen: s.maxLen,
    href: s.href || null,
    originalText: (s.originalText || "").slice(0, 280),
    seedText: s.seedText || null,
  }));

  const system = `You rewrite a competitor landing page into original brand content.

You receive:
1) Firecrawl markdown of the competitor page (structure + copy)
2) A CID inventory of real text placements (for the design paste step)

Return ONLY JSON:
{
  "pageType": string|null,
  "tone": string|null,
  "differentiationSummary": string,
  "document": {
    "summary": string,
    "meta": { "title": string, "description": string },
    "sections": [
      {
        "id": "hero"|"features"|"faq"|...,
        "kind": "meta"|"hero"|"features"|"faq"|"cta"|"testimonials"|"links"|"logos"|"body"|"other",
        "title": string,
        "body": string,
        "faqs": [{ "question": string, "answer": string, "qBlockId": string|null, "aBlockId": string|null }],
        "links": [{ "label": string, "href": string, "role": "nav"|"footer_link"|"social"|"internal_link"|null }],
        "logos": [{ "label": string, "note": string|null }],
        "blockIds": string[]
      }
    ]
  },
  "blocks": [{ "id": string, "text": string }]
}

Document rules (critical):
1) Analyze the markdown into coherent PAGE SECTIONS (hero, features, social proof, FAQ, CTA, footer/links, logos, etc.).
2) Write brand copy as UNIFIED section prose in "body" — not micro-fragments. FAQs must be full Q&A pairs. Links/logos are structured lists.
3) Never mention competitor "${input.competitorName}". Strong paraphrase; no 3+ consecutive content words from competitor copy (locked keywords are the only exception).
4) Include a links section (nav/footer/social/service) and a logos section when markdown shows partner/press/brand logos.
5) FAQ section required when the page has FAQ/accordion content.
6) COMPLETE sentences only — never truncate mid-thought.

CID / blocks rules:
7) Fill EVERY cid inventory id exactly once in "blocks".
8) Map FAQ questions/answers to faq_question / faq_answer (or heading/body in FAQ sections) via qBlockId/aBlockId AND blocks[].text.
9) section.blockIds lists the CID ids that section feeds. Prefer semantic match to originalText topic.
10) LENGTH: stay near targetLen / between minLen–maxLen when possible; finishing the thought beats exact maxLen.
11) LINK roles (nav, footer_link, social, internal_link): keep href exactly from inventory; polish label only.
12) KEYWORDS LOCK (exact when used):
${lockedKeywords.map((k) => `   - "${k}"`).join("\n") || `   - "${input.keyword}"`}
13) No fabricated regulated claims, fake endorsements, or invented licence numbers.
${feedback ? `14) HIGHEST PRIORITY user feedback:\n"""${feedback.slice(0, 2500)}"""` : ""}`;

  const userPayload = {
    brand: {
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
      navLinks: brandLinkOpts.navLinks.slice(0, 12),
      footerLinks: brandLinkOpts.footerLinks.slice(0, 12),
      socialLinks: brandLinkOpts.socialLinks.slice(0, 8),
      servicePages: brandLinkOpts.servicePages.slice(0, 10),
      logoUrl: assets?.logoUrl || null,
    },
    competitor: {
      name: input.competitorName,
      url: competitorUrl,
      avoidName: input.competitorName,
    },
    topicHints: {
      audience: input.analysis.audience || null,
      offer: input.analysis.offer || null,
      summary: input.analysis.summary || null,
    },
    firecrawl: {
      title: scrape.data?.metadata?.title || null,
      description: scrape.data?.metadata?.description || null,
      links: (scrape.data?.links || []).slice(0, 40),
      markdown: mdBudget,
    },
    cidInventory,
    userFeedback: feedback || null,
  };

  const client = getAnthropicClient();
  const completion = await client.messages.create({
    model,
    max_tokens: 12_000,
    temperature: 0.25,
    system,
    messages: [{ role: "user", content: JSON.stringify(userPayload, null, 2) }],
  });

  const raw = completion.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
  if (!raw) {
    throw new Error("Claude returned empty content draft");
  }

  const parsed = claudeDraftSchema.parse(JSON.parse(extractJsonObject(raw)));
  const document = documentFromParsed(parsed, {
    competitorUrl,
    markdownChars: markdown.length,
    pageType:
      parsed.pageType || input.analysis.pageArchitecture?.pageType || null,
    tone: parsed.tone || null,
  });

  const byId = new Map<string, string>();
  for (const row of parsed.blocks || []) {
    const id = String(row.id).trim();
    const text = normalize(String(row.text ?? ""));
    if (id && text) byId.set(id, text);
  }

  for (const section of document.sections) {
    for (const faq of section.faqs || []) {
      if (faq.qBlockId && faq.question) byId.set(faq.qBlockId, faq.question);
      if (faq.aBlockId && faq.answer) byId.set(faq.aBlockId, faq.answer);
    }
  }
  if (document.meta?.title) byId.set("meta-title", document.meta.title);
  if (document.meta?.description) {
    byId.set("meta-description", document.meta.description);
  }

  let blocks: LandingContentBlock[] = scaffold.map((slot) => {
    let text = (byId.get(slot.id) || slot.seedText || "")
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

  blocks = syncDocumentIntoBlocks(document, blocks);

  return {
    draft: {
      status: "ready",
      createdAt: now,
      updatedAt: now,
      model,
      pageType: document.pageType || null,
      tone: document.tone || null,
      differentiationSummary:
        parsed.differentiationSummary ||
        `Firecrawl markdown (${markdown.length} chars) → Claude section rewrite for ${input.brandName}.`,
      blocks,
      document,
      slotSource: "firecrawl_markdown",
      slotCount: blocks.filter((b) => b.originalText).length,
      userFeedback: feedback || null,
      approvedAt: null,
      error: null,
    },
    sourceArchive,
  };
}

/**
 * Prefer Firecrawl+Claude unified document; fall back to OpenAI slot drafting.
 */
export async function generateLandingContentDraftPreferred(input: {
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
  if (hasFirecrawlKey() && process.env.ANTHROPIC_API_KEY) {
    try {
      return await generateMarkdownContentDraft(input);
    } catch (err) {
      console.warn(
        "[markdownContentDraft] Firecrawl/Claude path failed; falling back",
        err,
      );
    }
  }
  return generateLandingContentDraft(input);
}
