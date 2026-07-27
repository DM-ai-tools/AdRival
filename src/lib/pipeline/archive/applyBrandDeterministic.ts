import * as cheerio from "cheerio";
import type { BrandTokens } from "./brandTokens";
import { buildColorMap } from "./brandTokens";
import type { ArchivedPage } from "./capturePage";
import { detectSocialNetwork } from "../brandAssets";
import { replaceColorEverywhere } from "./colorReplace";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic brand application — no AI on markup.
 * Colors, fonts, logo src (keep dimensions), link rules.
 */
export function applyBrandDeterministic(input: {
  html: string;
  archive: ArchivedPage;
  brand: BrandTokens;
  businessUrl: string;
  brandName: string;
}): { html: string; stats: Record<string, number> } {
  const stats = {
    colors: 0,
    logos: 0,
    fonts: 0,
    links: 0,
    socials: 0,
  };

  let html = input.html;
  const colorMap = buildColorMap(input.archive.paintedColors, input.brand.colors);

  // Also collect hex literals from the document for exact replacement
  const hexes = new Set<string>();
  for (const m of html.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const full = m[0].length === 4
      ? `#${m[1][0]}${m[1][0]}${m[1][1]}${m[1][1]}${m[1][2]}${m[1][2]}`.toUpperCase()
      : m[0].toUpperCase();
    hexes.add(full);
  }

  const userTargets = [
    input.brand.colors.primary,
    input.brand.colors.secondary,
    input.brand.colors.accent,
  ];
  let hi = 0;
  for (const hex of hexes) {
    // skip light/dark neutrals
    const n = hex.replace("#", "");
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (lum > 0.92 || lum < 0.08) continue;
    if (Math.max(r, g, b) - Math.min(r, g, b) < 18) continue;
    if (!colorMap.has(hex)) {
      colorMap.set(hex, userTargets[Math.min(hi, userTargets.length - 1)]);
      hi += 1;
    }
    if (hi >= 14) break;
  }

  for (const [from, to] of colorMap.entries()) {
    if (/^#/i.test(from)) {
      html = replaceColorEverywhere(html, from, to);
      stats.colors += 1;
    } else if (/rgb/i.test(from)) {
      // replace exact rgb(...) strings in CSS
      html = html.split(from).join(to);
      stats.colors += 1;
    }
  }

  const $ = cheerio.load(html);

  // Fonts: swap font-family declarations + inject @font-face stack hint
  if (input.brand.fonts[0]) {
    const family = input.brand.fonts[0];
    const stack = `"${family}", system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    $("style").each((_, el) => {
      const css = $(el).html() || "";
      const next = css.replace(
        /font-family\s*:\s*[^;}{]+/gi,
        `font-family: ${stack}`,
      );
      if (next !== css) {
        $(el).html(next);
        stats.fonts += 1;
      }
    });
    $("[style*='font-family']").each((_, el) => {
      const style = $(el).attr("style") || "";
      $(el).attr(
        "style",
        style.replace(/font-family\s*:\s*[^;]+/gi, `font-family: ${stack}`),
      );
      stats.fonts += 1;
    });
    // Inject brand font preference
    $("head").append(
      `<style id="adrival-font-swap">html,body,button,input,textarea,select{font-family:${stack}!important}</style>`,
    );
  }

  // Logo: replace src only — preserve width/height/style
  if (input.brand.logoUrl) {
    let logoHits = 0;
    $("img").each((_, el) => {
      if (logoHits >= 3) return;
      const $el = $(el);
      const hay = `${$el.attr("src") || ""} ${$el.attr("alt") || ""} ${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
      const inHeader =
        $el.closest("header, nav, [role='banner'], .navbar, .logo").length > 0;
      if (!/logo|brand|wordmark/i.test(hay) && !inHeader) return;
      if (/icon|sprite|avatar|payment|flag/i.test(hay) && !/logo/i.test(hay)) {
        return;
      }
      $el.attr("src", input.brand.logoUrl!);
      $el.removeAttr("srcset");
      $el.attr("alt", input.brandName);
      $el.attr("data-adrival-logo", "1");
      logoHits += 1;
      stats.logos += 1;
    });
    // SVG logo slots → replace with img keeping approximate size
    if (logoHits === 0) {
      $("header svg, nav svg, a.logo svg, .navbar-brand svg")
        .first()
        .each((_, el) => {
          const $el = $(el);
          const w = $el.attr("width") || "140";
          const h = $el.attr("height") || "40";
          $el.replaceWith(
            `<img src="${input.brand.logoUrl}" alt="${input.brandName}" width="${w}" height="${h}" data-adrival-logo="1" style="object-fit:contain;max-height:${h}px;width:auto;" />`,
          );
          stats.logos += 1;
        });
    }
  }

  // Links: domain swap + CTA routing; socials only to real brand handles
  let competitorHost = "";
  try {
    competitorHost = new URL(input.archive.finalUrl).hostname
      .replace(/^www\./i, "")
      .toLowerCase();
  } catch {
    // ignore
  }
  const brandSocialByNet = new Map<string, string>();
  for (const s of input.brand.socialLinks) {
    const net = detectSocialNetwork(s.href, s.label);
    if (net && !brandSocialByNet.has(net)) brandSocialByNet.set(net, s.href);
  }

  $("a[href]").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href") || "";
    if (!href || /^mailto:|^tel:|^#|^javascript:/i.test(href)) return;

    const label = ($el.text() || "").replace(/\s+/g, " ").trim();
    const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
    const net = detectSocialNetwork(href, label, className);
    if (net) {
      const brandSocial = brandSocialByNet.get(net);
      if (brandSocial) {
        $el.attr("href", brandSocial);
        $el.attr("target", "_blank");
        $el.attr("rel", "noopener noreferrer");
        stats.socials += 1;
      } else {
        $el.remove(); // do not show competitor social without a brand handle
        stats.socials += 1;
      }
      return;
    }

    try {
      const u = new URL(href, input.archive.finalUrl);
      const host = u.hostname.replace(/^www\./i, "").toLowerCase();
      if (competitorHost && host.includes(competitorHost)) {
        // Domain swap → user site (same path when possible is skipped; route home)
        $el.attr("href", input.businessUrl);
        stats.links += 1;
        return;
      }
    } catch {
      // ignore
    }

    // CTA-looking buttons → business URL
    if (
      /btn|button|cta|primary/i.test(className) ||
      /get started|book|apply|download|sign up|try|demo|call/i.test(label)
    ) {
      $el.attr("href", input.businessUrl);
      stats.links += 1;
    }
  });

  // Rebuild a clean social row if we have brand socials and footer exists
  const $footer = $("footer, [role='contentinfo']").first();
  if ($footer.length && input.brand.socialLinks.length) {
    $footer.find("[data-adrival-social]").remove();
    const socialHtml = input.brand.socialLinks
      .slice(0, 8)
      .map(
        (s) =>
          `<a href="${s.href}" target="_blank" rel="noopener noreferrer" data-adrival-social-link="1" style="margin-right:12px;">${s.label}</a>`,
      )
      .join("");
    $footer.append(
      `<div data-adrival-social="1" style="padding:12px 0;">${socialHtml}</div>`,
    );
  }

  // Brand CSS variables overlay (surgical, layout-preserving)
  const c = input.brand.colors;
  const overlay = `<style id="adrival-brand-tokens">
:root{
  --adrival-primary:${c.primary};
  --adrival-secondary:${c.secondary};
  --adrival-accent:${c.accent};
  --primary:${c.primary};
  --brand:${c.primary};
  --accent:${c.accent};
}
</style>
<meta name="theme-color" content="${c.primary}">
<meta name="adrival-brand-source" content="${(c.source || "brand").replace(/"/g, "")}">`;

  let out = $.html();
  out = out.replace(/<style id="adrival-brand-tokens">[\s\S]*?<\/style>/gi, "");
  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, `${overlay}</head>`);
  } else {
    out = overlay + out;
  }

  void escapeRegExp;
  return { html: out, stats };
}
