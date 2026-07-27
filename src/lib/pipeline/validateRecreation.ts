import * as cheerio from "cheerio";
import {
  getAnthropicClient,
  getAnthropicModel,
} from "../anthropic/client";

export type ValidationIssue = {
  code: string;
  message: string;
  severity: "error" | "warn";
  /** Optional ids/snippets for targeted rewrite */
  samples?: string[];
};

export type ValidationResult = {
  ok: boolean;
  score: number;
  issues: ValidationIssue[];
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normalize(a).split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const tb = new Set(normalize(b).split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.min(ta.size, tb.size);
}

function extractHeadingsAndParas(html: string): Array<{ tag: string; text: string }> {
  const $ = cheerio.load(html);
  const out: Array<{ tag: string; text: string }> = [];
  $("h1, h2, h3, p").each((_, el) => {
    const $el = $(el);
    if (
      $el.closest(
        "footer, [role='contentinfo'], [data-adrival-brand-footer], [data-adrival-dup-removed], script, style, #adrival-draft-banner",
      ).length
    ) {
      return;
    }
    if (
      /display\s*:\s*none/i.test($el.attr("style") || "") ||
      $el.attr("aria-hidden") === "true"
    ) {
      return;
    }
    const tag = ((el as { tagName?: string }).tagName || "").toLowerCase();
    const text = $el.text().replace(/\s+/g, " ").trim();
    if (text.length >= 8) out.push({ tag, text });
  });
  return out.slice(0, 80);
}

/**
 * Deterministic checks for recreation quality / copyright safety.
 */
export function validateRecreatedHtml(input: {
  html: string;
  competitorName: string;
  brandName: string;
  businessUrl: string;
  brandSocialHrefs: string[];
  originalTexts: string[];
}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const $ = cheerio.load(input.html);
  const pageText = $("body").text().replace(/\s+/g, " ").trim();
  const competitor = input.competitorName.trim();

  if (competitor.length > 2) {
    const re = new RegExp(
      competitor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );
    if (re.test(pageText)) {
      issues.push({
        code: "competitor_name_present",
        message: `Competitor name "${competitor}" still appears in the page copy.`,
        severity: "error",
        samples: [competitor],
      });
    }
  }

  // Social links must not be homepage and must be brand socials when present
  const socialLike = $("a[href]")
    .toArray()
    .map((el) => {
      const $el = $(el);
      const href = ($el.attr("href") || "").trim();
      const label = $el.text().replace(/\s+/g, " ").trim();
      const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
      const removed = Boolean($el.attr("data-adrival-social-removed"));
      const hidden =
        removed ||
        /display\s*:\s*none/i.test($el.attr("style") || "") ||
        $el.attr("aria-hidden") === "true";
      return { href, label, className, hidden };
    })
    .filter(({ href, label, className, hidden }) => {
      if (hidden || !href || href === "#") return false;
      return /facebook|instagram|linkedin|youtube|tiktok|twitter|x\.com|pinterest|threads/i.test(
        `${href} ${label} ${className}`,
      );
    });

  let businessHost = "";
  try {
    businessHost = new URL(input.businessUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    // ignore
  }

  const brandSocialSet = new Set(
    input.brandSocialHrefs.map((u) => u.replace(/\/$/, "").toLowerCase()),
  );

  for (const s of socialLike) {
    let host = "";
    try {
      host = new URL(s.href, input.businessUrl).hostname
        .replace(/^www\./, "")
        .toLowerCase();
    } catch {
      continue;
    }
    const isHome =
      host === businessHost &&
      !/facebook|instagram|linkedin|youtube|tiktok|twitter|x\.com|pinterest|threads/i.test(
        s.href,
      );
    if (isHome) {
      issues.push({
        code: "social_points_to_homepage",
        message: "A social icon/link points to the business homepage instead of a social profile.",
        severity: "error",
        samples: [s.href],
      });
      break;
    }
    if (
      /facebook|instagram|linkedin|youtube|tiktok|twitter|x\.com|pinterest|threads/i.test(
        s.href,
      ) &&
      brandSocialSet.size > 0
    ) {
      const normalized = s.href.replace(/\/$/, "").toLowerCase();
      const exact = brandSocialSet.has(normalized);
      const sameProfile = [...brandSocialSet].some((b) => {
        try {
          const a = new URL(normalized.startsWith("http") ? normalized : s.href);
          const bb = new URL(b);
          if (a.hostname.replace(/^www\./, "") !== bb.hostname.replace(/^www\./, "")) {
            return false;
          }
          const pa = a.pathname.replace(/\/$/, "").toLowerCase();
          const pb = bb.pathname.replace(/\/$/, "").toLowerCase();
          return pa.length > 1 && pa === pb;
        } catch {
          return false;
        }
      });
      if (!exact && !sameProfile) {
        issues.push({
          code: "social_not_brand_handle",
          message: `Social link is not one of the brand handles: ${s.href}`,
          severity: "error",
          samples: [s.href],
        });
        break;
      }
    }
  }

  // Compare headlines/paragraphs against originals for near-duplicates.
  // Ignore short CTAs ("Download free", etc.) — they collide across brands.
  const current = extractHeadingsAndParas(input.html);
  const originals = input.originalTexts.map(normalize).filter((t) => t.length >= 20);
  const unchanged: string[] = [];
  for (const item of current) {
    if (item.tag !== "h1" && item.tag !== "h2" && item.tag !== "h3" && item.tag !== "p") {
      continue;
    }
    // Skip footer / brand-footer copy from similarity checks
    // (extractHeadingsAndParas is page-wide; short legal lines are fine)
    const n = normalize(item.text);
    if (n.length < 28) continue;
    if (/^©|all rights reserved|information on this page is general/i.test(n)) {
      continue;
    }
    const exact = originals.includes(n);
    const near = originals.some((o) => {
      if (Math.min(o.length, n.length) < 40 && tokenOverlap(o, n) < 0.92) {
        return false;
      }
      return tokenOverlap(o, n) >= 0.78;
    });
    if (exact || near) unchanged.push(item.text.trim());
  }
  if (unchanged.length >= 3) {
    issues.push({
      code: "content_too_similar",
      message: `${unchanged.length} headlines/paragraphs are still too similar to the competitor.`,
      severity: "error",
      // Full strings so repair can find & replace them in HTML
      samples: unchanged.slice(0, 12),
    });
  }

  // Detect duplicated headlines / body blocks on the recreated page itself
  const seenPageCopy = new Map<string, number>();
  const duplicatedOnPage: string[] = [];
  for (const item of current) {
    if (!["h1", "h2", "h3", "p"].includes(item.tag)) continue;
    const n = normalize(item.text);
    if (n.length < 24) continue;
    if (/^©|all rights reserved|information on this page is general/i.test(n)) {
      continue;
    }
    // Exact doubled phrase inside one node: "Foo Foo"
    const halfDup = n.match(/^(.{10,}?)\s+\1$/);
    if (halfDup) {
      duplicatedOnPage.push(item.text.trim());
      continue;
    }
    const count = (seenPageCopy.get(n) || 0) + 1;
    seenPageCopy.set(n, count);
    if (count === 2) duplicatedOnPage.push(item.text.trim());
  }
  if (duplicatedOnPage.length > 0) {
    issues.push({
      code: "repeated_content_blocks",
      message: `${duplicatedOnPage.length} headline/paragraph block(s) are repeated on the page.`,
      severity: "error",
      samples: duplicatedOnPage.slice(0, 8),
    });
  }

  // Brand name should appear at least once
  if (
    input.brandName.length > 2 &&
    !new RegExp(
      input.brandName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    ).test(pageText)
  ) {
    issues.push({
      code: "brand_missing",
      message: `Brand name "${input.brandName}" does not appear in the page.`,
      severity: "warn",
    });
  }

  // Hollow page check — never present logo+footer-only drafts as "validated"
  const $contentRoot = $("body").clone();
  $contentRoot
    .find(
      "footer, [role='contentinfo'], [data-adrival-brand-footer], [data-adrival-brand-footer-root], #adrival-draft-banner, script, style, noscript",
    )
    .remove();
  const contentText = normalize($contentRoot.text());
  const headingCount = $contentRoot.find("h1, h2, h3").length;
  const paragraphCount = $contentRoot.find("p, li").length;
  if (
    contentText.length < 280 ||
    headingCount < 1 ||
    (headingCount + paragraphCount < 3 && contentText.length < 600)
  ) {
    issues.push({
      code: "page_hollow",
      message:
        "Landing page body has almost no content (likely wiped during footer/sanitize). Refusing to present an empty draft.",
      severity: "error",
      samples: [contentText.slice(0, 120) || "(empty body)"],
    });
  }

  // Footer is a sensitive section — competitor legal/licence copy must not remain
  const $footer = $(
    "footer, [role='contentinfo'], [data-adrival-brand-footer], .footer, #footer",
  ).first();
  if ($footer.length) {
    const footerText = normalize($footer.text());

    if (
      competitor.length > 2 &&
      new RegExp(
        competitor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      ).test(footerText)
    ) {
      issues.push({
        code: "footer_competitor_content",
        message: "Footer still contains the competitor name or legal identity.",
        severity: "error",
        samples: [competitor],
      });
    }

    // AU licence numbers in a non-brand-rebuilt footer are almost always competitor leftovers
    if (
      /\b(acn|afsl|acl)\s*[:#]?\s*\d{5,}/i.test(footerText) &&
      $footer.find("[data-adrival-brand-footer]").length === 0 &&
      !$footer.is("[data-adrival-brand-footer]")
    ) {
      issues.push({
        code: "footer_competitor_licence",
        message: "Footer still contains competitor licence/registration numbers.",
        severity: "error",
        samples:
          footerText.match(/\b(?:acn|afsl|acl)\s*[:#]?\s*\d{5,}/gi) || [],
      });
    }

    if (/compare\s*the\s*market|ctm\s+is\s+the\s+holder/i.test(footerText)) {
      issues.push({
        code: "footer_competitor_content",
        message: "Footer still contains competitor legal disclaimer copy.",
        severity: "error",
        samples: ["compare the market legal block"],
      });
    }

    // Footer page links must not all collapse to the same homepage URL
    const footerHrefs = $footer
      .find("a[href]")
      .toArray()
      .map((el) => ($(el).attr("href") || "").trim())
      .filter(
        (href) =>
          href &&
          !/^mailto:|^tel:|^#|^javascript:/i.test(href) &&
          !/facebook|instagram|linkedin|youtube|tiktok|twitter|x\.com|pinterest|threads/i.test(
            href,
          ),
      );

    if (footerHrefs.length >= 3) {
      const normalizedHomes = footerHrefs.map((h) => {
        try {
          const u = new URL(h, input.businessUrl);
          return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "") || "/"}`.toLowerCase();
        } catch {
          return h.toLowerCase();
        }
      });
      const unique = new Set(normalizedHomes);
      let homePath = "/";
      try {
        homePath =
          `${new URL(input.businessUrl).hostname.replace(/^www\./, "")}/`.toLowerCase();
      } catch {
        // ignore
      }
      const allSame = unique.size === 1;
      const onlyHome =
        allSame &&
        [...unique][0].replace(/\/$/, "") === homePath.replace(/\/$/, "");
      if (onlyHome) {
        issues.push({
          code: "footer_links_collapsed",
          message:
            "Footer links all point to the same homepage URL — unmatched pages should be omitted, not remapped.",
          severity: "error",
          samples: footerHrefs.slice(0, 5),
        });
      }
    }

    // Visible social labels with no real social href (or homepage) are invalid
    $footer.find("a").each((_, el) => {
      const $el = $(el);
      if (/display\s*:\s*none/i.test($el.attr("style") || "")) return;
      const href = ($el.attr("href") || "").trim();
      const label = normalize($el.text());
      const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
      const looksSocial =
        /facebook|instagram|linkedin|youtube|tiktok|twitter|\bx\b|pinterest|threads|follow/i.test(
          `${label} ${className}`,
        );
      if (!looksSocial) return;
      const isRealSocial =
        /facebook\.com|instagram\.com|linkedin\.com|youtube\.com|youtu\.be|tiktok\.com|twitter\.com|x\.com|pinterest\.com|threads\.net/i.test(
          href,
        );
      if (!isRealSocial) {
        issues.push({
          code: "footer_social_invalid",
          message:
            "Footer shows a social handle without a real brand social URL (should be omitted).",
          severity: "error",
          samples: [label || href || "social"],
        });
        return false;
      }
    });
  }

  const errors = issues.filter((i) => i.severity === "error");
  const score = Math.max(0, 100 - errors.length * 25 - (issues.length - errors.length) * 5);
  return { ok: errors.length === 0, score, issues };
}

/**
 * Ask Claude to rewrite only the failing similar strings (and any competitor leftovers).
 * Returns a map keyed by the exact failing sample strings passed in.
 */
export async function repairFailingCopyWithClaude(input: {
  failingSamples: string[];
  competitorName: string;
  brandName: string;
  keyword: string;
  businessUrl: string;
  industry?: string | null;
  userFeedback?: string | null;
}): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const samples = [
    ...new Set(input.failingSamples.map((s) => s.trim()).filter((s) => s.length >= 8)),
  ].slice(0, 30);
  if (!samples.length) return map;

  const client = getAnthropicClient();
  const model = getAnthropicModel();
  const feedback = input.userFeedback?.trim() || "";
  const feedbackRule = feedback
    ? `\n- Also honor USER FEEDBACK: """${feedback.slice(0, 1200)}"""`
    : "";

  const system = `You rewrite landing-page strings that failed originality validation.
Return ONLY JSON:
{ "replacements": [ { "id": 0, "to": "fully new copy" }, ... ] }

Rules:
- Use the numeric id from the input list. Rewrite EVERY id.
- Every "to" must be clearly different wording (new angle, not a light paraphrase).
- Never include competitor name "${input.competitorName}".
- Use brand "${input.brandName}" and keyword "${input.keyword}" where natural.
- Keep similar length (±40%).
- Headlines stay headline-like; paragraphs stay paragraph-like.${feedbackRule}`;

  const completion = await client.messages.create({
    model,
    max_tokens: 4000,
    temperature: 0.9,
    system,
    messages: [
      {
        role: "user",
        content: JSON.stringify(
          {
            brand: input.brandName,
            url: input.businessUrl,
            industry: input.industry || null,
            userFeedback: feedback || null,
            strings: samples.map((text, id) => ({ id, text })),
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
  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      replacements?: Array<{ id?: number; from?: string; to?: string }>;
    };
    for (const row of parsed.replacements || []) {
      const to = (row.to || "").replace(/\s+/g, " ").trim();
      if (!to) continue;
      if (typeof row.id === "number" && samples[row.id]) {
        map.set(samples[row.id], to);
        continue;
      }
      if (row.from && row.from.trim()) {
        map.set(row.from.trim(), to);
      }
    }
  } catch {
    // ignore
  }
  return map;
}

/** Apply from→to replacements with whitespace-tolerant matching. */
export function applyFromToReplacements(html: string, map: Map<string, string>): string {
  if (!map.size) return html;
  const pairs = [...map.entries()]
    .filter(([from, to]) => from && to && from !== to)
    .sort((a, b) => b[0].length - a[0].length);

  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const $ = cheerio.load(html);

  const replaceIn = (raw: string): string => {
    let next = raw;
    for (const [from, to] of pairs) {
      if (next.includes(from)) {
        next = next.split(from).join(to);
        continue;
      }
      // Whitespace-tolerant: collapse runs of space/newlines in the node
      const nRaw = norm(next);
      const nFrom = norm(from);
      if (nFrom.length >= 12 && nRaw.includes(nFrom)) {
        // Rebuild by splitting on normalized form is hard; do regex on flexible whitespace
        const flex = from
          .trim()
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\s+/g, "\\s+");
        try {
          next = next.replace(new RegExp(flex, "g"), to);
        } catch {
          // ignore bad regex
        }
      }
    }
    return next;
  };

  const walk = (nodes: any) => {
    nodes.each((_: number, node: any) => {
      if (node.type === "text") {
        const raw = node.data || "";
        const next = replaceIn(raw);
        if (next !== raw) node.data = next;
        return;
      }
      if (node.type === "tag") {
        const tag = (node.tagName || "").toLowerCase();
        if (tag === "script" || tag === "style") return;
        // Also replace when the whole element text matches (split across text nodes)
        walk($(node).contents());
      }
    });
  };
  walk($.root().contents());

  // Second pass: whole-element text for h1–h3/p when still exact match
  $("h1, h2, h3, p, li, a, button").each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 0 && $el.find("h1,h2,h3,p").length) return;
    const text = norm($el.text());
    for (const [from, to] of pairs) {
      if (text === norm(from)) {
        $el.text(to);
        break;
      }
    }
  });

  return $.html();
}
