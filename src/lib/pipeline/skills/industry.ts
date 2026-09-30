import { readFileSync } from "node:fs";
import path from "node:path";
import { parseCsv } from "./csv";
import { skillsRoot } from "./playbook";

/**
 * Industry lookup from UI UX Pro Max's data (192 product types): what
 * visitors in the client's industry expect, what to avoid, and a font
 * pairing and palette. The pairing and palette fill gaps only: the client's
 * own fonts and colours always win.
 */

export type IndustryGuide = {
  productType: string;
  landingPattern: string;
  stylePriority: string;
  colorMood: string;
  typographyMood: string;
  keyConsiderations: string;
  antiPatterns: string;
  fonts: { name: string; heading: string; body: string } | null;
  palette: { primary: string; secondary: string; accent: string; background: string; text: string } | null;
  score: number;
};

type Tables = {
  products: Array<Record<string, string>>;
  colors: Array<Record<string, string>>;
  reasoning: Array<Record<string, string>>;
  typography: Array<Record<string, string>>;
};

let tables: Tables | null | undefined;

function load(): Tables | null {
  if (tables !== undefined) return tables;
  try {
    const dir = path.join(skillsRoot(), "vendor", "ui-ux-pro-max", "data");
    const read = (f: string) => parseCsv(readFileSync(path.join(dir, f), "utf8"));
    tables = {
      products: read("products.csv"),
      colors: read("colors.csv"),
      reasoning: read("ui-reasoning.csv"),
      typography: read("typography.csv"),
    };
  } catch (err) {
    console.warn("[skills] UI UX Pro Max data unavailable", err instanceof Error ? err.message : err);
    tables = null;
  }
  return tables;
}

const STOP = new Set(["and", "the", "for", "with", "services", "service", "company", "business", "general", "your", "our", "app", "platform", "online", "best", "near", "me", "top"]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Families that read as the generated default (Taste Skill, Impeccable). */
const DEFAULT_FONTS = /^(inter|roboto|open sans|arial|helvetica|fraunces|instrument serif|poppins)$/i;
const HEX = /^#[0-9a-f]{6}$/i;

export function matchIndustry(input: {
  industry?: string | null;
  subIndustry?: string | null;
  offerings?: string[];
  keyword?: string | null;
  description?: string | null;
}): IndustryGuide | null {
  const data = load();
  if (!data) return null;
  const strong = [input.industry, input.subIndustry, input.keyword, ...(input.offerings || []).slice(0, 12)]
    .filter(Boolean)
    .join(" | ")
    .toLowerCase();
  const weak = (input.description || "").toLowerCase().slice(0, 600);
  if (!strong.trim() && !weak.trim()) return null;
  const strongWords = new Set(words(strong));
  const weakWords = new Set(words(weak));

  let best: { row: Record<string, string>; score: number } | null = null;
  for (const row of data.products) {
    const type = row["Product Type"] || "";
    let score = 0;
    for (const phrase of (row.Keywords || "").split(",").map((p) => p.trim().toLowerCase()).filter(Boolean)) {
      if (phrase.length < 3 || STOP.has(phrase)) continue;
      const isPhrase = phrase.includes(" ") || phrase.includes("-");
      if (isPhrase ? strong.includes(phrase) : strongWords.has(phrase)) score += isPhrase ? 4 : 2;
      else if (isPhrase ? weak.includes(phrase) : weakWords.has(phrase)) score += 1;
    }
    for (const w of words(type)) {
      if (strongWords.has(w)) score += 3;
      else if (weakWords.has(w)) score += 1;
    }
    if (!best || score > best.score) best = { row, score };
  }
  if (!best || best.score < 4) return null;

  const type = best.row["Product Type"];
  const reasoning = data.reasoning.find((r) => r.UI_Category === type) || null;
  const color = data.colors.find((r) => r["Product Type"] === type) || null;

  // Font pairing: best for this kind of business, in the mood the industry calls for.
  const moodWords = new Set(words(`${reasoning?.Typography_Mood || ""} ${best.row["Primary Style Recommendation"] || ""}`));
  const typeWords = new Set([...words(type), ...strongWords]);
  let font: { row: Record<string, string>; score: number } | null = null;
  for (const row of data.typography) {
    const heading = row["Heading Font"] || "";
    const body = row["Body Font"] || "";
    if (!heading || !body) continue;
    let score = 0;
    for (const w of words(row["Best For"] || "")) if (typeWords.has(w)) score += 2;
    for (const w of words(row["Mood/Style Keywords"] || "")) if (moodWords.has(w)) score += 1;
    if (DEFAULT_FONTS.test(heading)) score -= 3;
    if (DEFAULT_FONTS.test(body)) score -= 2;
    if (!font || score > font.score) font = { row, score };
  }

  const palette =
    color && [color.Primary, color.Secondary, color.Accent, color.Background, color.Foreground].every((v) => HEX.test(v || ""))
      ? { primary: color.Primary, secondary: color.Secondary, accent: color.Accent, background: color.Background, text: color.Foreground }
      : null;

  return {
    productType: type,
    landingPattern: best.row["Landing Page Pattern"] || reasoning?.Recommended_Pattern || "",
    stylePriority: reasoning?.Style_Priority || best.row["Primary Style Recommendation"] || "",
    colorMood: reasoning?.Color_Mood || best.row["Color Palette Focus"] || "",
    typographyMood: reasoning?.Typography_Mood || "",
    keyConsiderations: best.row["Key Considerations"] || "",
    antiPatterns: reasoning?.Anti_Patterns || "",
    fonts: font && font.score > 0 ? { name: font.row["Font Pairing Name"], heading: font.row["Heading Font"], body: font.row["Body Font"] } : null,
    palette,
    score: best.score,
  };
}

/** What the writer is told about the industry (context, not a restyle). */
export function industryBrief(guide: IndustryGuide | null): Record<string, string> | null {
  if (!guide) return null;
  return {
    source: "UI UX Pro Max industry data. Context only: the client's brand tokens and the competitor's layout still decide the look.",
    industry: guide.productType,
    whatVisitorsExpect: guide.keyConsiderations,
    typographyMood: guide.typographyMood,
    colourMood: guide.colorMood,
    avoidInThisIndustry: guide.antiPatterns,
  };
}
