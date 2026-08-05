import * as cheerio from "cheerio";
import type { LandingContentBlock, LandingContentDraft } from "../types";
import type { CidTextNode } from "./archive/rewriteTextByCid";
import { clipToCompletePhrase } from "./slotTextBudget";

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Keep approved copy. Soft-truncate only when wildly longer — prefer complete phrases.
 */
function fitApprovedText(
  text: string,
  node: CidTextNode,
  maxLenHint?: number | null,
): string {
  let t = normalize(text);
  if (!t) return t;
  const ceiling = Math.max(
    maxLenHint || 0,
    Math.ceil(node.text.length * 1.55),
    node.maxLen,
    24,
  );
  if (t.length > ceiling) {
    t = clipToCompletePhrase(t, ceiling, {
      softMax: Math.ceil(ceiling * 1.25),
      role: node.role,
    });
  }
  return t;
}

function roleBucket(role: string): string {
  const r = role.toLowerCase();
  if (r === "h1") return "h1";
  if (r === "h2") return "h2";
  if (r === "h3" || r === "h4" || r === "h5" || r === "h6") return "h3";
  if (r === "cta" || r === "button") return "cta";
  if (r === "a" || r === "nav" || r === "internal_link") return "link";
  if (r === "bullet" || r === "li") return "bullet";
  if (r === "testimonial") return "testimonial";
  if (r === "stat") return "stat";
  if (r === "eyebrow") return "eyebrow";
  if (r === "body" || r === "p" || r === "span" || r === "strong" || r === "em") {
    return "body";
  }
  return "other";
}

function cidBucket(node: CidTextNode): string {
  const r = node.role.toLowerCase();
  if (r === "h1") return "h1";
  if (r === "h2") return "h2";
  if (r === "h3" || r === "h4" || r === "h5" || r === "h6") return "h3";
  if (r === "button") return "cta";
  if (r === "a") return node.text.length <= 48 ? "cta" : "link";
  if (r === "li") return "bullet";
  if (r === "p" || r === "span" || r === "strong" || r === "em" || r === "label") {
    return node.text.length <= 48 ? "eyebrow" : "body";
  }
  return "other";
}

/**
 * Map approved content onto stamped CID nodes (strict).
 * Preferred: id match → original competitor text → role-order queues.
 * No cycle-fill — unmapped slots keep competitor text.
 */
export function mapApprovedContentToCidReplacements(
  draft: LandingContentDraft,
  nodes: CidTextNode[],
): Map<string, string> {
  return mapApprovedContentWithStats(draft, nodes).replacements;
}

export type ApprovedCidMapStats = {
  replacements: Map<string, string>;
  matchedCount: number;
  unmatchedCount: number;
  coverage: number;
  unmatchedIds: string[];
};

export function mapApprovedContentWithStats(
  draft: LandingContentDraft,
  nodes: CidTextNode[],
): ApprovedCidMapStats {
  const map = new Map<string, string>();

  const pageBlocks = draft.blocks.filter(
    (b) =>
      b.text?.trim() &&
      ![
        "meta_title",
        "meta_description",
        "footer",
        "footer_link",
        "social",
        "nav",
        "internal_link",
      ].includes(String(b.role)),
  );

  const byOriginal = new Map<string, LandingContentBlock[]>();
  for (const b of pageBlocks) {
    const key = normalize(b.originalText || "").toLowerCase();
    if (key.length < 2) continue;
    const list = byOriginal.get(key) || [];
    list.push(b);
    byOriginal.set(key, list);
  }

  const byId = new Map(
    pageBlocks.filter((b) => /^n\d+$/i.test(b.id)).map((b) => [b.id, b]),
  );

  const usedBlockIds = new Set<string>();
  const eligible = nodes.filter((n) => !n.inFooter);

  for (const node of eligible) {
    const byCid = byId.get(node.id);
    if (byCid && !usedBlockIds.has(byCid.id)) {
      const fitted = fitApprovedText(byCid.text, node, byCid.maxLen);
      if (fitted.length >= 2) {
        map.set(node.id, fitted);
        usedBlockIds.add(byCid.id);
        continue;
      }
    }

    const key = normalize(node.text).toLowerCase();
    const candidates = byOriginal.get(key);
    if (candidates?.length) {
      const block =
        candidates.find((b) => !usedBlockIds.has(b.id)) || candidates[0];
      if (block) {
        const fitted = fitApprovedText(block.text, node, block.maxLen);
        if (fitted.length >= 2) {
          map.set(node.id, fitted);
          usedBlockIds.add(block.id);
          continue;
        }
      }
    }
  }

  // Role-order fill for remaining nodes from unused page blocks (same role only)
  const queues = new Map<string, LandingContentBlock[]>();
  for (const b of pageBlocks) {
    if (usedBlockIds.has(b.id)) continue;
    const bucket = roleBucket(String(b.role));
    const list = queues.get(bucket) || [];
    list.push(b);
    queues.set(bucket, list);
  }
  const take = (bucket: string) => {
    const list = queues.get(bucket);
    if (!list?.length) return null;
    return list.shift() || null;
  };

  for (const node of eligible) {
    if (map.has(node.id)) continue;
    const bucket = cidBucket(node);
    const block =
      take(bucket) ||
      (bucket === "cta" ? take("link") : null) ||
      (bucket === "eyebrow" ? take("body") : null);
    if (!block) continue;
    usedBlockIds.add(block.id);
    const fitted = fitApprovedText(block.text, node, block.maxLen);
    if (fitted.length >= 2) map.set(node.id, fitted);
  }

  // No cycle-fill — leave unmatched competitor text in place
  const unmatchedIds = eligible
    .filter((n) => !map.has(n.id))
    .map((n) => n.id);
  const matchedCount = map.size;
  const coverage =
    eligible.length > 0 ? matchedCount / eligible.length : 1;

  return {
    replacements: map,
    matchedCount,
    unmatchedCount: unmatchedIds.length,
    coverage,
    unmatchedIds,
  };
}

/** Approved footer disclaimer blurb, if present. */
export function getApprovedFooterDisclaimer(
  draft: LandingContentDraft,
): string | null {
  const block = draft.blocks.find((b) => b.role === "footer" && b.text?.trim());
  return block?.text?.trim() || null;
}

/** Apply meta title/description from approved draft into HTML head. */
export function applyMetaFromContentDraft(
  html: string,
  draft: LandingContentDraft,
): string {
  const title = draft.blocks.find((b) => b.role === "meta_title")?.text?.trim();
  const desc = draft.blocks
    .find((b) => b.role === "meta_description")
    ?.text?.trim();

  let out = html;
  if (title) {
    if (/<title[^>]*>[\s\S]*?<\/title>/i.test(out)) {
      out = out.replace(
        /<title[^>]*>[\s\S]*?<\/title>/i,
        `<title>${escapeHtml(title)}</title>`,
      );
    } else if (/<head[^>]*>/i.test(out)) {
      out = out.replace(
        /<head([^>]*)>/i,
        `<head$1><title>${escapeHtml(title)}</title>`,
      );
    }
  }
  if (desc) {
    if (/<meta[^>]+name=["']description["'][^>]*>/i.test(out)) {
      out = out.replace(
        /<meta[^>]+name=["']description["'][^>]*>/i,
        `<meta name="description" content="${escapeAttr(desc)}" />`,
      );
    } else if (/<head[^>]*>/i.test(out)) {
      out = out.replace(
        /<head([^>]*)>/i,
        `<head$1><meta name="description" content="${escapeAttr(desc)}" />`,
      );
    }
  }
  return out;
}

function setAnchorLabel($: cheerio.CheerioAPI, $el: cheerio.Cheerio<any>, text: string) {
  if ($el.children().length === 0) {
    $el.text(text);
    return;
  }
  // Clear all direct text first so competitor labels cannot remain beside the new copy
  $el.contents().each((_, child) => {
    const node = child as { type?: string; data?: string };
    if (node.type === "text") node.data = "";
  });

  const $textChild = $el
    .children("span, p, strong, em, label")
    .filter((_, c) => {
      const $c = $(c);
      if ($c.is("svg, i, img")) return false;
      if ($c.children("svg, i, img").length && normalize($c.text()).length < 2) {
        return false;
      }
      return true;
    })
    .first();
  if ($textChild.length) {
    $el.children("span, p, strong, em, label").each((_, c) => {
      const $c = $(c);
      if ($c[0] === $textChild[0]) return;
      if ($c.is("svg, i, img")) return;
      $c.text("");
    });
    if ($textChild.children().length === 0) $textChild.text(text);
    else setAnchorLabel($, $textChild, text);
    return;
  }
  const safe = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  $el.append(safe);
}

/**
 * Remap header/nav anchors to approved brand nav + internal link hrefs.
 * Prefer label similarity, then order as fallback.
 */
export function applyApprovedNavAndInternalLinks(
  html: string,
  draft: LandingContentDraft,
): string {
  const nav = draft.blocks.filter(
    (b) => (b.role === "nav" || b.role === "internal_link") && b.href,
  );
  if (!nav.length) return html;

  const $ = cheerio.load(html);
  const targets = $(
    "header a[href], nav a[href], [role='navigation'] a[href], .navbar a[href]",
  ).toArray();

  const used = new Set<number>();
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

  for (const el of targets) {
    const $el = $(el);
    const href = ($el.attr("href") || "").trim();
    if (!href || /^mailto:|^tel:|^javascript:/i.test(href)) continue;
    if (
      /facebook|instagram|linkedin|youtube|tiktok|twitter|x\.com|pinterest|threads/i.test(
        href,
      )
    ) {
      continue;
    }
    const label = normalize($el.text());
    let idx = nav.findIndex(
      (b, i) => !used.has(i) && norm(b.text || "") === norm(label),
    );
    if (idx < 0) {
      idx = nav.findIndex((b, i) => {
        if (used.has(i)) return false;
        const t = norm(b.text || "");
        const l = norm(label);
        return t.length >= 3 && l.length >= 3 && (t.includes(l) || l.includes(t));
      });
    }
    if (idx < 0) {
      idx = nav.findIndex((_, i) => !used.has(i));
    }
    if (idx < 0) break;
    const block = nav[idx];
    used.add(idx);
    $el.attr("href", block.href!);
    if (block.text?.trim()) {
      setAnchorLabel($, $el, block.text.trim());
    }
    $el.attr("data-adrival-nav", "1");
  }

  return $.html();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
