import type { Browser } from "playwright";
import type { BlueprintSection, CompetitorBlueprint } from "./blueprint";

/**
 * After the page is built: render it, measure every section the same way the
 * competitor was measured, and list where the rebuild drifted. Also checks
 * the words for repetition, copied sentences and competitor names.
 */

export type SectionMeasure = {
  id: string;
  height: number;
  words: number;
  columns: number;
  cards: number;
  dark: boolean;
  images: number;
  formFields: number;
  /** Section text without the form, and its headings. */
  text?: string;
  headings?: string[];
  /** A full-width photo sits behind the band's text. */
  photo?: boolean;
  /** Where item icons sit in the main row of items, and whether rules divide them. */
  iconSide?: "left" | "top" | null;
  divided?: boolean;
  /** Horizontal centre of the form, when the section has one. */
  formCenterX?: number | null;
};

export type ChromeMeasure = {
  /** Horizontal centre of the header logo, 0–1 of the page width. */
  logoCenter: number | null;
  headerItems: number;
  /** Header text, and whether it links a phone number or an email. */
  headerText?: string;
  headerTel?: boolean;
  headerMail?: boolean;
  footerHeight: number;
};

export type FidelityReport = {
  score: number;
  /** severe = layout needs rebuilding; copied = competitor lines to reword (layout kept). */
  sections: Array<{ id: string; kind: string; problems: string[]; severe: boolean; copied: string[] }>;
  /** Header and footer drift from the competitor's. */
  chrome: { header: string[]; footer: string[] };
  consistency: { styleBlocks: number; fontSizes: number; sectionPaddings: number };
  form: { expected: number; found: number; inPlace: boolean } | null;
  content: { repeatedPhrases: string[]; copiedSentences: string[]; competitorMentions: number };
  summary: string[];
};

const MEASURE_SCRIPT = String.raw`(function(){
  function box(el){ var r = el.getBoundingClientRect(); return { y: r.y + scrollY, h: r.height, w: r.width }; }
  function lum(c){ var m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return 1; var p = m[1].split(',').map(parseFloat); if (p.length > 3 && p[3] < 0.1) return 1; function t(v){ v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); } return 0.2126 * t(p[0]) + 0.7152 * t(p[1]) + 0.0722 * t(p[2]); }
  function bgOf(el){ var n = el; for (var d = 0; n && d < 3; d++) { var s = getComputedStyle(n); if (/gradient|url\(/.test(s.backgroundImage)) return 0.1; var l = lum(s.backgroundColor); if (l < 1) return l; n = n.firstElementChild; } return 1; }
  var out = [];
  document.querySelectorAll('main [data-section-id]').forEach(function(el){
    if (el.parentElement && el.parentElement.closest('[data-section-id]')) return;
    var best = { cols: 1, cards: 0 };
    var all = [el].concat(Array.prototype.slice.call(el.querySelectorAll('div,ul,ol,article')));
    for (var i = 0; i < all.length && i < 500; i++) {
      var kids = Array.prototype.slice.call(all[i].children).filter(function(c){ var b = box(c); return b.w > 60 && b.h > 30; });
      if (kids.length < 2) continue;
      var rows = {}; kids.forEach(function(k){ var y = Math.round(box(k).y / 14); rows[y] = (rows[y] || 0) + 1; });
      var cols = Math.max.apply(null, Object.keys(rows).map(function(k){ return rows[k]; }));
      var widths = kids.map(function(k){ return box(k).w; });
      var similar = Math.max.apply(null, widths) - Math.min.apply(null, widths) < Math.max(40, Math.max.apply(null, widths) * 0.15);
      var cards = similar && kids.length >= 3 ? kids.length : 0;
      if (cols >= 2 && (cards > best.cards || (cards === best.cards && cols > best.cols))) best = { cols: cols, cards: cards };
    }
    var clone = el.cloneNode(true); clone.querySelectorAll('form').forEach(function(f){ f.remove(); });
    var text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    var ownText = (clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
    var heads = Array.prototype.slice.call(clone.querySelectorAll('h1,h2,h3,.adr-eyebrow')).map(function(h){ return (h.textContent || '').replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    // Icon beside or above the text in the first item of the main row of items.
    var iconSide = null; var divided = false;
    var grid = el.querySelector('.adr-grid');
    if (grid && grid.children.length >= 2) {
      var item = grid.children[0];
      var icon = item.querySelector('.adr-icon, img, svg');
      var label = Array.prototype.slice.call(item.querySelectorAll('h3,h4,p,span,strong')).find(function(t){ return (t.textContent || '').trim().length > 2 && !(icon && (icon.contains(t) || t.contains(icon))); });
      if (icon && label) { var ib = box(icon), lb = box(label); iconSide = lb.y < ib.y + ib.h - 4 && label.getBoundingClientRect().left >= icon.getBoundingClientRect().right - 4 ? 'left' : 'top'; }
      var second = grid.children[1]; var ss = getComputedStyle(second);
      divided = grid.classList.contains('adr-grid--divided') || parseFloat(ss.borderLeftWidth) > 0;
    }
    var formEl = el.querySelector('form'); var fr = formEl ? formEl.getBoundingClientRect() : null;
    out.push({
      id: el.getAttribute('data-section-id'),
      height: Math.round(box(el).h),
      words: text ? text.split(' ').length : 0,
      columns: Math.min(best.cols, 6),
      cards: best.cards,
      dark: bgOf(el) < 0.18,
      images: el.querySelectorAll('img').length,
      formFields: el.querySelectorAll('form input:not([type=hidden]), form select, form textarea').length,
      text: ownText,
      headings: heads,
      photo: el.classList.contains('adr-section--photo') || !!el.querySelector('.adr-photo-bg'),
      iconSide: iconSide,
      divided: divided,
      formCenterX: fr ? Math.round(fr.left + fr.width / 2) : null
    });
  });
  var sizes = {}; document.querySelectorAll('main h1, main h2, main h3, main p').forEach(function(e){ sizes[getComputedStyle(e).fontSize] = 1; });
  var pads = {}; document.querySelectorAll('main [data-section-id]').forEach(function(e){ pads[getComputedStyle(e).paddingTop] = 1; });
  var header = document.querySelector('body > header, header.adr-header');
  var logo = header ? header.querySelector('img[data-logo-role="company"], .adr-brand, .adr-wordmark') : null;
  var lr = logo ? logo.getBoundingClientRect() : null;
  var footer = document.querySelector('body > footer, footer.adr-footer');
  var chrome = {
    logoCenter: lr && lr.width ? Math.round((lr.left + lr.width / 2) / innerWidth * 100) / 100 : null,
    headerItems: header ? header.querySelectorAll('a, .adr-header-item').length : 0,
    headerText: header ? (header.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400) : '',
    headerTel: header ? !!header.querySelector('a[href^="tel:"]') : false,
    headerMail: header ? !!header.querySelector('a[href^="mailto:"]') : false,
    footerHeight: footer ? Math.round(footer.getBoundingClientRect().height) : 0
  };
  return { sections: out, chrome: chrome, fontSizes: Object.keys(sizes).length, paddings: Object.keys(pads).length, styles: document.querySelectorAll('style').length, text: (document.querySelector('main') || document.body).innerText };
})()`;

type Measured = {
  sections: SectionMeasure[];
  chrome?: ChromeMeasure;
  fontSizes: number;
  paddings: number;
  styles: number;
  text: string;
};

export async function measureRenderedPage(html: string, browser?: Browser): Promise<Measured> {
  const { launchChromium } = await import("../content/playwrightRuntime");
  const own = !browser;
  const b = browser || (await launchChromium());
  try {
    const page = await b.newPage({ viewport: { width: 1280, height: 860 } });
    // Data-URI images and inline CSS only; external fonts may not load offline.
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(400);
    const measured = (await page.evaluate(MEASURE_SCRIPT)) as Measured;
    await page.close().catch(() => undefined);
    return measured;
  } finally {
    if (own) await b.close().catch(() => undefined);
  }
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$%'\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const STOP = new Set(["the", "and", "a", "to", "of", "for", "your", "you", "in", "we", "our", "with", "that", "is", "it", "on", "are", "or", "be", "this", "an", "at", "as", "by", "from"]);

/** Phrases (4–6 words) repeated three or more times across the page. */
export function repeatedPhrases(text: string, min = 3): string[] {
  const w = words(text);
  const counts = new Map<string, number>();
  for (let n = 4; n <= 6; n += 1) {
    for (let i = 0; i + n <= w.length; i += 1) {
      const gram = w.slice(i, i + n);
      if (gram.filter((x) => !STOP.has(x)).length < 3) continue;
      const key = gram.join(" ");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const hits = [...counts.entries()].filter(([, c]) => c >= min).sort((a, b) => b[0].length - a[0].length);
  const out: string[] = [];
  for (const [phrase] of hits) {
    if (out.some((p) => p.includes(phrase))) continue;
    out.push(phrase);
    if (out.length >= 8) break;
  }
  return out;
}

/** Competitor sentences reproduced word for word (6+ word runs). */
export function copiedSentences(rebuilt: string, competitorBlocks: string[], minRun = 6): string[] {
  const rw = words(rebuilt);
  const grams = new Set<string>();
  for (let i = 0; i + minRun <= rw.length; i += 1) grams.add(rw.slice(i, i + minRun).join(" "));
  const out: string[] = [];
  for (const block of competitorBlocks) {
    const bw = words(block);
    if (bw.length < minRun) continue;
    for (let i = 0; i + minRun <= bw.length; i += 1) {
      const gram = bw.slice(i, i + minRun);
      if (gram.filter((x) => !STOP.has(x)).length < 3) continue;
      if (grams.has(gram.join(" "))) {
        out.push(block.slice(0, 140));
        break;
      }
    }
    if (out.length >= 6) break;
  }
  return out;
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function compareSection(
  source: BlueprintSection,
  built: SectionMeasure | undefined,
  expectForm: number | null,
  allBlocks: string[],
  expectFormSide: "left" | "right" | "centre" | null = null,
): { problems: string[]; severe: boolean; copied: string[] } {
  if (!built) return { problems: ["Section is missing from the rebuilt page."], severe: true, copied: [] };
  const problems: string[] = [];
  let severe = false;
  // Wording lifted from the competitor.
  const competitorHeads = new Set(source.blocks.filter((b) => /^h[1-6]$/.test(b.role)).map((b) => norm(b.text)).filter((t) => t.split(" ").length >= 3));
  const reusedHeads = (built.headings || []).filter((h) => competitorHeads.has(norm(h)));
  const copied = built.text ? copiedSentences(built.text, allBlocks) : [];
  if (reusedHeads.length || copied.length) {
    const sample = (reusedHeads[0] || copied[0] || "").slice(0, 90);
    problems.push(`Uses the competitor's wording ("${sample}") — rewrite every heading and sentence in original words for the client.`);
  }
  const copiedLines = [...new Set([...reusedHeads, ...copied])];
  const ratio = source.bounds.height > 0 ? built.height / source.bounds.height : 1;
  if (source.bounds.height > 240 && ratio < 0.45) {
    problems.push(`Much shorter than the competitor section (${built.height}px vs ${source.bounds.height}px) — rebuild the full content and layout.`);
    severe = true;
  }
  if (source.wordCount >= 40 && built.words < source.wordCount * 0.5) {
    problems.push(`Too little copy: ${built.words} words vs about ${source.wordCount} in the competitor section.`);
    severe = true;
  }
  // A logo strip is not a card grid.
  const logoStrip = source.media.logos >= Math.max(3, source.layout.cards - 1);
  if (source.layout.cards >= 3 && !logoStrip && Math.abs(built.cards - source.layout.cards) >= 2) {
    problems.push(`The competitor shows ${source.layout.cards} cards; the rebuild shows ${built.cards || "none"}.`);
    severe = severe || built.cards === 0;
  } else if (source.layout.columns >= 2 && built.columns < 2) {
    problems.push(`The competitor section is laid out in ${source.layout.columns} columns; the rebuild is a single column.`);
    severe = true;
  }
  if (source.background.kind === "image" && !built.photo) {
    problems.push("The competitor's text sits on a full-width photo across this band; the rebuild has no photo behind it. Use .adr-section--photo with the image slot in .adr-photo-bg.");
    severe = true;
  }
  const card = source.layout.card;
  if (card?.iconSide && built.iconSide && card.iconSide !== built.iconSide) {
    problems.push(card.iconSide === "left" ? "Each item's icon sits beside its text in the competitor section; the rebuild stacks the icon above the text (use .adr-card--inline)." : "Each item's icon sits above its text in the competitor section; the rebuild puts it beside the text.");
    severe = true;
  }
  if (card?.divided && built.iconSide !== undefined && !built.divided) {
    problems.push("The competitor separates the items with thin vertical rules; the rebuild has none (use .adr-grid--divided).");
  }
  const sourceDark = source.background.kind === "dark" || source.background.kind === "gradient" || source.background.kind === "image";
  if (sourceDark !== built.dark && source.kind !== "hero") {
    problems.push(sourceDark ? "The competitor uses a dark or colour band here; the rebuild is light." : "The competitor uses a light band here; the rebuild is dark.");
  }
  if (expectForm !== null && built.formFields < Math.max(1, expectForm - 1)) {
    problems.push(`The form should be in this section with ${expectForm} fields; found ${built.formFields}.`);
    severe = true;
  }
  if (expectFormSide && built.formCenterX != null) {
    const side = built.formCenterX > 640 + 80 ? "right" : built.formCenterX < 640 - 80 ? "left" : "centre";
    if (side !== expectFormSide) {
      problems.push(`The competitor's form sits on the ${expectFormSide} of this section; the rebuild puts it on the ${side}.`);
      severe = true;
    }
  }
  return { problems, severe, copied: copiedLines };
}

export function fidelityReport(input: {
  blueprint: CompetitorBlueprint;
  measured: Measured;
  html: string;
  competitorName: string;
  expectedFormSection: string | null;
  expectedFormFields: number;
}): FidelityReport {
  const { blueprint, measured } = input;
  const byId = new Map(measured.sections.map((s) => [s.id, s]));
  const allBlocks = blueprint.sections.flatMap((s) => s.blocks.map((b) => b.text));
  const sections = blueprint.sections.map((source) => {
    const expectForm = input.expectedFormSection === source.id ? input.expectedFormFields : null;
    const form = expectForm !== null ? blueprint.forms.find((f) => f.sectionId === source.id && f.bounds) : null;
    const formX = form?.bounds ? form.bounds.x + form.bounds.width / 2 : null;
    const width = blueprint.viewport?.width || 1280;
    const expectFormSide = formX === null ? null : formX > width / 2 + 80 ? "right" : formX < width / 2 - 80 ? "left" : "centre";
    const res = compareSection(source, byId.get(source.id), expectForm, allBlocks, expectFormSide);
    return { id: source.id, kind: source.kind, ...res };
  });
  const formFound = measured.sections.reduce((n, s) => n + s.formFields, 0);
  const formInPlace = input.expectedFormSection
    ? (byId.get(input.expectedFormSection)?.formFields || 0) > 0
    : true;
  const name = input.competitorName.trim();
  const mentions = name.length >= 3
    ? (measured.text.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) || []).length
    : 0;
  const content = {
    repeatedPhrases: repeatedPhrases(measured.text),
    copiedSentences: copiedSentences(measured.text, blueprint.sections.flatMap((s) => s.blocks.map((b) => b.text))),
    competitorMentions: mentions,
  };
  const chrome = chromeProblems(blueprint, measured.chrome);
  const matched = sections.filter((s) => !s.problems.length).length;
  let score = sections.length ? matched / sections.length : 0;
  score -= (chrome.header.length + chrome.footer.length) * 0.05;
  score -= Math.min(0.2, content.copiedSentences.length * 0.05);
  score -= mentions ? 0.2 : 0;
  if (input.expectedFormSection && !formInPlace) score -= 0.15;
  score = Math.max(0, Math.round(score * 100) / 100);

  const summary: string[] = [];
  summary.push(`${matched} of ${sections.length} sections match the competitor's layout and length.`);
  if (input.expectedFormSection) {
    summary.push(formInPlace ? `Lead form rebuilt in place with ${formFound} fields.` : "The lead form is not in the competitor's position.");
  }
  if (content.repeatedPhrases.length) summary.push(`Repeated phrases: ${content.repeatedPhrases.slice(0, 3).map((p) => `"${p}"`).join(", ")}.`);
  if (content.copiedSentences.length) summary.push(`${content.copiedSentences.length} competitor sentence(s) appear word for word.`);
  if (mentions) summary.push(`The competitor's name appears ${mentions} time(s).`);
  if (measured.fontSizes > 12) summary.push(`Text uses ${measured.fontSizes} different sizes — sections are not consistent.`);
  for (const p of [...chrome.header, ...chrome.footer]) summary.push(p);

  return {
    score,
    sections,
    chrome,
    consistency: { styleBlocks: measured.styles, fontSizes: measured.fontSizes, sectionPaddings: measured.paddings },
    form: input.expectedFormSection ? { expected: input.expectedFormFields, found: formFound, inPlace: formInPlace } : null,
    content,
    summary,
  };
}

/** Header logo position and footer presence, compared with the competitor's. */
export function chromeProblems(
  blueprint: CompetitorBlueprint,
  chrome: ChromeMeasure | undefined,
): { header: string[]; footer: string[] } {
  const header: string[] = [];
  const footer: string[] = [];
  if (!chrome) return { header, footer };
  const want = blueprint.header?.logoPosition;
  if (want && want !== "unknown" && chrome.logoCenter !== null) {
    const got = chrome.logoCenter < 0.33 ? "left" : chrome.logoCenter > 0.67 ? "right" : "center";
    if (got !== want) header.push(`The competitor's logo is ${want === "center" ? "centred" : `on the ${want}`} in the header; the rebuild has it ${got === "center" ? "centred" : `on the ${got}`}.`);
  }
  const items = blueprint.header?.items || [];
  const text = chrome.headerText || "";
  const has = {
    phone: Boolean(chrome.headerTel) || /\(?\+?\d[\d\s()-]{7,}\d/.test(text),
    email: Boolean(chrome.headerMail) || /@/.test(text),
    address: /\d.*\b(st|street|rd|road|ave|avenue|hwy|highway|lane|drive|dr|blvd|parade|place|way)\b/i.test(text),
  };
  for (const item of items) {
    if ((item.kind === "phone" || item.kind === "email" || item.kind === "address") && !has[item.kind]) {
      header.push(`The competitor's header shows ${item.kind === "address" ? "an address" : `a ${item.kind}`} on the ${item.side}${item.button ? " as a button" : ""}; the rebuild's header has none. Add the client's real ${item.kind} there.`);
    }
  }
  if (!blueprint.footer && chrome.footerHeight > 140) {
    footer.push(`The competitor page has no footer; the rebuild adds a ${chrome.footerHeight}px footer. Keep only a slim one-line legal bar.`);
  }
  return { header, footer };
}

/** Replace one section in the page by its data-section-id. */
export function replaceSection(html: string, id: string, sectionHtml: string): string {
  const marker = `data-section-id="${id}"`;
  const at = html.indexOf(marker);
  if (at < 0) return html;
  const start = html.lastIndexOf("<section", at);
  if (start < 0) return html;
  // Find the matching </section>, allowing nested sections.
  const re = /<section\b|<\/section>/gi;
  re.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      return html.slice(0, start) + sectionHtml + html.slice(m.index + m[0].length);
    }
  }
  return html;
}
