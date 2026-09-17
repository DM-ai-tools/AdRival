export interface InventoryComponent {
  id: string;
  kind: "headline" | "paragraph" | "list" | "cta" | "card" | "proof" | "faq" | "image";
  text: string;
  items: string[];
  nodeId?: string | null;
}

export interface InventorySection {
  id: string;
  order: number;
  sourceHeading: string | null;
  internalLabel: string;
  purpose: string;
  textKind: "rendered" | "summary";
  components: InventoryComponent[];
  gaps: string[];
  box?: { x: number; y: number; width: number; height: number; viewport: string } | null;
  cropRef?: string | null;
}

export interface PageInventory {
  captureId: string;
  sourceUrl: string;
  finalUrl: string;
  capturedAt: string;
  viewports: Array<{ name: string; width: number; height: number }>;
  sections: InventorySection[];
  gaps: string[];
  coverage: { visualRegions: number; mapped: number; unresolved: number };
  visionUsed: boolean;
  overlays?: string[];
  tiles?: Array<{ id: string; viewport: string; path: string; y: number }>;
}

export interface RenderedBlock {
  tag: string;
  text: string;
  alt?: string | null;
  href?: string | null;
  box?: { x: number; y: number; width: number; height: number } | null;
  nodeId?: string | null;
}

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

/** Build sections from rendered DOM blocks captured in one page state. */
export function inventoryFromBlocks(input: {
  sourceUrl: string;
  finalUrl: string;
  blocks: RenderedBlock[];
  gaps?: string[];
  capturedAt?: string;
}): PageInventory {
  const sections: InventorySection[] = [];
  let current: InventorySection | null = null;
  const start = (heading: string, order: number): InventorySection => ({
    id: `src-${order + 1}`,
    order,
    sourceHeading: heading || null,
    internalLabel: heading || `Section ${order + 1}`,
    purpose: "Present this part of the page",
    textKind: "rendered",
    components: heading
      ? [{ id: `src-${order + 1}-headline`, kind: "headline", text: heading, items: [] }]
      : [],
    gaps: [],
    box: null,
  });
  for (const block of input.blocks) {
    const text = block.text.replace(/\s+/g, " ").trim();
    if (!text && !block.alt) continue;
    if (/^h[1-3]$/i.test(block.tag)) {
      if (current) sections.push(current);
      current = start(text, sections.length);
      if (block.box) {
        current.box = { ...block.box, viewport: "desktop" };
      }
      continue;
    }
    if (!current) current = start("", 0);
    const id = `${current.id}-${current.components.length + 1}`;
    if (/^(p|div)$/i.test(block.tag) && text.length > 40) {
      current.components.push({ id, kind: "paragraph", text, items: [] });
    } else if (block.tag.toLowerCase() === "li") {
      const list = current.components.find((item) => item.kind === "list");
      if (list) list.items.push(text);
      else current.components.push({ id, kind: "list", text: "", items: [text] });
    } else if (block.tag.toLowerCase() === "button" || (block.tag.toLowerCase() === "a" && text.length < 48)) {
      current.components.push({ id, kind: "cta", text, items: block.href ? [block.href] : [] });
    } else if (block.alt) {
      current.components.push({ id, kind: "image", text: block.alt, items: [] });
    }
  }
  if (current) sections.push(current);
  const unresolved = sections.filter((section) => section.components.length < 2).length;
  return {
    captureId: `cap-${Date.now()}`,
    sourceUrl: input.sourceUrl,
    finalUrl: input.finalUrl,
    capturedAt: input.capturedAt || new Date().toISOString(),
    viewports: VIEWPORTS,
    sections,
    gaps: [...(input.gaps || []), ...(sections.length === 0 ? ["No rendered sections were extracted."] : [])],
    coverage: { visualRegions: sections.length, mapped: sections.length - unresolved, unresolved },
    visionUsed: false,
  };
}

export function inventoryFromAnalysisSummaries(input: {
  sourceUrl: string;
  sections: Array<{ name?: string | null; purpose?: string | null; summary?: string | null; keyElements?: string[] | null }>;
}): PageInventory {
  const sections = input.sections.map((section, index) => ({
    id: `src-${index + 1}`,
    order: index,
    sourceHeading: section.name || null,
    internalLabel: section.purpose || section.name || `Section ${index + 1}`,
    purpose: section.purpose || "Persuade the reader",
    textKind: "summary" as const,
    components: [
      {
        id: `src-${index + 1}-summary`,
        kind: "paragraph" as const,
        text: [section.summary, ...(section.keyElements || [])].filter(Boolean).join(" ").slice(0, 700),
        items: [],
      },
    ],
    gaps: ["Rendered page text was not captured. This is an analysis summary, not source text."],
    box: null,
  }));
  return {
    captureId: `summary-${Date.now()}`,
    sourceUrl: input.sourceUrl,
    finalUrl: input.sourceUrl,
    capturedAt: new Date().toISOString(),
    viewports: VIEWPORTS,
    sections,
    gaps: ["Rendered capture was not available. Sections come from the earlier analysis summary."],
    coverage: { visualRegions: sections.length, mapped: 0, unresolved: sections.length },
    visionUsed: false,
  };
}

export interface VisionGroup {
  label: string;
  y: number;
}

/** Match vision groups to DOM sections. Unmatched model text is a gap, not source copy. */
export function applyVisionGroups(inventory: PageInventory, groups: VisionGroup[]): PageInventory {
  const sections = inventory.sections.map((section) => ({ ...section }));
  const gaps = [...inventory.gaps];
  let mapped = 0;
  for (const group of groups) {
    const label = group.label.trim().toLowerCase();
    const hit = sections.find((section) => {
      const heading = (section.sourceHeading || "").toLowerCase();
      const text = section.components.map((component) => component.text).join(" ").toLowerCase();
      return Boolean(heading) && (label.includes(heading) || heading.includes(label) || (label.length > 8 && text.includes(label)));
    });
    if (!hit) {
      gaps.push(`Visual region “${group.label}” was not matched to rendered DOM text and was not added as source copy.`);
      continue;
    }
    mapped += 1;
    const tile = (inventory.tiles || []).find((item) => group.y >= item.y && group.y < item.y + 900);
    if (tile) hit.cropRef = tile.path;
  }
  const thin = sections.filter((section) => section.components.length < 2).length;
  return {
    ...inventory,
    sections,
    gaps,
    visionUsed: true,
    coverage: { visualRegions: groups.length, mapped, unresolved: groups.length - mapped + thin },
  };
}

/** Keep the first section id and move the other section's components onto it. */
export function mergeInventorySections(inventory: PageInventory, keepId: string, dropId: string): PageInventory {
  const keep = inventory.sections.find((section) => section.id === keepId);
  const drop = inventory.sections.find((section) => section.id === dropId);
  if (!keep || !drop || keepId === dropId) return inventory;
  return {
    ...inventory,
    sections: inventory.sections
      .filter((section) => section.id !== dropId)
      .map((section) =>
        section.id === keepId
          ? { ...section, components: [...section.components, ...drop.components], gaps: [...section.gaps, `Merged ${dropId} into ${keepId}.`] }
          : section,
      ),
    gaps: [...inventory.gaps, `Section ${dropId} was merged into ${keepId}. Copy stays attached by component id, not by heading.`],
  };
}

export function hasUsableRenderedSource(inventory: PageInventory): boolean {
  return inventory.sections.some(
    (section) =>
      section.textKind === "rendered"
      && section.components.some((component) => component.text.trim().length >= 40),
  );
}

/** Rebuild inventory from archive text nodes. Does not treat summaries as page copy. */
export function inventoryFromCapturedNodes(input: {
  sourceUrl: string;
  title: string | null;
  nodes: Array<{ id: string; role: string; text: string; inFooter?: boolean }>;
}): PageInventory {
  const sections: InventorySection[] = [];
  let current: InventorySection | null = null;
  const body = input.nodes.filter((node) => !node.inFooter && node.text.trim().length > 1);
  for (const node of body) {
    const heading = /^h[1-3]$/.test(node.role);
    if (heading || !current) {
      current = {
        id: `sec-${sections.length + 1}`,
        order: sections.length,
        sourceHeading: heading ? node.text : input.title,
        internalLabel: heading ? node.text : input.title || `Section ${sections.length + 1}`,
        purpose: "Captured page region",
        textKind: "rendered",
        components: [],
        gaps: [],
        cropRef: null,
      };
      sections.push(current);
    }
    current.components.push({
      id: node.id,
      kind: heading ? "headline" : node.role === "li" ? "list" : /button|a/.test(node.role) ? "cta" : "paragraph",
      text: node.text,
      items: node.role === "li" ? [node.text] : [],
      nodeId: node.id,
    });
  }
  return {
    captureId: `archive-${sections.length}`,
    sourceUrl: input.sourceUrl,
    finalUrl: input.sourceUrl,
    capturedAt: new Date().toISOString(),
    viewports: [{ name: "archive", width: 1440, height: 900 }],
    sections,
    gaps: body.length
      ? ["Inventory reused stored archive text for this URL. A new browser capture was not required."]
      : ["Stored archive did not contain readable page text."],
    coverage: { visualRegions: 0, mapped: sections.length, unresolved: body.length ? 0 : 1 },
    visionUsed: false,
  };
}

export function sameCapturedPage(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "")
      && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

