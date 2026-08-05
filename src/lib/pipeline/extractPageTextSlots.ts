import type { CidTextNode } from "./archive/rewriteTextByCid";
import {
  collectStampedCidNodes,
  stampTextCids,
} from "./archive/rewriteTextByCid";
import { fetchRawLandingHtml } from "./htmlFetch";
import { captureArchivedPage } from "./archive/capturePage";
import type { StoredPageArchive } from "../types";

import { lengthBudgetForRole } from "./slotTextBudget";

export type PageTextSlot = {
  id: string;
  sectionIndex: number;
  sectionName: string;
  role: string;
  htmlRole: string;
  label: string;
  purpose: string;
  targetLen: number;
  minLen: number;
  maxLen: number;
  /** Competitor text at this placement — paraphrase topic only */
  originalText: string;
  href?: string | null;
  seedText?: string | null;
};

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function semanticRole(node: CidTextNode): string {
  const tag = node.role.toLowerCase();
  if (tag === "h1") return "h1";
  if (tag === "h2") return "h2";
  if (tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "h3";
  if (tag === "button") return "cta";
  if (tag === "a") return node.text.length <= 48 ? "cta" : "body";
  if (tag === "li") return "bullet";
  if (tag === "label") return "eyebrow";
  if (tag === "span" || tag === "strong" || tag === "em") {
    if (node.text.length <= 40) return "eyebrow";
    return "body";
  }
  if (node.text.length <= 48) return "eyebrow";
  if (
    /[“"]/.test(node.text) ||
    /\b(review|testimonial|customer said|stars?)\b/i.test(node.text)
  ) {
    return "testimonial";
  }
  if (/^\d+%?$|^\d+[kKmMbB+]/.test(node.text) || node.text.length <= 12) {
    return "stat";
  }
  return "body";
}

function roleLabel(role: string, sectionName: string, index: number): string {
  const map: Record<string, string> = {
    h1: "Headline (H1)",
    h2: "Section heading (H2)",
    h3: "Subheading",
    body: "Body copy",
    bullet: "Bullet / list item",
    cta: "Call to action",
    testimonial: "Testimonial",
    stat: "Stat / proof",
    eyebrow: "Eyebrow / short line",
  };
  return map[role] || `${sectionName} · ${role} ${index + 1}`;
}

/**
 * Convert stamped CID nodes into content-generation slots with length budgets
 * that leave room for complete phrases (not mid-sentence stubs).
 */
export function slotsFromCidNodes(nodes: CidTextNode[]): PageTextSlot[] {
  const slots: PageTextSlot[] = [];
  let sectionIndex = 1;
  let sectionName = "Hero / top of page";
  let sectionItem = 0;

  for (const node of nodes) {
    if (node.inFooter) continue;
    const role = semanticRole(node);
    const tag = node.role.toLowerCase();

    if (tag === "h1") {
      sectionIndex = 1;
      sectionName = "Hero / top of page";
      sectionItem = 0;
    } else if (tag === "h2") {
      sectionIndex += 1;
      sectionName = normalize(node.text).slice(0, 60) || `Section ${sectionIndex}`;
      sectionItem = 0;
    }

    const budget = lengthBudgetForRole(node.text.length, role);
    slots.push({
      id: node.id,
      sectionIndex,
      sectionName,
      role,
      htmlRole: tag,
      label: roleLabel(role, sectionName, sectionItem),
      purpose: `Replace competitor ${tag} text in “${sectionName}” — write a COMPLETE phrase near the original length`,
      targetLen: node.text.length,
      minLen: budget.minLen,
      maxLen: budget.maxLen,
      originalText: node.text,
    });
    sectionItem += 1;
  }

  return slots;
}

export type ExtractedPageSlots = {
  slots: PageTextSlot[];
  finalUrl: string;
  title: string | null;
  source: "fetch" | "playwright";
  nodeCount: number;
  /** Stamped HTML — persist and reuse in design phase */
  stampedHtml: string;
  archive: StoredPageArchive;
};

/**
 * Pull real visible text placements from the competitor page.
 * Prefer Playwright archive first so content + design share the same DOM/CIDs.
 * Fall back to fetch HTML only if Playwright fails.
 */
export async function extractCompetitorPageTextSlots(
  sourceUrl: string,
): Promise<ExtractedPageSlots> {
  let html = "";
  let finalUrl = sourceUrl;
  let title: string | null = null;
  let source: "fetch" | "playwright" = "playwright";

  try {
    const archive = await captureArchivedPage(sourceUrl);
    html = archive.html;
    finalUrl = archive.finalUrl;
    title = archive.title;
    source = "playwright";
  } catch (err) {
    console.warn(
      "[slots] Playwright capture failed, trying fetch/Firecrawl",
      (err as Error).message,
    );
    try {
      const page = await fetchRawLandingHtml(sourceUrl);
      html = page.html;
      finalUrl = page.finalUrl;
      title = page.title;
      source = "fetch";
    } catch (fetchErr) {
      throw new Error(
        `Could not extract page text slots: ${(fetchErr as Error).message}`,
      );
    }
  }

  let stamped = stampTextCids(html);

  // Thin stamp after Playwright → try fetch as supplement only if < 3 nodes
  if (stamped.nodes.length < 3 && source === "playwright") {
    try {
      const page = await fetchRawLandingHtml(sourceUrl);
      const alt = stampTextCids(page.html);
      if (alt.nodes.length > stamped.nodes.length) {
        stamped = alt;
        html = page.html;
        finalUrl = page.finalUrl;
        title = page.title || title;
        source = "fetch";
      }
    } catch {
      // keep playwright stamp
    }
  }

  if (stamped.nodes.length < 3) {
    throw new Error(
      `Too few text placements found on ${finalUrl} (${stamped.nodes.length}). Try analyzing the page again.`,
    );
  }

  // Prefer primary (non-dup) nodes for content writing
  const seen = new Set<string>();
  const unique: CidTextNode[] = [];
  for (const n of stamped.nodes) {
    if (n.inFooter) continue;
    const key = `${n.role}:${normalize(n.text).toLowerCase()}`;
    if (normalize(n.text).length >= 18 && seen.has(key)) continue;
    if (normalize(n.text).length >= 18) seen.add(key);
    unique.push(n);
    if (unique.length >= 180) break;
  }

  const slots = slotsFromCidNodes(unique);
  if (slots.length < 3) {
    throw new Error(
      `Too few text placements found on ${finalUrl} (${slots.length}). Try analyzing the page again.`,
    );
  }

  const archive: StoredPageArchive = {
    html: stamped.html,
    finalUrl,
    title,
    capturedAt: new Date().toISOString(),
    source,
    nodeCount: stamped.nodes.length,
  };

  return {
    slots,
    finalUrl,
    title,
    source,
    nodeCount: stamped.nodes.length,
    stampedHtml: stamped.html,
    archive,
  };
}

/** Re-read CID nodes from a stored stamped archive. */
export function slotsFromStoredArchive(archive: StoredPageArchive): {
  slots: PageTextSlot[];
  nodes: CidTextNode[];
} {
  const collected = collectStampedCidNodes(archive.html);
  const slots = slotsFromCidNodes(
    collected.nodes.filter((n) => !n.inFooter).slice(0, 180),
  );
  return { slots, nodes: collected.nodes };
}
