import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The design skills in skills/recreate/: short rules distilled from Taste
 * Skill, Impeccable, Vercel's guidelines, Anthropic frontend-design and
 * screenshot-to-code. The same text goes into every generation call's system
 * prompt, so after the first call of a run it is served from the prompt cache.
 */

export const STYLE_DIRECTIONS = ["brand", "minimal", "soft", "brutalist"] as const;
export type StyleDirection = (typeof STYLE_DIRECTIONS)[number];

export const STYLE_DIRECTION_LABEL: Record<StyleDirection, string> = {
  brand: "Match the brand",
  minimal: "Minimal",
  soft: "High-end soft",
  brutalist: "Bold / brutalist",
};

export function isStyleDirection(value: unknown): value is StyleDirection {
  return typeof value === "string" && (STYLE_DIRECTIONS as readonly string[]).includes(value);
}

/** skills/recreate, next to the app (the Docker image copies it to /app/skills). */
export function skillsRoot(): string {
  return process.env.RECREATE_SKILLS_DIR?.trim() || path.join(process.cwd(), "skills", "recreate");
}

const cache = new Map<string, string>();

function readPlaybook(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  let text = "";
  try {
    text = readFileSync(path.join(skillsRoot(), "playbook", name), "utf8").trim();
  } catch {
    console.warn(`[skills] playbook file missing: ${name}`);
  }
  cache.set(name, text);
  return text;
}

const CORE = ["00-precedence.md", "screenshot-fidelity.md", "quality-floor.md", "anti-generic.md", "copy.md"];

/** The rules every recreation call follows. Stable text, so it caches. */
export function designPlaybook(): string {
  return CORE.map(readPlaybook).filter(Boolean).join("\n\n");
}

/** Extra rules for the chosen style direction (none for "brand"). */
export function styleGuide(style: StyleDirection | null | undefined): string | null {
  if (!style || style === "brand") return null;
  return readPlaybook(`style-${style}.md`) || null;
}

/** How to fix design-check findings without redesigning a section. */
export function repairGuide(): string {
  return readPlaybook("repair.md");
}
