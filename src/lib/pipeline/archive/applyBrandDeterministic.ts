import * as cheerio from "cheerio";
import type { BrandTokens } from "./brandTokens";
import { buildColorMap } from "./brandTokens";
import type { ArchivedPage } from "./capturePage";
import { detectSocialNetwork } from "../brandAssets";
import { replaceColorEverywhere } from "./colorReplace";
import { injectBrandColorOverlay } from "../brandColorOverlay";
import {
  collectRoutableBrandLinks,
  pickCtaHref,
  resolveBrandPageHref,
} from "../brandLinkRouting";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Partner / press / client logo strips — keep as-is (neither brand logo nor AI). */
export function isPartnerLogoContext($el: cheerio.Cheerio<any>): boolean {
  return (
    $el.closest(
      "[class*='partner'], [class*='Partner'], [class*='client'], [class*='Client'], [class*='press'], [class*='Press'], [class*='as-seen'], [class*='asseen'], [class*='trusted-by'], [class*='trustedby'], [class*='award'], [class*='certif'], [class*='accreditation'], [class*='media-logo'], [class*='logo-cloud'], [class*='logo-wall'], [class*='brands-row']",
    ).length > 0
  );
}

/**
 * True when this <img> is a site brand mark (header/nav/footer/identity),
 * not a photo that should get AI replacement.
 */
export function isSiteLogoCandidate(
  $el: cheerio.Cheerio<any>,
  src: string,
  alt: string,
  className: string,
): boolean {
  if (isPartnerLogoContext($el)) return false;

  const hay = `${src.slice(0, 220)} ${alt} ${className}`.toLowerCase();
  // Photos / people / scene content — never treat as logo
  if (
    /handshake|review|testimonial|people|portrait|photo|stock|hero-img|hero-image|team-photo|office|clinic|patient|smile|before|after|gallery|unsplash|pexels/i.test(
      hay,
    )
  ) {
    return false;
  }

  const inBrandChrome =
    $el.closest(
      "header, nav, [role='banner'], .navbar, .header, .site-header, .masthead, footer, [role='contentinfo'], a.logo, .navbar-brand, [class*='site-logo'], [class*='brand-logo'], [class*='Logo']",
    ).length > 0;
  const inLogoLink = $el.closest(
    "a.logo, .navbar-brand, a[class*='logo'], [class*='navbar-brand'], [class*='site-logo'], [class*='brand-logo']",
  ).length;

  // Explicit logo / wordmark naming
  if (/logo|wordmark|logotype|site-logo|navbar-brand|brand-mark/i.test(hay)) {
    // In main content "logo" may be a section heading image — only accept if chrome or small
    const width = Number($el.attr("width") || 0);
    const height = Number($el.attr("height") || 0);
    if (inBrandChrome || inLogoLink) return true;
    if (height > 0 && height <= 140) return true;
    if (width > 0 && width <= 320 && (height === 0 || height <= 160)) return true;
    if (/^data:image\/svg/i.test(src) || /\.svg(\?|#|$)/i.test(src)) return true;
    return false;
  }

  if (!inBrandChrome && !inLogoLink) return false;
  // Nav menu icons are not logos
  if (
    $el.closest("li, button, .menu, .nav-item, .nav-link, .mobile-nav").length &&
    !inLogoLink
  ) {
    return false;
  }

  const width = Number($el.attr("width") || 0);
  const height = Number($el.attr("height") || 0);
  if (height > 0 && height <= 120) return true;
  if (width > 0 && width <= 280 && (height === 0 || height <= 140)) return true;
  if (
    (width === 0 && height === 0 && /\.(svg|png|webp)(\?|#|$)/i.test(src)) ||
    /^data:image\/svg/i.test(src)
  ) {
    return true;
  }
  if (inLogoLink) return true;
  return false;
}

/** @deprecated use isSiteLogoCandidate */
function isHeaderLogoCandidate(
  $el: cheerio.Cheerio<any>,
  src: string,
  alt: string,
  className: string,
): boolean {
  return isSiteLogoCandidate($el, src, alt, className);
}

/**
 * Apply brand logo to header/nav marks. Exported so design can re-run after image embed.
 */
export function applyBrandLogoToHtml(
  html: string,
  input: { logoUrl: string; brandName: string; businessUrl: string },
): { html: string; logos: number } {
  const $ = cheerio.load(html);
  const logos = applyBrandLogoMarks($, input);
  return { html: $.html(), logos };
}

function applyBrandLogoMarks(
  $: cheerio.CheerioAPI,
  input: { logoUrl: string; brandName: string; businessUrl: string },
): number {
  let logoHits = 0;
  const logoUrl = input.logoUrl;

  const stampLogoImg = ($el: cheerio.Cheerio<any>) => {
    // Logos win over AI slots — reclaim any mistaken gen stamps
    $el.removeAttr("data-adrival-gen-id");
    $el.removeAttr("data-adrival-image");
    $el.attr("src", logoUrl);
    $el.removeAttr("srcset");
    $el.removeAttr("sizes");
    $el.removeAttr("data-src");
    $el.removeAttr("data-lazy-src");
    $el.attr("alt", input.brandName);
    $el.attr("data-adrival-logo", "1");
    const $picture = $el.parent("picture");
    if ($picture.length) {
      $picture.find("source").each((_: number, srcEl: any) => {
        $(srcEl).attr("srcset", logoUrl);
        $(srcEl).attr("data-adrival-logo", "1");
      });
    }
    const style = $el.attr("style") || "";
    if (!/object-fit/i.test(style)) {
      $el.attr(
        "style",
        `${style}${style && !style.trim().endsWith(";") ? ";" : ""}object-fit:contain;`,
      );
    }
    logoHits += 1;
  };

  // Always refresh previously stamped logos
  $("img[data-adrival-logo]").each((_, el) => {
    stampLogoImg($(el));
  });

  $("img").each((_, el) => {
    if (logoHits >= 24) return;
    const $el = $(el);
    if ($el.attr("data-adrival-logo")) return;
    const src = $el.attr("src") || "";
    const alt = $el.attr("alt") || "";
    const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
    if (!isSiteLogoCandidate($el, src, alt, className)) return;
    if (
      /icon|sprite|avatar|payment|flag|favicon/i.test(`${src} ${alt}`) &&
      !/logo/i.test(`${src} ${alt} ${className}`)
    ) {
      return;
    }
    stampLogoImg($el);
  });

  // picture/source logos in header / nav / footer brand areas
  $(
    "header picture source, nav picture source, .navbar picture source, footer picture source, a.logo picture source, .navbar-brand picture source",
  ).each((_, el) => {
    const $el = $(el);
    if ($el.attr("srcset") || $el.attr("data-adrival-logo")) {
      $el.attr("srcset", logoUrl);
      $el.attr("data-adrival-logo", "1");
      logoHits += 1;
    }
  });

  // SVG wordmarks in brand chrome → replace with brand <img>
  $(
    "header svg, nav svg, footer svg, a.logo svg, .navbar-brand svg, [class*='site-logo'] svg, [class*='brand-logo'] svg",
  ).each((_, el) => {
    if (logoHits >= 24) return;
    const $el = $(el);
    if ($el.closest("[data-adrival-logo]").length) return;
    if (isPartnerLogoContext($el)) return;
    // Skip large illustrative SVGs
    const w = Number($el.attr("width") || 0);
    const h = Number($el.attr("height") || 0);
    if ((w && w > 400) || (h && h > 200)) return;
    if (
      $el.closest("li, button, .menu, .nav-item").length &&
      !$el.closest("a.logo, .navbar-brand, [class*='logo']").length
    ) {
      return;
    }
    const width = $el.attr("width") || "140";
    const height = $el.attr("height") || "40";
    $el.replaceWith(
      `<img src="${logoUrl}" alt="${input.brandName}" width="${width}" height="${height}" data-adrival-logo="1" style="object-fit:contain;max-height:${height}px;width:auto;" />`,
    );
    logoHits += 1;
  });

  if (logoHits === 0) {
    const $header = $(
      "header, [role='banner'], .navbar, .site-header, .masthead, nav",
    ).first();
    if ($header.length) {
      $header.prepend(
        `<a href="${input.businessUrl}" data-adrival-logo="1" style="display:inline-flex;align-items:center;padding:8px 12px;z-index:5;position:relative;"><img src="${logoUrl}" alt="${input.brandName}" style="max-height:48px;width:auto;max-width:220px;object-fit:contain;" data-adrival-logo="1" /></a>`,
      );
      logoHits += 1;
    }
  }

  return logoHits;
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
    images: 0,
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
    const heading =
      input.brand.design?.typography?.fontFamilies?.heading || family;
    const stack = `"${family}", system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    const headingStack = `"${heading}", ${stack}`;
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
    // Inject brand font preference + Firecrawl button/radius tokens + Google Fonts
    const radius =
      input.brand.design?.components?.buttonPrimary?.borderRadius ||
      input.brand.design?.spacing?.borderRadius ||
      input.brand.borderRadii[0] ||
      null;
    const btnBg =
      input.brand.design?.components?.buttonPrimary?.background ||
      input.brand.colors.accent ||
      input.brand.colors.primary;
    const btnFg =
      input.brand.design?.components?.buttonPrimary?.textColor || "#FFFFFF";
    const btnSecFg =
      input.brand.design?.components?.buttonSecondary?.textColor ||
      input.brand.colors.accent ||
      input.brand.colors.primary;
    const btnSecBorder =
      input.brand.design?.components?.buttonSecondary?.borderColor ||
      btnSecFg;

    const radiusCss = radius
      ? `button,.btn,a.btn,.button,[class*='btn'],[class*='cta']{border-radius:${radius}!important}`
      : "";
    const btnCss = `button.btn-primary,.btn-primary,a.btn-primary,[class*='btn-primary'],[class*='cta-primary']{background:${btnBg}!important;color:${btnFg}!important;border-color:${btnBg}!important}
button.btn-secondary,.btn-secondary,a.btn-secondary,[class*='btn-secondary'],[class*='cta-secondary']{color:${btnSecFg}!important;border-color:${btnSecBorder}!important}`;

    const fontFamilies = Array.from(
      new Set(
        [family, heading, ...(input.brand.fonts || [])].filter(Boolean),
      ),
    ).slice(0, 4);
    const googleFonts = fontFamilies
      .filter((f) => !/^(arial|helvetica|system-ui|sans-serif|serif|roboto|georgia|times)/i.test(f))
      .map((f) => f.replace(/\s+/g, "+"))
      .join("&family=");
    const fontLink = googleFonts
      ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=${googleFonts}:wght@400;500;600;700&display=swap" rel="stylesheet">`
      : "";

    $("head").append(fontLink);
    $("head").append(
      `<style id="adrival-font-swap">html,body,button,input,textarea,select{font-family:${stack}!important}h1,h2,h3,h4,h5,h6{font-family:${headingStack}!important}${radiusCss}${btnCss}</style>`,
    );
  } else if (
    input.brand.design?.spacing?.borderRadius ||
    input.brand.design?.components?.buttonPrimary
  ) {
    const radius =
      input.brand.design?.components?.buttonPrimary?.borderRadius ||
      input.brand.design?.spacing?.borderRadius ||
      null;
    const btnBg =
      input.brand.design?.components?.buttonPrimary?.background ||
      input.brand.colors.accent;
    const btnFg =
      input.brand.design?.components?.buttonPrimary?.textColor || "#FFFFFF";
    const parts: string[] = [];
    if (radius) {
      parts.push(
        `button,.btn,a.btn,.button,[class*='btn'],[class*='cta']{border-radius:${radius}!important}`,
      );
    }
    if (btnBg) {
      parts.push(
        `button.btn-primary,.btn-primary,a.btn-primary,[class*='btn-primary']{background:${btnBg}!important;color:${btnFg}!important}`,
      );
    }
    if (parts.length) {
      $("head").append(
        `<style id="adrival-brand-components">${parts.join("")}</style>`,
      );
    }
  }

  // Logo: replace header/nav brand marks — preserve width/height/style
  if (input.brand.logoUrl) {
    const logoResult = applyBrandLogoMarks($, {
      logoUrl: input.brand.logoUrl,
      brandName: input.brandName,
      businessUrl: input.businessUrl,
    });
    stats.logos += logoResult;
  }

  // Hero / large content image swaps from brand assets (never icons/footer)
  // Skip slots reserved for Runway generation (`data-adrival-gen-id`).
  const brandImages = input.brand.siteAssets?.images || [];
  const heroPool = [
    ...(input.brand.siteAssets?.ogImageUrl
      ? [{ src: input.brand.siteAssets.ogImageUrl, kind: "og" as const }]
      : []),
    ...brandImages.filter((i) => i.kind === "hero" || i.kind === "og"),
  ];
  const contentPool = brandImages.filter((i) => i.kind === "content");
  const pickHero = heroPool[0]?.src || contentPool[0]?.src || null;
  const pickContent = contentPool[0]?.src || heroPool[0]?.src || null;

  if (pickHero || pickContent) {
    let heroSwapped = false;
    $("img").each((_, el) => {
      if (stats.images >= 4) return;
      const $el = $(el);
      if ($el.attr("data-adrival-logo")) return;
      if ($el.attr("data-adrival-gen-id")) return;
      const src = $el.attr("src") || "";
      const alt = $el.attr("alt") || "";
      const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
      const hay = `${src} ${alt} ${className}`.toLowerCase();
      if (
        /icon|sprite|bullet|check|tick|star|badge|payment|flag|social|emoji|avatar|pixel|tracking|logo|wordmark/i.test(
          hay,
        )
      ) {
        return;
      }
      if (
        $el.closest(
          "li, ul, ol, footer, [role='contentinfo'], [class*='Footer']",
        ).length
      ) {
        return;
      }
      const width = Number($el.attr("width") || 0);
      const height = Number($el.attr("height") || 0);
      if ((width > 0 && width <= 96) || (height > 0 && height <= 96)) return;

      const inHero =
        $el.closest(
          ".hero, .banner, .jumbotron, [class*='hero'], [class*='Hero'], [class*='banner'], [class*='masthead'], section:first-of-type",
        ).length > 0;
      const looksLarge =
        width >= 280 ||
        height >= 200 ||
        /hero|banner|cover|main-image|featured/i.test(hay);

      if (!inHero && !looksLarge) return;

      let next: string | null = null;
      if (inHero && !heroSwapped && pickHero) {
        next = pickHero;
        heroSwapped = true;
      } else if (looksLarge && pickContent && stats.images < 3) {
        next = pickContent;
      }
      if (!next || next === src) return;
      $el.attr("src", next);
      $el.removeAttr("srcset");
      $el.attr("data-adrival-image", "1");
      stats.images += 1;
    });

    if (pickHero) {
      $(
        ".hero, [class*='hero'], [class*='Hero'], .banner, [class*='banner']",
      ).each((_, el) => {
        const $el = $(el);
        if ($el.attr("data-adrival-gen-id")) return;
        const style = $el.attr("style") || "";
        if (!/url\(/i.test(style)) return;
        if ($el.closest("header, nav, footer").length) return;
        const nextStyle = style.replace(
          /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi,
          `url("${pickHero}")`,
        );
        if (nextStyle !== style) {
          $el.attr("style", nextStyle);
          stats.images += 1;
        }
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

  const pageLinks = collectRoutableBrandLinks(
    input.brand.siteAssets,
    input.businessUrl,
  );

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

    const isCta =
      /btn|button|cta|primary/i.test(className) ||
      /get started|book|apply|download|sign up|try|demo|call|contact|schedule|quote|enquire/i.test(
        label,
      );

    try {
      const u = new URL(href, input.archive.finalUrl);
      const host = u.hostname.replace(/^www\./i, "").toLowerCase();
      if (competitorHost && host.includes(competitorHost)) {
        if (isCta) {
          $el.attr(
            "href",
            pickCtaHref({
              label,
              className,
              assets: input.brand.siteAssets,
              businessUrl: input.businessUrl,
            }),
          );
        } else {
          const resolved = resolveBrandPageHref({
            label,
            competitorPath: u.pathname,
            links: pageLinks,
            businessUrl: input.businessUrl,
          });
          $el.attr("href", resolved || input.businessUrl);
        }
        stats.links += 1;
        return;
      }
    } catch {
      // ignore
    }

    // CTA-looking buttons on external/relative hosts → best brand CTA page
    if (isCta) {
      $el.attr(
        "href",
        pickCtaHref({
          label,
          className,
          assets: input.brand.siteAssets,
          businessUrl: input.businessUrl,
        }),
      );
      stats.links += 1;
    }
  });

  // Socials remapped above; footer in-place pass owns footer social row — do not append a duplicate

  // Brand CSS variables + scoped CTA chrome (not every heading/link)
  let out = $.html();
  out = injectBrandColorOverlay(out, input.brand.colors);

  void escapeRegExp;
  return { html: out, stats };
}
