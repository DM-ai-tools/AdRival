import * as cheerio from "cheerio";
import {
  detectSocialNetwork,
  type BrandSiteAssets,
} from "./brandAssets";

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

/**
 * Replace competitor footer with a brand-only footer.
 * If no safe footer node exists, append a new <footer> — never empty the page body.
 */
export function rebuildBrandFooter(
  html: string,
  assets: BrandSiteAssets,
  brandName: string,
  businessUrl: string,
): { html: string; rebuilt: boolean; linkCount: number; socialCount: number } {
  const $ = cheerio.load(html);
  const $footer = findSafeFooterRoot($);

  const year = new Date().getFullYear();
  const footerLinks = assets.footerLinks
    .filter((l) => {
      if (!l.href || !l.label) return false;
      if (detectSocialNetwork(l.href, l.label)) return false;
      try {
        const u = new URL(l.href);
        const b = new URL(businessUrl);
        if (
          u.hostname.replace(/^www\./, "") ===
            b.hostname.replace(/^www\./, "") &&
          (u.pathname === "/" || u.pathname === "")
        ) {
          return false;
        }
      } catch {
        // keep
      }
      return l.label.length >= 2 && l.label.length <= 60;
    })
    .slice(0, 14);

  const seenHref = new Set<string>();
  const uniqueLinks = footerLinks.filter((l) => {
    const key = l.href.replace(/\/$/, "").toLowerCase();
    if (seenHref.has(key)) return false;
    seenHref.add(key);
    return true;
  });

  if (uniqueLinks.length < 4) {
    for (const l of assets.navLinks) {
      if (uniqueLinks.length >= 10) break;
      if (!l.href || !l.label) continue;
      if (detectSocialNetwork(l.href, l.label)) continue;
      const key = l.href.replace(/\/$/, "").toLowerCase();
      if (seenHref.has(key)) continue;
      seenHref.add(key);
      uniqueLinks.push(l);
    }
  }

  const socials = assets.socialLinks
    .filter((s) =>
      /facebook\.com|instagram\.com|linkedin\.com|youtube\.com|youtu\.be|tiktok\.com|twitter\.com|x\.com|pinterest\.com|threads\.net/i.test(
        s.href,
      ),
    )
    .slice(0, 8);

  const mid = Math.ceil(uniqueLinks.length / 2) || 0;
  const col1 = uniqueLinks.slice(0, mid);
  const col2 = uniqueLinks.slice(mid);

  const linkList = (links: typeof uniqueLinks) =>
    links
      .map(
        (l) =>
          `<li style="margin:0 0 8px;list-style:none;"><a href="${escapeHtml(l.href)}" style="color:inherit;text-decoration:none;">${escapeHtml(l.label)}</a></li>`,
      )
      .join("");

  const socialHtml = socials.length
    ? `<div data-adrival-social="1" style="margin-top:18px;">
        <div style="font-weight:600;margin-bottom:8px;">Follow us</div>
        <div style="display:flex;flex-wrap:wrap;gap:14px;">
          ${socials
            .map(
              (s) =>
                `<a href="${escapeHtml(s.href)}" target="_blank" rel="noopener noreferrer" data-adrival-social-link="1" style="color:inherit;text-decoration:underline;">${escapeHtml(s.label)}</a>`,
            )
            .join("")}
        </div>
      </div>`
    : "";

  const contactBits: string[] = [];
  if (assets.emails[0]) {
    contactBits.push(
      `<a href="mailto:${escapeHtml(assets.emails[0])}" style="color:inherit;">${escapeHtml(assets.emails[0])}</a>`,
    );
  }
  if (assets.phones[0]) {
    contactBits.push(
      `<a href="tel:${escapeHtml(assets.phones[0])}" style="color:inherit;">${escapeHtml(assets.phones[0])}</a>`,
    );
  }

  const logoBlock = assets.logoUrl
    ? `<a href="${escapeHtml(businessUrl)}" data-adrival-footer-logo="1" style="display:inline-block;margin-bottom:16px;"><img src="${escapeHtml(assets.logoUrl)}" alt="${escapeHtml(brandName)}" style="max-height:40px;width:auto;object-fit:contain;" /></a>`
    : `<a href="${escapeHtml(businessUrl)}" style="font-weight:700;font-size:18px;color:inherit;text-decoration:none;display:inline-block;margin-bottom:16px;">${escapeHtml(brandName)}</a>`;

  const footerInner = `
    <div data-adrival-brand-footer="1" style="padding:28px 20px 20px;font:14px/1.5 system-ui,sans-serif;color:inherit;">
      ${logoBlock}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:20px 32px;margin:8px 0 20px;">
        ${col1.length ? `<ul style="margin:0;padding:0;">${linkList(col1)}</ul>` : ""}
        ${col2.length ? `<ul style="margin:0;padding:0;">${linkList(col2)}</ul>` : ""}
      </div>
      ${contactBits.length ? `<p style="margin:0 0 12px;">${contactBits.join(" · ")}</p>` : ""}
      ${socialHtml}
      <p style="margin:20px 0 8px;opacity:.85;">© ${year} ${escapeHtml(brandName)}. All rights reserved.</p>
      <p style="margin:0;font-size:12px;opacity:.7;max-width:720px;">Information on this page is general in nature. Speak with ${escapeHtml(brandName)} for advice suited to your situation.</p>
    </div>
  `;

  if ($footer.length) {
    $footer.empty();
    $footer.append(footerInner);
  } else if ($("body").length) {
    $("body").append(
      `<footer role="contentinfo" data-adrival-brand-footer-root="1" style="margin-top:48px;border-top:1px solid rgba(0,0,0,.08);">${footerInner}</footer>`,
    );
  } else {
    return {
      html,
      rebuilt: false,
      linkCount: uniqueLinks.length,
      socialCount: socials.length,
    };
  }

  $("a[href]").each((_: number, el: any) => {
    const $el = $(el);
    if ($el.closest("[data-adrival-brand-footer]").length) return;
    const href = $el.attr("href") || "";
    const label = normalizeText($el.text());
    const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
    if (detectSocialNetwork(href, label, className)) {
      $el.remove();
    }
  });

  return {
    html: $.html(),
    rebuilt: true,
    linkCount: uniqueLinks.length,
    socialCount: socials.length,
  };
}
