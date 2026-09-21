import assert from "node:assert/strict";
import { test } from "node:test";
import { constructLandingPage } from "../src/lib/pipeline/design/constructPage";
import { alignLayoutEvidence, architectureFromProbe, type PageLayoutEvidence, type ProbeBand, type SectionArchitecture } from "../src/lib/pipeline/design/layoutEvidence";
import { designTokens } from "../src/lib/pipeline/design/tokens";
import { packagePortableHtml } from "../src/lib/pipeline/design/packageHtml";
import { stripDraftBanner } from "../src/lib/pipeline/stripDraftBanner";
import type { CanonicalContent, CompetitorReference } from "../src/lib/pipeline/content/model";
import type { BrandColors } from "../src/lib/types";

const colors: BrandColors = {
  primary: "#112233",
  secondary: "#ffffff",
  accent: "#884400",
  background: "#f4f1ea",
  text: "#1a1a1a",
};

const competitor: CompetitorReference = {
  sourceUrl: "https://rival.example/work/",
  retrievedAt: "2026-09-17T00:00:00.000Z",
  name: "Rival Agency",
  host: "rival.example",
  sections: [],
};

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function band(extra: Partial<ProbeBand> = {}): ProbeBand {
  return {
    box: { x: 0, y: 0, width: 1440, height: 500 },
    background: "rgb(255, 255, 255)",
    pageBackground: "rgb(255, 255, 255)",
    textAlign: "left",
    paddingY: 48,
    gap: 24,
    containerWidth: 720,
    fullWidth: false,
    columnWidths: [],
    columnRoles: [],
    repeatedCount: 0,
    repeatedColumns: 0,
    repeatedGap: null,
    repeatedBordered: false,
    repeatedRadius: null,
    mediaPosition: "none",
    mediaAspect: null,
    heading: null,
    headingAlign: "start",
    textMeasure: 640,
    separator: "whitespace",
    interactions: [],
    ...extra,
  };
}

function architecture(id: string, composition: SectionArchitecture["composition"], extra: Partial<SectionArchitecture> = {}): SectionArchitecture {
  return {
    id,
    order: 0,
    source: `measured ${composition}`,
    bounds: { x: 0, y: 0, width: 1440, height: 560 },
    cropRef: `${id}.jpg`,
    composition,
    compositionConfidence: "observed",
    fullWidth: composition === "media-band",
    containerWidth: composition === "stack" ? 720 : 1180,
    align: composition === "stack" ? "start" : "center",
    gap: composition === "repeated" ? 12 : 48,
    paddingY: composition === "stack" ? 72 : 40,
    columns: composition === "columns"
      ? [
          { id: `${id}-a`, fraction: 0.42, role: "content", componentIds: ["copy"], confidence: "observed" },
          { id: `${id}-b`, fraction: 0.58, role: "media", componentIds: [], confidence: "observed" },
        ]
      : [],
    repeated: composition === "repeated"
      ? { kind: "cards", columns: 3, gap: 12, bordered: true, radius: 0, confidence: "observed" }
      : null,
    media: composition === "stack"
      ? { position: "none", aspect: null, focal: "unknown", classification: "none", confidence: "observed" }
      : { position: composition === "media-band" ? "background" : "right", aspect: 1.5, focal: "center", classification: "generate", confidence: "observed" },
    headingAlign: composition === "stack" ? "start" : "center",
    textMeasure: composition === "stack" ? 640 : 460,
    backgroundRole: composition === "media-band" ? "contrast" : "page",
    separator: composition === "stack" ? "whitespace" : composition === "repeated" ? "border" : "background",
    radius: null,
    interactions: [],
    responsive: { stacks: true, source: "mobile measurement" },
    ...extra,
  };
}

function evidence(sections: SectionArchitecture[]): PageLayoutEvidence {
  return {
    version: 1,
    captureId: "arch",
    sourceUrl: competitor.sourceUrl,
    viewport: { name: "desktop", width: 1440, height: 900 },
    header: { arrangement: "split", confidence: "observed", source: "header" },
    footer: { arrangement: "stacked", groups: 2, confidence: "observed" },
    sections,
    incomplete: false,
    gaps: [],
  };
}

function page(sections: CanonicalContent["sections"]): CanonicalContent {
  return {
    draftId: "draft-arch",
    revision: 1,
    evidenceVersion: 2,
    clientUrl: "https://client.example/",
    clientName: "Northwind Studio",
    competitorUrl: competitor.sourceUrl,
    competitorName: competitor.name,
    serviceContext: "brand design",
    audienceContext: null,
    meta: { title: "Northwind", description: "Approved" },
    sections,
    issues: [],
    approved: true,
    approvedAt: "2026-09-17T00:00:00.000Z",
    approvedRevision: 1,
  };
}

function offer(id: string, competitorSectionId: string, heading: string, paragraph: string) {
  return {
    id,
    decision: "adapt" as const,
    decisionReason: "matched",
    purpose: "offer",
    competitorSectionId,
    heading,
    paragraphs: [paragraph],
    items: [],
    evidenceIds: [],
    locked: false,
    issues: [],
    fields: [
      { id: `${id}-h`, sourceComponentId: `${id}-n1`, kind: "headline", text: heading, items: [], disposition: "adapt" as const, reason: null },
      { id: `${id}-p`, sourceComponentId: `${id}-n2`, kind: "paragraph", text: paragraph, items: [], disposition: "adapt" as const, reason: null },
    ],
  };
}

async function build(sections: CanonicalContent["sections"], layout: PageLayoutEvidence, fontFamily?: string) {
  return constructLandingPage({
    snapshot: page(sections),
    competitor,
    layoutEvidence: layout,
    colors,
    competitorId: "arch",
    keyword: "brand design",
    fontFamily,
    hasImageKey: () => true,
    generateImage: async () => ({ buffer: png, taskId: "task" }),
  });
}

test("fewer measured bands are shared with captured sections instead of blocking", () => {
  const measured = architectureFromProbe({
    viewport: { width: 1440, height: 900 },
    pageBackground: "rgb(255,255,255)",
    headerArrangement: "split",
    footerArrangement: "stacked",
    footerGroups: 1,
    mobileStacks: null,
    gaps: [],
    bands: [
      band({ heading: "SEO Agency Australia", columnWidths: [700], columnRoles: ["content"] }),
      band({ heading: "FAQs", columnWidths: [700], columnRoles: ["content"] }),
    ],
  }, competitor.sourceUrl);
  const aligned = alignLayoutEvidence(measured, ["sec-2", "sec-3", "sec-16", "sec-17"], [
    { id: "sec-2", heading: "SEO Agency Australia" },
    { id: "sec-3", heading: "When it comes to ranking on Google" },
    { id: "sec-16", heading: "FAQs" },
    { id: "sec-17", heading: "Is it worth investing into an external SEO team?" },
  ]);
  assert.equal(aligned.incomplete, false);
  assert.equal(aligned.sections.length, 4);
  assert.equal(aligned.sections.every((section) => section.composition === "stack"), true);
  assert.equal(aligned.sections.some((section) => section.composition === "columns"), false);
});

test("a measured probe does not turn one wrapper into a two-column section", () => {
  const layout = architectureFromProbe({
    viewport: { width: 1440, height: 900 },
    pageBackground: "rgb(255,255,255)",
    headerArrangement: "split",
    footerArrangement: "stacked",
    footerGroups: 1,
    mobileStacks: null,
    gaps: [],
    bands: [band({ columnWidths: [680], columnRoles: ["content"] })],
  }, competitor.sourceUrl);
  assert.equal(layout.sections[0].composition, "stack");
  assert.equal(layout.sections.some((section) => section.composition === "columns"), false);
});

test("editorial, card, and media-led references keep different structures under the same brand", async () => {
  const copy = [
    offer("a", "ref", "Same heading", "A short approved paragraph that must stay in this section only."),
    offer("b", "cards", "Same heading", "A different approved paragraph that must not be matched by the shared heading."),
  ];
  const editorial = await build(
    [copy[0]],
    evidence([architecture("ref", "stack", { containerWidth: 720, separator: "whitespace", backgroundRole: "page" })]),
  );
  const cards = await build(
    [{
      ...offer("cards", "cards", "Services", "Intro"),
      fields: [
        { id: "cards-h", sourceComponentId: "b-n1", kind: "headline", text: "Services", items: [], disposition: "adapt", reason: null },
        { id: "card-1", sourceComponentId: "c1", kind: "card", text: "Identity", items: ["One offer."], disposition: "adapt", reason: null },
        { id: "card-2", sourceComponentId: "c2", kind: "card", text: "Sites", items: ["Another offer."], disposition: "adapt", reason: null },
      ],
    }],
    evidence([architecture("cards", "repeated")]),
  );
  const media = await build([copy[0]], evidence([architecture("ref", "columns")]));
  assert.equal(editorial.blockers.length, 0, editorial.blockers.join("\n"));
  assert.equal(media.blockers.length, 0, media.blockers.join("\n"));
  assert.equal(cards.blockers.length, 0, cards.blockers.join("\n"));
  assert.match(editorial.html, /data-composition="stack"/);
  assert.match(cards.html, /data-composition="repeated"/);
  assert.match(media.html, /data-composition="columns"/);
  assert.equal(editorial.html.includes("data-display=\"grid\""), false);
  assert.match(media.html, /data-display="grid" data-expected-children="2"/);
  assert.match(cards.html, /data-expected-children="2"/);
  assert.match(media.html, /--cols:0.42fr 0.58fr/);
  assert.match(editorial.html, /--container:720px/);
  assert.equal(editorial.html.includes("data-composition=\"columns\""), false);
  assert.equal(media.html.includes("adr-split"), false);
});

test("similar headings stay bound to their own fields", async () => {
  const built = await build(
    [
      offer("one", "one", "Shared title", "First section body stays with one-p."),
      offer("two", "two", "Shared title", "Second section body stays with two-p."),
    ],
    evidence([
      architecture("one", "stack"),
      architecture("two", "stack", { separator: "border", containerWidth: 680 }),
    ]),
  );
  assert.equal(built.blockers.length, 0, built.blockers.join("\n"));
  const firstAt = built.html.indexOf('class="adr-section" data-section-id="one"');
  const secondAt = built.html.indexOf('class="adr-section" data-section-id="two"');
  const first = built.html.slice(firstAt, secondAt);
  const second = built.html.slice(secondAt);
  assert.match(first, /data-field-id="one-p"/);
  assert.equal(first.includes("data-field-id=\"two-p\""), false);
  assert.match(second, /data-field-id="two-p"/);
  assert.equal(second.includes("data-field-id=\"one-p\""), false);
});

test("a heading that reads as a paragraph is rendered as copy, not a giant title", async () => {
  const built = await build(
    [{
      ...offer("one", "one", "Short", "Ignored."),
      fields: [{
        id: "blob",
        sourceComponentId: "blob",
        kind: "headline",
        text: "This approved field was stored as a heading even though it is a full body paragraph with far too many words to be a title on the page.",
        items: [],
        disposition: "adapt",
        reason: null,
      }],
    }],
    evidence([architecture("one", "stack")]),
  );
  assert.equal(built.blockers.some((item) => /blob/.test(item)), false);
  assert.equal(built.html.includes("<h1 data-field-id=\"blob\""), false);
  assert.match(built.html, /data-field-id="blob"[^>]*>/);
  assert.match(built.html, /<p data-field-id="blob"/);
});

test("an FAQ answer stored as the question is not quietly swapped", async () => {
  const built = await build(
    [{
      ...offer("faq", "faq", "Questions", "Ask us."),
      items: [{
        id: "bad-faq",
        kind: "faq",
        label: "Most projects take six weeks of work.",
        detail: "How long does it take?",
        evidenceIds: [],
      }],
    }],
    evidence([architecture("faq", "stack")]),
  );
  assert.equal(built.blockers.some((item) => /FAQ bad-faq/.test(item)), true);
});

test("ambiguous logos are not guessed from the first site image", async () => {
  const built = await constructLandingPage({
    snapshot: page([offer("one", "one", "Hello", "A short approved paragraph for the page.")]),
    competitor,
    layoutEvidence: evidence([architecture("one", "stack")]),
    colors,
    competitorId: "arch",
    keyword: "brand design",
    hasImageKey: () => true,
    generateImage: async () => ({ buffer: png, taskId: "task" }),
    assets: {
      finalUrl: "https://client.example/",
      siteName: "Northwind",
      logoUrl: null,
      faviconUrl: "https://client.example/favicon.ico",
      ogImageUrl: null,
      navLinks: [],
      footerLinks: [],
      socialLinks: [],
      images: [
        { src: "https://client.example/logo-a.svg", kind: "logo" },
        { src: "https://client.example/logo-b.svg", kind: "logo" },
        { src: "https://client.example/team.jpg", kind: "hero" },
      ],
      emails: [],
      phones: [],
    },
  });
  assert.equal(built.blockers.some((item) => /ambiguous/i.test(item)), true);
  assert.equal(built.html.includes("team.jpg"), false);
  assert.equal(built.html.includes("logo-a.svg"), false);
});

test("dark brand surfaces do not keep black text", () => {
  const tokens = designTokens({ ...colors, background: "#111111", text: "#000000", primary: "#0b0b0b" }, null);
  assert.equal(tokens.ink.toLowerCase(), "#f6f5f2");
  assert.notEqual(tokens.primaryInk.toLowerCase(), "#000000");
});

test("missing fonts are declared as fallbacks, and export rejects unresolved pages", async () => {
  const built = await build(
    [offer("one", "one", "Hello", "A short approved paragraph for the page.")],
    evidence([architecture("one", "stack")]),
    "Northwind Sans",
  );
  assert.equal(built.blockers.length, 0, built.blockers.join("\n"));
  assert.equal(built.notes.some((note) => /fallback/i.test(note)), true);
  assert.match(built.html, /Northwind Sans/);
  assert.match(built.html, /prefers-reduced-motion/);
  assert.match(built.html, /if \(toggle && nav\)/);
  assert.equal(/opacity\s*:\s*0/.test(built.html), false);
  const packaged = packagePortableHtml(stripDraftBanner(built.html));
  assert.equal(packaged.html.includes('data-field-id="one-p"'), true);
  assert.equal(packaged.external.some((url) => url.includes("/generated/")), false);
});

test("incomplete capture is not replaced with a universal template", async () => {
  const built = await constructLandingPage({
    snapshot: page([offer("one", "one", "Hello", "A short approved paragraph for the page.")]),
    competitor,
    colors,
    competitorId: "arch",
    keyword: "brand design",
    hasImageKey: () => true,
    generateImage: async () => ({ buffer: png, taskId: "unused" }),
  });
  assert.equal(built.html, "");
  assert.equal(built.blockers.some((item) => /not invent/i.test(item)), true);
  assert.equal(built.images.length, 0);
});
