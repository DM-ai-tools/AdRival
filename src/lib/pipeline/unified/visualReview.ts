import sharp from "sharp";
import type { Browser } from "playwright";
import { getAnthropicClient, getAnthropicModel } from "../../anthropic/client";
import type { CompetitorBlueprint } from "./blueprint";
import { replaceSection } from "./fidelity";
import { repairFromReview, type BlueprintGenerationInput } from "./generateBlueprint";

/**
 * Side-by-side review before a page is saved: render the rebuilt page, measure
 * layout faults in the browser (squeezed columns, text spilling out of cards,
 * mixed alignment, text on photos, low contrast, sideways scrolling), then show
 * a reviewer each part of the page next to the competitor's version. Parts the
 * reviewer flags are fixed, rendered again and reviewed again; a fix is kept
 * only when the reviewer confirms it is better.
 */

const MAX_ROUNDS = 2;
const MAX_FIXES_PER_ROUND = 6;
/** No new fix round starts after this long, so the review cannot hold the page up. */
const REVIEW_BUDGET_MS = 6 * 60_000;
const REVIEW_BATCH = 3;
const CROP_WIDTH = 1280;
const MAX_CROP_HEIGHT = 1500;
const MAX_CROP_BYTES = 260_000;

export type ReviewVerdict = {
  id: string;
  verdict: "pass" | "fix";
  severity: number;
  flaws: string[];
  fix: string;
};

export type VisualReviewSummary = {
  reviewed: number;
  rounds: number;
  fixed: string[];
  /** Parts still flagged after the last round. */
  remaining: Array<{ id: string; severity: number; flaws: string[] }>;
  /** Faults the browser measured on the final page. */
  measured: string[];
};

type Rendered = {
  order: string[];
  crops: Map<string, string>;
  lint: Map<string, string[]>;
  page: string[];
};

// Runs in the page: measures every part (header, each section, footer) for
// faults a visitor would see.
const LINT_SCRIPT = String.raw`(function(){
  function txt(el){ return (el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function rgba(c){ var m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null; var p = m[1].split(',').map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
  function lum(c){ function t(v){ v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); } return 0.2126 * t(c.r) + 0.7152 * t(c.g) + 0.0722 * t(c.b); }
  function bgOf(el){ for (var n = el; n && n !== document.documentElement; n = n.parentElement) { var s = getComputedStyle(n); if (s.backgroundImage && s.backgroundImage !== 'none') return null; var c = rgba(s.backgroundColor); if (c && c.a > 0.6) return c; } return { r: 255, g: 255, b: 255, a: 1 }; }
  function opaque(el, stop){ for (var n = el; n && n !== stop; n = n.parentElement) { var s = getComputedStyle(n); var c = rgba(s.backgroundColor); if ((c && c.a > 0.75) || (s.backdropFilter && s.backdropFilter !== 'none')) return true; } return false; }
  function parts(){
    var out = [];
    var header = document.querySelector('body > header, header.adr-header');
    if (header) out.push({ id: 'header', el: header });
    document.querySelectorAll('main [data-section-id]').forEach(function(el){ if (el.parentElement && el.parentElement.closest('[data-section-id]')) return; out.push({ id: el.getAttribute('data-section-id'), el: el }); });
    var footer = document.querySelector('body > footer, footer.adr-footer');
    if (footer) out.push({ id: 'footer', el: footer });
    return out;
  }
  function lintPart(root){
    var found = {}; function add(kind, el){ if (!found[kind]) found[kind] = { n: 0, sample: txt(el).slice(0, 60) }; found[kind].n++; }
    root.querySelectorAll('h1,h2,h3,h4,p,li,a,button,summary,label,span').forEach(function(el){
      var t = txt(el); if (!t) return;
      var cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1) return;
      var r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return;
      var block = /^(H1|H2|H3|H4|P|LI)$/.test(el.tagName);
      var words = t.split(' ').length;
      var lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
      var lines = Math.max(1, Math.round(r.height / lh));
      if (block && words >= 6 && (r.width < 170 || lines >= words * 0.55)) add('narrow', el);
      if (cs.display !== 'inline' && cs.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 3) add('overflow', el);
      var box = el.parentElement && el.parentElement.closest('.adr-card, .adr-grid > *, .adr-split > *, .adr-form-panel');
      if (box && box !== el) { var b = box.getBoundingClientRect(); if (r.right > b.right + 4 || r.left < b.left - 4) add('spill', el); }
      if (/^(H1|H2|H3|H4|P|SPAN|LI)$/.test(el.tagName) && t.length > 1 && r.top >= 0) {
        var stack = document.elementsFromPoint(Math.min(innerWidth - 1, r.left + Math.min(r.width, 60) / 2), r.top + Math.min(r.height, 30) / 2);
        var i = stack.indexOf(el);
        var img = i >= 0 ? stack.slice(i + 1).find(function(n){ return n.tagName === 'IMG' && (n.hasAttribute('data-adrival-slot') || n.closest('.adr-media')); }) : null;
        if (img && !opaque(el, img.parentElement)) add('overImage', el);
      }
      if (block || el.tagName === 'A' || el.tagName === 'SPAN') {
        var fg = rgba(cs.color); var bg = bgOf(el);
        if (fg && bg && fg.a > 0.5) {
          var l1 = lum(fg), l2 = lum(bg); var ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          var big = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.5 && parseInt(cs.fontWeight, 10) >= 700);
          if (ratio < (big ? 3 : 4.5)) add('contrast', el);
        }
      }
    });
    root.querySelectorAll('.adr-grid').forEach(function(g){
      var kids = Array.prototype.slice.call(g.children).filter(function(k){ return k.getBoundingClientRect().height > 20; });
      if (kids.length >= 2 && kids.some(function(k){ return k.getBoundingClientRect().width < 150; })) add('sliver', kids[0]);
    });
    // Mixed alignment: text blocks sharing a parent should share an alignment and a left edge.
    var groups = new Map();
    root.querySelectorAll('h1,h2,h3,p,.adr-eyebrow,.adr-lead').forEach(function(el){
      if (el.closest('.adr-card, form, .adr-faq, li, .adr-form-panel')) return;
      if (!txt(el) || el.getBoundingClientRect().width < 1) return;
      var p = el.parentElement; if (!groups.has(p)) groups.set(p, []); groups.get(p).push(el);
    });
    groups.forEach(function(list){
      if (list.length < 2) return;
      var aligns = {}; var lefts = [];
      list.forEach(function(el){ var a = getComputedStyle(el).textAlign; a = a === 'start' || a === 'justify' ? 'left' : a; aligns[a] = 1; if (a === 'left') lefts.push(Math.round(el.getBoundingClientRect().left)); });
      if (aligns.center && aligns.left) add('mixedAlign', list[0]);
      else if (lefts.length >= 2 && Math.max.apply(null, lefts) - Math.min.apply(null, lefts) > 12) add('ragged', list[0]);
    });
    root.querySelectorAll('img').forEach(function(img){ if (img.complete && img.naturalWidth === 0) add('broken', img); });
    var logo = root.querySelector('img[data-logo-role="company"]');
    if (logo) { var lr = logo.getBoundingClientRect(); if (lr.height > 0 && (lr.height < 18 || lr.width < 40)) add('logoSmall', logo); }
    return found;
  }
  var res = {}; parts().forEach(function(p){ res[p.id] = { found: lintPart(p.el), rect: (function(r){ return { y: r.top + scrollY, h: r.height }; })(p.el.getBoundingClientRect()) }; });
  return { parts: res, order: parts().map(function(p){ return p.id; }), sideways: document.documentElement.scrollWidth > innerWidth + 2 };
})()`;

const LINT_TEXT: Record<string, (n: number, sample: string) => string> = {
  narrow: (n, s) => `${n} text block(s) squeezed into a very narrow column, wrapping every word or two (e.g. "${s}").`,
  overflow: (n, s) => `${n} element(s) whose text overflows its own box (e.g. "${s}").`,
  spill: (n, s) => `${n} text element(s) spilling out of their card or column (e.g. "${s}").`,
  overImage: (n, s) => `${n} text element(s) sitting directly on a photo without a solid background (e.g. "${s}").`,
  contrast: (n, s) => `${n} text element(s) with low contrast against their background (e.g. "${s}").`,
  sliver: () => "A card grid whose cards are under 150px wide.",
  mixedAlign: (n, s) => `${n} text group(s) mixing centred and left-aligned lines (e.g. near "${s}").`,
  ragged: (n, s) => `${n} text group(s) whose lines do not share one left edge (e.g. near "${s}").`,
  broken: (n) => `${n} image(s) that do not load.`,
  logoSmall: () => "The logo renders too small to read.",
};

async function cropJpeg(full: Buffer, width: number, height: number, rect: { y: number; h: number }): Promise<string | null> {
  const top = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
  const h = Math.max(1, Math.min(height - top, Math.round(rect.h)));
  if (h < 24) return null;
  try {
    let image = sharp(full).extract({ left: 0, top, width, height: h });
    if (width > CROP_WIDTH) image = image.resize({ width: CROP_WIDTH });
    if (h > MAX_CROP_HEIGHT) image = image.resize({ height: MAX_CROP_HEIGHT, fit: "inside" });
    let quality = 70;
    let out = await image.jpeg({ quality, mozjpeg: true }).toBuffer();
    while (out.length > MAX_CROP_BYTES && quality > 38) {
      quality -= 10;
      out = await sharp(out).jpeg({ quality, mozjpeg: true }).toBuffer();
    }
    return out.toString("base64");
  } catch {
    return null;
  }
}

/** Render the page, measure faults and crop every part. */
export async function renderForReview(html: string, browser?: Browser): Promise<Rendered> {
  const { launchChromium } = await import("../content/playwrightRuntime");
  const own = !browser;
  const b = browser || (await launchChromium());
  try {
    const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 }).catch(() => undefined);
    await page.evaluate("document.fonts && document.fonts.ready").catch(() => undefined);
    await page.waitForTimeout(300);
    // The whole page in the viewport, so elementsFromPoint sees every part.
    const fullHeight = Math.min(20_000, Number(await page.evaluate("document.documentElement.scrollHeight")) || 900);
    await page.setViewportSize({ width: 1280, height: Math.max(900, fullHeight) });
    await page.waitForTimeout(200);
    const lint = (await page.evaluate(LINT_SCRIPT)) as {
      parts: Record<string, { found: Record<string, { n: number; sample: string }>; rect: { y: number; h: number } }>;
      order: string[];
      sideways: boolean;
    };
    const shot = await page.screenshot({ fullPage: true, type: "png", timeout: 60_000 }).catch(() => null);
    const pageNotes: string[] = [];
    if (lint.sideways) pageNotes.push("The page scrolls sideways on desktop.");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    const phoneSideways = Boolean(await page.evaluate("document.documentElement.scrollWidth > innerWidth + 2"));
    if (phoneSideways) pageNotes.push("The page scrolls sideways on phones: something is wider than the screen.");
    await page.close().catch(() => undefined);

    const crops = new Map<string, string>();
    const notes = new Map<string, string[]>();
    const meta = shot ? await sharp(shot).metadata() : null;
    for (const id of lint.order) {
      const row = lint.parts[id];
      notes.set(
        id,
        Object.entries(row.found).map(([kind, v]) => (LINT_TEXT[kind] ? LINT_TEXT[kind](v.n, v.sample.replace(/"/g, "'")) : `${kind}: ${v.n}`)),
      );
      if (shot && meta?.width && meta.height) {
        const crop = await cropJpeg(shot, meta.width, meta.height, row.rect);
        if (crop) crops.set(id, crop);
      }
    }
    return { order: lint.order, crops, lint: notes, page: pageNotes };
  } finally {
    if (own) await b.close().catch(() => undefined);
  }
}

const REVIEW_SYSTEM = `You are a senior web designer doing final QA on a landing page that was rebuilt from a competitor's page for a different business. For each part of the page you get the competitor's version (the layout reference) and the rebuilt version as rendered on a 1280px desktop, plus faults the browser measured. Judge the rebuilt version: is it ready to publish, and does its layout follow the competitor's?

Intended differences, never flag them: different words, the client's brand colours, fonts and logo, different photos, a brand-coloured gradient panel where an image has not been made yet.

Flag, specifically (which element, what is wrong, where):
- text alignment: mixed centred and left-aligned text in one block, headings not aligned with their text, uneven left edges, centred where the competitor is left-aligned or the reverse
- squeezed columns where text wraps every word or two, cards too narrow, text or headings spilling out of cards or overlapping other elements
- layout drifted from the competitor: wrong number of columns or cards, media on the wrong side, a section far emptier or more cramped
- spacing: large empty gaps, elements touching, uneven padding, elements not vertically aligned
- readability: low contrast, text on busy photos, tiny text
- images: text, letters or garbled writing inside a photo, distorted people or objects, bad crops; a screenshot, a mock-up or another company's logo used as the business logo
- buttons: wrapped labels, misaligned, clashing styles
- anything else a client would call unprofessional

verdict "pass" when the part is ready to publish, otherwise "fix". severity: 3 broken or clearly unprofessional, 2 noticeable, 1 minor, 0 none. "fix": precise instructions a front-end developer can apply from the HTML alone (e.g. "Put the 4 service cards below the heading at full width as a 4-column grid; left-align the intro with the heading").

Return ONLY JSON: { "parts": [ { "id": "…", "verdict": "pass" | "fix", "severity": 0-3, "flaws": ["…"], "fix": "…" } ] } with one entry per part.`;

function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function competitorCrops(blueprint: CompetitorBlueprint): Map<string, string> {
  const out = new Map<string, string>();
  if (blueprint.header?.crop) out.set("header", blueprint.header.crop);
  if (blueprint.footer?.crop) out.set("footer", blueprint.footer.crop);
  for (const s of blueprint.sections) if (s.crop) out.set(s.id, s.crop);
  return out;
}

function label(id: string, blueprint: CompetitorBlueprint): string {
  if (id === "header" || id === "footer") return `the ${id}`;
  const s = blueprint.sections.find((x) => x.id === id);
  return s ? `section ${id} (${s.kind})` : `section ${id}`;
}

/** Ask the reviewer about some parts of the page, a few per call, in parallel. */
export async function reviewParts(input: {
  ids: string[];
  rendered: Rendered;
  competitor: Map<string, string>;
  blueprint: CompetitorBlueprint;
  signal?: AbortSignal;
}): Promise<Map<string, ReviewVerdict>> {
  const out = new Map<string, ReviewVerdict>();
  if (!process.env.ANTHROPIC_API_KEY) return out;
  const ids = input.ids.filter((id) => input.rendered.crops.has(id));
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += REVIEW_BATCH) batches.push(ids.slice(i, i + REVIEW_BATCH));
  await Promise.all(
    batches.map(async (batch) => {
      const content: Array<Record<string, unknown>> = [];
      for (const id of batch) {
        const theirs = input.competitor.get(id);
        content.push({ type: "text", text: `Part ${id}: ${label(id, input.blueprint)}.${theirs ? " First image: competitor. Second image: rebuilt." : " Only the rebuilt version is available."}` });
        if (theirs) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: theirs } });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: input.rendered.crops.get(id)! } });
        const measured = input.rendered.lint.get(id) || [];
        if (measured.length) content.push({ type: "text", text: `Measured in the browser for ${id}: ${measured.join(" ")}` });
      }
      content.push({ type: "text", text: `Review parts ${batch.join(", ")}.` });
      try {
        const response = await getAnthropicClient().messages.create(
          {
            model: getAnthropicModel(),
            max_tokens: 700 + batch.length * 600,
            system: REVIEW_SYSTEM,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            messages: [{ role: "user", content: content as any }],
          },
          { timeout: 150_000, ...(input.signal ? { signal: input.signal } : {}) },
        );
        const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
        const rows = extractJson(text)?.parts;
        if (!Array.isArray(rows)) return;
        for (const row of rows as Array<Record<string, unknown>>) {
          const id = String(row.id || "");
          if (!batch.includes(id)) continue;
          const flaws = Array.isArray(row.flaws) ? row.flaws.map(String).filter(Boolean).slice(0, 10) : [];
          const severity = Math.max(0, Math.min(3, Number(row.severity) || 0));
          out.set(id, {
            id,
            verdict: row.verdict === "fix" && flaws.length ? "fix" : "pass",
            severity,
            flaws,
            fix: String(row.fix || "").slice(0, 1500),
          });
        }
      } catch (err) {
        console.warn("[review] batch failed", err instanceof Error ? err.message.slice(0, 160) : err);
      }
    }),
  );
  return out;
}

/** Where the page header (before <main>) or footer (after </main>) sits; cards may hold their own. */
function chromeRange(html: string, id: "header" | "footer"): [number, number] | null {
  const lower = html.toLowerCase();
  const mainAt = lower.indexOf("<main");
  const mainEnd = lower.indexOf("</main>");
  const from = id === "header" ? 0 : Math.max(0, mainEnd);
  const to = id === "header" && mainAt >= 0 ? mainAt : html.length;
  let open = lower.indexOf(`<${id}`, from);
  // "<header" must not match "<headers…"-like tags.
  while (open >= 0 && /[a-z0-9-]/.test(lower[open + id.length + 1] || "")) open = lower.indexOf(`<${id}`, open + 1);
  if (open < 0 || open >= to) return null;
  const close = lower.indexOf(`</${id}>`, open);
  return close < 0 ? null : [open, close + id.length + 3];
}

function partHtml(html: string, id: string): string {
  if (id === "header" || id === "footer") {
    const range = chromeRange(html, id);
    return range ? html.slice(range[0], range[1]) : "";
  }
  const marker = `data-section-id="${id}"`;
  const at = html.indexOf(marker);
  if (at < 0) return "";
  const start = html.lastIndexOf("<section", at);
  const re = /<section\b|<\/section>/gi;
  re.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return "";
}

function replacePart(html: string, id: string, next: string): string {
  if (id === "header" || id === "footer") {
    const range = chromeRange(html, id);
    return range ? html.slice(0, range[0]) + next + html.slice(range[1]) : html;
  }
  return replaceSection(html, id, next.replace(/<section\b(?![^>]*\bid=)/i, `<section id="${id}"`));
}

function withCss(html: string, rows: Array<{ id: string; css: string }>): string {
  const css = rows.filter((r) => r.css.trim()).map((r) => `/* ${r.id} (reviewed) */\n${r.css}`);
  return css.length ? html.replace(/<\/style>/i, () => `${css.join("\n")}\n</style>`) : html;
}

const better = (after: ReviewVerdict | undefined, before: ReviewVerdict, lintBefore: number, lintAfter: number) =>
  Boolean(after) &&
  lintAfter <= lintBefore &&
  (after!.verdict === "pass" || after!.severity < before.severity || (after!.severity === before.severity && after!.flaws.length < before.flaws.length));

/**
 * Review the page part by part against the competitor, fix what is flagged
 * and keep only confirmed improvements. `finish` re-applies the page's own
 * post-processing (logo injection, design fixes) to a changed page.
 */
export async function reviewAndFixPage(input: {
  html: string;
  blueprint: CompetitorBlueprint;
  classSystem: string;
  designDirection?: BlueprintGenerationInput["designDirection"];
  finish: (html: string) => string;
  signal?: AbortSignal;
  onProgress: (message: string) => void;
}): Promise<{ html: string; summary: VisualReviewSummary; warnings: string[] }> {
  const { launchChromium } = await import("../content/playwrightRuntime");
  const browser = await launchChromium();
  const competitor = competitorCrops(input.blueprint);
  let html = input.html;
  const fixed = new Set<string>();
  let rounds = 0;
  const started = Date.now();
  try {
    let rendered = await renderForReview(html, browser);
    const verdicts = await reviewParts({ ids: rendered.order, rendered, competitor, blueprint: input.blueprint, signal: input.signal });
    const reviewed = verdicts.size;
    const attempts = new Map<string, number>();
    while (rounds < MAX_ROUNDS && !input.signal?.aborted && Date.now() - started < REVIEW_BUDGET_MS) {
      const todo = [...verdicts.values()]
        .filter((v) => v.verdict === "fix" && v.severity >= (rounds === 0 ? 1 : 2) && (attempts.get(v.id) || 0) < 2)
        .sort((a, b) => b.severity - a.severity || b.flaws.length - a.flaws.length)
        .slice(0, MAX_FIXES_PER_ROUND);
      if (!todo.length) break;
      rounds += 1;
      input.onProgress(`Fixing ${todo.length} part${todo.length === 1 ? "" : "s"} the side-by-side review flagged…`);
      const results = await Promise.all(
        todo.map(async (v) => {
          attempts.set(v.id, (attempts.get(v.id) || 0) + 1);
          const current = partHtml(html, v.id);
          if (!current) return null;
          try {
            const next = await repairFromReview({
              target: v.id,
              html: current,
              competitorCrop: competitor.get(v.id) || null,
              rebuiltCrop: rendered.crops.get(v.id) || null,
              flaws: [...v.flaws, ...(rendered.lint.get(v.id) || [])],
              fix: v.fix,
              classSystem: input.classSystem,
              designDirection: input.designDirection,
              signal: input.signal,
            });
            return next ? { id: v.id, ...next } : null;
          } catch {
            return null;
          }
        }),
      );
      const rows = results.filter((r): r is NonNullable<typeof r> => Boolean(r));
      if (!rows.length) continue;
      const place = (base: string, list: typeof rows) => {
        let next = base;
        for (const row of list) next = replacePart(next, row.id, row.html);
        return input.finish(withCss(next, list));
      };
      const trial = place(html, rows);
      input.onProgress("Reviewing the fixed parts side by side again…");
      const after = await renderForReview(trial, browser);
      const confirm = await reviewParts({ ids: rows.map((r) => r.id), rendered: after, competitor, blueprint: input.blueprint, signal: input.signal });
      const kept = rows.filter((r) =>
        better(confirm.get(r.id), verdicts.get(r.id)!, (rendered.lint.get(r.id) || []).length, (after.lint.get(r.id) || []).length),
      );
      if (!kept.length) continue;
      html = kept.length === rows.length ? trial : place(html, kept);
      for (const r of kept) {
        fixed.add(r.id);
        const v = confirm.get(r.id);
        if (v) verdicts.set(r.id, v);
      }
      rendered = kept.length === rows.length ? after : await renderForReview(html, browser);
    }
    const remaining = [...verdicts.values()]
      .filter((v) => v.verdict === "fix")
      .map((v) => ({ id: v.id, severity: v.severity, flaws: v.flaws.slice(0, 4) }));
    const measured = [...rendered.page, ...[...rendered.lint.entries()].flatMap(([id, list]) => list.map((l) => `${id}: ${l}`))].slice(0, 12);
    const warnings = remaining
      .filter((r) => r.severity >= 2)
      .map((r) => `Review (${r.id === "header" || r.id === "footer" ? r.id : `section ${r.id.replace("sec-", "")}`}): ${r.flaws[0] || "needs a look"}`);
    warnings.push(...rendered.page);
    return { html, summary: { reviewed, rounds, fixed: [...fixed], remaining, measured }, warnings };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
