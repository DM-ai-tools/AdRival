import * as cheerio from "cheerio";
import type { BrandSiteAssets } from "./brandAssets";

/** AU 13/1300/1800 + common local / intl phone patterns in visible copy. */
const PHONE_IN_TEXT_RE =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:\s*(?:ext|x)\.?\s*\d+)?/i;

const AU_SERVICE_PHONE_RE =
  /(?:\+?61[\s.-]?)?(?:0?13\d{2}|1300|1800|13\s?\d{2})[\s.-]?\d{3}[\s.-]?\d{3}/i;

function looksLikePhoneText(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 8 || t.length > 48) return false;
  if (/@|http|www\./i.test(t)) return false;
  if (/^call\b/i.test(t) && PHONE_IN_TEXT_RE.test(t)) return true;
  if (AU_SERVICE_PHONE_RE.test(t)) return true;
  const digits = t.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 && PHONE_IN_TEXT_RE.test(t);
}

function looksLikeEmailText(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

function formatCallLabel(phone: string): string {
  const cleaned = phone.replace(/^tel:/i, "").trim();
  // Keep existing spacing style if already human-readable
  if (/\s/.test(cleaned)) return `Call ${cleaned}`;
  // AU 1300/1800 style: 1300558659 → 1300 558 659
  const m = cleaned.match(/^(1300|1800|13\d{2})(\d{3})(\d{3})$/);
  if (m) return `Call ${m[1]} ${m[2]} ${m[3]}`;
  return `Call ${cleaned}`;
}

function telHref(phone: string): string {
  const raw = phone.replace(/^tel:/i, "").trim();
  const compact = raw.replace(/[^\d+]/g, "");
  return `tel:${compact || raw}`;
}

/**
 * Swap competitor phones/emails to brand contacts on the recreate path.
 * Updates href AND visible label; neutralizes competitor contacts when brand
 * has none (fail closed).
 */
export function applyBrandContactInfo(
  html: string,
  assets: Pick<BrandSiteAssets, "phones" | "emails"> | null | undefined,
): { html: string; stats: { phones: number; emails: number; neutralized: number } } {
  const stats = { phones: 0, emails: 0, neutralized: 0 };
  const $ = cheerio.load(html);
  const brandPhone = assets?.phones?.[0]?.trim() || null;
  const brandEmail = assets?.emails?.[0]?.trim() || null;

  $("a[href^='tel:']").each((_, el) => {
    const $el = $(el);
    if (brandPhone) {
      $el.attr("href", telHref(brandPhone));
      const label = ($el.text() || "").replace(/\s+/g, " ").trim();
      if (!label || looksLikePhoneText(label) || /^call\b/i.test(label)) {
        $el.text(formatCallLabel(brandPhone));
      }
      const aria = $el.attr("aria-label");
      if (aria && looksLikePhoneText(aria)) {
        $el.attr("aria-label", formatCallLabel(brandPhone));
      }
      stats.phones += 1;
    } else {
      $el.attr("href", "#");
      $el.attr("data-adrival-neutralized-contact", "tel");
      const label = ($el.text() || "").replace(/\s+/g, " ").trim();
      if (looksLikePhoneText(label)) {
        $el.text("Contact us");
      }
      stats.neutralized += 1;
    }
  });

  $("a[href^='mailto:']").each((_, el) => {
    const $el = $(el);
    if (brandEmail) {
      $el.attr("href", `mailto:${brandEmail}`);
      const label = ($el.text() || "").replace(/\s+/g, " ").trim();
      if (!label || looksLikeEmailText(label)) {
        $el.text(brandEmail);
      }
      stats.emails += 1;
    } else {
      $el.attr("href", "#");
      $el.attr("data-adrival-neutralized-contact", "mailto");
      stats.neutralized += 1;
    }
  });

  // Plaintext phone CTAs in chrome (buttons/spans/links without tel:)
  if (brandPhone) {
    const chrome =
      "header, nav, [role='banner'], .navbar, .header, .site-header, footer, [role='contentinfo']";
    $(`${chrome} a, ${chrome} button, ${chrome} span, ${chrome} p, ${chrome} div`).each(
      (_, el) => {
        const $el = $(el);
        if ($el.find("a, button, span, p, div").length > 0) return; // leaf-ish only
        const label = ($el.text() || "").replace(/\s+/g, " ").trim();
        if (!looksLikePhoneText(label)) return;
        if ($el.is("a")) {
          $el.attr("href", telHref(brandPhone));
        }
        $el.text(formatCallLabel(brandPhone));
        stats.phones += 1;
      },
    );
  } else {
    // Fail closed: strip visible competitor numbers in chrome even without brand phone
    const chrome =
      "header, nav, [role='banner'], .navbar, .header, .site-header, footer, [role='contentinfo']";
    $(`${chrome} a, ${chrome} button, ${chrome} span`).each((_, el) => {
      const $el = $(el);
      if ($el.find("a, button, span").length > 0) return;
      const label = ($el.text() || "").replace(/\s+/g, " ").trim();
      if (!looksLikePhoneText(label)) return;
      $el.text("Contact us");
      if ($el.is("a")) $el.attr("href", "#");
      stats.neutralized += 1;
    });
  }

  return { html: $.html(), stats };
}

/**
 * Hide empty styled pills/buttons left after logo/CID passes (broken imgs,
 * cleared labels) so they don't read as "sensitive" solid blocks.
 */
export function scrubEmptyChromePills(html: string): {
  html: string;
  removed: number;
} {
  const $ = cheerio.load(html);
  let removed = 0;
  const sel =
    "header a, header button, header [class*='btn'], header [class*='Button'], nav a, nav button, [role='banner'] a, [role='banner'] button";

  $(sel).each((_, el) => {
    const $el = $(el);
    if ($el.attr("data-adrival-logo") != null) return;
    if ($el.closest("[data-adrival-brand-footer]").length) return;
    const text = ($el.text() || "").replace(/\s+/g, " ").trim();
    const hasMedia =
      $el.find("img, svg, video, iframe, input, select, textarea").length > 0;
    if (text || hasMedia) return;
    // Empty rounded / pill chrome with background styling — hide
    const cls = `${$el.attr("class") || ""} ${$el.attr("style") || ""}`;
    const looksChrome =
      /btn|button|pill|chip|badge|cta|rounded|bg-|background/i.test(cls) ||
      Boolean($el.attr("style"));
    if (!looksChrome && $el.is("a") && !text) {
      // bare empty anchor in header
      $el.attr("hidden", "true");
      $el.attr("data-adrival-empty-chrome", "1");
      removed += 1;
      return;
    }
    if (looksChrome) {
      $el.attr("hidden", "true");
      $el.attr("data-adrival-empty-chrome", "1");
      removed += 1;
    }
  });

  return { html: $.html(), removed };
}
