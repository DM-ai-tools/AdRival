import * as cheerio from "cheerio";
import {
  detectSocialNetwork,
  type BrandSiteAssets,
} from "./brandAssets";
import {
  collectRoutableBrandLinks,
  resolveBrandPageHref,
} from "./brandLinkRouting";

function normalizeText(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sameHost(href: string, businessUrl: string): boolean {
  try {
    const u = new URL(href);
    const b = new URL(businessUrl);
    return (
      u.hostname.replace(/^www\./i, "").toLowerCase() ===
      b.hostname.replace(/^www\./i, "").toLowerCase()
    );
  } catch {
    return false;
  }
}

function isHomepageHref(href: string, businessUrl: string): boolean {
  try {
    const u = new URL(href);
    const b = new URL(businessUrl);
    if (
      u.hostname.replace(/^www\./i, "").toLowerCase() !==
      b.hostname.replace(/^www\./i, "").toLowerCase()
    ) {
      return false;
    }
    const path = u.pathname.replace(/\/$/, "") || "/";
    return path === "/" || path === "";
  } catch {
    return false;
  }
}

/**
 * Find a footer node that is safe to empty/replace.
 * Never return a page-level wrapper that contains the main landing content.
 */
export function findSafeFooterRoot($: any): any {
  const bodyTextLen =
    normalizeText($("body").text() || $.root().text()).length || 1;

  const isUnsafeToEmpty = ($el: any): boolean => {
    if (!$el || !$el.length) return true;
    if ($el.is("body, html, main, header, nav")) return true;
    if ($el.find("h1").length > 0) return true;
    if ($el.find("h2").length > 2) return true;
    if ($el.find("main, [role='main'], header, nav").length > 0) return true;
    const textLen = normalizeText($el.text()).length;
    if (textLen > Math.max(500, bodyTextLen * 0.2)) return true;
    if ($el.find("p").length > 8) return true;
    if ($el.find("section, article").length > 2) return true;
    return false;
  };

  for (const el of $("footer, [role='contentinfo'], .footer, #footer").toArray()) {
    const $el = $(el);
    if (!isUnsafeToEmpty($el)) return $el;
  }

  for (const el of $("[class*='Footer'], [class*='footer']").toArray()) {
    const $el = $(el);
    if ($el.is("footer, [role='contentinfo'], .footer, #footer")) continue;
    if (!isUnsafeToEmpty($el)) return $el;
  }

  let best: any = null;
  let bestScore = 0;
  $("div, section, aside").each((_: number, el: any) => {
    const $el = $(el);
    if (isUnsafeToEmpty($el)) return;
    const text = normalizeText($el.text()).toLowerCase();
    if (text.length < 40 || text.length > 2500) return;
    const score =
      (/privacy|terms|copyright|©|all rights reserved/.test(text) ? 3 : 0) +
      (/follow us|connect with|social/.test(text) ? 1 : 0) +
      ($el.find("a[href]").length >= 2 && $el.find("a[href]").length <= 20
        ? 1
        : 0) +
      (/footer/i.test($el.attr("class") || "") ? 2 : 0);
    if (score >= 3 && score > bestScore) {
      best = $el;
      bestScore = score;
    }
  });
  return best || $();
}

/** Brand-site pages only — never invent competitor destinations. */
function filterFooterLinks(
  assets: BrandSiteAssets,
  businessUrl: string,
): Array<{ label: string; href: string }> {
  const pool = [
    ...(assets.footerLinks || []),
    ...(assets.navLinks || []),
    ...(assets.servicePages || []),
    ...(assets.ctaLinks || []),
  ];

  const footerLinks = pool
    .filter((l) => {
      if (!l.href || !l.label) return false;
      if (detectSocialNetwork(l.href, l.label)) return false;
      if (!sameHost(l.href, businessUrl)) return false;
      if (isHomepageHref(l.href, businessUrl)) return false;
      return l.label.length >= 2 && l.label.length <= 60;
    })
    .slice(0, 16);

  const seenHref = new Set<string>();
  return footerLinks.filter((l) => {
    const key = l.href.replace(/\/$/, "").toLowerCase();
    if (seenHref.has(key)) return false;
    seenHref.add(key);
    return true;
  });
}

function setAnchorLabel($: any, $el: any, text: string): void {
  if ($el.children().length === 0) {
    $el.text(text);
    return;
  }
  const $textChild = $el
    .children("span, p, strong, em, label")
    .filter((_: number, c: any) => {
      const $c = $(c);
      if ($c.is("svg, i, img")) return false;
      return normalizeText($c.text()).length > 0 || $c.children().length === 0;
    })
    .first();
  if ($textChild.length) {
    $textChild.text(text);
    return;
  }
  let replaced = false;
  $el.contents().each((_: number, child: any) => {
    if (child.type === "text" && normalizeText(child.data || "").length > 0) {
      if (!replaced) {
        child.data = text;
        replaced = true;
      } else {
        child.data = "";
      }
    }
  });
  if (!replaced) $el.prepend(text);
}

function removeFooterAnchor($: any, $el: any): void {
  const $li = $el.closest("li");
  if ($li.length && $li.find("a[href]").length <= 1) {
    $li.remove();
    return;
  }
  $el.replaceWith(`<span style="display:none" data-adrival-removed-footer-link="1"></span>`);
}

/**
 * Patch footer in place: keep competitor layout/columns; remap logo, links, socials.
 * Only brand-website destinations are kept — unmatched competitor links are removed
 * (never collapsed to the same homepage URL).
 */
export function rebuildBrandFooter(
  html: string,
  assets: BrandSiteAssets,
  brandName: string,
  businessUrl: string,
  options?: { disclaimer?: string | null },
): {
  html: string;
  rebuilt: boolean;
  inPlace: boolean;
  linkCount: number;
  socialCount: number;
} {
  const $ = cheerio.load(html);
  const $footer = findSafeFooterRoot($);
  const uniqueLinks = filterFooterLinks(assets, businessUrl);
  const routable = collectRoutableBrandLinks(assets, businessUrl);
  const socials = (assets.socialLinks || []).filter(
    (s) => s.href && detectSocialNetwork(s.href, s.label),
  );
  const year = new Date().getFullYear();

  // --- Preferred: in-place remap ---
  if ($footer.length) {
    let linkCount = 0;
    let socialCount = 0;

    // Logo in footer (brand mark — not partner strips)
    if (assets.logoUrl) {
      $footer.find("img").each((_: number, el: any) => {
        const $el = $(el);
        const hay = `${$el.attr("src") || ""} ${$el.attr("alt") || ""} ${$el.attr("class") || ""}`;
        if (
          $el.closest(
            "[class*='partner'], [class*='Partner'], [class*='client'], [class*='press'], [class*='award'], [class*='certif']",
          ).length
        ) {
          return;
        }
        const looksLogo =
          /logo|brand|wordmark/i.test(hay) ||
          $el.closest("a.logo, [class*='logo'], .navbar-brand").length > 0 ||
          (Number($el.attr("height") || 0) > 0 &&
            Number($el.attr("height") || 0) <= 80);
        if (!looksLogo) return;
        $el.attr("src", assets.logoUrl!);
        $el.removeAttr("srcset");
        $el.attr("alt", brandName);
        $el.attr("data-adrival-footer-logo", "1");
        $el.attr("data-adrival-logo", "1");
      });

      if (!$footer.find("img[data-adrival-footer-logo]").length) {
        const $col = $footer
          .find(
            "[class*='logo'], [class*='brand'], .footer-logo, .widget:first-child",
          )
          .first();
        const inject = `<a href="${escapeHtml(businessUrl)}" data-adrival-footer-logo="1" data-adrival-logo="1" style="display:inline-block;margin-bottom:12px;"><img src="${escapeHtml(assets.logoUrl)}" alt="${escapeHtml(brandName)}" style="max-height:48px;width:auto;object-fit:contain;" data-adrival-logo="1" data-adrival-footer-logo="1" /></a>`;
        if ($col.length) $col.prepend(inject);
        else $footer.prepend(inject);
      }
    }

    // Social anchors inside footer
    const socialByNet = new Map<string, string>();
    for (const s of socials) {
      const net = detectSocialNetwork(s.href, s.label);
      if (net && !socialByNet.has(net)) socialByNet.set(net, s.href);
    }

    $footer.find("a[href]").each((_: number, el: any) => {
      const $el = $(el);
      const href = ($el.attr("href") || "").trim();
      const label = normalizeText($el.text());
      const net = detectSocialNetwork(href, label, $el.attr("class") || "");
      if (net) {
        const brandHref = socialByNet.get(net);
        if (brandHref) {
          $el.attr("href", brandHref);
          $el.attr("data-adrival-footer-social", net);
          socialCount += 1;
        } else {
          removeFooterAnchor($, $el);
        }
        return;
      }
    });

    // Non-social footer links — ONLY keep when we can map to a real brand page
    const usedLink = new Set<number>();
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const anchors = $footer.find("a[href]").toArray();
    for (const el of anchors) {
      const $el = $(el);
      if ($el.attr("data-adrival-footer-social")) continue;
      if ($el.attr("data-adrival-footer-logo")) continue;
      const href = ($el.attr("href") || "").trim();
      if (!href || /^mailto:|^tel:|^#|^javascript:/i.test(href)) continue;
      if (detectSocialNetwork(href, normalizeText($el.text()))) continue;

      const label = normalizeText($el.text());
      let idx = uniqueLinks.findIndex(
        (l, i) => !usedLink.has(i) && norm(l.label) === norm(label),
      );
      if (idx < 0) {
        idx = uniqueLinks.findIndex((l, i) => {
          if (usedLink.has(i)) return false;
          const a = norm(l.label);
          const b = norm(label);
          return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));
        });
      }

      let resolved: string | null = null;
      let resolvedLabel: string | null = null;
      if (idx >= 0) {
        usedLink.add(idx);
        resolved = uniqueLinks[idx].href;
        resolvedLabel = uniqueLinks[idx].label;
      } else {
        resolved = resolveBrandPageHref({
          label,
          competitorPath: (() => {
            try {
              return new URL(href).pathname;
            } catch {
              return null;
            }
          })(),
          links: routable,
          businessUrl,
        });
        if (resolved) {
          const match = uniqueLinks.find(
            (l) =>
              l.href.replace(/\/$/, "").toLowerCase() ===
              resolved!.replace(/\/$/, "").toLowerCase(),
          );
          resolvedLabel = match?.label || label;
          const usedIdx = uniqueLinks.findIndex(
            (l) =>
              l.href.replace(/\/$/, "").toLowerCase() ===
              resolved!.replace(/\/$/, "").toLowerCase(),
          );
          if (usedIdx >= 0) usedLink.add(usedIdx);
        }
      }

      if (!resolved || isHomepageHref(resolved, businessUrl)) {
        // Do NOT collapse every leftover to the homepage — remove instead
        removeFooterAnchor($, $el);
        continue;
      }

      $el.attr("href", resolved);
      if (resolvedLabel) setAnchorLabel($, $el, resolvedLabel);
      $el.attr("data-adrival-footer-link", "1");
      linkCount += 1;
    }

    // Append unused brand pages into an existing quick-links / menu list
    const unused = uniqueLinks.filter((_, i) => !usedLink.has(i));
    if (unused.length) {
      const $list = $footer
        .find("ul, ol, [class*='menu'], [class*='links']")
        .filter((_: number, el: any) => {
          const $el = $(el);
          const t = normalizeText($el.closest("div, section, aside").find("h2, h3, h4, .title, [class*='title']").first().text()).toLowerCase();
          return (
            /quick|link|menu|explore|navigat|service|page/i.test(t) ||
            $el.find("a[data-adrival-footer-link]").length > 0
          );
        })
        .first();
      if ($list.length) {
        for (const link of unused.slice(0, 8)) {
          if ($list.is("ul, ol")) {
            $list.append(
              `<li><a href="${escapeHtml(link.href)}" data-adrival-footer-link="1">${escapeHtml(link.label)}</a></li>`,
            );
          } else {
            $list.append(
              `<a href="${escapeHtml(link.href)}" data-adrival-footer-link="1" style="display:block;margin:4px 0;">${escapeHtml(link.label)}</a>`,
            );
          }
          linkCount += 1;
        }
      }
    }

    // Disclaimer / copyright blurb
    if (options?.disclaimer) {
      $footer
        .find("p, small, span, div")
        .filter((_: number, el: any) => {
          const t = normalizeText($(el).text());
          return /©|copyright|all rights reserved/i.test(t) && t.length < 280;
        })
        .first()
        .each((_: number, el: any) => {
          $(el).text(options.disclaimer!);
        });
    } else {
      $footer
        .find("p, small, span")
        .filter((_: number, el: any) => {
          const t = normalizeText($(el).text());
          return /©|copyright|all rights reserved/i.test(t) && t.length < 200;
        })
        .first()
        .each((_: number, el: any) => {
          $(el).text(`© ${year} ${brandName}. All rights reserved.`);
        });
    }

    $footer.attr("data-adrival-brand-footer", "1");

    // Strip competitor socials left outside the remapped footer
    $("a[href]").each((_: number, el: any) => {
      const $el = $(el);
      if ($el.closest("[data-adrival-brand-footer]").length) return;
      const href = $el.attr("href") || "";
      const net = detectSocialNetwork(href, normalizeText($el.text()));
      if (!net) return;
      if (socialByNet.has(net)) {
        $el.attr("href", socialByNet.get(net)!);
      } else {
        $el.remove();
      }
    });

    return {
      html: $.html(),
      rebuilt: true,
      inPlace: true,
      linkCount,
      socialCount,
    };
  }

  // --- Fallback: inject generic footer ---
  const linkHtml = uniqueLinks
    .map(
      (l) =>
        `<a href="${escapeHtml(l.href)}" style="color:inherit;text-decoration:underline;margin:0 8px 6px 0;display:inline-block;">${escapeHtml(l.label)}</a>`,
    )
    .join("");
  const socialHtml = socials
    .map(
      (s) =>
        `<a href="${escapeHtml(s.href)}" style="color:inherit;margin-right:10px;text-decoration:none;">${escapeHtml(s.label)}</a>`,
    )
    .join("");
  const disclaimer =
    options?.disclaimer?.trim() ||
    `© ${year} ${escapeHtml(brandName)}. All rights reserved.`;

  const footerInner = `
    <div data-adrival-brand-footer="1" style="padding:28px 20px;font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;border-top:1px solid rgba(0,0,0,.08);">
      ${
        assets.logoUrl
          ? `<div style="margin-bottom:14px;"><img src="${escapeHtml(assets.logoUrl)}" alt="${escapeHtml(brandName)}" style="max-height:40px;width:auto;" data-adrival-logo="1" /></div>`
          : `<div style="font-weight:700;margin-bottom:12px;">${escapeHtml(brandName)}</div>`
      }
      <div style="display:flex;flex-wrap:wrap;gap:4px 0;margin-bottom:12px;">${linkHtml}</div>
      ${socialHtml ? `<div style="margin-bottom:12px;">${socialHtml}</div>` : ""}
      <div style="opacity:.75;font-size:12px;">${escapeHtml(disclaimer)}</div>
    </div>`;

  if ($("body").length) {
    $("body").append(
      `<footer role="contentinfo" data-adrival-brand-footer-root="1">${footerInner}</footer>`,
    );
  }

  return {
    html: $.html(),
    rebuilt: true,
    inPlace: false,
    linkCount: uniqueLinks.length,
    socialCount: socials.length,
  };
}
