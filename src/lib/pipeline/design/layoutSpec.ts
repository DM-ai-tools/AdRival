import type { CanonicalContent, ContentSection, DraftField, StructuredItem } from "../content/model";
import type { PageLayoutEvidence, SectionArchitecture } from "./layoutEvidence";

export type LayoutNodeKind =
  | "section"
  | "container"
  | "heading-group"
  | "content-group"
  | "columns"
  | "column"
  | "repeated"
  | "item"
  | "media"
  | "cta-group"
  | "faq"
  | "quote"
  | "hero"
  | "steps"
  | "cards";

export type BoundField = {
  id: string;
  role: "eyebrow" | "heading" | "paragraph" | "list" | "cta" | "card" | "faq" | "quote" | "caption";
  text: string;
  items: string[];
  href: string | null;
  question: string | null;
  answer: string | null;
};

export type LayoutNode = {
  id: string;
  kind: LayoutNodeKind;
  display: "block" | "grid" | "flex";
  expectedChildren: number | null;
  columns: string | null;
  gap: number | null;
  align: string | null;
  width: number | null;
  fullWidth: boolean;
  surface: string;
  separator: string;
  fieldIds: string[];
  assetSlotId: string | null;
  children: LayoutNode[];
};

export type LayoutSpec = {
  sections: Array<{
    id: string;
    composition: string;
    source: string;
    nodes: LayoutNode;
    fields: BoundField[];
    aspect: number | null;
  }>;
  imageSlots: Array<{ id: string; sectionId: string; aspect: number | null; purpose: string }>;
  blockers: string[];
  notes: string[];
};

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

export function fieldLooksLikeParagraph(field: Pick<DraftField, "kind" | "text">): boolean {
  const kind = field.kind.toLowerCase();
  if (!/headline|heading|^h[1-3]$/.test(kind)) return false;
  return field.text.includes("\n") || field.text.includes("**") || wordCount(field.text) > 22;
}

function roleOf(field: DraftField): BoundField["role"] | null {
  if (field.disposition === "omit") return null;
  const kind = field.kind.toLowerCase();
  if (/eyebrow|kicker/.test(kind)) return "eyebrow";
  if (/headline|heading|^h[1-3]$/.test(kind)) return "heading";
  if (/paragraph|body|prose|copy/.test(kind)) return "paragraph";
  if (/list|bullet|step/.test(kind)) return "list";
  if (/cta|button/.test(kind)) return "cta";
  if (/card|service/.test(kind)) return "card";
  if (/faq|question/.test(kind)) return "faq";
  if (/quote|testimonial/.test(kind)) return "quote";
  if (/caption/.test(kind)) return "caption";
  return null;
}

function bindField(field: DraftField, href: string | null): BoundField | null {
  const role = roleOf(field);
  if (!role) return null;
  if (!field.text.trim() && field.items.length === 0) return null;
  if (role === "faq") {
    return {
      id: field.id,
      role,
      text: field.text,
      items: field.items,
      href: null,
      question: field.text,
      answer: field.items[0] || "",
    };
  }
  return {
    id: field.id,
    role,
    text: field.text,
    items: field.items,
    href: role === "cta" ? href : null,
    question: null,
    answer: null,
  };
}

function faqLooksSwapped(item: StructuredItem): boolean {
  const question = item.label.trim();
  const answer = (item.detail || "").trim();
  if (!question || !answer) return false;
  const questionLooksLikeAnswer = !question.endsWith("?") && wordCount(question) > wordCount(answer) && answer.endsWith("?");
  return questionLooksLikeAnswer;
}

export function fieldsForSection(section: ContentSection, clientHref: (value: string | null | undefined) => string | null): {
  fields: BoundField[];
  blockers: string[];
  notes: string[];
} {
  const blockers: string[] = [];
  const notes: string[] = [];
  const fields: BoundField[] = [];
  const seen = new Set<string>();
  for (const field of section.fields || []) {
    if (field.disposition === "omit") {
      notes.push(`Field ${field.id} was omitted by the approved revision.`);
      continue;
    }
    if (/cta|button/i.test(field.kind) && wordCount(field.text) > 14) {
      notes.push(`Field ${field.id} is too long for a button, so it was rendered as copy. The approved text was not rewritten.`);
      fields.push({
        id: field.id,
        role: "paragraph",
        text: field.text,
        items: field.items,
        href: null,
        question: null,
        answer: null,
      });
      continue;
    }
    if (fieldLooksLikeParagraph(field)) {
      notes.push(`Field ${field.id} reads as body copy, so it was kept as a paragraph rather than a giant heading.`);
      fields.push({
        id: field.id,
        role: "paragraph",
        text: field.text,
        items: field.items,
        href: null,
        question: null,
        answer: null,
      });
      continue;
    }
    const bound = bindField(field, null);
    if (!bound) {
      if (field.text.trim()) {
        blockers.push(`Field ${field.id} has no recognized content type. Correct its classification in content review.`);
      }
      continue;
    }
    seen.add(field.text.trim());
    fields.push(bound);
  }
  for (const item of section.items) {
    if (item.kind === "faq") {
      if (faqLooksSwapped(item)) {
        blockers.push(`FAQ ${item.id} looks like the answer was stored as the question. Correct it in content review. Design did not swap them.`);
      }
      fields.push({
        id: item.id,
        role: "faq",
        text: item.label,
        items: item.detail ? [item.detail] : [],
        href: null,
        question: item.label,
        answer: item.detail || "",
      });
      continue;
    }
    if (item.kind === "testimonial") {
      fields.push({
        id: item.id,
        role: "quote",
        text: item.label,
        items: item.detail ? [item.detail] : [],
        href: null,
        question: null,
        answer: null,
      });
      continue;
    }
    if (item.kind === "cta") {
      if (wordCount(item.label) > 14) {
        notes.push(`Item ${item.id} is too long for a button, so it was rendered as copy.`);
        fields.push({
          id: item.id,
          role: "paragraph",
          text: item.label,
          items: [],
          href: null,
          question: null,
          answer: null,
        });
        continue;
      }
      fields.push({
        id: item.id,
        role: "cta",
        text: item.label,
        items: [],
        href: clientHref(item.href),
        question: null,
        answer: null,
      });
    }
  }
  const heading = section.heading.replace(/\s+/g, " ").trim();
  if (heading && !fields.some((field) => field.role === "heading" && field.text.trim() === heading)) {
    const already = fields.some((field) => field.text.trim() === heading);
    if (!already && heading.length <= 140 && !heading.includes("**") && !heading.includes("\n")) {
      fields.unshift({
        id: `${section.id}-heading`,
        role: "heading",
        text: heading,
        items: [],
        href: null,
        question: null,
        answer: null,
      });
    }
  }
  for (const paragraph of section.paragraphs) {
    const text = paragraph.trim();
    if (!text || seen.has(text) || fields.some((field) => field.text.trim() === text)) continue;
    fields.push({
      id: `${section.id}-p-${fields.length + 1}`,
      role: "paragraph",
      text,
      items: [],
      href: null,
      question: null,
      answer: null,
    });
  }
  return { fields, blockers, notes };
}

function node(partial: LayoutNode): LayoutNode {
  return partial;
}

function resolvedSurface(section: SectionArchitecture): string {
  if (!section.paint || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0/.test(section.paint)) return "page";
  return section.backgroundRole === "unknown" ? "page" : section.backgroundRole;
}

function sourceWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function isQuestionHeading(value: string): boolean {
  return value.trim().endsWith("?");
}

function isNumberedHeading(value: string): boolean {
  return /^\d+[\.\)]\s+\S/.test(value.trim());
}

function isShortLabel(value: string): boolean {
  const text = value.trim();
  return text.length > 0 && text.length <= 42 && sourceWords(text) <= 6 && !isQuestionHeading(text) && !isNumberedHeading(text);
}

type SourceGroup =
  | { kind: "hero"; sections: ContentSection[] }
  | { kind: "steps"; sections: ContentSection[] }
  | { kind: "cards"; title: ContentSection; cards: ContentSection[] }
  | { kind: "faq"; title: ContentSection; items: ContentSection[] }
  | { kind: "single"; section: ContentSection };

/** Group captured competitor headings into the layouts those headings already name. Approved copy is not rewritten. */
export function groupByCompetitorHeadings(
  sections: ContentSection[],
  headingOf: (section: ContentSection) => string,
): SourceGroup[] {
  const groups: SourceGroup[] = [];
  let index = 0;
  while (index < sections.length) {
    const heading = headingOf(sections[index]);
    const next = sections[index + 1];
    if (!groups.length && next && isShortLabel(heading) && sourceWords(headingOf(next)) >= 6) {
      groups.push({ kind: "hero", sections: [sections[index], next] });
      index += 2;
      continue;
    }
    if (isNumberedHeading(heading)) {
      const steps = [sections[index]];
      let cursor = index + 1;
      while (cursor < sections.length && isNumberedHeading(headingOf(sections[cursor]))) {
        steps.push(sections[cursor]);
        cursor += 1;
      }
      if (steps.length >= 2) {
        groups.push({ kind: "steps", sections: steps });
        index = cursor;
        continue;
      }
    }
    if (/^faqs?$/i.test(heading.trim())) {
      const items: ContentSection[] = [];
      let cursor = index + 1;
      while (cursor < sections.length && isQuestionHeading(headingOf(sections[cursor]))) {
        items.push(sections[cursor]);
        cursor += 1;
      }
      if (items.length) {
        groups.push({ kind: "faq", title: sections[index], items });
        index = cursor;
        continue;
      }
    }
    const cards: ContentSection[] = [];
    let cursor = index + 1;
    while (cursor < sections.length && isShortLabel(headingOf(sections[cursor])) && !/^faqs?$/i.test(headingOf(sections[cursor]).trim())) {
      cards.push(sections[cursor]);
      cursor += 1;
    }
    if ((heading.trim().endsWith(":") || isShortLabel(heading)) && cards.length >= 2) {
      groups.push({ kind: "cards", title: sections[index], cards });
      index = cursor;
      continue;
    }
    groups.push({ kind: "single", section: sections[index] });
    index += 1;
  }
  return groups;
}

function placeFields(section: SectionArchitecture, fields: BoundField[], sectionId: string): LayoutNode {
  const headings = fields.filter((field) => field.role === "heading" || field.role === "eyebrow");
  const prose = fields.filter((field) => field.role === "paragraph" || field.role === "list" || field.role === "caption");
  const cards = fields.filter((field) => field.role === "card");
  const faqs = fields.filter((field) => field.role === "faq");
  const quotes = fields.filter((field) => field.role === "quote");
  const ctas = fields.filter((field) => field.role === "cta");
  const width = section.containerWidth || (section.composition === "stack" ? 760 : 1120);
  const gap = section.gap || (section.composition === "repeated" ? 16 : 28);
  const surface = resolvedSurface(section);
  const children: LayoutNode[] = [];
  const slotId = section.media.classification === "generate" && section.media.position !== "none" ? `img-${sectionId}` : null;

  const headingGroup = node({
    id: `${section.id}-headings`,
    kind: "heading-group",
    display: "block",
    expectedChildren: null,
    columns: null,
    gap: 8,
    align: section.headingAlign,
    width,
    fullWidth: false,
    surface,
    separator: section.separator,
    fieldIds: headings.map((field) => field.id),
    assetSlotId: null,
    children: [],
  });
  const contentGroup = node({
    id: `${sectionId}-copy`,
    kind: "content-group",
    display: "block",
    expectedChildren: null,
    columns: null,
    gap: 12,
    align: section.align === "unknown" ? section.headingAlign : section.align,
    width: width,
    fullWidth: false,
    surface,
    separator: section.separator,
    fieldIds: prose.map((field) => field.id),
    assetSlotId: null,
    children: [],
  });
  const ctaGroup = node({
    id: `${section.id}-ctas`,
    kind: "cta-group",
    display: "flex",
    expectedChildren: ctas.length || null,
    columns: null,
    gap: 12,
    align: "start",
    width,
    fullWidth: false,
    surface,
    separator: section.separator,
    fieldIds: ctas.map((field) => field.id),
    assetSlotId: null,
    children: [],
  });

  if (section.composition === "columns" && section.columns.length >= 2) {
    const template = section.columns.map((column) => `${Math.max(column.fraction, 0.15)}fr`).join(" ");
    const hasMedia = section.columns.some((column) => column.role === "media");
    const leading = [headingGroup, ...(ctas.length ? [ctaGroup] : [])].map((child) => ({ ...child, width: null }));
    const trailing = [contentGroup].map((child) => ({ ...child, width: null }));
    const together = [headingGroup, contentGroup, ...(ctas.length ? [ctaGroup] : [])].map((child) => ({ ...child, width: null }));
    let contentPlaced = false;
    const columnNodes = section.columns.map((column, index) => {
      const isMedia = column.role === "media" || (!hasMedia && index === section.columns.length - 1 && Boolean(slotId));
      const children = isMedia
        ? []
        : hasMedia
          ? (contentPlaced ? [] : together)
          : index === 0
            ? leading
            : index === 1
              ? trailing
              : [];
      if (!isMedia && children.length) contentPlaced = true;
      return node({
        id: column.id,
        kind: "column",
        display: "block",
        expectedChildren: null,
        columns: null,
        gap: 12,
        align: "start",
        width: null,
        fullWidth: false,
        surface,
        separator: section.separator,
        fieldIds: [],
        assetSlotId: isMedia ? slotId : null,
        children,
      });
    });
    const mediaColumn = columnNodes.find((column) => column.assetSlotId);
    if (!mediaColumn && slotId) {
      const empty = columnNodes.find((column) => column.children.length === 0) || columnNodes[columnNodes.length - 1];
      if (empty.children.length === 0) empty.assetSlotId = slotId;
    }
    const contentColumn = columnNodes.find((column) => column.children.length > 0);
    if (!contentColumn && columnNodes[0]) columnNodes[0].children = together;
    children.push(node({
      id: `${sectionId}-cols`,
      kind: "columns",
      display: "grid",
      expectedChildren: columnNodes.length,
      columns: template,
      gap,
      align: "center",
      width,
      fullWidth: Boolean(section.fullWidth),
      surface,
      separator: section.separator,
      fieldIds: [],
      assetSlotId: null,
      children: columnNodes,
    }));
  } else if (section.composition === "repeated") {
    if (headings.length || prose.length) {
      children.push(headingGroup, contentGroup);
    }
    const items = (cards.length ? cards : quotes.length ? quotes : faqs).map((field) => node({
      id: `${section.id}-item-${field.id}`,
      kind: field.role === "faq" ? "faq" : "item",
      display: "block",
      expectedChildren: null,
      columns: null,
      gap: null,
      align: "start",
      width: null,
      fullWidth: false,
      surface,
      separator: section.separator,
      fieldIds: [field.id],
      assetSlotId: null,
      children: [],
    }));
    const columns = Math.max(1, Math.min(section.repeated?.columns || items.length || 1, items.length || 1));
    children.push(node({
      id: `${sectionId}-grid`,
      kind: "repeated",
      display: "grid",
      expectedChildren: items.length,
      columns: `repeat(${columns}, minmax(0, 1fr))`,
      gap: section.repeated?.gap || gap,
      align: "stretch",
      width,
      fullWidth: Boolean(section.fullWidth),
      surface,
      separator: section.separator,
      fieldIds: [],
      assetSlotId: null,
      children: items,
    }));
    if (ctas.length) children.push(ctaGroup);
  } else if (section.composition === "media-band") {
    if (section.media.classification === "generate") {
      children.push(node({
        id: `${section.id}-band`,
        kind: "media",
        display: "block",
        expectedChildren: null,
        columns: null,
        gap: null,
        align: "center",
        width: null,
        fullWidth: true,
        surface: "media",
        separator: section.separator,
        fieldIds: [],
        assetSlotId: slotId,
        children: [],
      }));
    }
    children.push(headingGroup, contentGroup);
    if (ctas.length) children.push(ctaGroup);
  } else {
    children.push(headingGroup, contentGroup);
    if (faqs.length) {
      children.push(node({
        id: `${section.id}-faqs`,
        kind: "faq",
        display: "block",
        expectedChildren: null,
        columns: null,
        gap: 0,
        align: "start",
        width,
        fullWidth: false,
        surface,
        separator: section.separator,
        fieldIds: faqs.map((field) => field.id),
        assetSlotId: null,
        children: [],
      }));
    }
    if (quotes.length) {
      children.push(node({
        id: `${section.id}-quotes`,
        kind: "quote",
        display: "block",
        expectedChildren: null,
        columns: null,
        gap: 16,
        align: "start",
        width,
        fullWidth: false,
        surface,
        separator: section.separator,
        fieldIds: quotes.map((field) => field.id),
        assetSlotId: null,
        children: [],
      }));
    }
    if (section.media.classification === "generate" && section.media.position !== "none") {
      children.push(node({
        id: `${section.id}-media`,
        kind: "media",
        display: "block",
        expectedChildren: null,
        columns: null,
        gap: null,
        align: "start",
        width,
        fullWidth: false,
        surface,
        separator: section.separator,
        fieldIds: [],
        assetSlotId: slotId,
        children: [],
      }));
    }
    if (ctas.length) children.push(ctaGroup);
  }

  return node({
    id: sectionId,
    kind: "section",
    display: "block",
    expectedChildren: null,
    columns: null,
    gap,
    align: section.align === "unknown" ? null : section.align,
    width,
    fullWidth: Boolean(section.fullWidth),
    surface,
    separator: section.separator,
    fieldIds: fields.map((field) => field.id),
    assetSlotId: null,
    children,
  });
}

function fallbackBand(id: string, composition: SectionArchitecture["composition"]): SectionArchitecture {
  return {
    id,
    order: 0,
    source: `Captured competitor heading group “${id}”.`,
    bounds: null,
    cropRef: null,
    composition,
    compositionConfidence: "observed",
    fullWidth: composition === "media-band",
    containerWidth: composition === "stack" ? 760 : 1120,
    align: "start",
    gap: 28,
    paddingY: 56,
    columns: [],
    repeated: composition === "repeated" ? { kind: "cards", columns: 3, gap: 28, bordered: false, radius: 0, confidence: "observed" } : null,
    media: { position: composition === "media-band" ? "background" : "none", aspect: 1.7, focal: "center", classification: "none", confidence: "observed" },
    heading: null,
    headingAlign: "start",
    textMeasure: 640,
    backgroundRole: composition === "media-band" ? "contrast" : "page",
    paint: composition === "media-band" ? "rgb(18, 18, 18)" : "rgb(255, 255, 255)",
    separator: "whitespace",
    radius: 0,
    interactions: [],
    responsive: { stacks: true, source: "Captured heading group." },
  };
}

function shell(id: string, composition: SectionArchitecture["composition"], surface: string, children: LayoutNode[], fieldIds: string[]): LayoutNode {
  return {
    id,
    kind: "section",
    display: "block",
    expectedChildren: null,
    columns: null,
    gap: 28,
    align: "start",
    width: 1120,
    fullWidth: composition === "media-band",
    surface,
    separator: "whitespace",
    fieldIds,
    assetSlotId: null,
    children,
  };
}

export function buildLayoutSpec(
  snapshot: CanonicalContent,
  evidence: PageLayoutEvidence | null | undefined,
  clientHref: (value: string | null | undefined) => string | null,
  headingHints: Array<{ id: string; heading?: string | null }> = [],
): LayoutSpec {
  const blockers: string[] = [];
  const notes: string[] = [];
  const included = snapshot.sections.filter((section) => section.decision !== "omit" && section.decision !== "needs_input");
  if (!evidence || evidence.incomplete) {
    blockers.push("Competitor layout measurements are incomplete. Design will not invent an architecture from section-purpose summaries.");
  }
  const hintOf = new Map(headingHints.map((hint) => [hint.id, (hint.heading || "").replace(/\s+/g, " ").trim()]));
  const canGroup = included.some((section) => hintOf.has(section.competitorSectionId || ""));
  const groups = canGroup
    ? groupByCompetitorHeadings(included, (section) => hintOf.get(section.competitorSectionId || "") || "")
    : included.map((section) => ({ kind: "single" as const, section }));
  const sections = [];
  const imageSlots: LayoutSpec["imageSlots"] = [];

  const pushMeasured = (section: ContentSection) => {
    const measured = evidence?.sections.find((item) => item.id === section.competitorSectionId);
    if (!measured || measured.composition === "unknown") {
      blockers.push(`Section ${section.id} has no measured architecture. It was not mapped to a generic split.`);
      return;
    }
    const bound = fieldsForSection(section, clientHref);
    blockers.push(...bound.blockers);
    notes.push(...bound.notes);
    notes.push(`Section ${section.id} uses ${measured.composition} from ${measured.source}`);
    const tree = placeFields(measured, bound.fields, section.id);
    const slot = findSlot(tree);
    if (slot) imageSlots.push({ id: slot, sectionId: section.id, aspect: measured.media.aspect, purpose: section.purpose });
    sections.push({
      id: section.id,
      composition: measured.composition,
      source: measured.source,
      nodes: tree,
      fields: bound.fields,
      aspect: measured.media.aspect,
    });
  };

  for (const group of groups) {
    if (group.kind === "single") {
      pushMeasured(group.section);
      continue;
    }
    const members = group.kind === "hero" || group.kind === "steps"
      ? group.sections
      : group.kind === "cards"
        ? [group.title, ...group.cards]
        : [group.title, ...group.items];
    const bound = members.map((section) => fieldsForSection(section, clientHref));
    for (const item of bound) {
      blockers.push(...item.blockers);
      notes.push(...item.notes);
    }
    const fields = bound.flatMap((item) => item.fields);
    const composition = group.kind === "hero" ? "media-band" : group.kind === "faq" ? "stack" : "repeated";
    const surface = group.kind === "hero" ? "contrast" : "page";
    const band = fallbackBand(members[0].id, composition);
    const children: LayoutNode[] = [];
    if (group.kind === "hero") {
      children.push({
        id: `${members[0].id}-hero`,
        kind: "hero",
        display: "block",
        expectedChildren: null,
        columns: null,
        gap: 12,
        align: "start",
        width: 720,
        fullWidth: true,
        surface,
        separator: "whitespace",
        fieldIds: fields.map((field) => field.id),
        assetSlotId: null,
        children: [],
      });
      notes.push(`Hero uses captured headings “${hintOf.get(members[0].competitorSectionId || "") || members[0].id}” and the following headline section. Approved copy was not rewritten.`);
    } else if (group.kind === "steps") {
      children.push({
        id: `${members[0].id}-steps`,
        kind: "steps",
        display: "grid",
        expectedChildren: members.length,
        columns: `repeat(${members.length},minmax(0,1fr))`,
        gap: 28,
        align: "start",
        width: 1120,
        fullWidth: false,
        surface,
        separator: "whitespace",
        fieldIds: [],
        assetSlotId: null,
        children: members.map((section, step) => ({
          id: `${section.id}-step`,
          kind: "item",
          display: "block",
          expectedChildren: null,
          columns: null,
          gap: null,
          align: "start",
          width: null,
          fullWidth: false,
          surface,
          separator: "whitespace",
          fieldIds: bound[step].fields.map((field) => field.id),
          assetSlotId: null,
          children: [],
        })),
      });
      notes.push("Numbered competitor headings were kept as a step row.");
    } else if (group.kind === "cards") {
      children.push({
        id: `${group.title.id}-title`,
        kind: "heading-group",
        display: "block",
        expectedChildren: null,
        columns: null,
        gap: 8,
        align: "start",
        width: 1120,
        fullWidth: false,
        surface,
        separator: "whitespace",
        fieldIds: bound[0].fields.map((field) => field.id),
        assetSlotId: null,
        children: [],
      });
      children.push({
        id: `${group.title.id}-cards`,
        kind: "cards",
        display: "grid",
        expectedChildren: group.cards.length,
        columns: `repeat(${Math.min(group.cards.length, 3)},minmax(0,1fr))`,
        gap: 32,
        align: "start",
        width: 1120,
        fullWidth: false,
        surface,
        separator: "whitespace",
        fieldIds: [],
        assetSlotId: null,
        children: group.cards.map((section, card) => ({
          id: `${section.id}-card`,
          kind: "item",
          display: "block",
          expectedChildren: null,
          columns: null,
          gap: null,
          align: "start",
          width: null,
          fullWidth: false,
          surface,
          separator: "whitespace",
          fieldIds: bound[card + 1].fields.map((field) => field.id),
          assetSlotId: null,
          children: [],
        })),
      });
      notes.push("Short captured product headings were kept as a card row, not stacked paragraphs.");
    } else {
      children.push({
        id: `${group.title.id}-faq-title`,
        kind: "heading-group",
        display: "block",
        expectedChildren: null,
        columns: null,
        gap: 8,
        align: "start",
        width: 760,
        fullWidth: false,
        surface,
        separator: "whitespace",
        fieldIds: bound[0].fields.filter((field) => field.role === "heading").map((field) => field.id),
        assetSlotId: null,
        children: [],
      });
      children.push({
        id: `${group.title.id}-faqs`,
        kind: "faq",
        display: "block",
        expectedChildren: group.items.length,
        columns: null,
        gap: 0,
        align: "start",
        width: 760,
        fullWidth: false,
        surface,
        separator: "whitespace",
        fieldIds: [],
        assetSlotId: null,
        children: group.items.map((section, item) => ({
          id: `${section.id}-q`,
          kind: "item",
          display: "block",
          expectedChildren: null,
          columns: null,
          gap: null,
          align: "start",
          width: null,
          fullWidth: false,
          surface,
          separator: "whitespace",
          fieldIds: bound[item + 1].fields.map((field) => field.id),
          assetSlotId: null,
          children: [],
        })),
      });
      notes.push("Question headings under the FAQ label were kept as an accordion.");
    }
    sections.push({
      id: members[0].id,
      composition,
      source: band.source,
      nodes: shell(members[0].id, composition, surface, children, fields.map((field) => field.id)),
      fields,
      aspect: group.kind === "hero" ? 1.7 : null,
    });
  }
  return { sections, imageSlots, blockers, notes };
}

function findSlot(tree: LayoutNode): string | null {
  if (tree.assetSlotId) return tree.assetSlotId;
  for (const child of tree.children) {
    const found = findSlot(child);
    if (found) return found;
  }
  return null;
}
