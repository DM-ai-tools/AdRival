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

function coerceResponse(
  html: string,
  parsed?: Record<string, unknown>,
  extraWarnings: string[] = [],
): UnifiedGenerationResponse {
  if (!/<style[\s>]/i.test(html) && !/style\s*=/.test(html)) {
    throw new Error("The generated page is missing CSS.");
  }
  const slotsRaw = Array.isArray(parsed?.imageSlots) ? parsed!.imageSlots : [];
  const imageSlots: UnifiedImageSlot[] = slotsRaw.flatMap((item, index) => {
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
  const warnings = [
    ...(Array.isArray(parsed?.warnings)
      ? parsed!.warnings.map((item) => String(item)).filter(Boolean)
      : []),
    ...extraWarnings,
  ];
  const unresolvedRequirements = Array.isArray(parsed?.unresolvedRequirements)
    ? parsed!.unresolvedRequirements.map((item) => String(item)).filter(Boolean)
    : [];
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
