import * as cheerio from "cheerio";
import { packagePortableHtml } from "../design/packageHtml";
import type { BrandColors } from "../../types";

export type UnifiedValidation = {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  html: string;
};

export type ChromeLink = { label: string; href: string };

export type ChromeAssets = {
  clientName: string;
  clientUrl: string;
  logoUrl?: string | null;
  navLinks?: ChromeLink[];
  footerLinks?: ChromeLink[];
  /** Competitor-shaped footer columns when harvested. */
  footerColumns?: Array<{ heading: string; links: ChromeLink[] }>;
  ctaLinks?: ChromeLink[];
  socialLinks?: ChromeLink[];
  phones?: string[];
  emails?: string[];
  tagline?: string | null;
};

/** Drop competitor URLs and hostname mentions so a finished page is not rejected for leakage. */
function neutralizeCompetitorHost(html: string, competitorHost: string, clientHost: string): string {
  const host = competitorHost.trim().toLowerCase();
  if (!host || host.length < 4 || !html.toLowerCase().includes(host)) return html;
  const client = clientHost.trim().toLowerCase();
  const dest = client ? `https://${client}/` : "#";
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const urlRe = new RegExp(`https?:\\/\\/(?:www\\.)?${escaped}[^\\s"'<>]*`, "gi");
  const bareRe = new RegExp(`(?:www\\.)?${escaped}`, "gi");
  return html.replace(urlRe, dest).replace(bareRe, client);
}

function ensureBrandCss(html: string, colors: BrandColors | null | undefined): string {
  if (!colors) return html;
  const block = `
:root{
  --brand-primary:${colors.primary};
  --brand-secondary:${colors.secondary};
  --brand-accent:${colors.accent};
  --brand-bg:${colors.background || "#ffffff"};
  --brand-text:${colors.text || "#0b1220"};
  --bg-page:var(--brand-bg);
  --bg-section:color-mix(in srgb, var(--brand-secondary) 6%, var(--brand-bg));
  --bg-card:#ffffff;
  --radius-md:12px;
  --shadow-soft:0 10px 30px rgba(7,32,50,.08);
}
.adr-logo,[data-logo-role="company"]{
  display:block;height:auto;max-height:56px;max-width:240px;width:auto;object-fit:contain;object-position:left center;
}
[data-logo-role="proof"]{
  display:block;height:auto;max-height:36px;max-width:120px;width:auto;object-fit:contain;opacity:.9;
}
img[data-adrival-slot]{display:block;width:100%;height:auto;object-fit:cover;}
.adr-header-inner{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 0;flex-wrap:wrap}
.adr-nav{display:flex;align-items:center;gap:18px;flex-wrap:wrap;list-style:none;margin:0;padding:0}
.adr-nav a{text-decoration:none;font-size:15px;color:var(--brand-text,#0b1220)}
.adr-header-cta{display:inline-flex;align-items:center;padding:10px 18px;border-radius:999px;background:var(--brand-accent,var(--brand-primary));color:var(--text-on-brand,#fff);text-decoration:none;font-weight:600;white-space:nowrap}
.adr-footer{padding:48px 0 28px;border-top:1px solid color-mix(in srgb, var(--brand-text,#0b1220) 12%, transparent);background:var(--bg-section,var(--bg-page))}
.adr-footer-grid{display:grid;grid-template-columns:minmax(180px,1.2fr) repeat(auto-fit,minmax(140px,1fr));gap:28px;align-items:start}
.adr-footer h3{margin:0 0 12px;font-size:14px;letter-spacing:.04em;text-transform:uppercase;opacity:.7}
.adr-footer ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.adr-footer a{text-decoration:none;color:inherit;font-size:15px}
.adr-footer-meta{margin-top:28px;padding-top:16px;border-top:1px solid color-mix(in srgb, var(--brand-text,#0b1220) 10%, transparent);display:flex;flex-wrap:wrap;gap:12px 20px;font-size:14px;opacity:.8}
@media (max-width:720px){.adr-header-inner{flex-direction:column;align-items:flex-start}.adr-footer-grid{grid-template-columns:1fr 1fr}}
`;
  if (/<\/style>/i.test(html)) {
    return html.replace(/<\/style>/i, `${block}\n</style>`);
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `<style>${block}</style></head>`);
  }
  return `<style>${block}</style>${html}`;
}

function uniqueLinks(links: ChromeLink[] | undefined, limit: number): ChromeLink[] {
  const seen = new Set<string>();
  const out: ChromeLink[] = [];
  for (const link of links || []) {
    const label = (link.label || "").replace(/\s+/g, " ").trim();
    const href = (link.href || "").trim();
    if (!label || !href || href === "#") continue;
    const key = `${label.toLowerCase()}|${href.replace(/\/$/, "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: label.slice(0, 48), href });
    if (out.length >= limit) break;
  }
  return out;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function logoImgHtml(assets: ChromeAssets): string {
  const src = (assets.logoUrl || "").trim();
  if (!src) {
    return `<span class="adr-wordmark" style="font-weight:700;font-size:18px">${escapeText(assets.clientName)}</span>`;
  }
  return `<img class="adr-logo" data-logo-role="company" data-adrival-logo="1" src="${escapeAttr(src)}" alt="${escapeAttr(assets.clientName)} logo" style="display:block;height:auto;max-height:56px;max-width:240px;width:auto;object-fit:contain;object-position:left center">`;
}

function buildHeaderHtml(assets: ChromeAssets): string {
  const nav = uniqueLinks(
    assets.navLinks?.length ? assets.navLinks : [],
    6,
  );
  // Prefer exact competitor menu. Only fall back when nothing usable was provided.
  const navOrFallback =
    nav.length >= 1
      ? nav
      : uniqueLinks(
          [
            { label: "Home", href: assets.clientUrl },
            { label: "Contact", href: assets.clientUrl },
          ],
          2,
        );
  const cta =
    uniqueLinks(assets.ctaLinks, 1)[0] ||
    (assets.phones?.[0]
      ? { label: "Call now", href: `tel:${assets.phones[0].replace(/\s+/g, "")}` }
      : { label: "Contact", href: assets.clientUrl });
  const navHtml =
    navOrFallback.length > 0
      ? `<nav aria-label="Primary"><ul class="adr-nav">${navOrFallback
          .map((link) => `<li><a href="${escapeAttr(link.href)}">${escapeText(link.label)}</a></li>`)
          .join("")}</ul></nav>`
      : "";
  return `<header class="adr-header">
  <div class="adr-container adr-header-inner">
    <a class="adr-brand" href="${escapeAttr(assets.clientUrl)}" aria-label="${escapeAttr(assets.clientName)} home">${logoImgHtml(assets)}</a>
    ${navHtml}
    <a class="adr-header-cta" href="${escapeAttr(cta.href)}">${escapeText(cta.label)}</a>
  </div>
</header>`;
}

function buildFooterHtml(assets: ChromeAssets): string {
  const footerLinks = uniqueLinks(
    assets.footerLinks?.length ? assets.footerLinks : assets.navLinks,
    12,
  );
  const social = uniqueLinks(assets.socialLinks, 5);
  const phones = (assets.phones || []).slice(0, 2);
  const emails = (assets.emails || []).slice(0, 2);
  const tagline = (assets.tagline || "").trim() || assets.clientName;

  const linkList = (items: ChromeLink[]) =>
    items.length
      ? `<ul>${items
          .map((link) => `<li><a href="${escapeAttr(link.href)}">${escapeText(link.label)}</a></li>`)
          .join("")}</ul>`
      : `<ul><li><a href="${escapeAttr(assets.clientUrl)}">Home</a></li></ul>`;

  const contactBits: string[] = [];
  for (const phone of phones) {
    contactBits.push(
      `<li><a href="tel:${escapeAttr(phone.replace(/\s+/g, ""))}">${escapeText(phone)}</a></li>`,
    );
  }
  for (const email of emails) {
    contactBits.push(
      `<li><a href="mailto:${escapeAttr(email)}">${escapeText(email)}</a></li>`,
    );
  }
  if (social.length) {
    for (const link of social) {
      contactBits.push(`<li><a href="${escapeAttr(link.href)}">${escapeText(link.label)}</a></li>`);
    }
  }
  if (!contactBits.length) {
    contactBits.push(`<li><a href="${escapeAttr(assets.clientUrl)}">${escapeText(assets.clientName)}</a></li>`);
  }

  // Prefer competitor footer column headings/links when available.
  const columns = (assets.footerColumns || []).filter((c) => c.links?.length);
  let columnHtml = "";
  if (columns.length >= 2) {
    columnHtml = columns
      .slice(0, 4)
      .map(
        (col) => `<div>
        <h3>${escapeText(col.heading || "Links")}</h3>
        ${linkList(uniqueLinks(col.links, 8))}
      </div>`,
      )
      .join("\n");
    if (!columns.some((c) => /contact/i.test(c.heading))) {
      columnHtml += `<div>
        <h3>Contact</h3>
        <ul>${contactBits.join("")}</ul>
      </div>`;
    }
  } else {
    const serviceHalf = footerLinks.slice(0, Math.ceil(footerLinks.length / 2));
    const exploreHalf = footerLinks.slice(Math.ceil(footerLinks.length / 2));
    columnHtml = `<div>
        <h3>Explore</h3>
        ${linkList(serviceHalf)}
      </div>
      <div>
        <h3>Company</h3>
        ${linkList(exploreHalf.length ? exploreHalf : [{ label: "Contact", href: assets.clientUrl }])}
      </div>
      <div>
        <h3>Contact</h3>
        <ul>${contactBits.join("")}</ul>
      </div>`;
  }

  return `<footer class="adr-footer">
  <div class="adr-container">
    <div class="adr-footer-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:28px;padding:48px 0 28px">
      <div>
        <a class="adr-brand" href="${escapeAttr(assets.clientUrl)}">${logoImgHtml(assets)}</a>
        <p style="margin:14px 0 0;max-width:32ch;opacity:.8;line-height:1.5">${escapeText(tagline)}</p>
      </div>
      ${columnHtml}
    </div>
    <div class="adr-footer-meta">
      <span>© ${new Date().getFullYear()} ${escapeText(assets.clientName)}</span>
      <a href="${escapeAttr(assets.clientUrl)}">Visit website</a>
    </div>
  </div>
</footer>`;
}

/** Detect weak header/footer chrome that should be rebuilt before delivery. */
export function assessPageChrome(html: string): { headerWeak: boolean; footerWeak: boolean; issues: string[] } {
  const $ = cheerio.load(html);
  const issues: string[] = [];
  const $header = $("header").first();
  const $footer = $("footer").first();

  let headerWeak = !$header.length;
  if ($header.length) {
    const text = $header.text().replace(/\s+/g, " ").trim();
    const navLinks = $header.find("nav a[href], .adr-nav a[href], ul a[href]").length;
    const hasLogo =
      $header.find(
        'img[data-logo-role="company"], img[data-adrival-logo], .adr-logo, a.adr-brand img, .adr-wordmark',
      ).length > 0 ||
      $header.find("a.adr-brand").length > 0;
    const inventsRatings = /\b\d\.\d\s*star|\bgoogle reviews?\b|\b\d{2,4}\s+google reviews?/i.test(text);
    const tooFlat = text.length < 12 && navLinks === 0;
    if (!hasLogo) {
      headerWeak = true;
      issues.push("Header is missing a company logo placement.");
    }
    // Logo + CTA-only headers are valid when the competitor LP has no menu.
    if (navLinks === 0 && !hasLogo) {
      headerWeak = true;
      issues.push("Header lacks a proper navigation row.");
    }
    if (inventsRatings) {
      headerWeak = true;
      issues.push("Header includes unverified rating/review chrome.");
    }
    if (tooFlat) {
      headerWeak = true;
      issues.push("Header chrome is incomplete.");
    }
  } else {
    issues.push("No header landmark was found.");
  }

  let footerWeak = !$footer.length;
  if ($footer.length) {
    const text = $footer.text().replace(/\s+/g, " ").trim();
    const links = $footer.find("a[href]").length;
    const hasLogo =
      $footer.find('img[data-logo-role="company"], img[data-adrival-logo], .adr-logo, .adr-wordmark').length >
        0 || $footer.find("a.adr-brand").length > 0;
    // Thin strip: only logo / tiny text and almost no links.
    if (links < 3 || text.length < 40) {
      footerWeak = true;
      issues.push("Footer is incomplete (needs links and contact placements).");
    }
    if (!hasLogo && links < 4) {
      footerWeak = true;
      issues.push("Footer is missing logo placement.");
    }
  } else {
    issues.push("No footer landmark was found.");
  }

  return { headerWeak, footerWeak, issues };
}

/**
 * Guarantee proper header/footer structure with logo + nav/footer links before delivery.
 * Rebuilds weak chrome deterministically from client destination assets.
 */
export function ensurePageChrome(
  html: string,
  assets: ChromeAssets,
  options?: { forceHeader?: boolean; forceFooter?: boolean },
): { html: string; repaired: string[] } {
  const repaired: string[] = [];
  const assessment = assessPageChrome(html);
  const $ = cheerio.load(html);
  const rebuildHeader = Boolean(options?.forceHeader || assessment.headerWeak);
  const rebuildFooter = Boolean(options?.forceFooter || assessment.footerWeak);

  if (rebuildHeader) {
    const headerHtml = buildHeaderHtml(assets);
    if ($("header").length) {
      $("header").first().replaceWith(headerHtml);
    } else if ($("body").length) {
      $("body").prepend(headerHtml);
    }
    repaired.push("header");
  } else if (assets.logoUrl) {
    $('header img[data-logo-role="company"], header img[data-adrival-logo], header .adr-logo').attr(
      "src",
      assets.logoUrl,
    );
  }

  if (rebuildFooter) {
    const footerHtml = buildFooterHtml(assets);
    if ($("footer").length) {
      $("footer").first().replaceWith(footerHtml);
    } else if ($("body").length) {
      $("body").append(footerHtml);
    }
    repaired.push("footer");
  } else if (assets.logoUrl) {
    const $footerLogo = $('footer img[data-logo-role="company"], footer img[data-adrival-logo], footer .adr-logo');
    if ($footerLogo.length) {
      $footerLogo.attr("src", assets.logoUrl);
    } else {
      $("footer").first().prepend(
        `<a class="adr-brand" href="${escapeAttr(assets.clientUrl)}">${logoImgHtml(assets)}</a>`,
      );
      repaired.push("footer-logo");
    }
  }

  return { html: $.html(), repaired };
}

export function validateAndPackageUnifiedPage(input: {
  html: string;
  clientHost: string;
  competitorHost: string;
  logoRequired: boolean;
  expectedSections?: number;
  colors?: BrandColors | null;
  requireChrome?: boolean;
}): UnifiedValidation {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let html = neutralizeCompetitorHost(
    ensureBrandCss(input.html, input.colors),
    input.competitorHost,
    input.clientHost,
  );

  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) {
    blockers.push("Generated markup is not a complete HTML document.");
  }
  if (!/<style[\s>]/i.test(html)) blockers.push("Inline CSS is missing.");
  if (!/<header[\s>]/i.test(html)) {
    if (input.requireChrome !== false) blockers.push("No header landmark was found.");
    else warnings.push("No header landmark was found.");
  }
  if (!/<main[\s>]/i.test(html)) warnings.push("No main landmark was found.");
  if (!/<footer[\s>]/i.test(html)) {
    if (input.requireChrome !== false) blockers.push("No footer landmark was found.");
    else warnings.push("No footer landmark was found.");
  }

  const chrome = assessPageChrome(html);
  if (input.requireChrome !== false) {
    for (const issue of chrome.issues) blockers.push(issue);
  } else {
    warnings.push(...chrome.issues);
  }

  const $ = cheerio.load(html);
  const sections = $("main section, body > section, main > *").length;
  if (input.expectedSections && sections < Math.min(3, input.expectedSections)) {
    warnings.push(`Only ${sections} content regions were found; the competitor inventory listed ${input.expectedSections}.`);
  }
  if (input.logoRequired && !$('img[data-logo-role="company"], img[data-adrival-logo], header img').length) {
    if (input.requireChrome !== false) blockers.push("No company logo image was found in the header.");
    else warnings.push("No company logo image was found in the header. A text wordmark may have been used.");
  }
  if (input.competitorHost && html.toLowerCase().includes(input.competitorHost.toLowerCase())) {
    warnings.push(`Competitor domain ${input.competitorHost} remains in the page.`);
  }
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    const text = ($(el).text() || "").trim();
    if ((!href || href === "#") && text) {
      warnings.push("A link or CTA uses an empty or placeholder href.");
    }
  });
  if (/\*\*[^*]+\*\*/.test($.root().text())) warnings.push("Markdown markers remain visible in the page text.");

  $("header img").first().attr("data-logo-role", $("header img").first().attr("data-logo-role") || "company");
  $("img").each((_, el) => {
    const $el = $(el);
    // data-URI images must not use lazy loading (Chromium blanks them in previews)
    if (($el.attr("src") || "").startsWith("data:")) $el.removeAttr("loading");
    if (!$el.attr("alt") && $el.attr("data-logo-role")) {
      $el.attr("alt", $el.attr("data-logo-role") === "company" ? "Company logo" : "Logo");
    }
  });
  html = $.html();

  const packaged = packagePortableHtml(html);
  if (packaged.external.length > 8) {
    warnings.push(`The page still hotlinks ${packaged.external.length} external assets.`);
  }
  return {
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    html: packaged.html,
  };
}

const IDENTITY_LOGO_PLACEHOLDER = "{{ADRIVAL_IDENTITY_LOGO}}";

function isBrokenLogoSrc(src: string): boolean {
  const value = (src || "").trim();
  if (!value) return true;
  if (value === "#" || value === "about:blank") return true;
  if (value.includes("ADRIVAL_IDENTITY_LOGO") || value.includes("{{")) return true;
  if (/placeholder|logo\.svg|example\.com/i.test(value)) return true;
  return false;
}

export function injectIdentityLogo(
  html: string,
  logoUrl: string | null,
  clientName: string,
  clientUrl: string,
): string {
  if (!logoUrl) {
    // Strip leftover placeholders so the browser doesn't show a broken image icon.
    return html.split(IDENTITY_LOGO_PLACEHOLDER).join("");
  }

  // Models often leave the exact placeholder string — replace before DOM work.
  let next = html.split(IDENTITY_LOGO_PLACEHOLDER).join(logoUrl);
  next = next.replace(/src=(["'])\{\{ADRIVAL_IDENTITY_LOGO\}\}\1/gi, `src=$1${logoUrl}$1`);

  const $ = cheerio.load(next);
  const imgTag = `<img class="adr-logo" data-logo-role="company" data-adrival-logo="1" src="${logoUrl}" alt="${clientName} logo" style="display:block;height:auto;max-height:56px;max-width:240px;width:auto;object-fit:contain;object-position:left center">`;

  const applyLogoAttrs = ($el: any) => {
    $el
      .attr("src", logoUrl)
      .attr("alt", `${clientName} logo`)
      .attr("data-logo-role", "company")
      .attr("data-adrival-logo", "1")
      .attr(
        "style",
        "display:block;height:auto;max-height:56px;max-width:240px;width:auto;object-fit:contain;object-position:left center",
      )
      .removeAttr("width")
      .removeAttr("height")
      .removeAttr("loading")
      .removeAttr("srcset");
  };

  const companyImgs = $('img[data-logo-role="company"], img[data-adrival-logo]');
  if (companyImgs.length) {
    companyImgs.each((_, el) => {
      applyLogoAttrs($(el));
    });
  } else {
    const brand = $("header a.adr-brand, header .logo, header .brand, header a").first();
    if (brand.length) {
      brand.html(imgTag);
      if (!brand.attr("href")) brand.attr("href", clientUrl);
    } else if ($("header").length) {
      $("header").prepend(`<a class="adr-brand" href="${clientUrl}">${imgTag}</a>`);
    } else if ($("body").length) {
      $("body").prepend(`<header><a class="adr-brand" href="${clientUrl}">${imgTag}</a></header>`);
    }
  }

  if ($("footer").length) {
    if (!$('footer img[data-logo-role="company"]').length) {
      $("footer").prepend(`<a class="adr-brand" href="${clientUrl}">${imgTag}</a>`);
    } else {
      $('footer img[data-logo-role="company"]').each((_, el) => applyLogoAttrs($(el)));
    }
  }

  // Replace broken/empty/placeholder logo slots in header + footer
  $("header img, footer img").each((_, el) => {
    const src = ($(el).attr("src") || "").trim();
    const alt = ($(el).attr("alt") || "").toLowerCase();
    const role = ($(el).attr("data-logo-role") || "").toLowerCase();
    const looksLikeLogo =
      role === "company" ||
      /logo|brand|wordmark/i.test(alt) ||
      $(el).attr("data-adrival-logo") === "1" ||
      isBrokenLogoSrc(src);
    const broken = isBrokenLogoSrc(src) || (!src.startsWith("data:") && looksLikeLogo && role === "company");
    if (broken && looksLikeLogo) {
      applyLogoAttrs($(el));
    }
  });

  return $.html();
}

/** Inject authorised proof logos into empty proof strips when the model left them blank. */
export function injectProofLogos(
  html: string,
  logos: Array<{ src: string; alt: string }>,
): string {
  if (!logos.length) return html;
  let working = html;
  // Replace model placeholders with real https/data logo URLs from Firecrawl/HTML.
  logos.forEach((logo, index) => {
    const numbered = new RegExp(`\\{\\{ADRIVAL_PROOF_LOGO\\}}-${index + 1}`, "g");
    working = working.replace(numbered, logo.src);
  });
  working = working.replace(/\{\{ADRIVAL_PROOF_LOGO\}\}/g, logos[0].src);

  const $ = cheerio.load(working);
  const existing = $('img[data-logo-role="proof"]').length;
  if (existing > 0) {
    $('img[data-logo-role="proof"]').each((index, el) => {
      const logo = logos[index % logos.length];
      if (!logo) return;
      const src = ($(el).attr("src") || "").trim();
      const needsFill =
        !src ||
        src === "#" ||
        /placeholder|ADRIVAL_PROOF_LOGO|example\.com/i.test(src) ||
        (!src.startsWith("data:") && !/^https?:\/\//i.test(src));
      if (needsFill || index < logos.length) {
        $(el)
          .attr("src", logo.src)
          .attr("alt", logo.alt)
          .attr("data-logo-role", "proof")
          .removeAttr("loading")
          .removeAttr("srcset");
      }
    });
    return $.html();
  }
  const strip =
    `<div class="adr-proof-strip" style="display:flex;flex-wrap:wrap;gap:24px;align-items:center;justify-content:center">` +
    logos
      .slice(0, 8)
      .map(
        (logo) =>
          `<img data-logo-role="proof" src="${logo.src}" alt="${logo.alt}" style="max-height:36px;width:auto;object-fit:contain">`,
      )
      .join("") +
    `</div>`;
  const proofSection = $("section").filter((_, el) =>
    /proof|trust|client|partner|logo|as seen|featured/i.test($(el).text().slice(0, 240)),
  ).first();
  if (proofSection.length) {
    proofSection.append(strip);
  }
  return $.html();
}
