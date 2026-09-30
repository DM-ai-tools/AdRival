import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";

/**
 * Design check for a recreated page.
 *
 * 1. Automatic fixes from Vercel's Web Interface Guidelines and Taste Skill
 *    (zoom, autocomplete, alt, lazy images, rel=noopener, "transition: all",
 *    em dashes and "..." in visible text). Free and safe.
 * 2. Impeccable's detector engine (61 deterministic rules) on each section,
 *    so every finding is tied to the section that has it.
 * 3. Markup checks the detector does not cover (labels, icon buttons).
 *
 * Findings a section rewrite can fix are marked "repair"; findings that come
 * from the client's brand or the shared stylesheet are "report" only.
 */

export type DesignFinding = {
  rule: string;
  name: string;
  detail: string;
  category: string;
  sectionId: string | null;
  action: "repair" | "report";
  source: "impeccable" | "guidelines";
};

export type DesignCheck = {
  engine: "impeccable" | "unavailable";
  findings: DesignFinding[];
  /** Findings a section rewrite should fix, by section id. */
  repairable: Record<string, DesignFinding[]>;
};

/** Fixed by rewriting the section. */
const REPAIR = new Set([
  "low-contrast", "gray-on-color", "visual-contrast", "tiny-text", "undersized-ui-text", "side-tab",
  "border-accent-on-rounded", "gradient-text", "nested-cards", "cramped-padding", "line-length", "dark-glow",
  "radial-halo", "radial-spotlight-glow", "kicker-above-heading", "hero-eyebrow-chip", "numbered-section-labels",
  "icon-tile-stack", "em-dash-overuse", "marketing-buzzword", "theater-slop-phrase", "aphoristic-cadence",
  "repeated-container-text", "skipped-heading", "pulsing-dot", "text-overflow", "justified-text", "edge-flush-cards",
  "gpt-thin-border-wide-shadow", "shape-assembled-illustration", "table-frame", "text-occlusion",
  "missing-label", "icon-button-label",
]);

/** Set by the client's brand or the shared stylesheet: reported, never rewritten. */
const REPORT = new Set([
  "overused-font", "design-system-color", "design-system-font", "design-system-font-size", "design-system-radius",
  "flat-type-hierarchy", "tight-leading", "extreme-negative-tracking", "wide-tracking", "monotonous-spacing",
  "heading-rhythm", "all-caps-body", "italic-serif-display", "cream-palette", "ai-color-palette", "oversized-h1",
  "bounce-easing", "layout-transition",
]);

/** Our stylesheet pads these with clamp()/tokens, which the static engine reads as zero. */
const PADDED_BY_SYSTEM = /\badr-(section|card|form-panel|container|header|footer|faq|media|narrow)\b/;

const TRANSPARENT_GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

function engineBinary(): string | null {
  const env = process.env.IMPECCABLE_BIN?.trim();
  if (env && existsSync(env)) return env;
  const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const exe = process.platform === "win32" ? "impeccable.exe" : "impeccable";
  const candidate = path.join(process.cwd(), "node_modules", "@impeccable", `cli-${target}`, "bin", exe);
  return existsSync(candidate) ? candidate : null;
}

const AUTOCOMPLETE: Array<[RegExp, string]> = [
  [/e-?mail/i, "email"],
  [/phone|mobile|\btel\b/i, "tel"],
  [/first.?name|given/i, "given-name"],
  [/last.?name|surname|family/i, "family-name"],
  [/full.?name|^name$|your.?name/i, "name"],
  [/company|business|organi[sz]ation/i, "organization"],
  [/post.?code|zip/i, "postal-code"],
  [/website|url/i, "url"],
  [/suburb|city|town/i, "address-level2"],
  [/address|street/i, "street-address"],
];

function visibleTextFix(text: string): string {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")
    .replace(/\s+[—–]\s+/g, ", ")
    .replace(/[—–]/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/\.\.\.(?!\.)/g, "…");
}

/** Safe, free fixes applied to the finished page. */
export function applyDesignFixes(html: string): { html: string; fixed: string[] } {
  const $ = cheerio.load(html);
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] || 0) + 1);

  const viewport = $('meta[name="viewport"]');
  const vp = viewport.attr("content") || "";
  if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(vp)) {
    viewport.attr("content", "width=device-width, initial-scale=1");
    bump("Allowed pinch zoom");
  }

  // Visible text: no em/en dashes as punctuation, real ellipses (Taste Skill 9.G, Vercel).
  const walk = (node: unknown) => {
    const el = node as { type?: string; data?: string; name?: string; children?: unknown[] };
    if (el.type === "text" && typeof el.data === "string" && /[—–]|\.\.\./.test(el.data)) {
      const next = visibleTextFix(el.data);
      if (next !== el.data) {
        el.data = next;
        bump("Replaced dashes and dots in the copy");
      }
      return;
    }
    if (el.name === "script" || el.name === "style") return;
    for (const child of el.children || []) walk(child);
  };
  walk($("body").get(0));
  $("[alt],[title],[aria-label]").each((_, e) => {
    for (const attr of ["alt", "title", "aria-label"]) {
      const value = $(e).attr(attr);
      if (value && /[—–]/.test(value)) $(e).attr(attr, visibleTextFix(value));
    }
  });

  // Images with no source show a broken icon and their alt text: remove them,
  // and the empty frame they sat in. Planned image slots are filled elsewhere.
  $("img").each((_, e) => {
    const img = $(e);
    const src = (img.attr("src") || "").trim();
    if (img.attr("data-adrival-slot") || (src && !/^(#|about:blank|undefined|null)$/i.test(src))) return;
    const frame = img.parent(".adr-media");
    if (frame.length && frame.children().length === 1 && !frame.text().trim()) frame.remove();
    else img.remove();
    bump("Removed images that had no source");
  });

  // Images: alt present, below-the-fold images lazy (Vercel images).
  const firstSection = $("main section").first();
  $("img").each((_, e) => {
    const img = $(e);
    if (img.attr("alt") === undefined) {
      img.attr("alt", img.attr("data-logo-role") ? "Logo" : "");
      bump("Added missing alt text");
    }
    const aboveFold = img.closest("header").length > 0 || (firstSection.length > 0 && img.closest("section").is(firstSection));
    if (!aboveFold && !img.attr("loading")) {
      img.attr("loading", "lazy");
      bump("Lazy-loaded images below the fold");
    }
    if (!img.attr("decoding")) img.attr("decoding", "async");
  });

  // Form fields: autocomplete, keyboard type, no spellcheck on email (Vercel forms).
  $("input, textarea, select").each((_, e) => {
    const field = $(e);
    const type = (field.attr("type") || "").toLowerCase();
    if (["hidden", "submit", "button", "checkbox", "radio"].includes(type)) return;
    if (!field.attr("autocomplete")) {
      const hint = `${field.attr("name") || ""} ${field.attr("id") || ""} ${type}`;
      const hit = AUTOCOMPLETE.find(([re]) => re.test(hint));
      if (hit) {
        field.attr("autocomplete", hit[1]);
        bump("Added autocomplete to form fields");
      }
    }
    if (type === "email") {
      field.attr("spellcheck", "false");
      if (!field.attr("inputmode")) field.attr("inputmode", "email");
    }
    if (type === "tel" && !field.attr("inputmode")) field.attr("inputmode", "tel");
  });

  $('a[target="_blank"]').each((_, e) => {
    const rel = $(e).attr("rel") || "";
    if (!/noopener/.test(rel)) {
      $(e).attr("rel", `${rel} noopener`.trim());
      bump("Made new-tab links safe");
    }
  });

  // "transition: all" animates layout; list the cheap properties instead (Vercel animation).
  $("style").each((_, e) => {
    const css = $(e).html() || "";
    const next = css.replace(/transition\s*:\s*all\b([^;}]*)/gi, (_m, rest: string) => {
      bump("Listed transition properties instead of \"all\"");
      return `transition:${["color", "background-color", "border-color", "box-shadow", "transform", "opacity"].map((p) => `${p}${rest}`).join(",")}`;
    });
    if (next !== css) $(e).text(next);
  });

  return { html: $.html(), fixed: Object.entries(counts).map(([k, n]) => (n > 1 ? `${k} (${n})` : k)) };
}

type RawFinding = { antipattern: string; name: string; description: string; category: string; file: string; snippet: string };

function runEngine(bin: string, dir: string, timeoutMs: number): Promise<RawFinding[] | null> {
  return new Promise((resolve) => {
    execFile(bin, ["detect", "--json", dir], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      // Exit 2 means "findings", not failure.
      const code = (err as { code?: number } | null)?.code;
      if (err && code !== 2) {
        console.warn("[design-check] engine failed", err.message.slice(0, 200));
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "[]");
        resolve(Array.isArray(parsed) ? (parsed as RawFinding[]) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** Markup checks from Vercel's guidelines that the engine does not cover. */
function guidelineFindings($: cheerio.CheerioAPI, sectionId: string | null, root: ReturnType<cheerio.CheerioAPI>): DesignFinding[] {
  const out: DesignFinding[] = [];
  root.find("input, select, textarea").each((_, e) => {
    const f = $(e);
    const type = (f.attr("type") || "").toLowerCase();
    if (["hidden", "submit", "button"].includes(type)) return;
    const id = f.attr("id");
    const labelled = f.attr("aria-label") || f.attr("aria-labelledby") || f.closest("label").length || (id && $(`label[for="${id}"]`).length);
    if (!labelled) {
      out.push({ rule: "missing-label", name: "Form field without a label", detail: `${f.attr("name") || type || "field"} has no <label> or aria-label`, category: "a11y", sectionId, action: "repair", source: "guidelines" });
    }
  });
  root.find("a, button").each((_, e) => {
    const el = $(e);
    const text = el.text().replace(/\s+/g, "").length;
    const hasImgAlt = el.find("img[alt]").filter((__, i) => Boolean($(i).attr("alt"))).length > 0;
    if (!text && !hasImgAlt && !el.attr("aria-label") && !el.attr("title")) {
      out.push({ rule: "icon-button-label", name: "Icon-only control without a label", detail: `<${e.tagName}> with no text or aria-label`, category: "a11y", sectionId, action: "repair", source: "guidelines" });
    }
  });
  return out;
}

/** HSL lightness of the first "text #rrggbb" in a snippet, 0 to 1. */
function textLightness(snippet: string): number | null {
  const m = snippet.match(/text (#[0-9a-f]{6})/i);
  if (!m) return null;
  const n = Number.parseInt(m[1].slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

function classify(rule: string, snippet: string): DesignFinding["action"] | null {
  if (rule === "cramped-padding" && PADDED_BY_SYSTEM.test(snippet)) return null;
  // Near-white text on a dark colour band is readable; the heuristic is about mid greys.
  if (rule === "gray-on-color" && (textLightness(snippet) ?? 0) > 0.8) return null;
  if (REPAIR.has(rule)) return "repair";
  if (REPORT.has(rule)) return "report";
  return null;
}

/** Run the design check. Never throws: without the engine it still returns the markup checks. */
export async function runDesignCheck(html: string, options: { timeoutMs?: number } = {}): Promise<DesignCheck> {
  const $ = cheerio.load(html);
  const findings: DesignFinding[] = [];

  const sections = $("main section[data-section-id], body > section[data-section-id]").toArray();
  for (const s of sections) {
    const id = $(s).attr("data-section-id") || null;
    findings.push(...guidelineFindings($, id, $(s)));
  }

  const bin = engineBinary();
  let engine: DesignCheck["engine"] = "unavailable";
  if (bin) {
    // Strip embedded images (the engine reads markup and CSS, not pixels).
    const lean = html.replace(/(<img\b[^>]*\bsrc=")data:[^"]{200,}(")/gi, `$1${TRANSPARENT_GIF}$2`);
    const head = lean.slice(0, Math.max(0, lean.search(/<body\b/i))) || "<!DOCTYPE html><html><head></head>";
    const $lean = cheerio.load(lean);
    const dir = await mkdtemp(path.join(os.tmpdir(), "adr-design-check-"));
    try {
      const files = new Map<string, string | null>();
      const parts: Array<[string, string | null, string]> = [];
      const header = $lean("body > header, header").first();
      if (header.length) parts.push(["part-header.html", null, $lean.html(header) || ""]);
      $lean("section[data-section-id]").each((i, e) => {
        const id = $lean(e).attr("data-section-id") || `section-${i + 1}`;
        parts.push([`part-${i + 1}.html`, id, $lean.html(e) || ""]);
      });
      const footer = $lean("body > footer, footer").last();
      if (footer.length) parts.push(["part-footer.html", null, $lean.html(footer) || ""]);
      for (const [file, id, markup] of parts) {
        files.set(file, id);
        await writeFile(path.join(dir, file), `${head}<body><main>${markup}</main></body></html>`, "utf8");
      }
      const raw = await runEngine(bin, dir, options.timeoutMs ?? 30_000);
      if (raw) {
        engine = "impeccable";
        const seenPage = new Set<string>();
        for (const f of raw) {
          const file = path.basename(f.file || "");
          const sectionId = files.get(file) ?? null;
          const action = classify(f.antipattern, f.snippet || "");
          if (!action) continue;
          // Brand-level findings repeat in every file: report them once.
          if (action === "report") {
            if (seenPage.has(f.antipattern)) continue;
            seenPage.add(f.antipattern);
          }
          findings.push({
            rule: f.antipattern,
            name: f.name,
            detail: `${f.description} ${f.snippet ? `(${f.snippet})` : ""}`.trim(),
            category: f.category,
            sectionId: action === "report" ? null : sectionId,
            action,
            source: "impeccable",
          });
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // The same finding many times in one section (e.g. every card) is one problem to fix.
  const unique: DesignFinding[] = [];
  const keys = new Set<string>();
  for (const f of findings) {
    const key = `${f.sectionId}|${f.rule}|${f.detail}`;
    if (keys.has(key)) continue;
    keys.add(key);
    unique.push(f);
  }
  const repairable: Record<string, DesignFinding[]> = {};
  for (const f of unique) {
    if (f.action !== "repair" || !f.sectionId) continue;
    (repairable[f.sectionId] ||= []).push(f);
  }
  return { engine, findings: unique, repairable };
}

/** Number of findings a rewrite could fix, for comparing before and after. */
export function repairableCount(check: DesignCheck, sectionId?: string): number {
  if (sectionId) return (check.repairable[sectionId] || []).length;
  return Object.values(check.repairable).reduce((n, list) => n + list.length, 0);
}

/** One line per finding, for the repair prompt. */
export function findingsForPrompt(list: DesignFinding[]): string[] {
  return list.slice(0, 12).map((f) => `${f.name}: ${f.detail}`.slice(0, 300));
}
