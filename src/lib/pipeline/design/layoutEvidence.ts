/**
 * Measured competitor architecture. Observed values are kept separate from
 * unknowns. Purpose labels are not architecture.
 */

export const LAYOUT_EVIDENCE_VERSION = 2;

export type Confidence = "observed" | "inferred" | "unknown";

export type Box = { x: number; y: number; width: number; height: number };

export type ColumnRole = "content" | "media" | "mixed" | "unknown";

export type SectionComposition = "stack" | "columns" | "repeated" | "media-band" | "unknown";

export type MediaPosition = "left" | "right" | "above" | "below" | "background" | "none";

export type ImageClass = "generate" | "authentic" | "code" | "none";

export type SeparatorKind = "whitespace" | "background" | "border" | "divider" | "unknown";

export type SurfaceRole = "page" | "contrast" | "surface" | "accent" | "media" | "unknown";

export type RepeatedKind = "cards" | "steps" | "list" | "faq" | "quotes" | "unknown";

export type LayoutColumn = {
  id: string;
  fraction: number;
  role: ColumnRole;
  /** Captured component ids that were inside this column. Empty when the probe only measured boxes. */
  componentIds: string[];
  confidence: Confidence;
};

export type SectionArchitecture = {
  id: string;
  order: number;
  source: string;
  bounds: Box | null;
  cropRef: string | null;
  composition: SectionComposition;
  compositionConfidence: Confidence;
  fullWidth: boolean | null;
  containerWidth: number | null;
  align: "start" | "center" | "end" | "unknown";
  gap: number | null;
  paddingY: number | null;
  columns: LayoutColumn[];
  repeated: {
    kind: RepeatedKind;
    columns: number;
    gap: number | null;
    bordered: boolean;
    radius: number | null;
    confidence: Confidence;
  } | null;
  media: {
    position: MediaPosition;
    aspect: number | null;
    focal: "center" | "left" | "right" | "unknown";
    classification: ImageClass;
    confidence: Confidence;
  };
  heading?: string | null;
  headingAlign: "start" | "center" | "unknown";
  textMeasure: number | null;
  backgroundRole: SurfaceRole;
  /** Computed background of the section or its painted inner panel. */
  paint?: string | null;
  separator: SeparatorKind;
  radius: number | null;
  interactions: Array<{ kind: string; confidence: Confidence; evidence: string }>;
  responsive: {
    stacks: boolean | null;
    source: string;
  };
};

export type PageLayoutEvidence = {
  version: number;
  captureId: string;
  sourceUrl: string;
  viewport: { name: string; width: number; height: number };
  header: {
    arrangement: "split" | "centered" | "stacked" | "unknown";
    confidence: Confidence;
    source: string;
  };
  footer: {
    arrangement: "split" | "centered" | "stacked" | "unknown";
    groups: number | null;
    confidence: Confidence;
  };
  sections: SectionArchitecture[];
  incomplete: boolean;
  gaps: string[];
};

export type ProbeBand = {
  box: Box | null;
  background: string;
  pageBackground: string;
  textAlign: string;
  paddingY: number | null;
  gap: number | null;
  containerWidth: number | null;
  fullWidth: boolean | null;
  columnWidths: number[];
  columnRoles: ColumnRole[];
  repeatedCount: number;
  repeatedColumns: number;
  repeatedGap: number | null;
  repeatedBordered: boolean;
  repeatedRadius: number | null;
  mediaPosition: MediaPosition;
  mediaAspect: number | null;
  heading: string | null;
  headingAlign: "start" | "center" | "unknown";
  textMeasure: number | null;
  separator: SeparatorKind;
  interactions: Array<{ kind: string; evidence: string }>;
  cropRef?: string | null;
};

export type LayoutProbe = {
  viewport: { width: number; height: number };
  pageBackground: string;
  headerArrangement: "split" | "centered" | "stacked" | "unknown";
  footerArrangement: "split" | "centered" | "stacked" | "unknown";
  footerGroups: number | null;
  bands: ProbeBand[];
  mobileStacks: boolean | null;
  gaps: string[];
};

function fractions(widths: number[]): number[] {
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total <= 0) return [];
  return widths.map((width) => Math.round((width / total) * 1000) / 1000);
}

function alignOf(value: string): "start" | "center" | "end" | "unknown" {
  if (/center/.test(value)) return "center";
  if (/right|end/.test(value)) return "end";
  if (/left|start/.test(value)) return "start";
  return "unknown";
}

/** Turn a DOM measurement into architecture. Does not invent a split when columns were not measured. */
export function architectureFromProbe(probe: LayoutProbe, sourceUrl: string): PageLayoutEvidence {
  const gaps = [...probe.gaps];
  if (probe.bands.length === 0) {
    gaps.push("No visual bands were measured. Section-purpose summaries are not a substitute.");
  }
  const sections = probe.bands.map((band, index) => sectionFromBand(band, index, probe.mobileStacks));
  if (sections.some((section) => section.composition === "unknown")) {
    gaps.push("At least one measured band has an unknown composition.");
  }
  return {
    version: LAYOUT_EVIDENCE_VERSION,
    captureId: `layout-${probe.viewport.width}-${sections.length}`,
    sourceUrl,
    viewport: { name: "desktop", width: probe.viewport.width, height: probe.viewport.height },
    header: {
      arrangement: probe.headerArrangement,
      confidence: probe.headerArrangement === "unknown" ? "unknown" : "observed",
      source: "header box",
    },
    footer: {
      arrangement: probe.footerArrangement,
      groups: probe.footerGroups,
      confidence: probe.footerArrangement === "unknown" ? "unknown" : "observed",
    },
    sections,
    incomplete: gaps.length > 0 || sections.length === 0 || sections.some((section) => section.composition === "unknown"),
    gaps,
  };
}

function sectionFromBand(band: ProbeBand, index: number, mobileStacks: boolean | null): SectionArchitecture {
  const measuredColumns = band.columnWidths.filter((width) => width > 40);
  const repeated = band.repeatedCount >= 3 && band.repeatedColumns >= 2;
  let composition: SectionComposition = "unknown";
  let confidence: Confidence = "unknown";
  if (repeated) {
    composition = "repeated";
    confidence = "observed";
  } else if (measuredColumns.length >= 2) {
    composition = "columns";
    confidence = "observed";
  } else if (band.mediaPosition === "background" && measuredColumns.length <= 1) {
    composition = "media-band";
    confidence = "observed";
  } else if (measuredColumns.length <= 1 && band.box) {
    composition = "stack";
    confidence = "observed";
  }
  const parts = fractions(measuredColumns);
  const backgroundRole = classifyPaint(band.background, band.pageBackground);
  return {
    id: `band-${index + 1}`,
    order: index,
    source: "Rendered DOM measurements. Animation was not inferred from a still frame.",
    bounds: band.box,
    cropRef: band.cropRef || null,
    composition,
    compositionConfidence: confidence,
    fullWidth: band.fullWidth,
    containerWidth: band.containerWidth,
    align: alignOf(band.textAlign),
    gap: band.gap,
    paddingY: band.paddingY,
    columns: parts.map((fraction, columnIndex) => ({
      id: `band-${index + 1}-col-${columnIndex + 1}`,
      fraction,
      role: band.columnRoles[columnIndex] || "unknown",
      componentIds: [],
      confidence: "observed",
    })),
    repeated: repeated
      ? {
          kind: "cards",
          columns: band.repeatedColumns,
          gap: band.repeatedGap,
          bordered: band.repeatedBordered,
          radius: band.repeatedRadius,
          confidence: "observed",
        }
      : null,
    media: {
      position: band.mediaPosition,
      aspect: band.mediaAspect,
      focal: "unknown",
      classification: band.mediaPosition === "none" ? "none" : "generate",
      confidence: band.mediaPosition === "none" ? "observed" : "inferred",
    },
    heading: band.heading,
    headingAlign: band.headingAlign,
    textMeasure: band.textMeasure,
    backgroundRole,
    paint: band.background || null,
    separator: band.separator,
    radius: band.repeatedRadius,
    interactions: band.interactions.map((item) => ({
      kind: item.kind,
      confidence: "observed" as const,
      evidence: item.evidence,
    })),
    responsive: {
      stacks: mobileStacks,
      source: mobileStacks == null ? "Mobile stacking was not measured." : "Compared with the mobile viewport.",
    },
  };
}

export function evidenceCoversSections(evidence: PageLayoutEvidence | null | undefined, sectionIds: string[]): boolean {
  if (!evidence || evidence.version !== LAYOUT_EVIDENCE_VERSION || evidence.incomplete) return false;
  return sectionIds.every((id) => evidence.sections.some((section) => section.id === id && section.composition !== "unknown"));
}

function parseRgb(value: string | null | undefined): { r: number; g: number; b: number } | null {
  if (!value) return null;
  const rgb = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?/i);
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) === 0) return null;
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

/** Map a measured competitor fill onto a brand role. White stays page. Dark becomes the brand surface. Saturated fills become the brand primary. */
export function classifyPaint(paint: string | null | undefined, pageBackground: string | null | undefined): SurfaceRole {
  const color = parseRgb(paint);
  if (!color) return "page";
  const page = parseRgb(pageBackground);
  const lum = (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
  const max = Math.max(color.r, color.g, color.b) / 255;
  const min = Math.min(color.r, color.g, color.b) / 255;
  const sat = max === 0 ? 0 : (max - min) / max;
  if (page && Math.abs(color.r - page.r) < 14 && Math.abs(color.g - page.g) < 14 && Math.abs(color.b - page.b) < 14 && lum > 0.8) {
    return "page";
  }
  if (lum > 0.92 && sat < 0.18) return "page";
  if (lum < 0.45) return "contrast";
  if (sat > 0.28) return "accent";
  return "page";
}

function normHeading(value: string | null | undefined): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sameHeading(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normHeading(left);
  const b = normHeading(right);
  if (a.length < 8 || b.length < 8) return false;
  return a.includes(b.slice(0, 48)) || b.includes(a.slice(0, 48));
}

/**
 * Attach measured bands to captured sections.
 * Equal counts use visual order. Otherwise a section keeps the measured band
 * whose heading it came from, or the nearest measured parent band.
 * It is not given a generic split layout.
 */
export function alignLayoutEvidence(
  evidence: PageLayoutEvidence,
  sectionIds: string[],
  hints: Array<{ id: string; heading?: string | null }> = [],
): PageLayoutEvidence {
  if (sectionIds.length === 0) {
    return { ...evidence, incomplete: true, gaps: [...evidence.gaps, "No captured sections to align."] };
  }
  if (evidence.sections.length === 0 || evidence.sections.every((section) => section.composition === "unknown")) {
    return {
      ...evidence,
      incomplete: true,
      gaps: [...evidence.gaps, "No visual bands were measured. Retry capture before designing."],
    };
  }
  const hintById = new Map(hints.map((hint) => [hint.id, hint.heading || null]));
  if (evidence.sections.length === sectionIds.length) {
    return {
      ...evidence,
      incomplete: false,
      sections: evidence.sections.map((section, index) => ({
        ...section,
        id: sectionIds[index],
        source: `${section.source} Aligned to captured section ${sectionIds[index]} by visual order.`,
      })),
    };
  }
  const assigned: Array<{ id: string; band: SectionArchitecture; inferred: boolean }> = [];
  let previous: SectionArchitecture | null = null;
  const matched = sectionIds.map((id) => {
    const heading = hintById.get(id);
    return evidence.sections.find((band) => sameHeading(band.heading, heading)) || null;
  });
  for (let index = 0; index < sectionIds.length; index += 1) {
    const direct = matched[index];
    if (direct) previous = direct;
    const fallbackIndex = Math.min(
      evidence.sections.length - 1,
      Math.floor(index * evidence.sections.length / sectionIds.length),
    );
    const band = direct || previous || evidence.sections[fallbackIndex];
    assigned.push({ id: sectionIds[index], band, inferred: !direct });
  }
  for (let index = sectionIds.length - 1; index >= 0; index -= 1) {
    if (matched[index]) continue;
    const following = matched.slice(index + 1).find(Boolean);
    if (following && assigned[index].inferred) assigned[index] = { ...assigned[index], band: following };
  }
  const shared = assigned.filter((item) => item.inferred).length;
  return {
    ...evidence,
    incomplete: false,
    gaps: [
      ...evidence.gaps.filter((gap) => !/Refusing to invent/.test(gap)),
      shared
        ? `${shared} captured section(s) share a measured parent band. Their composition was copied from that band, not invented from a purpose label.`
        : "Every included section was aligned to a measured band.",
    ],
    sections: assigned.map((item) => ({
      ...item.band,
      id: item.id,
      composition: item.inferred && item.band.composition === "columns" ? "stack" : item.band.composition,
      columns: item.inferred ? [] : item.band.columns,
      compositionConfidence: item.inferred ? "inferred" as const : item.band.compositionConfidence,
      source: item.inferred
        ? `Shares the spacing of measured band “${item.band.heading || item.band.id}”. Column geometry was not copied onto a different section.`
        : `Matched captured heading to measured band “${item.band.heading || item.band.id}”.`,
    })),
  };
}
