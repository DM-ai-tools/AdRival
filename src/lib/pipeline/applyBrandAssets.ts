import * as cheerio from "cheerio";
import {
  detectSocialNetwork,
  type BrandSiteAssets,
} from "./brandAssets";
import { rebuildBrandFooter, findSafeFooterRoot } from "./rebuildFooter";

function normalizeText(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
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

function isHeaderLogoCandidate(
  $el: any,
  src: string,
  alt: string,
  className: string,
): boolean {
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
  if (height > 0 && height <= 100) return true;
  if (width > 0 && width <= 260 && (height === 0 || height <= 120)) return true;
  if (width === 0 && height === 0 && /\.(svg|png|webp)(\?|$)/i.test(src)) {
    return true;
  }
  return false;
}

function findFooterRoot($: any): any {
  return findSafeFooterRoot($);
}

/** Match a brand page URL, or null if the brand site has no equivalent (do not invent/homepage). */
function matchBrandHref(
  label: string,
  href: string,
  textLinks: BrandSiteAssets["footerLinks"],
  businessUrl: string,
): string | null {
  const a = `${label} ${href}`.toLowerCase();
  const rules: Array<[RegExp, RegExp]> = [
    [/privacy/, /privacy/],
    [/terms|condition/, /terms|condition/],
    [/licen[cs]/, /licen[cs]/],
    [/cookie/, /cookie/],
    [/contact|assistance/, /contact/],
    [/about/, /about/],
    [/career|job/, /career|job/],
    [/blog|news|resource/, /blog|news|resource|insight/],
    [/compare|rate|mortgage/, /rate|compare|mortgage|loan/],
  ];
  for (const [probe, linkRe] of rules) {
    if (!probe.test(a)) continue;
    const found = textLinks.find(
      (l) =>
        linkRe.test(l.label.toLowerCase()) || linkRe.test(l.href.toLowerCase()),
    );
    if (found) return found.href;
  }
  try {
    const path = new URL(href, businessUrl).pathname;
    if (path && path !== "/") {
      const samePath = textLinks.find((l) => {
        try {
          return (
            new URL(l.href).pathname.replace(/\/$/, "") ===
            path.replace(/\/$/, "")
          );
        } catch {
          return false;
        }
      });
      if (samePath) return samePath.href;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Inject the user's logo, footer/nav links, and images into cloned competitor HTML.
 */
export function applyBrandSiteAssets(
  html: string,
  assets: BrandSiteAssets,
  brandName: string,
  businessUrl: string,
  competitorSourceUrl?: string,
): {
  html: string;
  stats: {
    logos: number;
    images: number;
    footerLinks: number;
    navLinks: number;
  };
} {
  const $ = cheerio.load(html);
  const stats = { logos: 0, images: 0, footerLinks: 0, navLinks: 0 };

  $("#adrival-brand-footer, [data-adrival-logo-wrap], [data-adrival-social], [data-adrival-footer-logo]").remove();

  const logoUrl = assets.logoUrl;
  const competitorHost = competitorSourceUrl
    ? hostOf(competitorSourceUrl)
    : null;

  const imagePool = [
    ...assets.images.filter((i) => i.kind === "hero" || i.kind === "og"),
    ...assets.images.filter((i) => i.kind === "content"),
  ].filter((i) => i.src && i.src !== logoUrl);
  const uniqueImages = [
    ...new Map(imagePool.map((i) => [i.src, i])).values(),
  ];

  const textLinks = assets.footerLinks.filter(
    (l) =>
      !/facebook|instagram|twitter|linkedin|youtube|tiktok|x\.com/i.test(l.href),
  );

  // --- Logos ---
  if (logoUrl) {
    let logoReplaced = 0;
    $("img").each((_, el) => {
      if (logoReplaced >= 2) return;
      const $el = $(el);
      const src = $el.attr("src") || "";
      const alt = $el.attr("alt") || "";
      const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""} ${$el.parent().parent().attr("class") || ""}`;
      if (!isHeaderLogoCandidate($el, src, alt, className)) return;
      $el.attr("src", logoUrl);
      $el.removeAttr("srcset");
      $el.attr("alt", brandName);
      $el.attr("data-adrival-logo", "1");
      logoReplaced += 1;
      stats.logos += 1;
    });

    $("header svg, nav svg, [role='banner'] svg, .navbar svg, .masthead svg")
      .toArray()
      .slice(0, 1)
      .forEach((el) => {
        if (logoReplaced >= 2) return;
        const $el = $(el);
        if ($el.closest("button, li, .menu-item, footer").length) return;
        $el.replaceWith(
          `<img src="${logoUrl}" alt="${brandName}" data-adrival-logo="1" style="max-height:48px;width:auto;object-fit:contain;" />`,
        );
        logoReplaced += 1;
        stats.logos += 1;
      });

    $("a.logo, a.navbar-brand, a[class*='logo']").attr("href", businessUrl);

    // Inject only when no logo was placed (avoids duplicated/ghosted logos)
    if (logoReplaced === 0 && $("[data-adrival-logo]").length === 0) {
      const logoMarkup = `<a href="${businessUrl}" data-adrival-logo="1" style="display:inline-flex;align-items:center;gap:8px;text-decoration:none;"><img src="${logoUrl}" alt="${brandName}" style="max-height:48px;width:auto;max-width:220px;object-fit:contain;" /></a>`;
      const $header = $(
        "header, [role='banner'], .navbar, .site-header, .masthead",
      ).first();
      if ($header.length) {
        $header.prepend(
          `<div data-adrival-logo-wrap="1" style="padding:10px 16px;display:flex;align-items:center;">${logoMarkup}</div>`,
        );
        stats.logos += 1;
      } else if ($("body").length) {
        $("body").prepend(
          `<div data-adrival-logo-wrap="1" style="padding:12px 16px;background:#fff;border-bottom:1px solid rgba(0,0,0,.06);">${logoMarkup}</div>`,
        );
        stats.logos += 1;
      }
    }

    const $footerForLogo = findFooterRoot($);
    if ($footerForLogo.length) {
      const $footerImg = $footerForLogo
        .find("img[data-adrival-logo], img")
        .first();
      if ($footerImg.length && !$footerImg.attr("data-adrival-logo")) {
        // only if it looks like a logo slot
        const hay = `${$footerImg.attr("src") || ""} ${$footerImg.attr("alt") || ""} ${$footerImg.attr("class") || ""}`;
        if (/logo|brand/i.test(hay) || $footerImg.closest("a").length) {
          $footerImg.attr("src", logoUrl);
          $footerImg.removeAttr("srcset");
          $footerImg.attr("alt", brandName);
          $footerImg.attr("data-adrival-logo", "1");
          stats.logos += 1;
        }
      }
    }
  }

  // --- Images: replace competitor / content photos with brand images ---
  let imgIdx = 0;
  if (uniqueImages.length) {
    $("img").each((_, el) => {
      const $el = $(el);
      if ($el.attr("data-adrival-logo") === "1") return;
      if (
        $el.closest(
          "[data-adrival-logo-wrap],[data-adrival-footer-logo]",
        ).length
      ) {
        return;
      }

      const src = $el.attr("src") || "";
      const alt = $el.attr("alt") || "";
      const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
      if (isCompetitorLogoImg(src, alt, className)) return;

      const width = Number($el.attr("width") || 0);
      const height = Number($el.attr("height") || 0);
      const tiny =
        (width > 0 && width <= 48) ||
        (height > 0 && height <= 48) ||
        /icon|sprite|pixel|tracking|1x1|emoji|badge|payment|flag/i.test(
          `${src} ${className}`,
        );
      if (tiny) return;

      const inFooter =
        $el.closest(
          "footer, [role='contentinfo'], .footer, [class*='Footer']",
        ).length > 0;
      if (
        inFooter &&
        /facebook|instagram|twitter|linkedin|youtube|tiktok|social/i.test(
          `${src} ${className} ${alt}`,
        )
      ) {
        return;
      }

      const srcHost = hostOf(src.startsWith("http") ? src : `https://x/${src}`);
      const fromCompetitor = Boolean(
        competitorHost &&
          ((srcHost && srcHost.includes(competitorHost)) ||
            src.toLowerCase().includes(competitorHost)),
      );

      const inContent =
        $el.closest(
          "main, article, section, .hero, [class*='hero'], [class*='banner'], [class*='feature'], [class*='gallery'], [class*='card'], [class*='media']",
        ).length > 0;

      // Prefer swapping competitor-hosted + content images; allow up to ~12 swaps
      if (!fromCompetitor && !inContent && stats.images >= 6) return;
      if (stats.images >= 14) return;

      const next = uniqueImages[imgIdx % uniqueImages.length].src;
      imgIdx += 1;
      $el.attr("src", next);
      $el.removeAttr("srcset");
      if (!alt) $el.attr("alt", brandName);
      stats.images += 1;
    });

    $("[style*='background']").each((_, el) => {
      const style = $(el).attr("style") || "";
      if (!/url\(/i.test(style)) return;
      if (
        competitorHost &&
        style.toLowerCase().includes(competitorHost) &&
        uniqueImages[0]
      ) {
        $(el).attr(
          "style",
          style.replace(
            /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi,
            `url("${uniqueImages[0].src}")`,
          ),
        );
        stats.images += 1;
      }
    });
  }

  // --- Footer: sensitive — full rebuild from brand assets only ---
  // Never keep competitor copyright/licence copy or invent homepage fallbacks.
  const rebuilt = rebuildBrandFooter($.html(), assets, brandName, businessUrl);
  stats.footerLinks = rebuilt.linkCount + rebuilt.socialCount;
  const $doc = cheerio.load(rebuilt.html);

  // Hard pass on non-footer competitor-host links: match brand page or remove
  if (competitorHost) {
    $doc("a[href]").each((_, el) => {
      const $el = $doc(el);
      if ($el.closest("[data-adrival-brand-footer]").length) return;
      const href = $el.attr("href") || "";
      if (!href || /^mailto:|^tel:|^#|^javascript:/i.test(href)) return;
      if (/\.(png|jpe?g|gif|svg|webp|css|js|woff2?)(\?|$)/i.test(href)) return;
      if (detectSocialNetwork(href)) {
        const net = detectSocialNetwork(href);
        const brandSocial = assets.socialLinks.find(
          (s) => detectSocialNetwork(s.href) === net,
        );
        if (brandSocial) $el.attr("href", brandSocial.href);
        else $el.remove();
        return;
      }

      let linkHost: string | null = null;
      try {
        linkHost = new URL(href, businessUrl).hostname
          .replace(/^www\./i, "")
          .toLowerCase();
      } catch {
        return;
      }
      if (!linkHost.includes(competitorHost)) return;

      const label = normalizeText($el.text());
      const matched = matchBrandHref(label, href, textLinks, businessUrl);
      if (matched) {
        $el.attr("href", matched);
        return;
      }
      const navHit = assets.navLinks.find((l) => {
        const a = label.toLowerCase();
        const b = l.label.toLowerCase();
        return a && b && (a.includes(b) || b.includes(a));
      });
      if (navHit) $el.attr("href", navHit.href);
      else $el.remove();
    });
  }

  // --- Nav text links ---
  const navAnchors = $doc(
    "header nav a[href], nav a[href], header .menu a[href], .navbar-nav a[href]",
  )
    .toArray()
    .filter((el) => {
      const $el = $doc(el);
      if ($el.find("img, svg").length) return false;
      const className = $el.attr("class") || "";
      if (/logo|brand|btn|button|cta/i.test(className)) return false;
      const t = normalizeText($el.text());
      return t.length >= 2 && t.length <= 40;
    });
  if (assets.navLinks.length && navAnchors.length) {
    navAnchors.forEach((el, i) => {
      if (i >= assets.navLinks.length) return;
      $doc(el).attr("href", assets.navLinks[i].href);
      $doc(el).text(assets.navLinks[i].label);
      stats.navLinks += 1;
    });
  }

  if (assets.emails[0]) {
    $doc("a[href^='mailto:']").attr("href", `mailto:${assets.emails[0]}`);
  }
  if (assets.phones[0]) {
    $doc("a[href^='tel:']").attr("href", `tel:${assets.phones[0]}`);
  }

  return { html: $doc.html(), stats };
}
