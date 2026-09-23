import type { GeneratedLandingImage } from "../../types";

export type UnifiedImageSlot = {
  id: string;
  sectionId: string;
  purpose: string;
  prompt: string;
  aspectRatio: string;
  width?: number | null;
  height?: number | null;
  alt: string;
  kind: "illustrative" | "factual";
  priority: number;
  focal?: string | null;
  spaceForText?: boolean;
};

export type UnifiedGenerationResponse = {
  html: string;
  title?: string | null;
  description?: string | null;
  sections?: Array<{ id: string; purpose?: string; heading?: string }>;
  imageSlots: UnifiedImageSlot[];
  warnings: string[];
  unresolvedRequirements: string[];
};

/** Pass A — locked design tokens + empty page chrome. */
export type SpinePassResult = {
  css: string;
  shellHtml: string;
};

/** Pass B — fold chrome + hero section. */
export type HeroPassResult = {
  headerHtml: string;
  heroHtml: string;
  footerHtml?: string | null;
  title?: string | null;
  description?: string | null;
  imageSlots: UnifiedImageSlot[];
  warnings: string[];
  unresolvedRequirements: string[];
};

/** Pass C — one body section fragment. */
export type BodySectionFragment = {
  id: string;
  html: string;
  heading?: string;
  purpose?: string;
  imageSlots: UnifiedImageSlot[];
};

export type BodyBatchResult = {
  sections: BodySectionFragment[];
  warnings: string[];
  unresolvedRequirements: string[];
};

export type UnifiedImageReport = {
  planned: number;
  completed: number;
  skippedCredits: number;
  failed: number;
  placeholders: number;
  images: GeneratedLandingImage[];
};

const PLACEHOLDER_SVG = (label: string, w = 1200, h = 800) => {
  const text = label.replace(/[<>&]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#e8e4df"/><text x="50%" y="48%" text-anchor="middle" fill="#6b6560" font-family="system-ui,sans-serif" font-size="28">Image placeholder</text><text x="50%" y="56%" text-anchor="middle" fill="#8a847e" font-family="system-ui,sans-serif" font-size="18">${text.slice(0, 48)}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
};

export function placeholderDataUri(slot: Pick<UnifiedImageSlot, "id" | "purpose" | "width" | "height">): string {
  return PLACEHOLDER_SVG(slot.purpose || slot.id, slot.width || 1200, slot.height || 800);
}

function extractHtmlDocument(raw: string): string | null {
  const lower = raw.toLowerCase();
  const docStart = lower.search(/<!doctype\s+html|<html[\s>]/i);
  if (docStart < 0) return null;
  const end = lower.lastIndexOf("</html>");
  if (end < docStart) return null;
  const html = raw.slice(docStart, end + "</html>".length).trim();
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) return null;
  return html;
}

/** Pull a JSON string value for key "html" even when the surrounding JSON is truncated. */
function extractHtmlStringField(raw: string): string | null {
  const key = raw.search(/"html"\s*:/);
  if (key < 0) return null;
  const after = raw.slice(key);
  const colon = after.search(/:/);
  if (colon < 0) return null;
  let i = colon + 1;
  while (i < after.length && /\s/.test(after[i])) i += 1;
  if (after[i] !== '"') return null;
  i += 1;
  let out = "";
  let escaped = false;
  for (; i < after.length; i += 1) {
    const ch = after[i];
    if (escaped) {
      if (ch === "n") out += "\n";
      else if (ch === "r") out += "\r";
      else if (ch === "t") out += "\t";
      else if (ch === "u" && /^[0-9a-fA-F]{4}/.test(after.slice(i + 1, i + 5))) {
        out += String.fromCharCode(Number.parseInt(after.slice(i + 1, i + 5), 16));
        i += 4;
      } else out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') break;
    out += ch;
  }
  if (!/<html[\s>]/i.test(out)) return null;
  // Truncated responses often cut mid-</html> — refuse incomplete docs.
  if (!/<\/html>/i.test(out)) return null;
  return out.trim();
}

function coerceImageSlots(slotsRaw: unknown): UnifiedImageSlot[] {
  if (!Array.isArray(slotsRaw)) return [];
  return slotsRaw.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id = String(row.id || `img-${index + 1}`).trim();
    const kind = row.kind === "factual" ? "factual" : "illustrative";
    if (kind === "factual") return [];
    const prompt = String(row.prompt || "").trim();
    if (!prompt || prompt.length < 12) return [];
    return [{
      id,
      sectionId: String(row.sectionId || "page"),
      purpose: String(row.purpose || "illustration"),
      prompt,
      aspectRatio: String(row.aspectRatio || row.ratio || "1920:1088"),
      width: typeof row.width === "number" ? row.width : null,
      height: typeof row.height === "number" ? row.height : null,
      alt: String(row.alt || row.purpose || "Illustration"),
      kind: "illustrative" as const,
      priority: typeof row.priority === "number" ? row.priority : index + 1,
      focal: typeof row.focal === "string" ? row.focal : null,
      spaceForText: Boolean(row.spaceForText),
    }];
  });
}

function coerceStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Pull a JSON string field even when surrounding JSON is truncated. */
function extractJsonStringField(raw: string, field: string): string | null {
  const pattern = new RegExp(`"${field}"\\s*:`);
  const key = raw.search(pattern);
  if (key < 0) return null;
  const after = raw.slice(key);
  const colon = after.search(/:/);
  if (colon < 0) return null;
  let i = colon + 1;
  while (i < after.length && /\s/.test(after[i])) i += 1;
  if (after[i] !== '"') return null;
  i += 1;
  let out = "";
  let escaped = false;
  for (; i < after.length; i += 1) {
    const ch = after[i];
    if (escaped) {
      if (ch === "n") out += "\n";
      else if (ch === "r") out += "\r";
      else if (ch === "t") out += "\t";
      else if (ch === "u" && /^[0-9a-fA-F]{4}/.test(after.slice(i + 1, i + 5))) {
        out += String.fromCharCode(Number.parseInt(after.slice(i + 1, i + 5), 16));
        i += 4;
      } else out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') break;
    out += ch;
  }
  return out.trim() || null;
}

function coerceResponse(
  html: string,
  parsed?: Record<string, unknown>,
  extraWarnings: string[] = [],
): UnifiedGenerationResponse {
  if (!/<style[\s>]/i.test(html) && !/style\s*=/.test(html)) {
    throw new Error("The generated page is missing CSS.");
  }
  const imageSlots = coerceImageSlots(parsed?.imageSlots);
  const warnings = [
    ...coerceStringList(parsed?.warnings),
    ...extraWarnings,
  ];
  const unresolvedRequirements = coerceStringList(parsed?.unresolvedRequirements);
  return {
    html,
    title: typeof parsed?.title === "string" ? parsed.title : null,
    description: typeof parsed?.description === "string" ? parsed.description : null,
    sections: Array.isArray(parsed?.sections)
      ? parsed!.sections.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const row = item as Record<string, unknown>;
          return [{
            id: String(row.id || ""),
            purpose: typeof row.purpose === "string" ? row.purpose : undefined,
            heading: typeof row.heading === "string" ? row.heading : undefined,
          }].filter((section) => section.id);
        })
      : [],
    imageSlots,
    warnings,
    unresolvedRequirements,
  };
}

function ensureStyleTag(css: string): string {
  const trimmed = css.trim();
  if (!trimmed) return "";
  if (/^<style[\s>]/i.test(trimmed)) return trimmed;
  return `<style>\n${trimmed}\n</style>`;
}

function extractStyleInner(cssOrStyle: string): string {
  const match = cssOrStyle.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i);
  return (match ? match[1] : cssOrStyle).trim();
}

function unwrapFragment(html: string): string {
  return html.replace(/^\s*<!DOCTYPE[^>]*>/i, "").trim();
}

export function parseSpinePass(raw: string): SpinePassResult {
  const parsed = extractJsonObject(raw);
  let css =
    (typeof parsed?.css === "string" && parsed.css.trim()) ||
    extractJsonStringField(raw, "css") ||
    "";
  let shellHtml =
    (typeof parsed?.shellHtml === "string" && parsed.shellHtml.trim()) ||
    extractJsonStringField(raw, "shellHtml") ||
    "";
  if (!shellHtml) {
    const doc = extractHtmlDocument(raw);
    if (doc) shellHtml = doc;
  }
  if (!css && shellHtml) {
    const fromShell = shellHtml.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i);
    if (fromShell) css = fromShell[1].trim();
  }
  if (!css || !/:root/i.test(css)) {
    throw new Error("Design spine is missing :root CSS tokens.");
  }
  if (!shellHtml || !/<html[\s>]/i.test(shellHtml)) {
    throw new Error("Design spine is missing a valid shell HTML document.");
  }
  if (!/id=["']adr-sections["']/i.test(shellHtml)) {
    // Inject a main landmark so later assembly has a known insertion point.
    if (/<\/body>/i.test(shellHtml)) {
      shellHtml = shellHtml.replace(
        /<\/body>/i,
        `<main id="adr-sections"></main></body>`,
      );
    } else {
      shellHtml = `${shellHtml}<main id="adr-sections"></main>`;
    }
  }
  return { css: extractStyleInner(css), shellHtml };
}

export function parseHeroPass(raw: string): HeroPassResult {
  const parsed = extractJsonObject(raw);
  const headerHtml =
    (typeof parsed?.headerHtml === "string" && parsed.headerHtml.trim()) ||
    extractJsonStringField(raw, "headerHtml") ||
    "";
  const heroHtml =
    (typeof parsed?.heroHtml === "string" && parsed.heroHtml.trim()) ||
    extractJsonStringField(raw, "heroHtml") ||
    "";
  const footerHtml =
    (typeof parsed?.footerHtml === "string" && parsed.footerHtml.trim()) ||
    extractJsonStringField(raw, "footerHtml") ||
    null;
  if (!heroHtml || !/<section[\s>]/i.test(heroHtml)) {
    throw new Error("Hero pass did not return a hero <section>.");
  }
  if (!headerHtml || !/<header[\s>]/i.test(headerHtml)) {
    throw new Error("Hero pass did not return a <header>.");
  }
  // Footer is required for delivery-quality chrome; synthesize a stub if the model omitted it
  // so assembly still has a landmark (ensurePageChrome will rebuild it properly later).
  let resolvedFooter = footerHtml ? unwrapFragment(footerHtml) : null;
  if (!resolvedFooter || !/<footer[\s>]/i.test(resolvedFooter)) {
    resolvedFooter = "<footer></footer>";
  }
  return {
    headerHtml: unwrapFragment(headerHtml),
    heroHtml: unwrapFragment(heroHtml),
    footerHtml: resolvedFooter,
    title: typeof parsed?.title === "string" ? parsed.title : null,
    description: typeof parsed?.description === "string" ? parsed.description : null,
    imageSlots: coerceImageSlots(parsed?.imageSlots),
    warnings: coerceStringList(parsed?.warnings),
    unresolvedRequirements: coerceStringList(parsed?.unresolvedRequirements),
  };
}

export function parseBodyBatch(raw: string): BodyBatchResult {
  const parsed = extractJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.sections)) {
    throw new Error("Body batch did not return a sections array.");
  }
  const sections: BodySectionFragment[] = parsed.sections.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id = String(row.id || "").trim();
    const html = typeof row.html === "string" ? unwrapFragment(row.html.trim()) : "";
    if (!id || !html || !/<section[\s>]/i.test(html)) return [];
    return [{
      id,
      html,
      heading: typeof row.heading === "string" ? row.heading : undefined,
      purpose: typeof row.purpose === "string" ? row.purpose : undefined,
      imageSlots: coerceImageSlots(row.imageSlots).map((slot) => ({
        ...slot,
        sectionId: slot.sectionId === "page" ? id : slot.sectionId,
      })),
    }];
  });
  if (!sections.length) {
    throw new Error("Body batch returned no usable section fragments.");
  }
  return {
    sections,
    warnings: coerceStringList(parsed.warnings),
    unresolvedRequirements: coerceStringList(parsed.unresolvedRequirements),
  };
}

export function assembleUnifiedHtml(input: {
  spine: SpinePassResult;
  hero: HeroPassResult;
  bodySections: BodySectionFragment[];
  imageBudget: number;
}): UnifiedGenerationResponse {
  const styleBlock = ensureStyleTag(input.spine.css);
  let html = input.spine.shellHtml;

  // Ensure a single style block with spine CSS.
  if (/<style\b[^>]*>[\s\S]*?<\/style>/i.test(html)) {
    html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/i, styleBlock);
  } else if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `${styleBlock}</head>`);
  } else if (/<html[\s>]/i.test(html)) {
    html = html.replace(/<html([^>]*)>/i, `<html$1><head>${styleBlock}</head>`);
  } else {
    html = `<!DOCTYPE html><html><head>${styleBlock}</head><body>${html}</body></html>`;
  }

  if (input.hero.title) {
    if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(html)) {
      html = html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeHtmlText(input.hero.title)}</title>`);
    } else if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `<title>${escapeHtmlText(input.hero.title)}</title></head>`);
    }
  }
  if (input.hero.description) {
    const meta = `<meta name="description" content="${escapeHtmlAttr(input.hero.description)}">`;
    if (/<meta\s+name=["']description["'][^>]*>/i.test(html)) {
      html = html.replace(/<meta\s+name=["']description["'][^>]*>/i, meta);
    } else if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `${meta}</head>`);
    }
  }

  // Replace placeholder header if present; otherwise insert before main.
  if (/<header\b[^>]*>[\s\S]*?<\/header>/i.test(html)) {
    html = html.replace(/<header\b[^>]*>[\s\S]*?<\/header>/i, input.hero.headerHtml);
  } else if (/<body\b[^>]*>/i.test(html)) {
    html = html.replace(/<body\b[^>]*>/i, (m) => `${m}\n${input.hero.headerHtml}`);
  }

  const bodyHtml = input.bodySections.map((section) => section.html).join("\n");
  const mainInner = `${input.hero.heroHtml}\n${bodyHtml}`;
  if (/<main\b[^>]*id=["']adr-sections["'][^>]*>[\s\S]*?<\/main>/i.test(html)) {
    html = html.replace(
      /<main\b[^>]*id=["']adr-sections["'][^>]*>[\s\S]*?<\/main>/i,
      `<main id="adr-sections">\n${mainInner}\n</main>`,
    );
  } else if (/<main\b[^>]*>[\s\S]*?<\/main>/i.test(html)) {
    html = html.replace(/<main\b[^>]*>[\s\S]*?<\/main>/i, `<main id="adr-sections">\n${mainInner}\n</main>`);
  } else if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, `<main id="adr-sections">\n${mainInner}\n</main></body>`);
  } else {
    html = `${html}<main id="adr-sections">\n${mainInner}\n</main>`;
  }

  if (input.hero.footerHtml) {
    if (/<footer\b[^>]*>[\s\S]*?<\/footer>/i.test(html)) {
      html = html.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/i, input.hero.footerHtml);
    } else if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, `${input.hero.footerHtml}</body>`);
    }
  }

  const seenSlotIds = new Set<string>();
  const mergedSlots: UnifiedImageSlot[] = [];
  for (const slot of [...input.hero.imageSlots, ...input.bodySections.flatMap((s) => s.imageSlots)]) {
    if (seenSlotIds.has(slot.id)) continue;
    seenSlotIds.add(slot.id);
    mergedSlots.push(slot);
    if (mergedSlots.length >= input.imageBudget) break;
  }

  const sectionMeta = [
    { id: "hero", heading: undefined as string | undefined, purpose: "hero" },
    ...input.bodySections.map((s) => ({
      id: s.id,
      heading: s.heading,
      purpose: s.purpose,
    })),
  ];

  return coerceResponse(
    html,
    {
      title: input.hero.title,
      description: input.hero.description,
      sections: sectionMeta,
      imageSlots: mergedSlots,
      warnings: input.hero.warnings,
      unresolvedRequirements: input.hero.unresolvedRequirements,
    },
  );
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}

export function parseUnifiedResponse(raw: string): UnifiedGenerationResponse {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      const html = typeof parsed.html === "string" ? parsed.html.trim() : "";
      if (html && /<html[\s>]/i.test(html) && /<\/html>/i.test(html)) {
        return coerceResponse(html, parsed);
      }
    } catch {
      // fall through to recovery
    }
  }

  const fromField = extractHtmlStringField(raw);
  if (fromField) {
    return coerceResponse(fromField, undefined, [
      "Recovered HTML from a partially invalid model JSON response.",
    ]);
  }

  const fromDoc = extractHtmlDocument(raw);
  if (fromDoc) {
    return coerceResponse(fromDoc, undefined, [
      "Recovered a raw HTML document from the model response.",
    ]);
  }

  throw new Error("The model response JSON could not be parsed. The page was not marked complete.");
}

export function applyImageSlotsToHtml(
  html: string,
  slots: Map<string, string>,
): string {
  let out = html;
  for (const [id, src] of slots) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const attr = `data-adrival-slot="${id}"`;
    if (out.includes(attr)) {
      out = out.replace(
        new RegExp(`(<img\\b[^>]*\\bdata-adrival-slot="${escaped}"[^>]*\\bsrc=")[^"]*(")`, "i"),
        `$1${src}$2`,
      );
      if (!new RegExp(`data-adrival-slot="${escaped}"[^>]*src=`, "i").test(out) && new RegExp(`data-adrival-slot="${escaped}"`, "i").test(out)) {
        out = out.replace(
          new RegExp(`(<img\\b[^>]*\\bdata-adrival-slot="${escaped}")`, "i"),
          `$1 src="${src}"`,
        );
      }
      // Keep legacy regenerate hooks working alongside the unified slot id.
      if (!new RegExp(`data-adrival-gen-id="${escaped}"`, "i").test(out)) {
        out = out.replace(
          new RegExp(`(<img\\b[^>]*\\bdata-adrival-slot="${escaped}")`, "i"),
          `$1 data-adrival-gen-id="${id}"`,
        );
      }
    }
  }
  return out;
}
