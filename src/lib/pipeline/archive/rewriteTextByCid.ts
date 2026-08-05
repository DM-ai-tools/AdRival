import * as cheerio from "cheerio";
import { clipToCompletePhrase, lengthBudgetForRole } from "../slotTextBudget";
import {
  getAnthropicClient,
  getAnthropicModel,
} from "../../anthropic/client";

export type CidTextNode = {
  id: string;
  role: string;
  text: string;
  maxLen: number;
  minLen: number;
  inFooter?: boolean;
};

const TEXT_ROLES = new Set([
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
  "td",
  "th",
  "figcaption",
]);

const FOOTER_SEL =
  "footer, [role='contentinfo'], .footer, #footer, [class*='Footer'], [data-adrival-brand-footer]";

function normalizeText(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Replace visible text in a node. Never leave competitor copy beside the new text.
 * Preserves icon/svg/img chrome inside buttons/controls.
 */
function setTextPreservingStructure(
  $: ReturnType<typeof cheerio.load>,
  $el: cheerio.Cheerio<any>,
  text: string,
): void {
  const tag = String(($el.get(0) as { tagName?: string } | undefined)?.tagName || "")
    .toLowerCase();

  const isChrome = ($c: cheerio.Cheerio<any>) => {
    if ($c.is("svg, i, img, br, [aria-hidden='true']")) return true;
    const cls = `${$c.attr("class") || ""}`;
    if (/\bicon\b|chevron|caret|arrow/i.test(cls) && normalizeText($c.text()).length < 2) {
      return true;
    }
    return (
      $c.children("svg, i, img").length > 0 &&
      normalizeText($c.text()).length < 2
    );
  };

  const chromeHtml = $el
    .children()
    .toArray()
    .filter((c) => isChrome($(c)))
    .map((c) => $.html(c))
    .join("");

  const childTags = $el
    .children()
    .toArray()
    .map((c) => String((c as { tagName?: string }).tagName || "").toLowerCase());
  const onlyFormatOrChrome =
    childTags.length === 0 ||
    childTags.every((t) =>
      ["span", "strong", "em", "b", "small", "svg", "i", "img", "br", "a"].includes(
        t,
      ),
    );

  // Headings / paragraphs / simple wrappers: wipe and rewrite (keep icon chrome)
  if (
    $el.children().length === 0 ||
    /^(h1|h2|h3|h4|h5|h6|p|label|li)$/i.test(tag) ||
    onlyFormatOrChrome
  ) {
    const safe = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    if (chromeHtml) {
      $el.html(`${safe}${chromeHtml}`);
    } else {
      $el.text(text);
    }
    return;
  }

  // Interactive controls: clear ALL direct text, write into first text child, blank siblings
  $el.contents().each((_, child) => {
    const node = child as { type?: string; data?: string };
    if (node.type === "text") node.data = "";
  });

  const $textChild = $el
    .children("span, p, strong, em, label, a, small")
    .filter((_, c) => !isChrome($(c)))
    .first();

  if ($textChild.length) {
    $el.children("span, p, strong, em, label, a, small").each((_, c) => {
      const $c = $(c);
      if (isChrome($c) || $c[0] === $textChild[0]) return;
      if ($c.children().filter((_, x) => !isChrome($(x))).length === 0) {
        $c.text("");
      } else {
        $c.contents().each((__, ch) => {
          const n = ch as { type?: string; data?: string };
          if (n.type === "text") n.data = "";
        });
      }
    });
    if ($textChild.children().filter((_, x) => !isChrome($(x))).length === 0) {
      $textChild.text(text);
    } else {
      setTextPreservingStructure($, $textChild, text);
    }
    return;
  }

  // Fallback: append escaped text after cleared nodes (never prepend beside leftovers)
  const safe = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  $el.append(safe);
}

function lengthBudget(len: number, role?: string): { minLen: number; maxLen: number } {
  return lengthBudgetForRole(len, role || "body");
}

/**
 * Stamp leaf-ish text elements with data-cid so Claude never sees/emits markup.
 * Footer nodes are skipped — footer is remapped in place from brand assets.
 */
export function stampTextCids(html: string): {
  html: string;
  nodes: CidTextNode[];
} {
  const $ = cheerio.load(html);
  // If already stamped (content-phase archive), collect existing nodes — do not re-id
  if ($("[data-cid]").length >= 3) {
    return collectStampedCidNodes($.html());
  }

  const nodes: CidTextNode[] = [];
  let i = 0;
  const seenNormalized = new Set<string>();

  $("h1,h2,h3,h4,h5,h6,p,li,a,button,label,figcaption,td,th,span,strong,em").each(
    (_, el) => {
      const tag = ((el as { tagName?: string }).tagName || "").toLowerCase();
      if (!TEXT_ROLES.has(tag)) return;
      const $el = $(el);
      if ($el.closest("script, style, noscript, svg, [data-cid]").length) return;
      // Footer copy is remapped in place — do not CID-stamp it
      if ($el.closest(FOOTER_SEL).length) return;

      // Skip deep wrappers that contain other text tags (except headings/CTAs)
      if (
        !["a", "button", "label", "h1", "h2", "h3", "h4", "h5", "h6"].includes(
          tag,
        ) &&
        $el.find("h1,h2,h3,h4,p,li,a,button").length > 0
      ) {
        return;
      }

      const text = normalizeText($el.text());
      if (text.length < 2 || text.length > 900) return;
      if (/^(home|menu|skip to content|©)$/i.test(text)) return;

      // Avoid stamping the same visible string twice (duplicate hero/slide copy)
      const key = `${tag}:${text.toLowerCase()}`;
      if (text.length >= 18 && seenNormalized.has(key)) {
        // Still mark so write-back / collapse can target it, but don't ask Claude twice
        const id = `n${i++}`;
        $el.attr("data-cid", id);
        $el.attr("data-cid-dup", "1");
        nodes.push({
          id,
          role: tag,
          text,
          ...lengthBudget(text.length, tag),
        });
        if (nodes.length >= 320) return false;
        return;
      }
      if (text.length >= 18) seenNormalized.add(key);

      const id = `n${i++}`;
      $el.attr("data-cid", id);
      nodes.push({
        id,
        role: tag,
        text,
        ...lengthBudget(text.length, tag),
      });
      if (nodes.length >= 320) return false;
    },
  );

  return { html: $.html(), nodes };
}

/**
 * Read existing data-cid stamps without changing ids (content↔design fidelity).
 */
export function collectStampedCidNodes(html: string): {
  html: string;
  nodes: CidTextNode[];
} {
  const $ = cheerio.load(html);
  const nodes: CidTextNode[] = [];
  $("[data-cid]").each((_, el) => {
    const $el = $(el);
    const id = ($el.attr("data-cid") || "").trim();
    if (!id) return;
    if ($el.closest(FOOTER_SEL).length && !$el.attr("data-cid")) return;
    const tag = ((el as { tagName?: string }).tagName || "p").toLowerCase();
    const text = normalizeText($el.text());
    if (text.length < 1) return;
    nodes.push({
      id,
      role: tag,
      text,
      ...lengthBudget(text.length, tag),
      inFooter: $el.closest(FOOTER_SEL).length > 0,
    });
  });
  // Stable order by n# when possible
  nodes.sort((a, b) => {
    const na = Number(/^n(\d+)$/i.exec(a.id)?.[1] ?? 99999);
    const nb = Number(/^n(\d+)$/i.exec(b.id)?.[1] ?? 99999);
    return na - nb;
  });
  return { html: $.html(), nodes };
}

/**
 * Collapse accidental doubled phrases inside a single element
 * (e.g. "Get rates Get rates" from writing the same string into every text node).
 */
export function collapseDoubledElementText(html: string): {
  html: string;
  collapsed: number;
} {
  const $ = cheerio.load(html);
  let collapsed = 0;

  $("h1,h2,h3,h4,h5,h6,p,li,a,button,label,span,strong,em,td,th,figcaption").each(
    (_, el) => {
      const $el = $(el);
      if ($el.closest("script, style, noscript, svg").length) return;
      // Only fix leaves or cid-stamped nodes — avoid nuking large wrappers
      if (
        $el.children().length > 0 &&
        !$el.attr("data-cid") &&
        $el.find("h1,h2,h3,p,li").length > 0
      ) {
        return;
      }

      const raw = normalizeText($el.text());
      if (raw.length < 10) return;

      let next = raw;
      // Exact half-and-half duplicate: "ABCABC" / "ABC ABC"
      const compact = next.replace(/\s+/g, "");
      if (compact.length >= 12 && compact.length % 2 === 0) {
        const half = compact.length / 2;
        if (compact.slice(0, half) === compact.slice(half)) {
          next = normalizeText(next.slice(0, Math.ceil(next.length / 2)));
        }
      }
      // Repeated phrase: "Hello world Hello world"
      const phraseDup = next.match(/^(.{8,}?)\s+\1$/i);
      if (phraseDup) {
        next = normalizeText(phraseDup[1]);
      }
      // Repeated sentence fragment glued without space detection via regex
      const glued = next.replace(/(.{12,}?)\1+/gi, "$1");
      if (glued.length >= 8 && glued.length < next.length) {
        next = normalizeText(glued);
      }

      if (next !== raw && next.length >= 4) {
        $el.text(next);
        collapsed += 1;
      }
    },
  );

  return { html: $.html(), collapsed };
}

/**
 * Ensure substantial rewritten strings are unique across nodes.
 * Duplicate short CTAs are allowed; headlines/body must differ.
 */
export function ensureUniqueReplacements(
  nodes: CidTextNode[],
  replacements: Map<string, string>,
): Map<string, string> {
  const out = new Map(replacements);
  const used = new Set<string>();

  for (const node of nodes) {
    let text = out.get(node.id);
    if (!text) continue;
    text = normalizeText(text);

    if (["a", "button"].includes(node.role) && text.length < 40) {
      out.set(node.id, text);
      continue;
    }
    if (text.length < 20) {
      out.set(node.id, text);
      continue;
    }

    let key = text.toLowerCase();
    if (!used.has(key)) {
      used.add(key);
      out.set(node.id, text);
      continue;
    }

    const alts = [
      clipToCompletePhrase(normalizeText(`Also: ${text}`), node.maxLen, {
        role: node.role,
      }),
      clipToCompletePhrase(normalizeText(`${text} — next steps`), node.maxLen, {
        role: node.role,
      }),
      clipToCompletePhrase(normalizeText(`Another option: ${text}`), node.maxLen, {
        role: node.role,
      }),
      clipToCompletePhrase(normalizeText(`Explore: ${text}`), node.maxLen, {
        role: node.role,
      }),
    ];
    let variant = text;
    for (const pick of alts) {
      if (pick.length >= Math.min(node.minLen, 12) && !used.has(pick.toLowerCase())) {
        variant = pick;
        break;
      }
      variant = pick;
    }
    used.add(variant.toLowerCase());
    out.set(node.id, variant);
  }

  return out;
}

/**
 * Apply Claude's / approved {id,newText} map back onto data-cid elements.
 * When forceApply is true (approved content path), always write — do not keep
 * competitor originals just because length is slightly outside budget.
 */
export function applyCidReplacements(
  html: string,
  nodes: CidTextNode[],
  replacements: Map<string, string>,
  options?: { forceApply?: boolean },
): { html: string; applied: number } {
  const $ = cheerio.load(html);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let applied = 0;
  const force = Boolean(options?.forceApply);

  $("[data-cid]").each((_, el) => {
    const $el = $(el);
    const id = $el.attr("data-cid") || "";
    const meta = byId.get(id);
    if (!meta) return;

    // Duplicate stamped copies of the same original string: clear secondary
    // instances so the page doesn't show the same block twice.
    // Never hide FAQ/accordion items — answers must stay replaceable + interactive.
    const inFaq = Boolean(
      $el.closest(
        ".accordion, .accordion-item, .faq, .faq-item, [class*='faq'], [class*='accordion'], details",
      ).length,
    );
    if ($el.attr("data-cid-dup") === "1" && !inFaq) {
      const primary = nodes.find(
        (n) =>
          n.id !== id &&
          n.role === meta.role &&
          normalizeText(n.text).toLowerCase() ===
            normalizeText(meta.text).toLowerCase(),
      );
      if (primary && replacements.has(primary.id)) {
        const $block = $el.closest(
          "section, article, .swiper-slide, [class*='slide'], [class*='card'], li, div",
        );
        if (
          $block.length &&
          !$block.is("body, html, main, header, nav") &&
          !$block.closest(
            ".accordion, .accordion-item, .faq, .faq-item, [class*='faq'], [class*='accordion'], details",
          ).length &&
          normalizeText($block.text()).length <
            normalizeText(meta.text).length * 3 + 80
        ) {
          $block.attr("data-adrival-dup-removed", "1");
          $block.css("display", "none");
          $block.attr("aria-hidden", "true");
        } else {
          $el.text("");
          $el.css("display", "none");
          $el.attr("aria-hidden", "true");
        }
        return;
      }
    }

    const next = replacements.get(id);
    if (!next) return;

    let text = normalizeText(next);
    // Approved path: never hard-truncate mid-sentence — approved copy wins
    if (!force) {
      if (text.length > meta.maxLen) {
        text = clipToCompletePhrase(text, meta.maxLen, { role: meta.role });
      }
      if (text.length < Math.min(meta.minLen, 8) && text.length < meta.text.length) {
        // too short — keep original to avoid layout collapse
        return;
      }
    }

    // Single write — preserve icons/chevrons inside interactive controls
    setTextPreservingStructure($, $el, text);
    applied += 1;
  });

  return { html: $.html(), applied };
}

/**
 * Claude text-only rewrite. Model never receives or returns HTML tags.
 * temperature: 0; length budgets per node.
 */
export async function rewriteTextsByCid(input: {
  nodes: CidTextNode[];
  brandName: string;
  businessUrl: string;
  keyword: string;
  competitorName: string;
  userFeedback?: string | null;
  industry?: string | null;
}): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!input.nodes.length) return map;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required for CID text rewrite");
  }

  const client = getAnthropicClient();
  const model = getAnthropicModel();
  const feedback = input.userFeedback?.trim() || "";

  // Skip pure duplicate stamps — they are hidden in apply
  const rewriteNodes = input.nodes.filter((n) => {
    // dup nodes share text with an earlier node of same role
    const earlier = input.nodes.find(
      (o) =>
        o.id !== n.id &&
        Number(o.id.slice(1)) < Number(n.id.slice(1)) &&
        o.role === n.role &&
        normalizeText(o.text).toLowerCase() ===
          normalizeText(n.text).toLowerCase() &&
        n.text.length >= 18,
    );
    return !earlier;
  });

  const system = `You rewrite landing-page copy for a NEW brand. You receive ONLY text nodes with ids.
Return ONLY JSON: { "replacements": [ { "id": "n0", "newText": "..." }, ... ] }

Hard rules:
1) Never output HTML tags, markdown, or ids you were not given.
2) Respect each node's minLen/maxLen (±15% of original). newText MUST be within that range.
3) Preserve role: h1 stays headline-like, button/a stay CTA-like, p stays body copy.
4) Never mention competitor "${input.competitorName}".
5) Use brand "${input.brandName}" and keyword "${input.keyword}" where natural.
6) Do not invent regulated guarantees or celebrity endorsements.
7) Rewrite meaningfully — not light paraphrases.
8) UNIQUENESS: Every newText for h1/h2/h3/p/li (length ≥ 20) MUST be distinct from every other newText in this response. Do not reuse the same headline or paragraph for multiple ids. Carousel/slide duplicates must each get a fresh angle.
9) Never concatenate the same phrase twice inside one newText.
${feedback ? `10) HIGHEST PRIORITY user feedback:\n"""${feedback.slice(0, 2000)}"""` : ""}`;

  for (let i = 0; i < rewriteNodes.length; i += 50) {
    const batch = rewriteNodes.slice(i, i + 50);
    const completion = await client.messages.create({
      model,
      max_tokens: 4500,
      temperature: 0,
      system,
      messages: [
        {
          role: "user",
          content: JSON.stringify(
            {
              brand: input.brandName,
              url: input.businessUrl,
              keyword: input.keyword,
              industry: input.industry || null,
              userFeedback: feedback || null,
              nodes: batch.map((n) => ({
                id: n.id,
                role: n.role,
                text: n.text,
                minLen: n.minLen,
                maxLen: n.maxLen,
              })),
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
    if (!jsonMatch) continue;
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        replacements?: Array<{ id?: string; newText?: string }>;
      };
      for (const row of parsed.replacements || []) {
        if (row.id && row.newText?.trim()) {
          let t = normalizeText(row.newText);
          // Strip accidental self-duplication inside one string
          const phraseDup = t.match(/^(.{8,}?)\s+\1$/i);
          if (phraseDup) t = normalizeText(phraseDup[1]);
          map.set(row.id, t);
        }
      }
    } catch {
      console.warn("[cid] failed to parse rewrite batch", i);
    }
  }

  return ensureUniqueReplacements(input.nodes, map);
}
