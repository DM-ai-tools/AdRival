import * as cheerio from "cheerio";
import { packagePortableHtml } from "../design/packageHtml";
import type { BrandColors } from "../../types";

export type UnifiedValidation = {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  html: string;
};

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
  display:block;height:auto;max-height:44px;max-width:200px;width:auto;object-fit:contain;
}
[data-logo-role="proof"]{
  display:block;height:auto;max-height:36px;max-width:120px;width:auto;object-fit:contain;opacity:.9;
}
img[data-adrival-slot]{display:block;width:100%;height:auto;object-fit:cover;}
`;
  if (/<\/style>/i.test(html)) {
    return html.replace(/<\/style>/i, `${block}\n</style>`);
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `<style>${block}</style></head>`);
  }
  return `<style>${block}</style>${html}`;
}

export function validateAndPackageUnifiedPage(input: {
  html: string;
  clientHost: string;
  competitorHost: string;
  logoRequired: boolean;
  expectedSections?: number;
  colors?: BrandColors | null;
}): UnifiedValidation {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let html = ensureBrandCss(input.html, input.colors);

  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) {
    blockers.push("Generated markup is not a complete HTML document.");
  }
  if (!/<style[\s>]/i.test(html)) blockers.push("Inline CSS is missing.");
  if (!/<header[\s>]/i.test(html)) warnings.push("No header landmark was found.");
  if (!/<main[\s>]/i.test(html)) warnings.push("No main landmark was found.");
  if (!/<footer[\s>]/i.test(html)) warnings.push("No footer landmark was found.");

  const $ = cheerio.load(html);
  const sections = $("main section, body > section, main > *").length;
  if (input.expectedSections && sections < Math.min(3, input.expectedSections)) {
    warnings.push(`Only ${sections} content regions were found; the competitor inventory listed ${input.expectedSections}.`);
  }
  if (input.logoRequired && !$('img[data-logo-role="company"], img[data-adrival-logo], header img').length) {
    warnings.push("No company logo image was found in the header. A text wordmark may have been used.");
  }
  if (input.competitorHost && html.toLowerCase().includes(input.competitorHost.toLowerCase())) {
    blockers.push(`Competitor domain ${input.competitorHost} remains in the page.`);
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

export function injectIdentityLogo(
  html: string,
  logoUrl: string | null,
  clientName: string,
  clientUrl: string,
): string {
  if (!logoUrl) return html;
  const $ = cheerio.load(html);
  const imgTag = `<img class="adr-logo" data-logo-role="company" data-adrival-logo="1" src="${logoUrl}" alt="${clientName} logo" width="180" height="48" style="height:auto;max-height:44px;width:auto;object-fit:contain">`;

  const companyImgs = $('img[data-logo-role="company"], img[data-adrival-logo]');
  if (companyImgs.length) {
    companyImgs.each((_, el) => {
      $(el)
        .attr("src", logoUrl)
        .attr("alt", `${clientName} logo`)
        .attr("data-logo-role", "company")
        .attr("style", "height:auto;max-height:44px;width:auto;object-fit:contain")
        .removeAttr("loading");
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
      $('footer img[data-logo-role="company"]').attr("src", logoUrl).attr("alt", `${clientName} logo`);
    }
  }

  // Replace broken/empty/remote header images that look like logo slots
  $("header img").each((_, el) => {
    const src = ($(el).attr("src") || "").trim();
    const alt = ($(el).attr("alt") || "").toLowerCase();
    const role = ($(el).attr("data-logo-role") || "").toLowerCase();
    const looksLikeLogo =
      role === "company" ||
      /logo|brand|wordmark/i.test(alt) ||
      $(el).attr("data-adrival-logo") === "1";
    const broken =
      !src ||
      src === "#" ||
      src === "about:blank" ||
      /placeholder|logo\.svg|example\.com/i.test(src) ||
      (!src.startsWith("data:") && looksLikeLogo);
    if (broken && looksLikeLogo) {
      $(el)
        .attr("src", logoUrl)
        .attr("data-logo-role", "company")
        .attr("data-adrival-logo", "1")
        .attr("alt", `${clientName} logo`)
        .attr("style", "height:auto;max-height:44px;width:auto;object-fit:contain")
        .removeAttr("loading")
        .removeAttr("srcset");
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
  const $ = cheerio.load(html);
  const existing = $('img[data-logo-role="proof"]').length;
  if (existing >= Math.min(3, logos.length)) {
    $('img[data-logo-role="proof"]').each((index, el) => {
      const logo = logos[index];
      if (logo) $(el).attr("src", logo.src).attr("alt", logo.alt).removeAttr("loading");
    });
    return $.html();
  }
  const strip =
    `<div class="adr-proof-strip" style="display:flex;flex-wrap:wrap;gap:24px;align-items:center;justify-content:center">` +
    logos
      .slice(0, 6)
      .map(
        (logo) =>
          `<img data-logo-role="proof" src="${logo.src}" alt="${logo.alt}" style="max-height:36px;width:auto;object-fit:contain">`,
      )
      .join("") +
    `</div>`;
  const proofSection = $("section").filter((_, el) =>
    /proof|trust|client|partner|logo/i.test($(el).text().slice(0, 200)),
  ).first();
  if (proofSection.length) {
    proofSection.append(strip);
  }
  return $.html();
}
