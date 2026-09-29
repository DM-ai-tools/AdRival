import { FORM_SLOT_ATTR } from "./leadForm";

/**
 * Section fragments may carry a little layout CSS. It is moved into the page
 * stylesheet, scoped to its own section, and stripped of anything global
 * (:root, body, html, *, fonts) so no section can restyle the others.
 */

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Split CSS into top-level blocks: { prelude, body } pairs, handling nesting. */
function blocks(css: string): Array<{ prelude: string; body: string }> {
  const out: Array<{ prelude: string; body: string }> = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") depth -= 1;
      j += 1;
    }
    out.push({ prelude, body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

const GLOBAL_SELECTOR = /^(?::root|html|body|\*)(?![\w-])/i;

function scopeSelector(selector: string, scope: string): string | null {
  const s = selector.trim();
  if (!s) return null;
  if (GLOBAL_SELECTOR.test(s)) return null;
  if (s.includes("data-section-id")) return s;
  if (/^(header|footer)\b/i.test(s) && /^(header|footer)$/i.test(scope)) return s;
  return `${scopeOf(scope)} ${s}`;
}

function scopeOf(id: string): string {
  if (id === "header") return "header";
  if (id === "footer") return "footer";
  return `[data-section-id="${id.replace(/"/g, "")}"]`;
}

function cleanDeclarations(body: string): string {
  return body
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d && !/^font-family\s*:/i.test(d) && !/^--/.test(d))
    .join(";");
}

export function scopeCss(css: string, id: string): string {
  const out: string[] = [];
  for (const block of blocks(stripComments(css))) {
    const prelude = block.prelude;
    if (/^@(import|font-face|charset|namespace)/i.test(prelude)) continue;
    if (/^@keyframes|^@-webkit-keyframes/i.test(prelude)) {
      out.push(`${prelude}{${block.body}}`);
      continue;
    }
    if (/^@(media|supports|container)/i.test(prelude)) {
      const inner = scopeCss(block.body, id);
      if (inner.trim()) out.push(`${prelude}{${inner}}`);
      continue;
    }
    if (prelude.startsWith("@")) continue;
    const selectors = prelude
      .split(",")
      .map((sel) => scopeSelector(sel, id))
      .filter((sel): sel is string => Boolean(sel));
    const decls = cleanDeclarations(block.body);
    if (!selectors.length || !decls) continue;
    out.push(`${selectors.join(",")}{${decls}}`);
  }
  return out.join("\n");
}

/** Clean one generated fragment: scripts out, stray forms to the form slot, styles scoped. */
export function sanitizeFragment(html: string, id: string): { id: string; html: string; css: string } {
  let out = String(html || "");
  const styles: string[] = [];
  out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css: string) => {
    styles.push(css);
    return "";
  });
  out = out
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");
  // The real form is inserted by the pipeline; a model-written one becomes the slot.
  const isChrome = id === "header" || id === "footer";
  out = out.replace(/<form\b[\s\S]*?<\/form>/gi, isChrome ? "" : `<div ${FORM_SLOT_ATTR}></div>`);
  // Tidy <br> joins that lost their space ("levers.Scale").
  out = out.replace(/([.!?])<br\s*\/?>(?=[A-Z])/g, "$1 <br>");
  return { id, html: out.trim(), css: styles.map((css) => scopeCss(css, id)).filter(Boolean).join("\n") };
}

export function mergeSectionStyles(rows: Array<{ id: string; css: string }>): string {
  return rows
    .filter((row) => row.css.trim())
    .map((row) => `/* ${row.id} */\n${row.css}`)
    .join("\n");
}
