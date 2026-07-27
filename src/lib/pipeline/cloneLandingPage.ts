import * as cheerio from "cheerio";
import type { BrandColors, BusinessProfile } from "../types";
import { fetchRawLandingHtml } from "./htmlFetch";
import {
  fetchBrandSiteAssets,
  type BrandSiteAssets,
} from "./brandAssets";
import { collectCompetitorBrandColors } from "./brandColors";
import { applyBrandSiteAssets } from "./applyBrandAssets";
import { sanitizeCompetitorIdentity } from "./sanitizeCompetitorIdentity";
import {
  extractPageSections,
  rewriteSectionsWithClaude,
} from "./sectionRewrite";
import {
  applyFromToReplacements,
  repairFailingCopyWithClaude,
  validateRecreatedHtml,
} from "./validateRecreation";
import {
  getAnthropicClient,
  getAnthropicModel,
} from "../anthropic/client";

const TEXT_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "a",
  "button",
  "label",
  "span",
  "strong",
  "em",
  "small",
  "figcaption",
  "td",
  "th",
  "blockquote",
  "dt",
  "dd",
  "summary",
  "legend",
]);

const SKIP_PARENTS = new Set(["script", "style", "noscript", "svg", "code", "pre"]);

function absolutize(baseUrl: string, value: string): string {
  const v = value.trim();
  if (!v || v.startsWith("data:") || v.startsWith("mailto:") || v.startsWith("tel:") || v.startsWith("#") || v.startsWith("javascript:")) {
    return v;
  }
  try {
    return new URL(v, baseUrl).toString();
  } catch {
    return v;
  }
}

function normalizeText(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

function isRewritableText(t: string): boolean {
  const s = normalizeText(t);
  if (s.length < 2 || s.length > 400) return false;
  if (/^[\d\s.,:%$€£+\-–—/|]+$/.test(s)) return false;
  if (/^(https?:|www\.|mailto:)/i.test(s)) return false;
  // Skip pure icon fonts / single glyphs
  if (s.length <= 2 && !/[a-zA-Z]{2}/.test(s)) return false;
  return /[a-zA-Z]/.test(s);
}

/**
 * Clean competitor HTML for safe iframe preview while keeping layout/CSS/images.
 */
export function prepareCompetitorHtml(html: string, baseUrl: string): string {
  const $ = cheerio.load(html);

  $("script, noscript, iframe, object, embed").remove();
  $("[onclick], [onload], [onerror], [onmouseover]").each((_, el) => {
    const attribs = (el as { attribs?: Record<string, string> }).attribs || {};
    for (const key of Object.keys(attribs)) {
      if (key.toLowerCase().startsWith("on")) $(el).removeAttr(key);
    }
  });

  $("a[href], link[href], img[src], source[src], video[poster], use[href]").each(
    (_, el) => {
      const $el = $(el);
      for (const attr of ["href", "src", "poster"] as const) {
        const val = $el.attr(attr);
        if (val) $el.attr(attr, absolutize(baseUrl, val));
      }
      const srcset = $el.attr("srcset");
      if (srcset) {
        const next = srcset
          .split(",")
          .map((part) => {
            const [u, d] = part.trim().split(/\s+/);
            if (!u) return part.trim();
            return d ? `${absolutize(baseUrl, u)} ${d}` : absolutize(baseUrl, u);
          })
          .join(", ");
        $el.attr("srcset", next);
      }
    },
  );

  // Absolutize url(...) in inline style attributes
  $("[style]").each((_, el) => {
    const style = $(el).attr("style");
    if (!style || !/url\(/i.test(style)) return;
    $(el).attr(
      "style",
      style.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (_m, _q, u) => {
        return `url("${absolutize(baseUrl, u)}")`;
      }),
    );
  });

  // Prefer opening CTAs in same tab preview
  $("a[target]").attr("target", "_blank");
  $("a[href]").attr("rel", "noopener noreferrer");

  if (!$("base").length) {
    $("head").prepend(`<base href="${baseUrl}">`);
  }

  return $.html();
}

type TextItem = {
  id: string;
  tag: string;
  text: string;
};

export function extractRewritableTexts(html: string): TextItem[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const items: TextItem[] = [];
  let i = 0;

  $("*").each((_, el) => {
    const tag = ((el as { tagName?: string }).tagName || "").toLowerCase();
    if (!TEXT_TAGS.has(tag)) return;
    if (
      $(el)
        .parents()
        .toArray()
        .some((p) =>
          SKIP_PARENTS.has(((p as { tagName?: string }).tagName || "").toLowerCase()),
        )
    ) {
      return;
    }

    // Prefer leaf-ish text: if element has element children that also are text tags, skip deep nesting duplicates by only taking direct text when short
    const direct = normalizeText(
      $(el)
        .contents()
        .filter((_, node) => node.type === "text")
        .text(),
    );

    const candidates: string[] = [];
    if (isRewritableText(direct)) candidates.push(direct);
    else if (tag.startsWith("h") || tag === "button" || tag === "a" || tag === "label") {
      const full = normalizeText($(el).text());
      if (isRewritableText(full) && full.length <= 180) candidates.push(full);
    }

    const title = $(el).attr("title");
    const aria = $(el).attr("aria-label");
    const alt = tag === "img" ? $(el).attr("alt") : undefined;
    for (const extra of [title, aria, alt]) {
      if (extra && isRewritableText(extra)) candidates.push(normalizeText(extra));
    }

    for (const text of candidates) {
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ id: `t${i++}`, tag, text });
    }
  });

  // Prioritize headings / CTAs
  const rank = (t: TextItem) => {
    if (t.tag === "h1") return 0;
    if (t.tag === "h2") return 1;
    if (t.tag === "button") return 2;
    if (t.tag.startsWith("h")) return 3;
    if (t.tag === "a") return 4;
    if (t.tag === "p") return 5;
    return 6;
  };
  items.sort((a, b) => rank(a) - rank(b) || a.text.length - b.text.length);

  return items.slice(0, 180);
}

async function rewriteTextsWithLlm(input: {
  texts: TextItem[];
  keyword: string;
  competitorName: string;
  brandName: string;
  businessUrl: string;
  profile: BusinessProfile | null;
  userFeedback?: string | null;
}): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (input.texts.length === 0) return map;

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is required for landing-page recreation. Add it to .env.local.",
    );
  }

  const batches: TextItem[][] = [];
  for (let i = 0; i < input.texts.length; i += 40) {
    batches.push(input.texts.slice(i, i + 40));
  }

  const feedbackBlock = input.userFeedback?.trim()
    ? `
10) HIGHEST PRIORITY — apply this USER FEEDBACK when rewriting (tone, offers, CTAs, what to emphasize or remove):
"""
${input.userFeedback.trim().slice(0, 2000)}
"""
`
    : "";

  const system = `You are a conversion copywriter creating ORIGINAL landing-page copy for a NEW brand.
The HTML layout comes from a competitor for structure only. Your job is to make the wording clearly different and legally safer.

Return ONLY valid JSON:
{ "replacements": [ { "id": "t0", "text": "new copy" }, ... ] }

Hard rules:
1) Do NOT paraphrase lightly. Rewrite with new angles, hooks, and phrasing (aim for <40% lexical overlap with the source string).
2) NEVER keep the competitor brand name, mascots, celebrity/endorser names, or their phone numbers.
3) Use the USER brand name (${input.brandName}) and their offerings/industry.
4) Incorporate the search KEYWORD naturally in headlines and key hooks: "${input.keyword}".
5) Keep similar length (±35%) so the layout does not break.
6) Preserve role: headline stays headline-like, CTA stays CTA-like, FAQ stays FAQ-like.
7) Do not invent regulated guarantees, fake reviews, or celebrity endorsements.
8) For testimonial-like lines, write generic benefit statements for ${input.brandName} — never named third-party endorsers.
9) English only. No markdown.${feedbackBlock}`;

  const client = getAnthropicClient();
  const model = getAnthropicModel();

  for (const batch of batches) {
    const user = JSON.stringify(
      {
        keyword: input.keyword,
        competitorNameToAvoid: input.competitorName,
        userFeedback: input.userFeedback?.trim() || null,
        userBrand: {
          name: input.brandName,
          url: input.businessUrl,
          industry: input.profile?.industry || null,
          description: input.profile?.description || null,
          offerings: input.profile?.offerings || [],
          audience: input.profile?.targetAudience || null,
          positioning: input.profile?.positioningSummary || null,
        },
        strings: batch.map((t) => ({ id: t.id, tag: t.tag, text: t.text })),
      },
      null,
      2,
    );

    try {
      const completion = await client.messages.create({
        model,
        max_tokens: 4500,
        temperature: 0.7,
        system,
        messages: [{ role: "user", content: user }],
      });

      const content = completion.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n")
        .trim();

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;
      const parsed = JSON.parse(jsonMatch[0]) as {
        replacements?: Array<{ id?: string; text?: string }>;
      };
      for (const row of parsed.replacements || []) {
        if (row.id && typeof row.text === "string" && row.text.trim()) {
          let text = normalizeText(row.text);
          if (input.competitorName.length > 2) {
            text = text.replace(
              new RegExp(
                input.competitorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                "gi",
              ),
              input.brandName,
            );
          }
          map.set(row.id, text);
        }
      }
    } catch (err) {
      console.error("[clone] Claude rewrite batch failed", err);
    }
  }

  return map;
}

/**
 * After the main rewrite, apply explicit user feedback to current headlines/CTAs.
 */
async function applyUserFeedbackPass(input: {
  html: string;
  userFeedback: string;
  keyword: string;
  competitorName: string;
  brandName: string;
  businessUrl: string;
}): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const feedback = input.userFeedback.trim();
  if (!feedback) return map;

  const texts = extractRewritableTexts(input.html)
    .filter(
      (t) =>
        t.tag === "h1" ||
        t.tag === "h2" ||
        t.tag === "h3" ||
        t.tag === "p" ||
        t.tag === "button" ||
        t.tag === "a",
    )
    .slice(0, 60);
  if (!texts.length) return map;

  const client = getAnthropicClient();
  const model = getAnthropicModel();
  const system = `You revise landing-page copy to satisfy USER FEEDBACK.
Return ONLY JSON: { "replacements": [ { "id": "t0", "text": "revised copy" }, ... ] }

Rules:
- Prioritize the feedback over keeping prior wording.
- Only change strings that need to change to meet the feedback; others can stay close.
- Never mention competitor "${input.competitorName}".
- Keep brand "${input.brandName}" and keyword "${input.keyword}" where natural.
- Keep similar length (±40%). English only.`;

  try {
    const completion = await client.messages.create({
      model,
      max_tokens: 4500,
      temperature: 0.65,
      system,
      messages: [
        {
          role: "user",
          content: JSON.stringify(
            {
              userFeedback: feedback.slice(0, 2000),
              brand: input.brandName,
              url: input.businessUrl,
              keyword: input.keyword,
              strings: texts.map((t) => ({ id: t.id, tag: t.tag, text: t.text })),
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
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return map;
    const parsed = JSON.parse(jsonMatch[0]) as {
      replacements?: Array<{ id?: string; text?: string }>;
    };
    for (const row of parsed.replacements || []) {
      if (row.id && row.text?.trim()) {
        const item = texts.find((t) => t.id === row.id);
        if (item) map.set(item.text, normalizeText(row.text));
      }
    }
  } catch (err) {
    console.error("[clone] feedback pass failed", err);
  }
  return map;
}

function applyTextReplacements(
  html: string,
  texts: TextItem[],
  replacements: Map<string, string>,
  competitorName: string,
  brandName: string,
): string {
  const $ = cheerio.load(html);
  const pairs = texts
    .map((t) => ({
      from: t.text,
      to: replacements.get(t.id) || t.text,
    }))
    .filter((p) => p.from && p.to && p.from !== p.to)
    .sort((a, b) => b.from.length - a.from.length);

  const replaceInString = (value: string): string => {
    let next = value;
    for (const { from, to } of pairs) {
      if (next.includes(from)) next = next.split(from).join(to);
    }
    if (competitorName && brandName && competitorName.length > 2) {
      const re = new RegExp(
        competitorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "gi",
      );
      next = next.replace(re, brandName);
    }
    return next;
  };

  const walk = (nodes: ReturnType<typeof $>) => {
    nodes.each((_, node) => {
      if (node.type === "text") {
        const raw = (node as { data?: string }).data || "";
        const next = replaceInString(raw);
        if (next !== raw) (node as { data?: string }).data = next;
        return;
      }
      if (node.type === "tag") {
        const tag = ((node as { tagName?: string }).tagName || "").toLowerCase();
        if (SKIP_PARENTS.has(tag)) return;
        for (const attr of ["title", "aria-label", "alt", "placeholder"]) {
          const val = $(node).attr(attr);
          if (val) {
            const next = replaceInString(val);
            if (next !== val) $(node).attr(attr, next);
          }
        }
        walk($(node).contents());
      }
    });
  };

  walk($.root().contents());
  return $.html();
}

function collectHexColors(html: string): string[] {
  // kept for any residual callers — prefer collectCompetitorBrandColors
  return collectCompetitorBrandColors(html);
}

function replaceColorEverywhere(html: string, fromHex: string, toHex: string): string {
  const from = fromHex.toUpperCase();
  const to = toHex.toUpperCase();
  if (from === to) return html;

  let out = html;
  out = out.replace(new RegExp(from, "gi"), to);

  const r = parseInt(from.slice(1, 3), 16);
  const g = parseInt(from.slice(3, 5), 16);
  const b = parseInt(from.slice(5, 7), 16);
  const tr = parseInt(to.slice(1, 3), 16);
  const tg = parseInt(to.slice(3, 5), 16);
  const tb = parseInt(to.slice(5, 7), 16);
  const rgbRe = new RegExp(
    `rgba?\\(\\s*${r}\\s*,\\s*${g}\\s*,\\s*${b}(\\s*,\\s*[\\d.]+)?\\s*\\)`,
    "gi",
  );
  out = out.replace(rgbRe, (_m, a) =>
    a ? `rgba(${tr}, ${tg}, ${tb}${a})` : `rgb(${tr}, ${tg}, ${tb})`,
  );
  return out;
}

/**
 * Force the cloned page onto the user's brand palette.
 * 1) Remap dominant competitor hex/rgb colors → user primary/secondary/accent
 * 2) Inject a strong CSS overlay (beats most external competitor stylesheets)
 */
export function remapBrandColors(html: string, colors: BrandColors): string {
  const competitorColors = collectCompetitorBrandColors(html);
  let out = html;

  const targets = [colors.primary, colors.secondary, colors.accent].map((c) =>
    c.toUpperCase(),
  );

  competitorColors.forEach((comp, i) => {
    const target = targets[Math.min(i, targets.length - 1)];
    out = replaceColorEverywhere(out, comp, target);
  });

  // Rewrite common CSS variables inline if present
  out = out.replace(
    /(--[\w-]*(?:primary|brand|accent|main|secondary|cta|button|theme)[\w-]*)\s*:\s*([^;!}{]+)/gi,
    (full, name: string) => {
      const lower = name.toLowerCase();
      if (/accent|cta|secondary/.test(lower) && /accent|cta/.test(lower)) {
        return `${name}: ${colors.accent}`;
      }
      if (/secondary/.test(lower)) return `${name}: ${colors.secondary}`;
      return `${name}: ${colors.primary}`;
    },
  );

  // Drop remote stylesheets that fight the brand overlay (keep fonts/icon CDNs)
  out = out.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*["']stylesheet["']/i.test(tag)) return tag;
    if (
      /fonts\.googleapis|fonts\.gstatic|fontawesome|cdnjs\.cloudflare|unpkg\.com|jsdelivr\.net|use\.typekit/i.test(
        tag,
      )
    ) {
      return tag;
    }
    return `<!-- adrival: removed competing stylesheet -->`;
  });

  const overlay = `
<style id="adrival-brand-overlay">
:root, html, body {
  --adrival-primary: ${colors.primary} !important;
  --adrival-secondary: ${colors.secondary} !important;
  --adrival-accent: ${colors.accent} !important;
  --adrival-text: ${colors.text} !important;
  --adrival-bg: ${colors.background} !important;
  --primary: ${colors.primary} !important;
  --primary-color: ${colors.primary} !important;
  --brand: ${colors.primary} !important;
  --brand-color: ${colors.primary} !important;
  --brand-primary: ${colors.primary} !important;
  --color-primary: ${colors.primary} !important;
  --accent: ${colors.accent} !important;
  --accent-color: ${colors.accent} !important;
  --secondary: ${colors.secondary} !important;
  --link-color: ${colors.primary} !important;
  --button-bg: ${colors.primary} !important;
  --bs-primary: ${colors.primary} !important;
  --bs-link-color: ${colors.primary} !important;
}
a { color: ${colors.primary} !important; }
h1, h2, h3, .headline, [class*="headline"], [class*="Heading"] {
  color: ${colors.secondary} !important;
}
h1 span, h2 span, h3 span, strong span, .highlight, [class*="highlight"], [class*="accent"] {
  color: ${colors.accent} !important;
}
a.btn, a.button, button, .btn, .button,
[class*="btn-primary"], [class*="Button"], [class*="cta"],
input[type="submit"], input[type="button"] {
  background-color: ${colors.primary} !important;
  background-image: none !important;
  border-color: ${colors.primary} !important;
  color: #fff !important;
}
a.btn:hover, a.button:hover, button:hover, .btn:hover, .button:hover {
  background-color: ${colors.secondary} !important;
  border-color: ${colors.secondary} !important;
}
header, nav, [role="banner"] {
  border-color: ${colors.primary} !important;
}
[class*="hero"] [class*="badge"], [class*="pill"], [class*="tag"] {
  background-color: ${colors.primary} !important;
  color: #fff !important;
}
#adrival-draft-banner { background: ${colors.primary} !important; }
</style>
<meta name="theme-color" content="${colors.primary}">
<meta name="adrival-brand-source" content="${(colors.source || "site").replace(/"/g, "")}">
`;

  // Remove older overlay if regenerating mid-document
  out = out.replace(/<style id="adrival-brand-overlay">[\s\S]*?<\/style>/gi, "");
  out = out.replace(/<meta name="adrival-brand-source"[^>]*>/gi, "");

  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, `${overlay}</head>`);
  } else {
    out = overlay + out;
  }
  return out;
}

function updateDocumentMeta(
  html: string,
  brandName: string,
  keyword: string,
  businessUrl: string,
  assets?: BrandSiteAssets | null,
): string {
  const $ = cheerio.load(html);
  $("title").text(`${brandName} — ${keyword}`);
  if (!$("title").length) {
    $("head").prepend(`<title>${brandName} — ${keyword}</title>`);
  }
  $('meta[property="og:title"]').attr("content", `${brandName} — ${keyword}`);
  $('meta[name="description"]').attr(
    "content",
    `${brandName}: ${keyword}. Adapted landing page draft.`,
  );

  if (assets?.ogImageUrl || assets?.logoUrl) {
    const og = assets.ogImageUrl || assets.logoUrl!;
    if ($('meta[property="og:image"]').length) {
      $('meta[property="og:image"]').attr("content", og);
    } else {
      $("head").append(`<meta property="og:image" content="${og}">`);
    }
  }

  if (assets?.faviconUrl) {
    $('link[rel="icon"], link[rel="shortcut icon"]').remove();
    $("head").append(
      `<link rel="icon" href="${assets.faviconUrl}">`,
    );
  }

  // Point primary-looking CTAs at the business site
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").toLowerCase();
    const text = normalizeText($(el).text()).toLowerCase();
    const looksCta =
      /get started|sign up|apply|book|quote|contact|learn more|try|start|schedule|call|buy|shop/i.test(
        text,
      ) || /\/(apply|signup|start|quote|contact|demo)/i.test(href);
    if (looksCta) {
      $(el).attr("href", businessUrl);
    }
  });

  return $.html();
}

function isCompetitorLogoImg(
  src: string,
  alt: string,
  className: string,
): boolean {
  const hay = `${src} ${alt} ${className}`.toLowerCase();
  if (
    /handshake|trust|review|testimonial|people|portrait|avatar|badge|award|press|photo|stock/i.test(
      hay,
    )
  ) {
    return false;
  }
  return /logo|navbar-brand|site-logo|header-logo|brand-logo|brandlogo|wordmark|logotype/i.test(
    hay,
  );
}

function isHeaderLogoCandidate($el: any, src: string, alt: string, className: string): boolean {
  if (isCompetitorLogoImg(src, alt, className)) return true;
  if (
    /handshake|trust|review|testimonial|people|portrait|photo|stock|hero|banner/i.test(
      `${src} ${alt} ${className}`.toLowerCase(),
    )
  ) {
    return false;
  }
  const inHeader =
    $el.closest(
      "header, nav, [role='banner'], .navbar, .header, .site-header, .masthead",
    ).length > 0;
  if (!inHeader) return false;
  if ($el.closest("li, button, .menu, .nav-item").length) return false;
  const width = Number($el.attr("width") || 0);
  const height = Number($el.attr("height") || 0);
  // Logo-sized header image (not a wide hero photo)
  if (height > 0 && height <= 100) return true;
  if (width > 0 && width <= 260 && (height === 0 || height <= 120)) return true;
  if (width === 0 && height === 0 && /\.(svg|png|webp)(\?|$)/i.test(src)) {
    // Unknown size PNG/SVG in header — often the logo
    return true;
  }
  return false;
}

function logoImgHtml(logoUrl: string, brandName: string): string {
  return `<a href="#top" data-adrival-logo="1" style="display:inline-flex;align-items:center;text-decoration:none;"><img src="${logoUrl}" alt="${brandName}" style="max-height:48px;width:auto;max-width:220px;object-fit:contain;" /></a>`;
}

function isSmallOrUiImage(
  $el: any,
  src: string,
  className: string,
): boolean {
  const width = Number($el.attr("width") || 0);
  const height = Number($el.attr("height") || 0);
  if ((width > 0 && width <= 96) || (height > 0 && height <= 96)) return true;
  const hay = `${src} ${className}`.toLowerCase();
  if (
    /icon|sprite|bullet|check|tick|star|badge|payment|flag|social|facebook|instagram|linkedin|twitter|youtube|tiktok|emoji|avatar|pixel|tracking/i.test(
      hay,
    )
  ) {
    return true;
  }
  // Inside lists / feature grids — usually icons, not hero photos
  if ($el.closest("li, ul, ol, [class*='feature'] li, [class*='bullet'], [class*='checklist']").length) {
    return true;
  }
  if ($el.closest("footer, [role='contentinfo'], .footer, [class*='Footer']").length) {
    return true;
  }
  return false;
}

function findFooterRoot($: any): any {
  const direct = $("footer, [role='contentinfo'], .footer, #footer, [class*='Footer']").first();
  if (direct.length) return direct;

  // Heuristic: last big block that looks like a footer (contact / legal / connect)
  let best: any = null;
  $("div, section, aside").each((_: number, el: any) => {
    const $el = $(el);
    const text = normalizeText($el.text()).toLowerCase();
    if (text.length < 40 || text.length > 8000) return;
    const score =
      (/privacy|terms|contact|legal|connect with|copyright|©/.test(text) ? 2 : 0) +
      ($el.find("a[href]").length >= 3 ? 1 : 0) +
      (/footer/i.test($el.attr("class") || "") ? 3 : 0);
    if (score >= 3) best = $el;
  });
  return best || $();
}

/**
 * Inject the user's logo, footer/nav links, and images into the cloned competitor HTML.
 * Keeps competitor layout — only replaces brand assets carefully.
 */
function legacyApplyBrandSiteAssetsUnused(
  html: string,
  assets: BrandSiteAssets,
  brandName: string,
  businessUrl: string,
): { html: string; stats: { logos: number; images: number; footerLinks: number; navLinks: number } } {
  const $ = cheerio.load(html);
  const stats = { logos: 0, images: 0, footerLinks: 0, navLinks: 0 };

  // Always remove any previously injected duplicate footer
  $("#adrival-brand-footer").remove();

  const logoUrl = assets.logoUrl;
  const heroPool = assets.images.filter(
    (i) => i.kind === "hero" || i.kind === "og",
  );
  const largeContent = assets.images.filter((i) => i.kind === "content");

  // --- Logos ---
  if (logoUrl) {
    // 1) Replace explicit / header logo-sized images
    $("img").each((_, el) => {
      const $el = $(el);
      const src = $el.attr("src") || "";
      const alt = $el.attr("alt") || "";
      const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""} ${$el.parent().parent().attr("class") || ""}`;
      if (!isHeaderLogoCandidate($el, src, alt, className)) return;
      $el.attr("src", logoUrl);
      $el.removeAttr("srcset");
      $el.attr("alt", brandName);
      $el.attr(
        "style",
        `${$el.attr("style") || ""};max-height:48px;width:auto;object-fit:contain;`.replace(
          /^;/,
          "",
        ),
      );
      stats.logos += 1;
    });

    // 2) Replace header/nav SVGs that look like wordmarks (not tiny icons in menus)
    $("header svg, nav svg, [role='banner'] svg, .navbar svg, .masthead svg")
      .toArray()
      .slice(0, 2)
      .forEach((el) => {
        const $el = $(el);
        if ($el.closest("button, li, .menu-item, footer").length) return;
        const box = {
          w: Number($el.attr("width") || 0),
          h: Number($el.attr("height") || 0),
        };
        // Skip tiny icon SVGs
        if ((box.w > 0 && box.w < 24) || (box.h > 0 && box.h < 24)) return;
        $el.replaceWith(
          `<img src="${logoUrl}" alt="${brandName}" data-adrival-logo="1" style="max-height:48px;width:auto;object-fit:contain;" />`,
        );
        stats.logos += 1;
      });

    // 3) Point logo anchors home
    $("a.logo, a.navbar-brand, a[class*='logo']").each((_, el) => {
      $(el).attr("href", businessUrl);
    });

    // 4) If nothing was replaced, inject the brand logo into the header
    if (stats.logos === 0) {
      const $header = $(
        "header, [role='banner'], .navbar, .site-header, .masthead, nav",
      ).first();
      const inject = logoImgHtml(logoUrl, brandName).replace(
        'href="#top"',
        `href="${businessUrl}"`,
      );
      if ($header.length) {
        const $brandSlot = $header
          .find("a.navbar-brand, a.logo, .logo, .brand, .navbar-brand")
          .first();
        if ($brandSlot.length) {
          $brandSlot.html(
            `<img src="${logoUrl}" alt="${brandName}" data-adrival-logo="1" style="max-height:48px;width:auto;object-fit:contain;" />`,
          );
          $brandSlot.attr("href", businessUrl);
        } else {
          $header.prepend(
            `<div data-adrival-logo-wrap="1" style="padding:12px 16px;">${inject}</div>`,
          );
        }
        stats.logos += 1;
      } else if ($("body").length) {
        $("body").prepend(
          `<div data-adrival-logo-wrap="1" style="padding:12px 16px;background:#fff;">${inject}</div>`,
        );
        stats.logos += 1;
      }
    }
  }

  // --- Hero / large banner images only (never bullets, icons, footer, logos) ---
  let heroSwapped = false;
  $("img").each((_, el) => {
    const $el = $(el);
    const src = $el.attr("src") || "";
    const alt = $el.attr("alt") || "";
    const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;

    if (isCompetitorLogoImg(src, alt, className)) return;
    if (isSmallOrUiImage($el, src, className)) return;
    if ($el.closest("header, nav, [role='banner']").length && !/hero|banner/i.test(className)) {
      // Header decorative photos — leave alone (logo handling is separate)
      return;
    }

    const inHero = $el.closest(
      ".hero, hero, .banner, .jumbotron, [class*='hero'], [class*='Hero'], [class*='banner'], [class*='masthead']",
    ).length > 0;

    const width = Number($el.attr("width") || 0);
    const height = Number($el.attr("height") || 0);
    const looksLarge =
      (width >= 280 || height >= 200) ||
      /hero|banner|cover|main-image|featured/i.test(`${src} ${className} ${alt}`);

    if (!inHero && !looksLarge) return;

    let next: string | null = null;
    if (inHero && !heroSwapped && heroPool.length) {
      next = heroPool[0].src;
      heroSwapped = true;
    } else if (inHero && !heroSwapped && largeContent.length) {
      next = largeContent[0].src;
      heroSwapped = true;
    } else if (looksLarge && largeContent.length && stats.images < 2) {
      // At most 2 large content swaps — keep most competitor imagery intact
      next = largeContent[Math.min(stats.images, largeContent.length - 1)].src;
    }

    if (!next || next === src) return;
    $el.attr("src", next);
    $el.removeAttr("srcset");
    stats.images += 1;
  });

  // Background-image on explicit hero/banner only
  if (heroPool[0] || largeContent[0]) {
    const bgSrc = (heroPool[0] || largeContent[0]).src;
    $(".hero, [class*='hero'], [class*='Hero'], .banner, [class*='banner']").each(
      (_, el) => {
        const style = $(el).attr("style") || "";
        if (!/url\(/i.test(style)) return;
        if ($(el).closest("header, nav, footer").length) return;
        const nextStyle = style.replace(
          /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi,
          `url("${bgSrc}")`,
        );
        if (nextStyle !== style) {
          $(el).attr("style", nextStyle);
          stats.images += 1;
        }
      },
    );
  }

  // --- Footer: keep competitor layout, replace links only (never append a second footer) ---
  const $footer = findFooterRoot($);
  if ($footer.length && assets.footerLinks.length) {
    const textLinks = assets.footerLinks.filter(
      (l) => !/facebook|instagram|twitter|linkedin|youtube|tiktok|x\.com/i.test(l.href),
    );
    let textIdx = 0;

    $footer.find("a[href]").each((_: number, el: any) => {
      const $el = $(el);
      const href = ($el.attr("href") || "").toLowerCase();
      const label = normalizeText($el.text());
      const hasOnlyImg = $el.find("img, svg").length > 0 && label.length < 2;

      // Social / icon links: update href only, never rewrite label or swap images
      const socialKey = [
        "instagram",
        "facebook",
        "linkedin",
        "youtube",
        "tiktok",
        "twitter",
        "x.com",
      ].find((k) => href.includes(k));
      if (socialKey || hasOnlyImg) {
        if (socialKey && assets.socialLinks.length) {
          const social =
            assets.socialLinks.find((s) =>
              s.href
                .toLowerCase()
                .includes(socialKey === "x.com" ? "twitter" : socialKey),
            ) || null;
          if (social) {
            $el.attr("href", social.href);
            stats.footerLinks += 1;
          }
        }
        return;
      }

      if (/^mailto:/i.test(href) && assets.emails[0]) {
        $el.attr("href", `mailto:${assets.emails[0]}`);
        stats.footerLinks += 1;
        return;
      }
      if (/^tel:/i.test(href) && assets.phones[0]) {
        $el.attr("href", `tel:${assets.phones[0]}`);
        stats.footerLinks += 1;
        return;
      }

      if (!textLinks.length || textIdx >= textLinks.length) return;
      // Prefer mapping privacy/terms/about-like labels to similar brand links
      const prefer =
        textLinks.find((l) => {
          const a = label.toLowerCase();
          const b = l.label.toLowerCase();
          return (
            (a && b && (a.includes(b.slice(0, 5)) || b.includes(a.slice(0, 5)))) ||
            (/privacy/i.test(a) && /privacy/i.test(b)) ||
            (/terms/i.test(a) && /terms/i.test(b)) ||
            (/contact/i.test(a) && /contact/i.test(b)) ||
            (/about/i.test(a) && /about/i.test(b))
          );
        }) || textLinks[textIdx];

      $el.attr("href", prefer.href);
      if (label && label.length < 60) {
        $el.text(prefer.label);
      }
      textIdx += 1;
      stats.footerLinks += 1;
    });
  }

  // --- Nav text links only (skip logo anchors / icon links) ---
  const navAnchors = $(
    "header nav a[href], nav a[href], header .menu a[href], .navbar-nav a[href]",
  )
    .toArray()
    .filter((el) => {
      const $el = $(el);
      if ($el.find("img, svg").length) return false;
      const className = $el.attr("class") || "";
      if (/logo|brand|btn|button|cta/i.test(className)) return false;
      const t = normalizeText($el.text());
      return t.length >= 2 && t.length <= 40;
    });
  if (assets.navLinks.length && navAnchors.length) {
    navAnchors.forEach((el, i) => {
      if (i >= assets.navLinks.length) return;
      const link = assets.navLinks[i];
      $(el).attr("href", link.href);
      $(el).text(link.label);
      stats.navLinks += 1;
    });
  }

  // Contact mailto/tel in footer / page
  if (assets.emails[0]) {
    $("a[href^='mailto:']").attr("href", `mailto:${assets.emails[0]}`);
  }
  if (assets.phones[0]) {
    $("a[href^='tel:']").attr("href", `tel:${assets.phones[0]}`);
  }

  return { html: $.html(), stats };
}

/**
 * Clone a competitor landing page HTML and rewrite copy + brand colors for the user.
 */
export async function cloneAndAdaptLandingPage(input: {
  sourceUrl: string;
  keyword: string;
  competitorName: string;
  businessUrl: string;
  profile: BusinessProfile | null;
  colors: BrandColors;
  /** Pre-resolved brand assets from the user business URL (preferred) */
  brandAssets?: BrandSiteAssets | null;
  brandWarnings?: string[];
  userFeedback?: string | null;
}): Promise<{ html: string; differentiationNotes: string; textsRewritten: number }> {
  const fetched = await fetchRawLandingHtml(input.sourceUrl);

  let brandAssets = input.brandAssets ?? null;
  if (!brandAssets) {
    brandAssets = await fetchBrandSiteAssets(input.businessUrl).catch((err) => {
      console.warn("[clone] brand asset fetch failed", err);
      return null;
    });
  }
  // Profile snapshot fallback
  if (!brandAssets && input.profile?.brandAssets) {
    brandAssets = input.profile.brandAssets as BrandSiteAssets;
  }

  let html = prepareCompetitorHtml(fetched.html, fetched.finalUrl);

  const plainLen = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
  if (plainLen < 80) {
    throw new Error(
      "Competitor page returned almost no readable HTML (likely a heavy JavaScript app). Try another ad with a simpler landing URL.",
    );
  }

  const brandName =
    input.profile?.businessName ||
    brandAssets?.siteName ||
    (() => {
      try {
        return new URL(input.businessUrl).hostname.replace(/^www\./, "");
      } catch {
        return "Your Brand";
      }
    })();

  let competitorHost: string | null = null;
  try {
    competitorHost = new URL(fetched.finalUrl || input.sourceUrl).hostname
      .replace(/^www\./i, "")
      .toLowerCase();
  } catch {
    competitorHost = null;
  }

  const brandImageUrls = (brandAssets?.images || [])
    .filter((i) => i.kind === "hero" || i.kind === "content" || i.kind === "og")
    .map((i) => i.src);

  // Strip people/mascot/founder identity before rewriting copy
  let safety = sanitizeCompetitorIdentity(html, {
    competitorName: input.competitorName,
    brandName,
    brandImageUrls,
    competitorHost,
  });
  html = safety.html;

  // Snapshot competitor copy for originality validation
  const originalTexts = extractRewritableTexts(html)
    .filter((t) => t.tag.startsWith("h") || t.tag === "p")
    .map((t) => t.text);

  // 1) Section-by-section rewrite (headlines + paragraphs) — primary originality pass
  const sections = extractPageSections(html);
  const sectionMap = await rewriteSectionsWithClaude({
    sections,
    keyword: input.keyword,
    competitorName: input.competitorName,
    brandName,
    businessUrl: input.businessUrl,
    profile: input.profile,
    userFeedback: input.userFeedback || null,
  });
  html = applyFromToReplacements(html, sectionMap);

  // 2) Flat rewrite for CTAs / buttons / short leftovers (skip long headings/paras already done)
  const sectionCovered = new Set(
    [...sectionMap.keys()].map((k) => k.toLowerCase().replace(/\s+/g, " ").trim()),
  );
  const texts = extractRewritableTexts(html).filter((t) => {
    const key = t.text.toLowerCase().replace(/\s+/g, " ").trim();
    if (sectionCovered.has(key)) return false;
    if ((t.tag === "h1" || t.tag === "h2" || t.tag === "h3" || t.tag === "p") && t.text.length >= 20) {
      // Already handled via sections when present in map values
      const wasRewritten = [...sectionMap.values()].some(
        (v) => v.toLowerCase().replace(/\s+/g, " ").trim() === key,
      );
      if (wasRewritten) return false;
    }
    return true;
  });

  const replacements = await rewriteTextsWithLlm({
    texts,
    keyword: input.keyword,
    competitorName: input.competitorName,
    brandName,
    businessUrl: input.businessUrl,
    profile: input.profile,
    userFeedback: input.userFeedback || null,
  });

  html = applyTextReplacements(
    html,
    texts,
    replacements,
    input.competitorName,
    brandName,
  );

  // 2b) Dedicated feedback pass when the user gave regenerate instructions
  let feedbackEdits = 0;
  if (input.userFeedback?.trim()) {
    const feedbackMap = await applyUserFeedbackPass({
      html,
      userFeedback: input.userFeedback,
      keyword: input.keyword,
      competitorName: input.competitorName,
      brandName,
      businessUrl: input.businessUrl,
    });
    html = applyFromToReplacements(html, feedbackMap);
    feedbackEdits = feedbackMap.size;
  }
  html = remapBrandColors(html, input.colors);
  html = updateDocumentMeta(
    html,
    brandName,
    input.keyword,
    input.businessUrl,
    brandAssets,
  );

  let assetStats = { logos: 0, images: 0, footerLinks: 0, navLinks: 0 };
  if (brandAssets) {
    const applied = applyBrandSiteAssets(
      html,
      brandAssets,
      brandName,
      input.businessUrl,
      fetched.finalUrl || input.sourceUrl,
    );
    html = applied.html;
    assetStats = applied.stats;
  } else {
    // Without brand assets: never leave competitor socials; never map them to homepage
    try {
      const $ = cheerio.load(html);
      $("a[href]").each((_, el) => {
        const $el = $(el);
        const href = $el.attr("href") || "";
        if (!href || /^mailto:|^tel:|^#/i.test(href)) return;
        const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
        const label = normalizeText($el.text());
        if (
          /facebook|instagram|linkedin|youtube|tiktok|twitter|x\.com|pinterest|threads|social/i.test(
            `${href} ${label} ${className}`,
          )
        ) {
          $el.removeAttr("href");
          $el.css("display", "none");
          $el.attr("data-adrival-social-removed", "1");
          return;
        }
        try {
          const h = new URL(href, input.businessUrl).hostname
            .replace(/^www\./i, "")
            .toLowerCase();
          if (competitorHost && h.includes(competitorHost)) {
            $el.attr("href", input.businessUrl);
          }
        } catch {
          // ignore
        }
      });
      html = $.html();
    } catch {
      // ignore
    }
  }

  // Final safety pass after brand assets (catch leftover endorser photos / names)
  safety = sanitizeCompetitorIdentity(html, {
    competitorName: input.competitorName,
    brandName,
    brandImageUrls,
    competitorHost,
  });
  html = safety.html;

  // Re-apply brand colors LAST so overlay beats footer/asset markup and competitor CSS
  html = remapBrandColors(html, input.colors);

  // 3) Strict validation loop — only present HTML that passes checks
  const brandSocialHrefs = (brandAssets?.socialLinks || []).map((s) => s.href);
  let validation = validateRecreatedHtml({
    html,
    competitorName: input.competitorName,
    brandName,
    businessUrl: input.businessUrl,
    brandSocialHrefs,
    originalTexts,
  });

  const maxRepairRounds = 4;
  for (let round = 0; round < maxRepairRounds && !validation.ok; round += 1) {
    const failingSamples = validation.issues
      .filter((i) => i.severity === "error")
      .flatMap((i) => i.samples || []);

    if (
      validation.issues.some(
        (i) =>
          i.code === "social_points_to_homepage" ||
          i.code === "social_not_brand_handle" ||
          i.code === "footer_competitor_content" ||
          i.code === "footer_competitor_licence" ||
          i.code === "footer_links_collapsed" ||
          i.code === "footer_social_invalid",
      )
    ) {
      // Rebuild brand footer / socials (sensitive section)
      if (brandAssets) {
        const applied = applyBrandSiteAssets(
          html,
          brandAssets,
          brandName,
          input.businessUrl,
          fetched.finalUrl || input.sourceUrl,
        );
        html = applied.html;
      } else {
        const $ = cheerio.load(html);
        $(
          "footer, [role='contentinfo'], .footer, #footer, [class*='Footer']",
        )
          .first()
          .empty()
          .append(
            `<div data-adrival-brand-footer="1" style="padding:24px 16px;font:14px/1.5 system-ui,sans-serif;"><p>© ${new Date().getFullYear()} ${brandName}. All rights reserved.</p></div>`,
          );
        $("a[href]").each((_, el) => {
          const $el = $(el);
          const href = ($el.attr("href") || "").trim();
          if (
            /facebook\.com|instagram\.com|linkedin\.com|youtube\.com|youtu\.be|tiktok\.com|twitter\.com|x\.com|pinterest\.com|threads\.net/i.test(
              href,
            )
          ) {
            $el.remove();
          }
        });
        html = $.html();
      }
    }

    const copySamples = validation.issues
      .filter(
        (i) =>
          i.severity === "error" &&
          (i.code === "content_too_similar" || i.code === "competitor_name_present"),
      )
      .flatMap((i) => i.samples || []);

    if (copySamples.length || failingSamples.length) {
      try {
        const repairMap = await repairFailingCopyWithClaude({
          failingSamples: copySamples.length ? copySamples : failingSamples,
          competitorName: input.competitorName,
          brandName,
          keyword: input.keyword,
          businessUrl: input.businessUrl,
          industry: input.profile?.industry || null,
          userFeedback: input.userFeedback || null,
        });
        html = applyFromToReplacements(html, repairMap);
      } catch (err) {
        console.error("[clone] validation repair round failed", err);
      }
    }

    validation = validateRecreatedHtml({
      html,
      competitorName: input.competitorName,
      brandName,
      businessUrl: input.businessUrl,
      brandSocialHrefs,
      originalTexts,
    });
  }

  if (!validation.ok) {
    const detail = validation.issues
      .filter((i) => i.severity === "error")
      .map((i) => i.message)
      .join(" ");
    throw new Error(
      `Landing page failed quality validation after ${maxRepairRounds} repair rounds (score ${validation.score}). ${detail}`,
    );
  }

  const rewrittenCount = sectionMap.size + replacements.size + feedbackEdits;
  const assetNote = brandAssets
    ? ` Pulled brand assets from ${brandAssets.finalUrl}: logo×${assetStats.logos}, images×${assetStats.images}, footer links×${assetStats.footerLinks}, nav links×${assetStats.navLinks}, social×${brandSocialHrefs.length}.`
    : " Could not fetch brand website assets; used copy/color adaptation only.";

  const colorNote = ` Brand colors from your site (${input.colors.source || "site"}): primary ${input.colors.primary}, secondary ${input.colors.secondary}, accent ${input.colors.accent}.`;

  const warnNote =
    input.brandWarnings && input.brandWarnings.length
      ? ` Brand fetch notes: ${input.brandWarnings.slice(0, 3).join(" · ")}.`
      : "";

  const safetyNote = ` Removed/replaced ${safety.removedBlocks} sensitive identity blocks and ${safety.replacedImages} risky images. Section rewrite×${sections.length}, validated score ${validation.score}.`;

  const feedbackNote = input.userFeedback?.trim()
    ? ` Applied user feedback (${feedbackEdits} targeted edits).`
    : "";

  // Banner so it's clear this is an adapted draft
  const banner = `<div id="adrival-draft-banner" style="position:sticky;top:0;z-index:99999;background:${input.colors.primary};color:#fff;padding:8px 14px;font:600 13px/1.4 system-ui,sans-serif;">AdRival draft — layout from ${input.competitorName}, brand assets from your site · keyword “${input.keyword}” · validated${input.userFeedback?.trim() ? " · feedback applied" : ""}</div>`;
  if (/<body[^>]*>/i.test(html)) {
    html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
  } else {
    html = banner + html;
  }

  return {
    html,
    textsRewritten: rewrittenCount,
    differentiationNotes: `Cloned structure only; rewrote ${rewrittenCount} strings section-by-section via Claude for ${brandName}; remapped colors; passed validation.${feedbackNote}${assetNote}${colorNote}${warnNote}${safetyNote}`,
  };
}
