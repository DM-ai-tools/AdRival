import * as cheerio from "cheerio";

import { z } from "zod";
import type {
  CompetitorRecord,
  LandingPageOfferAnalysis,
  LookupAdRecord,
} from "../types";
import { extractCompetitorChromeFromHtml } from "./unified/recreateChrome";
import {
  getCompetitor,
  getJob,
  getLookupAd,
  getLookupAds,
  getSearchCompetitorAdsByCompetitor,
  updateCompetitor,
  updateLookupAd,
} from "../db";
import { enrichCompetitorDeepLocation } from "./competitorLocation";
import {
  getOpenRouterClient,
  hasOpenRouterKey,
  OPENROUTER_PERPLEXITY_MODEL,
} from "../openrouter/client";
import { OPENROUTER_FAST_MODEL, resolveOpenAICompatModel } from "../openrouter/openaiCompat";
import {
  getAnthropicClient,
  getAnthropicModel,
} from "../anthropic/client";
import { isCreditError } from "../accounting/errors";
import { maskClientFacingText } from "../clientFacing";
import { fetchRawLandingHtml, normalizeLandingUrl } from "./htmlFetch";
import {
  collectSameLandingPageAds,
  collectSameLandingPageAdsFromLookup,
  collectSameLandingPageAdsFromSearchCache,
} from "./sameLandingPageAds";
import {
  captureCompetitorScreenshotTiles,
  type CompetitorScreenshotTile,
} from "./competitorScreenshots";

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
  /** True when the competitor HTML includes a visible lead/contact form. */
  hasForm: boolean;
  /** Field labels / names detected on forms. */
  formFields: string[];
  /** Real header nav labels from the competitor page (not section headlines). */
  navLinks: Array<{ label: string; href: string }>;
  /** Real footer link labels from the competitor page. */
  footerLinks: Array<{ label: string; href: string }>;
  headerCta: { label: string; href: string } | null;
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

/** Brand + product + tagline mashed into one run-on title (common in <title>/OG). */
export function looksLikeMashedHeadline(text: string): boolean {
  const t = normalizeText(text);
  if (!t) return false;
  const parts = t.split(/\s*[|·•\/—–]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return true;
  const words = t.split(/\s+/);
  if (words.length < 8) return false;
  if (/[.?!]/.test(t) && words.length <= 18) return false;
  const titleCase = words.filter((w) =>
    /^[A-Z][a-z0-9'’]*$/.test(w) || /^[A-Z]{2,}$/.test(w) || /^[A-Z][a-z]+[A-Z]/.test(w),
  ).length;
  // "Billy Polsons Campaign Brain Actual Intelligence X AI Turbocharged"
  if (titleCase >= 6 && words.length >= 8 && !/[,:;]/.test(t)) return true;
  if (words.length > 16 && !/[.?!]/.test(t)) return true;
  return false;
}

/** Prefer a single clear phrase when titles use | / · separators. */
export function demashHeadline(text: string): string {
  const t = normalizeText(text);
  const parts = t
    .split(/\s*[|·•\/—–]\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 8 && !looksLikeNavJunk(p));
  if (parts.length < 2) return t;
  const scored = parts.map((p) => {
    let score = Math.min(p.length, 72) / 12;
    if (/\b(your|hate|stop|get|free|how|why|save|grow|book|ads|agency)\b/i.test(p)) {
      score += 8;
    }
    if (looksLikeMashedHeadline(p)) score -= 6;
    if (/^[A-Z][a-z]+(\s+[A-Z][a-z]+){0,2}$/.test(p) && p.split(/\s+/).length <= 3) {
      score -= 2; // brand-only fragment
    }
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.p || t;
}

function scoreHeroCandidate(text: string): number {
  const t = normalizeText(text);
  if (!t) return -100;
  let score = 10;
  if (looksLikeMashedHeadline(t)) score -= 25;
  const words = t.split(/\s+/).length;
  if (words >= 4 && words <= 16) score += 8;
  if (words > 18) score -= 10;
  if (/\b(your|hate|stop|get|free|how|why|agency|ads|save|grow)\b/i.test(t)) score += 6;
  if (/campaign brain|actual intelligence|turbocharged/i.test(t) && words >= 8) score -= 8;
  return score;
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
  const pushHero = (raw: string, opts?: { allowMashed?: boolean }) => {
    let t = normalizeText(raw);
    if (!t || t.length < 8 || t.length > 180) return;
    if (looksLikeNavJunk(t)) return;
    if (looksLikeMashedHeadline(t)) {
      const demashed = demashHeadline(t);
      if (demashed !== t && demashed.length >= 8) {
        t = demashed;
      } else if (!opts?.allowMashed) {
        return;
      }
    }
    if (heroCandidates.some((h) => h.toLowerCase() === t.toLowerCase())) return;
    heroCandidates.push(t);
  };

  $("h1").each((_, el) => pushHero($(el).text()));
  $(
    "[class*='hero'] h2, [class*='Hero'] h2, [class*='banner'] h2, [class*='jumbotron'] h2, header h2, [class*='hero'] [class*='title'], [class*='Hero'] [class*='title'], [class*='headline'], [data-testid*='headline'], [class*='Hero'] p, [class*='hero'] p",
  ).each((_, el) => {
    const t = normalizeText($(el).text());
    // Only treat short hero paragraphs as headline candidates
    if (t.split(/\s+/).length <= 18) pushHero(t);
  });
  // Meta titles last — often mashed brand strings; demash or skip
  if (ogTitle) pushHero(ogTitle, { allowMashed: true });
  if (title && title.length >= 8 && title.length <= 140) {
    pushHero(title, { allowMashed: true });
  }
  heroCandidates.sort((a, b) => scoreHeroCandidate(b) - scoreHeroCandidate(a));

  const headingOutline: PageOutline["headingOutline"] = [];
  const pushHeading = (level: number, textRaw: string, snippetRaw = "") => {
    const text = normalizeText(textRaw);
    if (!text || text.length < 3 || looksLikeNavJunk(text)) return;
    if (headingOutline.some((h) => h.text.toLowerCase() === text.toLowerCase())) return;
    headingOutline.push({
      level,
      text,
      snippet: normalizeText(snippetRaw).slice(0, 360),
    });
  };

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

    pushHeading(level, text, bits.slice(0, 2).join(" "));
  });

  // Landmark / section blocks without semantic headings (Webflow / funnels)
  $("main section, [role='main'] section, section[class], [class*='section']").each((_, el) => {
    if (headingOutline.length >= 24) return false;
    const $el = $(el);
    if ($el.closest("nav, footer").length) return;
    const heading = normalizeText(
      $el.find("h1, h2, h3, [class*='heading'], [class*='title']").first().text(),
    );
    if (!heading || heading.length < 4) return;
    const snippet = normalizeText($el.find("p, li").first().text());
    pushHeading(2, heading, snippet);
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

  const formFields: string[] = [];
  const pushFormField = (raw: string) => {
    const t = normalizeText(raw);
    if (!t || t.length < 2 || t.length > 60) return;
    if (/submit|send|captcha|token|honeypot|csrf/i.test(t)) return;
    if (formFields.some((f) => f.toLowerCase() === t.toLowerCase())) return;
    formFields.push(t);
  };
  $("form").each((_, form) => {
    const $form = $(form);
    if ($form.closest("nav, footer").length && $form.find("input:not([type='hidden']), textarea, select").length < 2) {
      return;
    }
    $form.find("label").each((__, label) => pushFormField($(label).text()));
    $form.find("input, textarea, select").each((__, field) => {
      const $field = $(field);
      const type = (($field.attr("type") || "") as string).toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" || type === "image") return;
      pushFormField(
        $field.attr("placeholder") ||
          $field.attr("aria-label") ||
          $field.attr("name") ||
          $field.attr("id") ||
          "",
      );
    });
  });
  const hasForm =
    $("form").filter((_, form) => {
      const $form = $(form);
      return $form.find("input:not([type='hidden']), textarea, select").length >= 2;
    }).length > 0 || formFields.length >= 2;

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

  // Recover outline from marked plain text when DOM headings were sparse
  if (headingOutline.length < 4) {
    const markerRe = /\[(H[1-3])\]\s*([^\n]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = markerRe.exec(plain)) && headingOutline.length < 30) {
      const level = Number(match[1].replace(/\D/g, "")) || 2;
      pushHeading(level, match[2]);
    }
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

  // Prefer chrome harvested before script stripping — re-parse original HTML for nav/footer.
  const chrome = extractCompetitorChromeFromHtml(html);

  return {
    title,
    ogTitle,
    metaDescription,
    heroCandidates: heroCandidates.slice(0, 6),
    headingOutline: headingOutline.slice(0, 40),
    ctas: ctas.slice(0, 12),
    hasForm: hasForm || chrome.hasForm,
    formFields: (formFields.length ? formFields : chrome.formFields).slice(0, 10),
    navLinks: chrome.navLinks,
    footerLinks: chrome.footerLinks,
    headerCta: chrome.headerCta,
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
- offer.headline MUST be the main on-page hero promise — prefer the first clear H1 / best heroCandidate. Copy it closely (fix typos only). NEVER concatenate brand name + product name + tagline into one run-on string. NEVER use the adHeadline as offer.headline when page hero candidates exist. One sentence or short phrase only (ideally ≤16 words).
- adHeadline/adBody are ad creatives for context only — they are NOT the landing-page headline unless the page truly has no hero text.
- offer.primaryOffer = what the visitor gets (product/service), not the headline restated awkwardly.
- offer.cta = the primary button label from ctas[] when possible.
- pageArchitecture.sections MUST cover the full page top-to-bottom using headingOutline as the map. Include typically: Hero, Problem/Agitation (if present), Solution/Features, Social proof, Offer/Pricing, How it works, FAQ, Final CTA, Footer (if meaningful). Aim for 5–12 sections when the page has that much content. Do NOT stop after Hero. If headingOutline is short, still infer distinct blocks from pageText (problem, benefits, proof, CTA).
- Each section name should be human (e.g. "Hero", "Features", "Testimonials") — not raw H1 text dumped as the only section.
- Be evidence-based. If pricing/CTA is unclear, use null. Do not invent.
- Return a single JSON object only.`;
}

export function pickBestHeadline(
  llmHeadline: string | null | undefined,
  outline: PageOutline,
  adHeadline?: string | null,
): string | null {
  const ranked = [...outline.heroCandidates]
    .map((c) => demashHeadline(c))
    .filter((c) => c.length >= 8 && !looksLikeNavJunk(c))
    .sort((a, b) => scoreHeroCandidate(b) - scoreHeroCandidate(a));

  const llm = demashHeadline((llmHeadline || "").replace(/\s+/g, " ").trim());
  const ad = demashHeadline((adHeadline || "").replace(/\s+/g, " ").trim());

  const usable = (value: string) => {
    if (!value || value.length < 8) return false;
    if (looksLikeMashedHeadline(value)) return false;
    const words = value.split(/\s+/).length;
    if (words > 22) return false;
    // Reject LLM mash that embeds multiple outline fragments
    const hits = outline.heroCandidates.filter(
      (c) =>
        c.length >= 8 &&
        value.toLowerCase().includes(c.toLowerCase()) &&
        value.length > c.length * 1.35,
    ).length;
    if (hits >= 2) return false;
    return true;
  };

  if (llm && usable(llm)) {
    // Prefer page hero over LLM when LLM mostly restates a weaker mashed title
    if (ranked[0] && scoreHeroCandidate(ranked[0]) > scoreHeroCandidate(llm) + 4) {
      return ranked[0];
    }
    return llm;
  }

  if (ranked[0] && usable(ranked[0])) return ranked[0];

  // Prefer a clean meta-description lead over a mashed <title> string
  const metaLead = (outline.metaDescription || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .find((s) => s.length >= 12 && s.length <= 120);
  if (metaLead && usable(metaLead)) return metaLead;

  if (ranked[0] && !looksLikeMashedHeadline(ranked[0])) return ranked[0];

  // Ad creative only as last resort when the page had no hero text
  if (ad && usable(ad) && outline.heroCandidates.length === 0) return ad;

  const og = outline.ogTitle ? demashHeadline(outline.ogTitle) : null;
  if (og && usable(og)) return og;
  // Still better to show a demashed/mashed page title than invent nothing when that is all we have
  if (ranked[0]) return ranked[0];
  return null;
}

export function ensureArchitectureSections(
  sections: z.infer<typeof analysisSchema>["pageArchitecture"]["sections"],
  outline: PageOutline,
): z.infer<typeof analysisSchema>["pageArchitecture"]["sections"] {
  if (sections.length >= 5) return sections;

  const nameFor = (text: string, index: number) => {
    if (index === 0) return "Hero";
    if (/faq|question/i.test(text)) return "FAQ";
    if (/price|pricing|plan|cost/i.test(text)) return "Pricing";
    if (/testimonial|review|client|customer|proof|logo/i.test(text)) return "Social proof";
    if (/how|step|process|work/i.test(text)) return "How it works";
    if (/feature|benefit|why|solution|system/i.test(text)) return "Features";
    if (/problem|pain|struggle|without|hate/i.test(text)) return "Problem";
    if (/cta|get started|book|demo|call|sign/i.test(text)) return "Final CTA";
    return text.slice(0, 48);
  };

  // Prefer h1/h2; include h3 when the outline is sparse
  let headings = outline.headingOutline.filter((h) => h.level <= 2);
  if (headings.length < 4) {
    headings = outline.headingOutline.slice(0, 14);
  }

  const synthesized = headings.slice(0, 12).map((h, i) => ({
    name: nameFor(h.text, i),
    purpose: `Present: ${h.text}`,
    summary: h.snippet || h.text,
    keyElements: [h.text].filter(Boolean),
  }));

  // Infer extra blocks from plain text when still Hero-only
  if (synthesized.length < 4 && outline.plainText.length > 400) {
    const extras: Array<{ name: string; purpose: string; summary: string; keyElements: string[] }> = [];
    const text = outline.plainText;
    if (/testimonial|review|client|customer|"[^"]{20,}"/i.test(text)) {
      extras.push({
        name: "Social proof",
        purpose: "Build trust with proof",
        summary: "Page includes social proof or customer language.",
        keyElements: ["Social proof"],
      });
    }
    if (/faq|frequently asked|questions?/i.test(text)) {
      extras.push({
        name: "FAQ",
        purpose: "Answer objections",
        summary: "Page includes FAQ-style content.",
        keyElements: ["FAQ"],
      });
    }
    if (outline.ctas.length) {
      extras.push({
        name: "Final CTA",
        purpose: "Convert the visitor",
        summary: `Primary CTA candidates: ${outline.ctas.slice(0, 3).join(", ")}`,
        keyElements: outline.ctas.slice(0, 3),
      });
    }
    if (/feature|benefit|how it works|24\/7|ai-|system/i.test(text)) {
      extras.push({
        name: "Features",
        purpose: "Explain the solution",
        summary: "Page describes product capabilities or benefits.",
        keyElements: ["Features"],
      });
    }
    const base =
      synthesized.length > 0
        ? synthesized
        : [
            {
              name: "Hero",
              purpose: "Introduce the offer and capture attention",
              summary: outline.heroCandidates[0] || outline.metaDescription || "Hero",
              keyElements: outline.heroCandidates.slice(0, 2),
            },
          ];
    const merged = [...base];
    for (const extra of extras) {
      if (!merged.some((s) => s.name === extra.name)) merged.push(extra);
    }
    if (merged.length > sections.length) return merged.slice(0, 12);
  }

  if (synthesized.length > sections.length) return synthesized;
  return sections;
}

async function analyzeWithLlm(input: {
  url: string;
  outline: PageOutline;
  adTitle?: string;
  adBody?: string;
  platform?: string;
  screenshots?: CompetitorScreenshotTile[];
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
    hasScreenshots: Boolean(input.screenshots?.length),
    instructions: {
      headline:
        "Prefer the H1 / hero text visible in the screenshot and heroCandidates. Do NOT concatenate brand+product+tagline. Do NOT copy adHeadline unless the page has no hero text.",
      cta: "primaryOffer.cta must match the primary CTA button text visible in the fold screenshot / primaryCtas (e.g. Book a strategy call) — not a different lead magnet.",
      architecture:
        "Map EVERY major visible band from the screenshots + headingOutline into sections (5–12 typical). Never return only Hero. Use screenshot section rhythm when headings are sparse.",
    },
  };
  const userText = JSON.stringify(userPayload, null, 2);
  const shots = (input.screenshots || []).slice(0, 2);

  let raw: string | null = null;

  // Offers / page offer extraction: OpenRouter OpenAI first (vision when screenshots exist).
  // Avoids burning direct platform.openai.com credits.
  if (hasOpenRouterKey()) {
    try {
      const client = getOpenRouterClient();
      const userContent: Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      > = [{ type: "text", text: userText }];
      for (const shot of shots) {
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:${shot.mediaType};base64,${shot.data}`,
          },
        });
      }
      const completion = await client.chat.completions.create({
        model: resolveOpenAICompatModel(
          process.env.OFFERS_OPENAI_MODEL?.trim() || OPENROUTER_FAST_MODEL,
        ),
        temperature: 0.15,
        max_tokens: 6000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      });
      raw = completion.choices[0]?.message?.content?.trim() || null;
    } catch (err) {
      if (isCreditError(err)) throw err;
      console.error("[page-analysis] OpenRouter OpenAI failed, falling back", err);
    }
  }

  // Prefer Claude when available — stronger at long structured extraction + vision
  if (!raw && process.env.ANTHROPIC_API_KEY) {
    try {
      const client = getAnthropicClient();
      const content: Array<
        | { type: "text"; text: string }
        | {
            type: "image";
            source: {
              type: "base64";
              media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
              data: string;
            };
          }
      > = [];
      for (const shot of shots) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: shot.mediaType,
            data: shot.data,
          },
        });
      }
      content.push({
        type: "text",
        text: shots.length
          ? `${userText}\n\nUse the attached screenshots to verify headline, primary CTA, and section architecture.`
          : userText,
      });
      const completion = await client.messages.create({
        model: getAnthropicModel(),
        max_tokens: 6000,
        temperature: 0.15,
        system,
        messages: [{ role: "user", content }],
      });
      raw = completion.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n")
        .trim();
    } catch (err) {
      if (isCreditError(err)) throw err;
      console.error("[page-analysis] Anthropic failed, falling back", err);
    }
  }

  if (!raw && hasOpenRouterKey()) {
    try {
      const client = getOpenRouterClient();
      const completion = await client.chat.completions.create({
        model: OPENROUTER_PERPLEXITY_MODEL,
        temperature: 0.15,
        max_tokens: 6000,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userText },
        ],
      });
      raw = completion.choices[0]?.message?.content?.trim() || "";
    } catch (err) {
      if (isCreditError(err)) throw err;
      console.error("[page-analysis] OpenRouter Perplexity failed", err);
    }
  }

  if (!raw) {
    console.error("[page-analysis] no model response", {
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
      openrouter: hasOpenRouterKey(),
    });
    throw new Error(
      "Landing-page analysis could not get a response. Try again, or contact your administrator if this keeps happening.",
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
    data.pageArchitecture.sections.length < 5 &&
    (input.outline.headingOutline.length >= 2 ||
      input.outline.plainText.length >= 500)
  ) {
    const expandSystem = `Expand landing-page architecture into 5–12 ordered sections from the heading outline and page evidence. Never return only Hero. Return ONLY JSON: { "sections": [{ "name", "purpose", "summary", "keyElements": string[] }] }`;
    const expandUser = JSON.stringify(
      {
        headingOutline: input.outline.headingOutline,
        heroCandidates: input.outline.heroCandidates,
        primaryCtas: input.outline.ctas,
        pageTextExcerpt: input.outline.plainText.slice(0, 8_000),
        existingSections: data.pageArchitecture.sections,
      },
      null,
      2,
    );
    try {
      let content = "";
      if (process.env.ANTHROPIC_API_KEY) {
        const client = getAnthropicClient();
        const completion = await client.messages.create({
          model: getAnthropicModel(),
          max_tokens: 3500,
          temperature: 0.1,
          system: expandSystem,
          messages: [{ role: "user", content: expandUser }],
        });
        content = completion.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("\n");
      } else if (hasOpenRouterKey()) {
        const client = getOpenRouterClient();
        const completion = await client.chat.completions.create({
          model: OPENROUTER_FAST_MODEL,
          temperature: 0.1,
          max_tokens: 3500,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: expandSystem },
            { role: "user", content: expandUser },
          ],
        });
        content = completion.choices[0]?.message?.content || "";
      }
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
      if (isCreditError(err)) throw err;
      console.warn("[page-analysis] architecture expansion failed", err);
    }
  }

  const headline = pickBestHeadline(
    data.offer.headline,
    input.outline,
    input.adTitle,
  );
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

    // Enrich thin/JS-rendered pages with ad creative for offer context only.
    // Do NOT seed heroCandidates from the ad — that caused headline mismatches.
    const adBits = [ad.title, ad.body].filter(Boolean).join("\n");
    if (outlineSignalLength(outline) < 120 && adBits.length >= 40) {
      outline = {
        ...outline,
        plainText: `${outline.plainText}\n\nAd creative context (not the page headline):\n${adBits}`.slice(
          0,
          MAX_TEXT_CHARS,
        ),
      };
    }

    if (outlineSignalLength(outline) < 40) {
      throw new Error(
        "Landing page returned too little readable text to analyze (likely a JavaScript-only page). Try another ad destination URL.",
      );
    }

    const screenshots = await captureCompetitorScreenshotTiles(page.finalUrl);
    const llm = await analyzeWithLlm({
      url: page.finalUrl,
      outline,
      adTitle: ad.title,
      adBody: ad.body,
      screenshots: screenshots.tiles,
    });
    if (screenshots.warnings.length) {
      console.warn("[page-analysis] screenshot warnings", screenshots.warnings.slice(0, 3));
    }

    let sameLandingPageAds = null;
    try {
      const siblings = getLookupAds(ad.lookupId);
      sameLandingPageAds = await collectSameLandingPageAdsFromLookup({
        ad,
        siblings,
        analyzedUrl: page.finalUrl,
        pageOffer: llm.offer?.primaryOffer,
      });
    } catch (err) {
      console.warn("[page-analysis] same-LP ads (lookup) failed", err);
    }

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
      sameLandingPageAds,
    };

    const updated = updateLookupAd(adId, { pageAnalysis: analysis });
    if (!updated) throw new Error("Failed to save page analysis");
    return updated;
  } catch (err) {
    const message =
      maskClientFacingText(err instanceof Error ? err.message : String(err)) ||
      "Analysis failed";
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
        plainText: `${outline.plainText}\n\nAd creative context (not the page headline):\n${adBits}`.slice(
          0,
          MAX_TEXT_CHARS,
        ),
      };
    }

    if (outlineSignalLength(outline) < 40) {
      throw new Error(
        "Landing page returned too little readable text to analyze (likely a JavaScript-only page). Try another ad destination URL.",
      );
    }

    const screenshots = await captureCompetitorScreenshotTiles(page.finalUrl);
    const llm = await analyzeWithLlm({
      url: page.finalUrl,
      outline,
      adTitle: competitor.sampleAd?.title,
      adBody: competitor.sampleAd?.body,
      platform: String(competitor.platform || "facebook"),
      screenshots: screenshots.tiles,
    });
    if (screenshots.warnings.length) {
      console.warn("[page-analysis] screenshot warnings", screenshots.warnings.slice(0, 3));
    }

    let sameLandingPageAds = null;
    try {
      const job = getJob(competitor.runId);
      const cachedAds = getSearchCompetitorAdsByCompetitor(
        competitor.runId,
        competitor.id,
      );
      const offersDone = job?.offersReport?.status === "completed";
      if (offersDone && cachedAds.length > 0) {
        sameLandingPageAds = await collectSameLandingPageAdsFromSearchCache({
          competitor,
          cachedAds,
          analyzedUrl: page.finalUrl,
          pageOffer: llm.offer?.primaryOffer,
        });
      } else {
        sameLandingPageAds = await collectSameLandingPageAds({
          competitor,
          analyzedUrl: page.finalUrl,
          pageOffer: llm.offer?.primaryOffer,
        });
      }
    } catch (err) {
      console.warn("[page-analysis] same-LP ads failed", err);
    }

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
      sameLandingPageAds,
    };

    const updated = updateCompetitor(competitorId, { pageAnalysis: analysis });
    if (!updated) throw new Error("Failed to save page analysis");

    // Deep location runs here (not during keyword search accept)
    try {
      const job = getJob(competitor.runId);
      await enrichCompetitorDeepLocation({
        competitorId,
        pageName: competitor.pageName,
        website:
          competitor.brand?.website ||
          competitor.sampleAd?.landingPageUrl ||
          page.finalUrl,
        facebookUrl: competitor.brand?.facebookUrl,
        linkedinUrl: competitor.brand?.linkedinUrl,
        geoMode: job?.geoMode || "countrywide",
        targetLocations: job?.targetLocations || [],
        provisional: {
          locationLabel: competitor.locationLabel ?? null,
          locationCity: competitor.locationCity ?? null,
          locationSuburb: competitor.locationSuburb ?? null,
          locationCountry: competitor.locationCountry ?? null,
          locationStatus: competitor.locationStatus || "unknown",
          locationSource: competitor.locationSource || "none",
        },
      });
    } catch (err) {
      console.warn("[page-analysis] location enrich failed", err);
    }

    return getCompetitor(competitorId) || updated;
  } catch (err) {
    const message =
      maskClientFacingText(err instanceof Error ? err.message : String(err)) ||
      "Analysis failed";
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
