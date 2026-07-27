import * as cheerio from "cheerio";
import OpenAI from "openai";
import { z } from "zod";
import type {
  CompetitorRecord,
  LandingPageOfferAnalysis,
  LookupAdRecord,
} from "../types";
import {
  getCompetitor,
  getLookupAd,
  updateCompetitor,
  updateLookupAd,
} from "../db";
import {
  getOpenRouterClient,
  OPENROUTER_PERPLEXITY_MODEL,
} from "../openrouter/client";
import {
  getAnthropicClient,
  getAnthropicModel,
} from "../anthropic/client";
import { fetchRawLandingHtml, normalizeLandingUrl } from "./htmlFetch";

const MAX_TEXT_CHARS = 22_000;

const analysisSchema = z.object({
  offer: z.object({
    headline: z.string().nullable().optional(),
    primaryOffer: z.string(),
    pricing: z.string().nullable().optional(),
    cta: z.string().nullable().optional(),
    guarantees: z.array(z.string()).optional().default([]),
    urgency: z.string().nullable().optional(),
    uniqueValueProps: z.array(z.string()).optional().default([]),
  }),
  pageArchitecture: z.object({
    pageType: z.string().nullable().optional(),
    sections: z
      .array(
        z.object({
          name: z.string(),
          purpose: z.string(),
          summary: z.string(),
          keyElements: z.array(z.string()).optional().default([]),
        }),
      )
      .default([]),
  }),
  audience: z.string().nullable().optional(),
  trustSignals: z.array(z.string()).optional().default([]),
  conversionElements: z.array(z.string()).optional().default([]),
  techNotes: z.array(z.string()).optional().default([]),
  summary: z.string().nullable().optional(),
});

type PageOutline = {
  title: string | null;
  ogTitle: string | null;
  metaDescription: string | null;
  /** Best hero / H1 candidates in order */
  heroCandidates: string[];
  /** Ordered heading outline with nearby body copy */
  headingOutline: Array<{
    level: number;
    text: string;
    snippet: string;
  }>;
  ctas: string[];
  plainText: string;
};

function resolveLandingUrl(urls: Array<string | null | undefined>): string | null {
  const candidates = urls.map((u) => (u || "").trim()).filter(Boolean);
  for (const raw of candidates) {
    const normalized = normalizeLandingUrl(raw);
    if (!normalized) continue;
    try {
      const u = new URL(normalized);
      if (!/^https?:$/i.test(u.protocol)) continue;
      if (
        /facebook\.com\/ads\/library|adstransparency\.google|linkedin\.com\/ad-library/i.test(
          u.hostname + u.pathname,
        )
      ) {
        continue;
      }
      return u.toString();
    } catch {
      // try next
    }
  }
  return null;
}

function extractUrlsFromText(text?: string | null): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  return matches.map((u) => u.replace(/[.,;:!?)]+$/, ""));
}

function resolveLookupAdUrl(ad: LookupAdRecord): string | null {
  return resolveLandingUrl([
    ad.landingPageUrl,
    ...extractUrlsFromText(ad.body),
    ad.youtubeUrl,
    ad.advertiserPageUrl,
  ]);
}

function resolveCompetitorUrl(c: CompetitorRecord): string | null {
  const ad = c.sampleAd;
  return resolveLandingUrl([
    ad?.landingPageUrl,
    ...extractUrlsFromText(ad?.body),
    ad?.youtubeUrl,
    ad?.advertiserPageUrl,
    c.brand?.website,
    ad?.domain ? `https://${ad.domain}` : null,
  ]);
}

function normalizeText(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

function looksLikeNavJunk(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length < 3) return true;
  if (t.length > 160) return false;
  return /^(home|about|contact|blog|login|sign\s*up|menu|skip to|privacy|terms|cookie|cart|search)$/i.test(
    t,
  );
}

/**
 * Build a structured outline from HTML so the LLM sees real H1/H2 order
 * instead of a noisy flattened text blob.
 */
export function extractPageOutline(html: string, fallbackTitle: string | null): PageOutline {
  const $ = cheerio.load(html);

  // Harvest hidden/static content BEFORE stripping — many funnels only put copy in noscript / JSON-LD
  const noscriptText = $("noscript")
    .toArray()
    .map((el) => normalizeText($(el).text()))
    .filter((t) => t.length > 20)
    .join("\n");

  const jsonLdBits: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html() || $(el).text() || "";
    try {
      const data = JSON.parse(raw);
      const walk = (node: unknown) => {
        if (!node) return;
        if (typeof node === "string") {
          const t = normalizeText(node);
          if (t.length >= 12 && t.length <= 400) jsonLdBits.push(t);
          return;
        }
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (typeof node === "object") {
          const obj = node as Record<string, unknown>;
          for (const key of [
            "headline",
            "name",
            "description",
            "text",
            "abstract",
            "caption",
          ]) {
            if (typeof obj[key] === "string") walk(obj[key]);
          }
          if (obj["@graph"]) walk(obj["@graph"]);
        }
      };
      walk(data);
    } catch {
      // ignore bad json-ld
    }
  });

  $("script, style, svg, iframe, template").remove();
  // Keep noscript text we already harvested; remove nodes so they don't double-count oddly
  $("noscript").remove();

  const ogTitle =
    normalizeText(
      $('meta[property="og:title"]').attr("content") ||
        $('meta[name="twitter:title"]').attr("content") ||
        "",
    ) || null;
  const metaDescription =
    normalizeText(
      $('meta[name="description"]').attr("content") ||
        $('meta[property="og:description"]').attr("content") ||
        "",
    ) || null;
  const title =
    normalizeText($("title").first().text()) || fallbackTitle || null;

  const heroCandidates: string[] = [];
  const pushHero = (raw: string) => {
    const t = normalizeText(raw);
    if (!t || t.length < 8 || t.length > 180) return;
    if (looksLikeNavJunk(t)) return;
    if (heroCandidates.some((h) => h.toLowerCase() === t.toLowerCase())) return;
    heroCandidates.push(t);
  };

  $("h1").each((_, el) => pushHero($(el).text()));
  $(
    "[class*='hero'] h2, [class*='Hero'] h2, [class*='banner'] h2, [class*='jumbotron'] h2, header h2, [class*='hero'] [class*='title'], [class*='Hero'] [class*='title']",
  ).each((_, el) => pushHero($(el).text()));
  if (ogTitle) pushHero(ogTitle);
  if (title && title.length >= 8 && title.length <= 120) pushHero(title);

  const headingOutline: PageOutline["headingOutline"] = [];
  $("h1, h2, h3").each((_, el) => {
    const $el = $(el);
    if ($el.closest("nav, footer, [role='navigation'], [role='contentinfo']").length) {
      return;
    }
    const tag = ((el as { tagName?: string }).tagName || "h2").toLowerCase();
    const level = Number(tag.replace("h", "")) || 2;
    const text = normalizeText($el.text());
    if (!text || text.length < 3 || looksLikeNavJunk(text)) return;

    const bits: string[] = [];
    let sib = $el.next();
    let guard = 0;
    while (sib.length && guard < 6) {
      const st = ((sib.get(0) as { tagName?: string } | undefined)?.tagName || "").toLowerCase();
      if (st === "h1" || st === "h2" || st === "h3") break;
      if (st === "p" || st === "li" || st === "div" || st === "span") {
        const sn = normalizeText(sib.text());
        if (sn.length >= 20 && sn.length < 600) bits.push(sn);
      } else {
        sib.find("p, li").each((__, p) => {
          const sn = normalizeText($(p).text());
          if (sn.length >= 20) bits.push(sn);
        });
      }
      if (bits.join(" ").length > 320) break;
      sib = sib.next();
      guard += 1;
    }

    headingOutline.push({
      level,
      text,
      snippet: bits.slice(0, 2).join(" ").slice(0, 360),
    });
  });

  const ctas: string[] = [];
  $("a, button").each((_, el) => {
    const $el = $(el);
    if ($el.closest("nav, footer, [role='navigation']").length) return;
    const t = normalizeText($el.text() || $el.attr("aria-label") || "");
    if (t.length < 3 || t.length > 60) return;
    if (
      !/(get|start|book|call|demo|free|download|try|join|apply|claim|learn|sign|schedule|buy|compare|quote)/i.test(
        t,
      )
    ) {
      return;
    }
    if (!ctas.some((c) => c.toLowerCase() === t.toLowerCase())) {
      ctas.push(t);
    }
  });

  // Readable body text with heading markers preserved
  const $scope: any = $("body").length ? $("body") : $.root();
  const bodyClone: any = $scope.clone();
  bodyClone.find("nav, footer, script, style").remove();
  let plain = "";
  bodyClone
    .find("h1, h2, h3, p, li, [class*='headline'], [class*='title']")
    .each((_: number, el: any) => {
      const tag = ((el as { tagName?: string }).tagName || "").toLowerCase();
      const t = normalizeText($(el).text());
      if (!t || t.length < 2) return;
      if (tag.startsWith("h")) plain += `\n[${tag.toUpperCase()}] ${t}\n`;
      else plain += `${t}\n`;
    });

  // Div-heavy builders (GHL / ClickFunnels / Webflow): take broad body text
  if (plain.trim().length < 120) {
    plain = normalizeText(String(bodyClone.text() || ""));
  }

  // Last resort: regex-strip the raw HTML (handles odd encodings / missing body)
  if (plain.trim().length < 80) {
    plain = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
  }

  const metaBlock = [
    title ? `Title: ${title}` : "",
    ogTitle ? `OG title: ${ogTitle}` : "",
    metaDescription ? `Description: ${metaDescription}` : "",
    noscriptText ? `Noscript:\n${noscriptText}` : "",
    jsonLdBits.length ? `Structured data:\n${jsonLdBits.slice(0, 20).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const combined = [metaBlock, plain].filter(Boolean).join("\n\n").trim();

  return {
    title,
    ogTitle,
    metaDescription,
    heroCandidates: heroCandidates.slice(0, 6),
    headingOutline: headingOutline.slice(0, 40),
    ctas: ctas.slice(0, 12),
    plainText: combined.slice(0, MAX_TEXT_CHARS),
  };
}

function outlineSignalLength(outline: PageOutline): number {
  return [
    outline.plainText,
    outline.metaDescription || "",
    outline.title || "",
    outline.ogTitle || "",
    ...outline.heroCandidates,
    ...outline.headingOutline.map((h) => `${h.text} ${h.snippet}`),
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim().length;
}

async function fetchLandingPage(url: string): Promise<{
  finalUrl: string;
  title: string | null;
  outline: PageOutline;
}> {
  const page = await fetchRawLandingHtml(url);
  return {
    finalUrl: page.finalUrl,
    title: page.title,
    outline: extractPageOutline(page.html, page.title),
  };
}

function schemaHint(): string {
  return `{
  "offer": {
    "headline": string|null,
    "primaryOffer": string,
    "pricing": string|null,
    "cta": string|null,
    "guarantees": string[],
    "urgency": string|null,
    "uniqueValueProps": string[]
  },
  "pageArchitecture": {
    "pageType": string|null,
    "sections": [{ "name": string, "purpose": string, "summary": string, "keyElements": string[] }]
  },
  "audience": string|null,
  "trustSignals": string[],
  "conversionElements": string[],
  "techNotes": string[],
  "summary": string
}`;
}

function buildSystemPrompt(): string {
  return `You are a conversion-copy and landing-page architect.
You receive a STRUCTURED outline of a landing page (hero candidates, ordered headings with snippets, CTAs) plus page text.

Extract:
1) The commercial OFFER
2) PAGE ARCHITECTURE as an ordered list of distinct sections
3) Audience, trust signals, conversion elements, tech/UX notes

Hard rules for accuracy:
- offer.headline MUST be the main hero promise — prefer the first clear H1 / heroCandidate. Copy it closely (fix typos only). NEVER concatenate brand name + product name + tagline into one run-on string. One sentence or short phrase only.
- offer.primaryOffer = what the visitor gets (product/service), not the headline restated awkwardly.
- offer.cta = the primary button label from ctas[] when possible.
- pageArchitecture.sections MUST cover the full page top-to-bottom using headingOutline as the map. Include typically: Hero, Problem/Agitation (if present), Solution/Features, Social proof, Offer/Pricing, How it works, FAQ, Final CTA, Footer (if meaningful). Aim for 5–12 sections when the page has that much content. Do NOT stop after Hero.
- Each section name should be human (e.g. "Hero", "Features", "Testimonials") — not raw H1 text dumped as the only section.
- Be evidence-based. If pricing/CTA is unclear, use null. Do not invent.
- Return a single JSON object only.`;
}

function pickBestHeadline(
  llmHeadline: string | null | undefined,
  outline: PageOutline,
): string | null {
  const candidates = [
    ...outline.heroCandidates,
    outline.ogTitle,
    outline.title,
  ].filter((s): s is string => Boolean(s && s.trim()));

  const llm = (llmHeadline || "").replace(/\s+/g, " ").trim();
  if (llm) {
    // Reject run-on concatenations that mash many title fragments
    const words = llm.split(/\s+/).length;
    const looksConcat =
      words > 18 &&
      candidates.some(
        (c) =>
          c.length >= 8 &&
          llm.toLowerCase().includes(c.toLowerCase()) &&
          llm.length > c.length * 1.6,
      );
    if (!looksConcat && words <= 22) return llm;

    // If LLM mashed titles, prefer first real H1/hero
    if (outline.heroCandidates[0]) return outline.heroCandidates[0];
  }

  return outline.heroCandidates[0] || outline.ogTitle || null;
}

function ensureArchitectureSections(
  sections: z.infer<typeof analysisSchema>["pageArchitecture"]["sections"],
  outline: PageOutline,
): z.infer<typeof analysisSchema>["pageArchitecture"]["sections"] {
  if (sections.length >= 4) return sections;

  // Fallback: synthesize architecture from heading outline when LLM truncated
  const synthesized = outline.headingOutline
    .filter((h) => h.level <= 2)
    .slice(0, 12)
    .map((h, i) => {
      const name =
        i === 0
          ? "Hero"
          : /faq|question/i.test(h.text)
            ? "FAQ"
            : /price|pricing|plan/i.test(h.text)
              ? "Pricing"
              : /testimonial|review|client|customer/i.test(h.text)
                ? "Social proof"
                : /how|step|process/i.test(h.text)
                  ? "How it works"
                  : /feature|benefit|why/i.test(h.text)
                    ? "Features"
                    : h.text.slice(0, 48);
      return {
        name,
        purpose: `Present: ${h.text}`,
        summary: h.snippet || h.text,
        keyElements: [h.text].filter(Boolean),
      };
    });

  if (synthesized.length > sections.length) return synthesized;
  return sections;
}

async function analyzeWithLlm(input: {
  url: string;
  outline: PageOutline;
  adTitle?: string;
  adBody?: string;
  platform?: string;
}): Promise<z.infer<typeof analysisSchema>> {
  const system = `${buildSystemPrompt()}\n\nRespond with a single JSON object matching: ${schemaHint()}`;

  const userPayload = {
    landingUrl: input.url,
    pageTitle: input.outline.title,
    ogTitle: input.outline.ogTitle,
    metaDescription: input.outline.metaDescription,
    heroCandidates: input.outline.heroCandidates,
    headingOutline: input.outline.headingOutline,
    primaryCtas: input.outline.ctas,
    adPlatform: input.platform || null,
    adHeadline: input.adTitle || null,
    adBody: input.adBody || null,
    // Cap body text; outline already carries structure
    pageText: input.outline.plainText.slice(0, 14_000),
    instructions: {
      headline: "Use heroCandidates[0] or first H1 unless clearly wrong",
      architecture:
        "Map EVERY major headingOutline entry into sections (5–12 typical). Never return only Hero.",
    },
  };
  const user = JSON.stringify(userPayload, null, 2);

  let raw: string | null = null;

  // Prefer Claude when available — stronger at long structured extraction
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = getAnthropicClient();
      const completion = await client.messages.create({
        model: getAnthropicModel(),
        max_tokens: 6000,
        temperature: 0.15,
        system,
        messages: [{ role: "user", content: user }],
      });
      raw = completion.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n")
        .trim();
    } catch (err) {
      console.error("[page-analysis] Anthropic failed, falling back", err);
    }
  }

  if (!raw && process.env.OPENAI_API_KEY) {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.15,
      max_tokens: 6000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    raw = completion.choices[0]?.message?.content || null;
    if (!raw) throw new Error("Empty OpenAI landing-page analysis");
  }

  if (!raw && process.env.OPENROUTER_API_KEY) {
    const client = getOpenRouterClient();
    const completion = await client.chat.completions.create({
      model: OPENROUTER_PERPLEXITY_MODEL,
      temperature: 0.15,
      max_tokens: 6000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    raw = completion.choices[0]?.message?.content?.trim() || "";
  }

  if (!raw) {
    throw new Error(
      "ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY is required",
    );
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Could not parse landing-page analysis JSON");

  let parsed = analysisSchema.safeParse(JSON.parse(jsonMatch[0]));
  if (!parsed.success) {
    throw new Error(`Analysis schema mismatch: ${parsed.error.message}`);
  }

  let data = parsed.data;

  // If architecture is still thin, ask once more for sections only
  if (
    data.pageArchitecture.sections.length < 4 &&
    input.outline.headingOutline.length >= 4 &&
    process.env.ANTHROPIC_API_KEY
  ) {
    try {
      const client = getAnthropicClient();
      const completion = await client.messages.create({
        model: getAnthropicModel(),
        max_tokens: 3500,
        temperature: 0.1,
        system: `Expand landing-page architecture into 5–12 ordered sections from the heading outline. Return ONLY JSON: { "sections": [{ "name", "purpose", "summary", "keyElements": string[] }] }`,
        messages: [
          {
            role: "user",
            content: JSON.stringify(
              {
                headingOutline: input.outline.headingOutline,
                existingSections: data.pageArchitecture.sections,
              },
              null,
              2,
            ),
          },
        ],
      });
      const content = completion.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");
      const m = content.match(/\{[\s\S]*\}/);
      if (m) {
        const extra = JSON.parse(m[0]) as {
          sections?: z.infer<typeof analysisSchema>["pageArchitecture"]["sections"];
        };
        if (extra.sections && extra.sections.length > data.pageArchitecture.sections.length) {
          data = {
            ...data,
            pageArchitecture: {
              ...data.pageArchitecture,
              sections: extra.sections,
            },
          };
        }
      }
    } catch (err) {
      console.warn("[page-analysis] architecture expansion failed", err);
    }
  }

  const headline = pickBestHeadline(data.offer.headline, input.outline);
  const sections = ensureArchitectureSections(
    data.pageArchitecture.sections,
    input.outline,
  );
  const cta =
    data.offer.cta ||
    input.outline.ctas[0] ||
    null;

  return {
    ...data,
    offer: {
      ...data.offer,
      headline,
      cta,
      uniqueValueProps: (data.offer.uniqueValueProps || []).slice(0, 8),
      guarantees: (data.offer.guarantees || []).slice(0, 6),
    },
    pageArchitecture: {
      ...data.pageArchitecture,
      sections,
    },
  };
}

/**
 * Fetch landing page for a lookup ad, analyze offer + architecture, persist on the ad.
 */
export async function analyzeLookupAdLandingPage(
  adId: string,
): Promise<LookupAdRecord> {
  const ad = getLookupAd(adId);
  if (!ad) throw new Error("Lookup ad not found");

  const url = resolveLookupAdUrl(ad);
  if (!url) {
    throw new Error(
      "No usable landing page URL on this ad (need destination / YouTube / advertiser page URL).",
    );
  }

  updateLookupAd(adId, {
    pageAnalysis: {
      status: "pending",
      analyzedUrl: url,
      analyzedAt: new Date().toISOString(),
      error: null,
    },
  });

  try {
    const page = await fetchLandingPage(url);
    let outline = page.outline;

    // Enrich thin/JS-rendered pages with ad creative so analysis can still run
    const adBits = [ad.title, ad.body].filter(Boolean).join("\n");
    if (outlineSignalLength(outline) < 120 && adBits.length >= 40) {
      outline = {
        ...outline,
        plainText: `${outline.plainText}\n\nAd creative context:\n${adBits}`.slice(
          0,
          MAX_TEXT_CHARS,
        ),
        heroCandidates:
          outline.heroCandidates.length > 0
            ? outline.heroCandidates
            : [ad.title].filter((t): t is string => Boolean(t && t.length >= 8)),
      };
    }

    if (outlineSignalLength(outline) < 40) {
      throw new Error(
        "Landing page returned too little readable text to analyze (likely a JavaScript-only page). Try another ad destination URL.",
      );
    }

    const llm = await analyzeWithLlm({
      url: page.finalUrl,
      outline,
      adTitle: ad.title,
      adBody: ad.body,
    });

    const analysis: LandingPageOfferAnalysis = {
      status: "completed",
      analyzedUrl: page.finalUrl,
      analyzedAt: new Date().toISOString(),
      offer: llm.offer,
      pageArchitecture: llm.pageArchitecture,
      audience: llm.audience ?? null,
      trustSignals: llm.trustSignals || [],
      conversionElements: llm.conversionElements || [],
      techNotes: [
        ...(llm.techNotes || []),
        ...(outlineSignalLength(page.outline) < 120
          ? ["Page HTML had little static text; analysis used meta/ad context fallbacks."]
          : []),
      ],
      summary: llm.summary ?? null,
      error: null,
    };

    const updated = updateLookupAd(adId, { pageAnalysis: analysis });
    if (!updated) throw new Error("Failed to save page analysis");
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Keep prior completed analysis visible; only stamp error if nothing useful exists
    if (ad.pageAnalysis?.status === "completed" && ad.pageAnalysis.offer) {
      updateLookupAd(adId, {
        pageAnalysis: {
          ...ad.pageAnalysis,
          error: `Refresh failed: ${message}`,
        },
      });
    } else {
      const failed: LandingPageOfferAnalysis = {
        status: "failed",
        analyzedUrl: url,
        analyzedAt: new Date().toISOString(),
        error: message,
      };
      updateLookupAd(adId, { pageAnalysis: failed });
    }
    throw err;
  }
}

/**
 * Fetch landing page for a search competitor, analyze offer + architecture, persist.
 */
export async function analyzeCompetitorLandingPage(
  competitorId: string,
): Promise<CompetitorRecord> {
  const competitor = getCompetitor(competitorId);
  if (!competitor) throw new Error("Competitor not found");

  const url = resolveCompetitorUrl(competitor);
  if (!url) {
    throw new Error(
      "No usable landing page URL on this competitor (need destination / website URL).",
    );
  }

  updateCompetitor(competitorId, {
    pageAnalysis: {
      status: "pending",
      analyzedUrl: url,
      analyzedAt: new Date().toISOString(),
      error: null,
    },
  });

  try {
    const page = await fetchLandingPage(url);
    let outline = page.outline;

    const adBits = [competitor.sampleAd?.title, competitor.sampleAd?.body]
      .filter(Boolean)
      .join("\n");
    if (outlineSignalLength(outline) < 120 && adBits.length >= 40) {
      outline = {
        ...outline,
        plainText: `${outline.plainText}\n\nAd creative context:\n${adBits}`.slice(
          0,
          MAX_TEXT_CHARS,
        ),
        heroCandidates:
          outline.heroCandidates.length > 0
            ? outline.heroCandidates
            : [competitor.sampleAd?.title].filter(
                (t): t is string => Boolean(t && t.length >= 8),
              ),
      };
    }

    if (outlineSignalLength(outline) < 40) {
      throw new Error(
        "Landing page returned too little readable text to analyze (likely a JavaScript-only page). Try another ad destination URL.",
      );
    }

    const llm = await analyzeWithLlm({
      url: page.finalUrl,
      outline,
      adTitle: competitor.sampleAd?.title,
      adBody: competitor.sampleAd?.body,
      platform: String(competitor.platform || "facebook"),
    });

    const analysis: LandingPageOfferAnalysis = {
      status: "completed",
      analyzedUrl: page.finalUrl,
      analyzedAt: new Date().toISOString(),
      offer: llm.offer,
      pageArchitecture: llm.pageArchitecture,
      audience: llm.audience ?? null,
      trustSignals: llm.trustSignals || [],
      conversionElements: llm.conversionElements || [],
      techNotes: [
        ...(llm.techNotes || []),
        ...(outlineSignalLength(page.outline) < 120
          ? ["Page HTML had little static text; analysis used meta/ad context fallbacks."]
          : []),
      ],
      summary: llm.summary ?? null,
      error: null,
    };

    const updated = updateCompetitor(competitorId, { pageAnalysis: analysis });
    if (!updated) throw new Error("Failed to save page analysis");
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Preserve last good analysis on refresh failure
    if (
      competitor.pageAnalysis?.status === "completed" &&
      competitor.pageAnalysis.offer
    ) {
      updateCompetitor(competitorId, {
        pageAnalysis: {
          ...competitor.pageAnalysis,
          error: `Refresh failed: ${message}`,
        },
      });
    } else {
      const failed: LandingPageOfferAnalysis = {
        status: "failed",
        analyzedUrl: url,
        analyzedAt: new Date().toISOString(),
        error: message,
      };
      updateCompetitor(competitorId, { pageAnalysis: failed });
    }
    throw err;
  }
}
