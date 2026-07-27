import * as cheerio from "cheerio";

const SENSITIVE_SECTION_RE =
  /testimonial|review|founder|expert|team|ambassador|mascot|meet[-_\s]?the|our[-_\s]?people|leadership|director|ceo|spokesperson|celebrity|partner[-_\s]?story|customer[-_\s]?story|case[-_\s]?stud/i;

const SENSITIVE_IMAGE_RE =
  /portrait|headshot|founder|expert|team|mascot|meerkat|aleksandr|koch|spokesperson|ambassador|celebrity|avatar|staff|employee|meet/i;

function normalizeText(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Remove / neutralize competitor identity that would create copyright risk:
 * people photos, mascots, founder/expert blocks, leftover competitor brand mentions.
 */
export function sanitizeCompetitorIdentity(
  html: string,
  options: {
    competitorName: string;
    brandName: string;
    brandImageUrls?: string[];
    competitorHost?: string | null;
  },
): { html: string; removedBlocks: number; replacedImages: number } {
  const $ = cheerio.load(html);
  let removedBlocks = 0;
  let replacedImages = 0;
  const brandImages = (options.brandImageUrls || []).filter(Boolean);
  let brandImgIdx = 0;

  const nextBrandImage = () => {
    if (!brandImages.length) return null;
    const src = brandImages[brandImgIdx % brandImages.length];
    brandImgIdx += 1;
    return src;
  };

  // Remove or scrub sensitive sections
  $("section, article, div, aside, li, figure").each((_, el) => {
    const $el = $(el);
    const classId = `${$el.attr("class") || ""} ${$el.attr("id") || ""}`;
    const text = normalizeText($el.text()).slice(0, 400);
    const sensitive =
      SENSITIVE_SECTION_RE.test(classId) ||
      SENSITIVE_SECTION_RE.test(text) ||
      new RegExp(options.competitorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(
        text,
      );

    if (!sensitive) return;

    // Don't nuke the whole page body/header/footer
    if ($el.is("body, html, header, footer, nav, main")) return;
    // Avoid removing huge wrappers
    if ($el.find("section, article").length > 3) return;
    if (normalizeText($el.text()).length > 1200 && !$el.is("section, article, figure")) {
      return;
    }

    const hasPersonImg =
      $el.find("img").toArray().some((img) => {
        const $img = $(img);
        const hay = `${$img.attr("src") || ""} ${$img.attr("alt") || ""} ${$img.attr("class") || ""}`;
        // Only treat as person/mascot imagery — never wipe a section just because
        // an image is hosted on the competitor domain.
        return SENSITIVE_IMAGE_RE.test(hay);
      }) || /david koch|compare the market|meerkat|aleksandr/i.test(text);

    // Only replace explicit people / endorsement blocks — not every "team" mention
    if (
      hasPersonImg ||
      /testimonial|founder|expert|meet the|director\s+of|ceo\b|spokesperson|mascot/i.test(
        classId + " " + text,
      )
    ) {
      // Replace block with a brand-safe placeholder keeping rough height
      const placeholderImg = nextBrandImage();
      const replacement = placeholderImg
        ? `<div data-adrival-safe-block="1" style="padding:28px 20px;text-align:center;background:rgba(0,0,0,.03);border-radius:12px;margin:12px 0;">
            <img src="${placeholderImg}" alt="${options.brandName}" style="max-width:min(420px,90%);max-height:220px;object-fit:cover;border-radius:10px;" />
            <p style="margin:14px 0 0;font:500 15px/1.45 system-ui,sans-serif;">Guidance from the ${options.brandName} team — built around your goals, not celebrity endorsements.</p>
          </div>`
        : `<div data-adrival-safe-block="1" style="padding:28px 20px;text-align:center;background:rgba(0,0,0,.03);border-radius:12px;margin:12px 0;">
            <p style="margin:0;font:500 15px/1.45 system-ui,sans-serif;">Talk to ${options.brandName} specialists for clear, practical home-loan advice.</p>
          </div>`;
      $el.replaceWith(replacement);
      removedBlocks += 1;
    }
  });

  // Replace remaining sensitive images globally
  $("img").each((_, el) => {
    const $el = $(el);
    if ($el.attr("data-adrival-logo") === "1") return;
    if ($el.closest("[data-adrival-logo-wrap],[data-adrival-footer-logo],[data-adrival-safe-block]").length) {
      return;
    }
    const hay = `${$el.attr("src") || ""} ${$el.attr("alt") || ""} ${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
    const fromCompetitor = Boolean(
      options.competitorHost && hay.toLowerCase().includes(options.competitorHost),
    );
    // Do not strip every competitor-hosted image — only sensitive person/mascot imagery
    if (!SENSITIVE_IMAGE_RE.test(hay)) return;
    void fromCompetitor;

    // Skip tiny icons
    const width = Number($el.attr("width") || 0);
    const height = Number($el.attr("height") || 0);
    if ((width > 0 && width <= 40) || (height > 0 && height <= 40)) return;

    const next = nextBrandImage();
    if (next) {
      $el.attr("src", next);
      $el.removeAttr("srcset");
      $el.attr("alt", options.brandName);
      replacedImages += 1;
    } else {
      $el.remove();
      replacedImages += 1;
    }
  });

  // Strip competitor brand mentions leftover in text nodes
  const competitor = options.competitorName.trim();
  if (competitor.length > 2) {
    const re = new RegExp(
      competitor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    );
    const walk = (nodes: any) => {
      nodes.each((_: number, node: any) => {
        if (node.type === "text") {
          const raw = node.data || "";
          const next = raw.replace(re, options.brandName);
          if (next !== raw) node.data = next;
          return;
        }
        if (node.type === "tag") {
          const tag = (node.tagName || "").toLowerCase();
          if (tag === "script" || tag === "style") return;
          walk($(node).contents());
        }
      });
    };
    walk($.root().contents());
  }

  // Neutralize obvious competitor contact numbers left in help bars (AU 1800 etc. often competitor)
  $("a[href^='tel:']").each((_, el) => {
    const $el = $(el);
    const href = ($el.attr("href") || "").toLowerCase();
    // Keep only if we already rewrote via brand assets; otherwise leave for later brand pass
    if (/compare|ownup|competitor/i.test(href)) {
      $el.attr("href", "#contact");
    }
  });

  return { html: $.html(), removedBlocks, replacedImages };
}
