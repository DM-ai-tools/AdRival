import * as cheerio from "cheerio";
import type { BrandSiteAssets } from "../brandAssets";

export type RecreateChromeLink = { label: string; href: string };

/** One field on the competitor lead form — used to rebuild a matching form dynamically. */
export type CompetitorFormField = {
  label: string;
  name: string;
  type: "text" | "email" | "tel" | "url" | "number" | "textarea" | "select" | "checkbox" | "radio";
  required: boolean;
  placeholder?: string;
  options?: string[];
};

export type CompetitorFormSpec = {
  fields: CompetitorFormField[];
  submitLabel: string;
  /** Rough layout hint from the competitor form. */
  layout: "single-column" | "two-column" | "stacked-wide";
  heading?: string | null;
  intro?: string | null;
};

export type CompetitorFooterColumn = {
  heading: string;
  links: RecreateChromeLink[];
};

export type CompetitorChrome = {
  navLinks: RecreateChromeLink[];
  footerLinks: RecreateChromeLink[];
  footerColumns: CompetitorFooterColumn[];
  headerCta: RecreateChromeLink | null;
  hasForm: boolean;
  /** Legacy flat labels — prefer formSpec.fields. */
  formFields: string[];
  formSpec: CompetitorFormSpec | null;
};

type CampaignBits = {
  headline?: string | null;
  primaryOffer?: string | null;
  cta?: string | null;
} | null;

const OFF_TOPIC_PATTERNS: Array<{ label: RegExp; topic: RegExp }> = [
  { label: /\bseo\b|search\s*engine\s*optim|local\s*seo|enterprise\s*seo|ecommerce\s*seo/i, topic: /\bseo\b|search\s*engine/i },
  { label: /\bweb\s*design\b|website\s*design|web\s*development/i, topic: /\bweb\s*design|website\s*design|web\s*dev/i },
  { label: /\bhosting\b|domain\s*name/i, topic: /\bhosting\b|domain/i },
  { label: /\bemail\s*marketing\b|newsletter/i, topic: /\bemail\s*marketing|newsletter|crm/i },
];

function clipLabel(label: string, max = 28): string {
  const text = label.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function campaignHay(campaign: CampaignBits, keyword?: string | null): string {
  return [keyword || "", campaign?.headline || "", campaign?.primaryOffer || "", campaign?.cta || ""]
    .join(" ")
    .toLowerCase();
}

export function isOffTopicChromeLink(label: string, topicHay: string): boolean {
  const text = (label || "").trim();
  if (!text) return true;
  for (const row of OFF_TOPIC_PATTERNS) {
    if (row.label.test(text) && !row.topic.test(topicHay)) return true;
  }
  return false;
}

export function isValidNavLabel(label: string): boolean {
  const text = (label || "").replace(/\s+/g, " ").trim();
  if (text.length < 2 || text.length > 28) return false;
  const words = text.split(/\s+/);
  if (words.length < 1 || words.length > 4) return false;
  if (/[,:;]/.test(text)) return false;
  if (/\.$/.test(text) && words.length > 2) return false;
  if (/^(home|about|contact|services|work|cases|blog|faq|pricing|team|login|sign\s*up)$/i.test(text)) {
    return true;
  }
  if (
    /amazing|record|featured|black\s*friday|peak\s*period|great\s*brands|tiktok'?s|growth\s*audit|we\s+grow|profitable|creative\s+strateg/i.test(
      text,
    )
  ) {
    return false;
  }
  if (/^(get|book|start|claim|try|join)\s+/i.test(text) && words.length >= 3) return false;
  return true;
}

function uniqueLinks(links: RecreateChromeLink[], max: number): RecreateChromeLink[] {
  const out: RecreateChromeLink[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const label = clipLabel(link.label || "");
    const href = (link.href || "").trim();
    if (!label || !href) continue;
    if (!isValidNavLabel(label) && !/^tel:|^mailto:/i.test(href)) continue;
    const key = `${label.toLowerCase()}|${href.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, href });
    if (out.length >= max) break;
  }
  return out;
}

function filterClientLinks(
  links: Array<{ label: string; href: string }> | undefined,
  topicHay: string,
  max: number,
): RecreateChromeLink[] {
  return uniqueLinks(
    (links || [])
      .filter((link) => isValidNavLabel(link.label) && !isOffTopicChromeLink(link.label, topicHay))
      .map((link) => ({ label: link.label, href: link.href })),
    max,
  );
}

function looksLikeCtaLabel(label: string): boolean {
  return /\b(get|book|call|start|try|join|apply|claim|schedule|audit|quote|demo|free|contact)\b/i.test(
    label,
  );
}

function inferFieldType(
  typeAttr: string,
  tag: string,
  name: string,
  label: string,
): CompetitorFormField["type"] {
  const hay = `${typeAttr} ${tag} ${name} ${label}`.toLowerCase();
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "select";
  if (typeAttr === "email" || /email/i.test(hay)) return "email";
  if (typeAttr === "tel" || /phone|mobile|tel/i.test(hay)) return "tel";
  if (typeAttr === "url" || /website|url/i.test(hay)) return "url";
  if (typeAttr === "number") return "number";
  if (typeAttr === "checkbox") return "checkbox";
  if (typeAttr === "radio") return "radio";
  return "text";
}

function humanizeName(raw: string): string {
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Build HTML for a lead form from the competitor's harvested field spec (not a hardcoded template). */
export function buildDynamicFormHtml(
  spec: CompetitorFormSpec | null | undefined,
  options?: { ctaLabel?: string | null; heading?: string | null },
): string {
  const fields = (spec?.fields || []).filter((f) => f.label || f.name);
  const useFields =
    fields.length >= 2
      ? fields
      : [
          { label: "Name", name: "name", type: "text" as const, required: true },
          { label: "Email", name: "email", type: "email" as const, required: true },
          { label: "Phone", name: "phone", type: "tel" as const, required: false },
        ];
  const layout = spec?.layout || (useFields.length >= 5 ? "two-column" : "single-column");
  const submit = (options?.ctaLabel || spec?.submitLabel || "Submit").trim() || "Submit";
  const heading = (options?.heading || spec?.heading || "").trim();
  const intro = (spec?.intro || "").trim();

  const fieldHtml = useFields
    .map((field) => {
      const id = `adr-field-${field.name.replace(/[^a-z0-9_-]/gi, "") || "field"}`;
      const req = field.required ? " required" : "";
      const ph = field.placeholder ? ` placeholder="${escapeAttr(field.placeholder)}"` : "";
      const label = escapeText(field.label || humanizeName(field.name));
      if (field.type === "textarea") {
        return `<label class="adr-field" for="${id}" style="display:grid;gap:6px;font-size:14px">${label}<textarea id="${id}" name="${escapeAttr(field.name)}" rows="4"${req}${ph} style="padding:12px 14px;border:1px solid var(--border,#d0d5dd);border-radius:10px;font:inherit"></textarea></label>`;
      }
      if (field.type === "select") {
        const opts = (field.options || ["Select…"])
          .map((o) => `<option value="${escapeAttr(o)}">${escapeText(o)}</option>`)
          .join("");
        return `<label class="adr-field" for="${id}" style="display:grid;gap:6px;font-size:14px">${label}<select id="${id}" name="${escapeAttr(field.name)}"${req} style="padding:12px 14px;border:1px solid var(--border,#d0d5dd);border-radius:10px;font:inherit">${opts}</select></label>`;
      }
      if (field.type === "checkbox") {
        return `<label class="adr-field adr-check" style="display:flex;gap:10px;align-items:flex-start;font-size:14px"><input id="${id}" name="${escapeAttr(field.name)}" type="checkbox"${req} style="margin-top:3px"><span>${label}</span></label>`;
      }
      const inputType = field.type === "radio" ? "text" : field.type;
      return `<label class="adr-field" for="${id}" style="display:grid;gap:6px;font-size:14px">${label}<input id="${id}" name="${escapeAttr(field.name)}" type="${inputType}"${req}${ph} style="padding:12px 14px;border:1px solid var(--border,#d0d5dd);border-radius:10px;font:inherit"></label>`;
    })
    .join("\n");

  const gridStyle =
    layout === "two-column"
      ? "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px"
      : "display:grid;gap:14px;grid-template-columns:1fr";
  const maxWidth = layout === "stacked-wide" || layout === "two-column" ? "720px" : "520px";

  return `<section data-section-id="adr-lead-form-section" id="adr-lead-form-section" style="padding:56px 0">
  <div class="adr-container" style="max-width:${maxWidth};margin:0 auto">
    ${heading ? `<h2 style="margin:0 0 12px;font-size:clamp(1.5rem,3vw,2rem)">${escapeText(heading)}</h2>` : ""}
    ${intro ? `<p style="margin:0 0 22px;opacity:.85">${escapeText(intro)}</p>` : ""}
    <form id="adr-lead-form" style="${gridStyle}">
      ${fieldHtml}
      <div style="${layout === "two-column" ? "grid-column:1/-1;" : ""}margin-top:4px">
        <button type="submit" class="adr-cta-btn" style="display:inline-flex;align-items:center;justify-content:center;padding:12px 22px;border:0;border-radius:999px;background:var(--accent,var(--brand-accent,var(--primary,#0F7A6C)));color:var(--text-on-brand,#fff);font-weight:600;cursor:pointer">${escapeText(submit)}</button>
      </div>
    </form>
  </div>
</section>`;
}

export function extractCompetitorChromeFromHtml(html: string): CompetitorChrome {
  const $ = cheerio.load(html || "");
  const navLinks: RecreateChromeLink[] = [];
  const footerLinks: RecreateChromeLink[] = [];
  const footerColumns: CompetitorFooterColumn[] = [];
  let headerCta: RecreateChromeLink | null = null;

  const push = (bucket: RecreateChromeLink[], label: string, href: string) => {
    const clean = label.replace(/\s+/g, " ").trim();
    if (!isValidNavLabel(clean)) return;
    if (bucket.some((l) => l.label.toLowerCase() === clean.toLowerCase())) return;
    bucket.push({ label: clipLabel(clean), href: href || "#" });
  };

  $("header nav a, header [role='navigation'] a, header .nav a, header ul a").each((_, el) => {
    const $el = $(el);
    const label = ($el.text() || $el.attr("aria-label") || "").replace(/\s+/g, " ").trim();
    const href = ($el.attr("href") || "#").trim();
    if (looksLikeCtaLabel(label) && /btn|button|cta|primary/i.test(`${$el.attr("class") || ""}`)) {
      if (!headerCta) headerCta = { label: clipLabel(label, 40), href };
      return;
    }
    push(navLinks, label, href);
  });

  $("header a, header button").each((_, el) => {
    if (headerCta) return false;
    const $el = $(el);
    if ($el.closest("nav, [role='navigation']").length) return;
    const label = ($el.text() || "").replace(/\s+/g, " ").trim();
    if (!label || label.length > 48) return;
    if (!looksLikeCtaLabel(label)) return;
    headerCta = { label: clipLabel(label, 40), href: ($el.attr("href") || "#").trim() || "#" };
  });

  $("footer").first().find("div, section, nav").each((_, block) => {
    const $block = $(block);
    if ($block.find("> div, > section, > nav").length > 3) return;
    const heading = ($block.find("h2, h3, h4, .title, [class*='heading']").first().text() || "")
      .replace(/\s+/g, " ")
      .trim();
    const links: RecreateChromeLink[] = [];
    $block.find("a").each((__, a) => {
      const $a = $(a);
      const label = ($a.text() || "").replace(/\s+/g, " ").trim();
      const href = ($a.attr("href") || "#").trim();
      if (/^(facebook|instagram|linkedin|twitter|tiktok|youtube|x)$/i.test(label)) {
        links.push({ label, href });
        return;
      }
      if (!isValidNavLabel(label) && !/^tel:|^mailto:/i.test(href)) return;
      if (links.some((l) => l.label.toLowerCase() === label.toLowerCase())) return;
      links.push({ label: clipLabel(label), href });
    });
    if (links.length >= 2 && heading && heading.length <= 32) {
      if (!footerColumns.some((c) => c.heading.toLowerCase() === heading.toLowerCase())) {
        footerColumns.push({ heading: clipLabel(heading, 24), links: links.slice(0, 8) });
      }
    }
  });

  $("footer a").each((_, el) => {
    const $el = $(el);
    const label = ($el.text() || $el.attr("aria-label") || "").replace(/\s+/g, " ").trim();
    const href = ($el.attr("href") || "#").trim();
    if (/^(facebook|instagram|linkedin|twitter|tiktok|youtube|x)$/i.test(label)) {
      footerLinks.push({ label, href });
      return;
    }
    push(footerLinks, label, href);
  });

  const formsFound: CompetitorFormSpec[] = [];
  const formFields: string[] = [];
  $("form").each((_, form) => {
    const $form = $(form);
    const controls = $form.find(
      "input:not([type='hidden']):not([type='submit']):not([type='button']), textarea, select",
    );
    if (controls.length < 2) return;
    const fields: CompetitorFormField[] = [];
    controls.each((__, field) => {
      const $field = $(field);
      const tag = (((field as { tagName?: string }).tagName) || "input").toLowerCase();
      const typeAttr = (($field.attr("type") || "") as string).toLowerCase();
      if (["hidden", "submit", "button", "image", "file"].includes(typeAttr)) return;
      const name = ($field.attr("name") || $field.attr("id") || `field_${fields.length + 1}`).trim();
      let label =
        ($form.find(`label[for='${$field.attr("id")}']`).first().text() || "").replace(/\s+/g, " ").trim() ||
        ($field.attr("aria-label") || "").trim() ||
        ($field.attr("placeholder") || "").trim() ||
        humanizeName(name);
      if ($field.closest("label").length) {
        label =
          $field
            .closest("label")
            .clone()
            .children("input, textarea, select")
            .remove()
            .end()
            .text()
            .replace(/\s+/g, " ")
            .trim() || label;
      }
      if (label.length > 80) label = label.slice(0, 80);
      const options: string[] = [];
      if (tag === "select") {
        $field.find("option").each((___, opt) => {
          const t = $(opt).text().replace(/\s+/g, " ").trim();
          if (t) options.push(t.slice(0, 60));
        });
      }
      const typed = inferFieldType(typeAttr, tag, name, label);
      fields.push({
        label: label || humanizeName(name),
        name: name.replace(/\s+/g, "_").slice(0, 40),
        type: typed,
        required: Boolean($field.attr("required")),
        placeholder: ($field.attr("placeholder") || "").trim().slice(0, 80) || undefined,
        options: options.length ? options.slice(0, 12) : undefined,
      });
      const last = fields[fields.length - 1].label;
      if (!formFields.includes(last)) formFields.push(last);
    });
    if (fields.length < 2) return;

    const submitLabel =
      (
        $form.find("button[type='submit'], input[type='submit']").first().text() ||
        $form.find("button[type='submit'], input[type='submit']").first().attr("value") ||
        "Submit"
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 48) || "Submit";

    const $section = $form.closest("section, [class*='form'], [class*='Form']");
    const heading =
      ($section.find("h1, h2, h3").first().text() || "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
    const intro =
      ($section.find("p").first().text() || "").replace(/\s+/g, " ").trim().slice(0, 220) || null;
    const layout: CompetitorFormSpec["layout"] =
      fields.length >= 5 ? "two-column" : fields.some((f) => f.type === "textarea") ? "stacked-wide" : "single-column";

    formsFound.push({ fields: fields.slice(0, 16), submitLabel, layout, heading, intro });
  });

  const resolvedForm =
    formsFound.sort((a, b) => b.fields.length - a.fields.length)[0] || null;
  return {
    navLinks: navLinks.slice(0, 8),
    footerLinks: footerLinks.slice(0, 14),
    footerColumns: footerColumns.slice(0, 5),
    headerCta,
    hasForm: Boolean(resolvedForm) || formFields.length >= 2,
    formFields: (resolvedForm ? resolvedForm.fields.map((f) => f.label) : formFields).slice(0, 16),
    formSpec: resolvedForm,
  };
}

export function buildRecreateChromeLinks(input: {
  clientUrl: string;
  sections?: Array<{ id: string; heading?: string | null; purpose?: string | null }>;
  campaignOffer?: CampaignBits;
  keyword?: string | null;
  assets?: BrandSiteAssets | null;
  hasForm?: boolean;
  competitorChrome?: CompetitorChrome | null;
}): {
  navLinks: RecreateChromeLink[];
  footerLinks: RecreateChromeLink[];
  ctaLinks: RecreateChromeLink[];
  footerColumns: CompetitorFooterColumn[];
  topicHay: string;
} {
  const topicHay = campaignHay(input.campaignOffer || null, input.keyword);
  const clientUrl = (input.clientUrl || "#").trim() || "#";
  const formHref = input.hasForm || input.competitorChrome?.hasForm ? "#adr-lead-form" : clientUrl;
  const comp = input.competitorChrome;

  const remap = (links: RecreateChromeLink[], max: number): RecreateChromeLink[] =>
    uniqueLinks(
      links.map((link) => ({
        label: link.label,
        href: /^tel:|^mailto:|^#/i.test(link.href) ? link.href : clientUrl,
      })),
      max,
    );

  const competitorNav = remap(comp?.navLinks || [], 6);
  const competitorFooter = remap(comp?.footerLinks || [], 12);
  const clientNav = filterClientLinks(input.assets?.navLinks, topicHay, 4);
  const clientFooter = filterClientLinks(
    [...(input.assets?.footerLinks || []), ...(input.assets?.navLinks || [])],
    topicHay,
    8,
  );

  const navLinks =
    competitorNav.length >= 1
      ? competitorNav
      : uniqueLinks(
          [
            ...clientNav.slice(0, 3),
            { label: "Home", href: clientUrl },
            { label: "Contact", href: formHref },
          ],
          competitorNav.length === 0 && clientNav.length === 0 ? 2 : 4,
        );

  const footerLinks = uniqueLinks(
    [
      ...competitorFooter,
      ...(competitorFooter.length < 3 ? clientFooter : []),
      { label: "Home", href: clientUrl },
      { label: "Contact", href: formHref },
      ...(input.assets?.phones?.[0]
        ? [{ label: "Call us", href: `tel:${input.assets.phones[0].replace(/\s+/g, "")}` }]
        : []),
      ...(input.assets?.emails?.[0]
        ? [{ label: input.assets.emails[0], href: `mailto:${input.assets.emails[0]}` }]
        : []),
    ],
    12,
  );

  const footerColumns = (comp?.footerColumns || [])
    .map((col) => ({
      heading: col.heading,
      links: remap(col.links, 8),
    }))
    .filter((col) => col.links.length);

  const campaignCta = (input.campaignOffer?.cta || "").trim();
  const competitorCta = comp?.headerCta?.label || "";
  const ctaLabel = clipLabel(campaignCta || competitorCta || "Contact", 40) || "Contact";

  return {
    navLinks,
    footerLinks,
    ctaLinks: [{ label: ctaLabel, href: formHref }],
    footerColumns,
    topicHay,
  };
}

export function scrubOffTopicChromeHtml(
  html: string,
  topicHay: string,
  allowedLabels: string[],
): string {
  const $ = cheerio.load(html);
  const allowed = new Set(allowedLabels.map((l) => l.toLowerCase().trim()).filter(Boolean));
  const scrub = (scope: string) => {
    $(`${scope} a`).each((_, el) => {
      const label = ($(el).text() || "").replace(/\s+/g, " ").trim();
      if (!label) return;
      if (allowed.has(label.toLowerCase())) return;
      const href = ($(el).attr("href") || "").trim();
      if (/^tel:|^mailto:/i.test(href)) return;
      if (/facebook|instagram|linkedin|tiktok|twitter|youtube/i.test(href)) return;
      const invalid = !isValidNavLabel(label) || isOffTopicChromeLink(label, topicHay);
      if (!invalid) return;
      const $li = $(el).closest("li");
      if ($li.length) $li.remove();
      else $(el).remove();
    });
  };
  scrub("header");
  scrub("footer");
  return $.html();
}
