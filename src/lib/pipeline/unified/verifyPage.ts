import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { buildDynamicFormHtml, type CompetitorFormSpec } from "./recreateChrome";

export type PageVerifyIssue = {
  code: string;
  severity: "blocker" | "warning";
  message: string;
};

export type PageVerifyResult = {
  html: string;
  ok: boolean;
  blockers: string[];
  warnings: string[];
  issues: PageVerifyIssue[];
  repairs: string[];
};

export type PageVerifyOptions = {
  expectForm: boolean;
  maxBodyCtas?: number;
  maxHeaderCtas?: number;
  clientName?: string;
  logoRequired?: boolean;
  /** Competitor form field spec — used when injecting a missing form. */
  formSpec?: CompetitorFormSpec | null;
  formCtaLabel?: string | null;
};

const CTA_TEXT =
  /\b(get|book|call|start|try|join|apply|claim|schedule|buy|download|sign\s*up|contact|audit|quote|demo|free)\b/i;

function isProminentCta($: cheerio.CheerioAPI, el: Element): boolean {
  const $el = $(el);
  if ($el.closest("nav, footer, header nav, .adr-nav").length) return false;
  const tag = (el.tagName || "").toLowerCase();
  const cls = `${$el.attr("class") || ""} ${$el.attr("role") || ""}`.toLowerCase();
  const text = ($el.text() || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 72) return false;
  if (tag === "button") return true;
  if ($el.is("input[type='submit'], input[type='button']")) return true;
  if (/btn|button|cta|primary|pill/.test(cls)) return true;
  if (tag === "a" && CTA_TEXT.test(text) && text.split(/\s+/).length <= 8) return true;
  return false;
}

function looksIncompleteCta($: cheerio.CheerioAPI, el: Element): boolean {
  const $el = $(el);
  const text = ($el.text() || "").replace(/\s+/g, " ").trim();
  const href = ($el.attr("href") || "").trim();
  const style = `${$el.attr("style") || ""} ${$el.attr("class") || ""}`.toLowerCase();
  if (!text || text === "…" || text === "..." || /\[\[placeholder\]\]/i.test(text)) return true;
  if ($el.is("a") && (!href || href === "#" || href === "about:blank")) return true;
  if ($el.is("a") && CTA_TEXT.test(text) && !/btn|button|cta|adr-header-cta|pill/.test(style)) {
    const display = style.includes("display") || $el.parent().is("li");
    if (!display && text.split(/\s+/).length <= 6) return true;
  }
  return false;
}

function formFieldCount($form: cheerio.Cheerio<AnyNode>): number {
  return $form.find("input:not([type='hidden']):not([type='submit']):not([type='button']), textarea, select").length;
}

/**
 * Thorough post-design QA: collapse duplicate forms/CTAs, finish incomplete CTAs,
 * check logo integrity, and surface remaining glitches before the page is presented.
 */
export function verifyAndRepairUnifiedPage(
  html: string,
  options: PageVerifyOptions,
): PageVerifyResult {
  const issues: PageVerifyIssue[] = [];
  const repairs: string[] = [];
  const $ = cheerio.load(html);
  const maxBodyCtas = options.maxBodyCtas ?? 4;
  const maxHeaderCtas = options.maxHeaderCtas ?? 1;

  // ——— Forms: keep at most one ———
  const $forms = $("form").toArray().filter((el) => formFieldCount($(el)) >= 1);
  if (!options.expectForm && $forms.length) {
    for (const el of $forms) {
      $(el).remove();
    }
    repairs.push(`Removed ${$forms.length} unexpected form(s).`);
  } else if (options.expectForm && $forms.length === 0) {
    const formHtml = buildDynamicFormHtml(options.formSpec, {
      ctaLabel: options.formCtaLabel,
      heading: options.formSpec?.heading || null,
    });
    const $main = $("main#adr-sections, main").first();
    if ($main.length) {
      const $last = $main.children("section").last();
      if ($last.length) $last.after(formHtml);
      else $main.append(formHtml);
    } else if ($("footer").length) {
      $("footer").first().before(formHtml);
    } else {
      $("body").append(formHtml);
    }
    repairs.push(
      `Injected dynamic lead form (${options.formSpec?.fields?.length || 3} fields) from competitor spec.`,
    );
  } else if (options.expectForm && $forms.length === 1 && options.formSpec?.fields?.length) {
    // If the model under-built the form vs competitor field count, replace with harvested spec.
    const expected = options.formSpec.fields.length;
    const actual = formFieldCount($($forms[0]));
    if (actual + 1 < expected) {
      $($forms[0]).closest("section").replaceWith(
        buildDynamicFormHtml(options.formSpec, {
          ctaLabel: options.formCtaLabel,
          heading: options.formSpec.heading || null,
        }),
      );
      repairs.push(`Replaced underbuilt form (${actual} fields) with competitor spec (${expected} fields).`);
    } else if (!$($forms[0]).attr("id")) {
      $($forms[0]).attr("id", "adr-lead-form");
    }
  } else if ($forms.length > 1) {
    // Prefer #adr-lead-form, else the form with the most fields.
    const ranked = $forms
      .map((el) => ({
        el,
        id: ($(el).attr("id") || "").toLowerCase(),
        fields: formFieldCount($(el)),
      }))
      .sort((a, b) => {
        const aPref = a.id === "adr-lead-form" || a.id.includes("lead") ? 1 : 0;
        const bPref = b.id === "adr-lead-form" || b.id.includes("lead") ? 1 : 0;
        if (bPref !== aPref) return bPref - aPref;
        return b.fields - a.fields;
      });
    const keep = ranked[0].el;
    $(keep).attr("id", $(keep).attr("id") || "adr-lead-form");
    let removed = 0;
    for (const row of ranked.slice(1)) {
      $(row.el).remove();
      removed += 1;
    }
    repairs.push(`Collapsed ${removed + 1} forms down to 1 lead form.`);
  } else if ($forms.length === 1) {
    const $keep = $($forms[0]);
    if (!$keep.attr("id")) $keep.attr("id", "adr-lead-form");
  }

  // Ensure remaining form has a submit control
  $("form#adr-lead-form, form").first().each((_, el) => {
    const $form = $(el);
    if (!$form.find("button[type='submit'], input[type='submit']").length) {
      $form.append(
        `<button type="submit" class="adr-cta-btn" style="display:inline-flex;align-items:center;justify-content:center;padding:12px 22px;border:0;border-radius:999px;background:var(--primary,var(--brand-primary,#0F7A6C));color:var(--text-on-brand,#fff);font-weight:600;cursor:pointer">Submit</button>`,
      );
      repairs.push("Added missing submit button on the lead form.");
    }
  });

  // ——— Header CTAs ———
  const headerCtas = $("header a, header button")
    .toArray()
    .filter((el) => {
      const $el = $(el);
      if ($el.closest("nav, .adr-nav").length) return false;
      return (
        $el.hasClass("adr-header-cta") ||
        /btn|cta|button/i.test($el.attr("class") || "") ||
        CTA_TEXT.test(($el.text() || "").trim())
      );
    });
  if (headerCtas.length > maxHeaderCtas) {
    for (const el of headerCtas.slice(maxHeaderCtas)) {
      $(el).remove();
    }
    repairs.push(`Reduced header CTAs to ${maxHeaderCtas}.`);
  }

  // ——— Body CTAs (outside header/footer/nav) ———
  const bodyCtas = $("a, button, input[type='submit'], input[type='button']")
    .toArray()
    .filter((el) => isProminentCta($, el));
  if (bodyCtas.length > maxBodyCtas) {
    // Keep first N in document order (hero + early sections), drop the rest that aren't form submits.
    let kept = 0;
    for (const el of bodyCtas) {
      const $el = $(el);
      const isSubmit =
        $el.is("button[type='submit'], input[type='submit']") || $el.closest("form").length > 0;
      if (isSubmit) continue;
      if (kept < maxBodyCtas) {
        kept += 1;
        continue;
      }
      // Demote excess CTAs to plain text links or remove empty shells
      if ($el.is("button")) {
        $el.replaceWith(`<span>${($el.text() || "").trim()}</span>`);
      } else {
        $el.removeClass("btn button cta primary pill adr-cta-btn");
        const cls = ($el.attr("class") || "")
          .split(/\s+/)
          .filter((c) => c && !/btn|button|cta|primary|pill/i.test(c))
          .join(" ");
        if (cls) $el.attr("class", cls);
        else $el.removeAttr("class");
        $el.attr("style", "text-decoration:underline");
      }
    }
    repairs.push(`Demoted excess body CTAs (cap ${maxBodyCtas}).`);
  }

  // ——— Finish incomplete CTAs ———
  $("a, button").each((_, el) => {
    if (!isProminentCta($, el) && !$(el).hasClass("adr-header-cta")) return;
    const $el = $(el);
    if (!looksIncompleteCta($, el)) {
      // Still ensure button-like CTAs have finished styles
      if (
        $el.is("a, button") &&
        (/btn|cta|button|adr-header-cta|adr-cta/i.test($el.attr("class") || "") ||
          $el.hasClass("adr-header-cta")) &&
        !/padding|background/i.test($el.attr("style") || "")
      ) {
        const existing = ($el.attr("style") || "").trim();
        const finished =
          "display:inline-flex;align-items:center;justify-content:center;padding:12px 22px;border-radius:999px;background:var(--accent,var(--brand-accent,var(--primary,#0F7A6C)));color:var(--text-on-brand,#fff);font-weight:600;text-decoration:none;border:0;cursor:pointer";
        $el.attr("style", existing ? `${existing};${finished}` : finished);
        if (!$el.attr("class")?.includes("adr-cta")) {
          $el.addClass("adr-cta-btn");
        }
        repairs.push("Finished incomplete CTA button styling.");
      }
      return;
    }
    const text = ($el.text() || "").replace(/\s+/g, " ").trim();
    if (!text || /\[\[placeholder\]\]/i.test(text) || text === "…" || text === "...") {
      $el.remove();
      repairs.push("Removed empty/placeholder CTA.");
      return;
    }
    if ($el.is("a") && (!($el.attr("href") || "").trim() || $el.attr("href") === "#")) {
      $el.attr("href", options.expectForm ? "#adr-lead-form" : "#");
      repairs.push("Repaired CTA with missing href.");
    }
    const existing = ($el.attr("style") || "").trim();
    const finished =
      "display:inline-flex;align-items:center;justify-content:center;padding:12px 22px;border-radius:999px;background:var(--accent,var(--brand-accent,var(--primary,#0F7A6C)));color:var(--text-on-brand,#fff);font-weight:600;text-decoration:none;border:0;cursor:pointer";
    $el.attr("style", existing ? `${existing};${finished}` : finished);
    $el.addClass("adr-cta-btn");
    repairs.push("Finished incomplete CTA design.");
  });

  // ——— Logo integrity ———
  const $logos = $('img[data-logo-role="company"], img[data-adrival-logo], header .adr-logo');
  if (options.logoRequired && !$logos.length) {
    issues.push({
      code: "missing_logo",
      severity: "blocker",
      message: "Company logo is missing from the finished page.",
    });
  }
  $logos.each((_, el) => {
    const $el = $(el);
    const src = ($el.attr("src") || "").trim();
    if (!src || src.includes("ADRIVAL_IDENTITY") || src.includes("{{") || src === "#") {
      issues.push({
        code: "broken_logo",
        severity: "blocker",
        message: "Company logo src is still a placeholder or empty.",
      });
      return;
    }
    // Prevent clipped / incomplete logos — drop fixed width/height that crop wide wordmarks
    $el.removeAttr("width").removeAttr("height");
    $el.attr(
      "style",
      "display:block;height:auto;max-height:56px;max-width:240px;width:auto;object-fit:contain;object-position:left center",
    );
    $el.removeAttr("loading").removeAttr("srcset");
    if (!$el.attr("alt")) {
      $el.attr("alt", `${options.clientName || "Company"} logo`);
    }
  });
  if ($logos.length) repairs.push("Normalized company logo sizing so the full mark is visible.");

  // ——— Glitch scans ———
  const pageText = $.root().text();
  if (/\{\{[^}]+\}\}/.test(html)) {
    issues.push({
      code: "template_leak",
      severity: "blocker",
      message: "Template placeholders remain visible in the page HTML.",
    });
  }
  if (/\[\[PLACEHOLDER\]\]/i.test(pageText)) {
    issues.push({
      code: "placeholder_copy",
      severity: "warning",
      message: "Unresolved [[PLACEHOLDER]] copy remains on the page.",
    });
  }
  if (/\bLorem ipsum\b/i.test(pageText)) {
    issues.push({
      code: "lorem",
      severity: "blocker",
      message: "Lorem ipsum placeholder copy was found.",
    });
  }
  $("img").each((_, el) => {
    const src = ($(el).attr("src") || "").trim();
    const alt = ($(el).attr("alt") || "").toLowerCase();
    if (!src && /logo|brand/i.test(alt)) {
      issues.push({
        code: "empty_logo_img",
        severity: "blocker",
        message: "A logo image has an empty src.",
      });
    }
  });

  // Pill clusters that aren't real CTAs but look unfinished (empty pills)
  $(".pill, [class*='pill']").each((_, el) => {
    const text = ($(el).text() || "").replace(/\s+/g, " ").trim();
    if (!text) {
      $(el).remove();
      repairs.push("Removed empty pill element.");
    }
  });

  // Final form count check after repairs
  const finalForms = $("form").toArray().filter((el) => formFieldCount($(el)) >= 1);
  if (finalForms.length > 1) {
    issues.push({
      code: "too_many_forms",
      severity: "blocker",
      message: `Page still has ${finalForms.length} forms after repair (expected ≤ 1).`,
    });
  }

  const blockers = issues.filter((i) => i.severity === "blocker").map((i) => i.message);
  const warnings = issues.filter((i) => i.severity === "warning").map((i) => i.message);

  return {
    html: $.html(),
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    issues,
    repairs: [...new Set(repairs)],
  };
}
