import assert from "node:assert/strict";
import test from "node:test";
import { assembleDraft, competitorReferenceFromInventory, draftInBatches, fieldBatchErrors, parseDraftModelResult } from "../src/lib/pipeline/content/generate";
import { applyVisionGroups, inventoryFromAnalysisSummaries, inventoryFromBlocks, mergeInventorySections } from "../src/lib/pipeline/content/inventory";
import { classifyRelationship } from "../src/lib/pipeline/content/relationships";
import { captureRenderedInventory } from "../src/lib/pipeline/content/captureInventory";
import { componentPlans } from "../src/lib/pipeline/content/plan";
import { saveCanonical, ContentRevisionError } from "../src/lib/pipeline/content/revisions";
import type { ClientEvidenceRecord, CompetitorReference, ContentPack } from "../src/lib/pipeline/content/model";

function evidence(): ClientEvidenceRecord {
  return {
    version: 2,
    ownerUserId: "owner-a",
    spaceId: "space-a",
    enteredUrl: "https://client.example",
    canonicalUrl: "https://client.example",
    pageKind: "homepage",
    businessName: "Click Trends",
    facts: [
      { id: "ev-1", category: "identity", value: "Click Trends", sourceUrl: "https://client.example", excerpt: "Click Trends", retrievedAt: "2026-09-17T00:00:00.000Z", status: "stated_on_site" },
      { id: "ev-2", category: "service", value: "Click Trends manages Google Ads for independent Australian firms.", sourceUrl: "https://client.example", excerpt: "Click Trends manages Google Ads for independent Australian firms.", retrievedAt: "2026-09-17T00:00:00.000Z", status: "stated_on_site" },
    ],
    pagesRead: [],
    unavailable: [],
    retrievedAt: "2026-09-17T00:00:00.000Z",
    incomplete: false,
    missingEssential: [],
  };
}

test("analysis summaries are not labeled as extracted source text", () => {
  const inventory = inventoryFromAnalysisSummaries({
    sourceUrl: "https://rival.example",
    sections: [{ name: "Hero", purpose: "Introduce the offer", summary: "A short model summary of the hero." }],
  });
  const reference = competitorReferenceFromInventory(inventory, "Rival");
  assert.equal(reference.sections[0].textKind, "summary");
  assert.ok(inventory.gaps.some((gap) => /not captured|analysis summary/i.test(gap)));
});

test("rendered blocks keep adjacent similar headings on their own sections", () => {
  const inventory = inventoryFromBlocks({
    sourceUrl: "https://rival.example",
    finalUrl: "https://rival.example",
    blocks: [
      { tag: "h2", text: "Services" },
      { tag: "p", text: "Our search ads service covers the whole account and landing pages for local firms." },
      { tag: "h2", text: "Service areas" },
      { tag: "p", text: "We work with shops in Melbourne and surrounding suburbs on their ad accounts." },
    ],
  });
  assert.equal(inventory.sections.length, 2);
  assert.match(inventory.sections[0].components.map((item) => item.text).join(" "), /search ads service/);
  assert.doesNotMatch(inventory.sections[0].components.map((item) => item.text).join(" "), /surrounding suburbs/);
});

test("locations and platforms are not media mentions", () => {
  assert.equal(classifyRelationship("Melbourne", "As seen in Melbourne"), "location");
  assert.equal(classifyRelationship("WooCommerce", "We build WooCommerce stores"), "platform");
  assert.equal(classifyRelationship("Facebook", "Follow us on Facebook"), "platform");
  assert.equal(classifyRelationship("Click Trends", "Trusted by Click Trends", "Click Trends"), "identity");
  assert.equal(classifyRelationship("The Age", "As seen in The Age"), "media");
});

test("a model section cannot be assigned to a different section id", () => {
  const competitor: CompetitorReference = {
    sourceUrl: "https://rival.example",
    retrievedAt: "2026-09-17T00:00:00.000Z",
    name: "Rival",
    host: "rival.example",
    sections: [
      { id: "src-1", heading: "Services", purpose: "Describe services", order: 0, sourceText: "Search management for firms.", textKind: "source", sourceUrl: "https://rival.example", cids: [] },
      { id: "src-2", heading: "Service areas", purpose: "Name locations", order: 1, sourceText: "Work in several cities.", textKind: "source", sourceUrl: "https://rival.example", cids: [] },
    ],
  };
  const draft = assembleDraft({
    evidence: evidence(),
    competitor,
    modelName: "test",
    modelResult: {
      meta: { title: "Click Trends", description: "Ads management." },
      sections: [{ competitorSectionId: "src-2", heading: "Where we work", paragraphs: ["We manage ads for firms, not a city list copied from the competitor."], evidenceIds: ["ev-2"] }],
    },
  });
  const first = draft.sections.find((section) => section.competitorSectionId === "src-1");
  assert.equal(first?.paragraphs.some((paragraph) => /city list/.test(paragraph)), false);
});

test("truncated model JSON is not a completed draft", () => {
  assert.throws(() => parseDraftModelResult('{"meta":{"title":"Click Trends"}'), /truncated or invalid|no JSON object/);
});

test("a stale save cannot overwrite a newer revision", () => {
  const draft = assembleDraft({
    evidence: evidence(),
    competitor: {
      sourceUrl: "https://rival.example",
      retrievedAt: "2026-09-17T00:00:00.000Z",
      name: "Rival",
      host: "rival.example",
      sections: [{ id: "src-1", heading: "Hero", purpose: "Introduce the client", order: 0, sourceText: "Intro paragraph for the offer.", textKind: "source", sourceUrl: "https://rival.example", cids: [] }],
    },
    modelName: "test",
    modelResult: { meta: { title: "Click Trends", description: "Ads." }, sections: [] },
  });
  const pack: ContentPack = {
    evidence: evidence(),
    competitor: {
      sourceUrl: "https://rival.example",
      retrievedAt: "2026-09-17T00:00:00.000Z",
      name: "Rival",
      host: "rival.example",
      sections: [],
    },
    canonical: draft,
    approvedSnapshot: null,
    proposal: null,
    previous: null,
    legacy: false,
  };
  const saved = saveCanonical(pack, pack.canonical, pack.canonical.revision);
  assert.throws(() => saveCanonical(saved, pack.canonical, pack.canonical.revision), ContentRevisionError);
});

test("a failed mobile capture is recorded and does not look complete", async () => {
  const inventory = await captureRenderedInventory("https://example.com", {
    open: async (_url, viewport) => {
      if (viewport.width < 500) throw new Error("mobile timed out");
      return {
        finalUrl: "https://example.com",
        blocks: [{ tag: "h1", text: "Example" }, { tag: "p", text: "This is the rendered desktop paragraph used as source text for the page." }],
        gaps: [],
      };
    },
  });
  assert.ok(inventory.gaps.some((gap) => /mobile/i.test(gap)));
  assert.equal(inventory.visionUsed, false);
});

test("an unmatched visual region is not stored as source copy", () => {
  const inventory = inventoryFromBlocks({
    sourceUrl: "https://rival.example",
    finalUrl: "https://rival.example",
    blocks: [
      { tag: "h2", text: "Services" },
      { tag: "p", text: "We manage search campaigns for independent firms across their ad accounts." },
    ],
  });
  const reconciled = applyVisionGroups({ ...inventory, visionUsed: false, tiles: [{ id: "t1", viewport: "desktop", path: "tile.jpg", y: 0 }] }, [
    { label: "Services", y: 20 },
    { label: "Hidden promo that was not in the DOM", y: 800 },
  ]);
  assert.equal(reconciled.visionUsed, true);
  assert.equal(reconciled.coverage.mapped, 1);
  assert.ok(reconciled.gaps.some((gap) => /not matched to rendered DOM text/.test(gap)));
  assert.equal(reconciled.sections.some((section) => /Hidden promo/.test(section.components.map((item) => item.text).join(" "))), false);
});

test("extra competitor cards are omitted instead of invented", () => {
  const competitor = {
    sourceUrl: "https://rival.example",
    retrievedAt: "2026-09-17T00:00:00.000Z",
    name: "Rival",
    host: "rival.example",
    sections: [{
      id: "src-1",
      heading: "Services",
      purpose: "List services",
      order: 0,
      sourceText: "Four service cards.",
      textKind: "source" as const,
      sourceUrl: "https://rival.example",
      cids: [],
      components: [
        { id: "card-1", kind: "card", text: "Search", items: [] },
        { id: "card-2", kind: "card", text: "Social", items: [] },
        { id: "card-3", kind: "card", text: "Email", items: [] },
      ],
    }],
  };
  const plans = componentPlans(competitor.sections[0], {
    competitorSectionId: "src-1",
    decision: "adapt",
    reason: "Supported",
    purpose: "List services",
    headingHint: "Services",
    allowedCategories: ["service"],
  }, evidence());
  assert.equal(plans.filter((plan) => plan.disposition === "omit").length, 2);
  const draft = assembleDraft({
    evidence: evidence(),
    competitor,
    modelName: "test",
    modelResult: {
      meta: { title: "Click Trends", description: "Ads." },
      sections: [{
        competitorSectionId: "src-1",
        heading: "What we manage",
        paragraphs: ["Click Trends manages Google Ads for independent Australian firms."],
        fields: [
          { id: "card-1", text: "Click Trends manages Google Ads for independent Australian firms." },
          { id: "card-2", omitted: true, reason: "No fourth service." },
          { id: "card-3", omitted: true, reason: "No fourth service." },
        ],
      }],
    },
  });
  const fields = draft.sections[0].fields || [];
  assert.equal(fields.find((field) => field.id === "card-1")?.text.includes("Google Ads"), true);
  assert.equal(fields.filter((field) => field.disposition === "omit").length, 2);
});

test("a missing component id is rejected even when the rest of the JSON is valid", () => {
  const errors = fieldBatchErrors(["card-1", "card-2"], [{ id: "card-1", text: "Search ads." }]);
  assert.ok(errors.some((error) => /card-2/.test(error)));
});

test("a failed later batch keeps the completed section", async () => {
  let calls = 0;
  const result = await draftInBatches({
    evidence: evidence(),
    competitor: {
      sourceUrl: "https://rival.example",
      retrievedAt: "2026-09-17T00:00:00.000Z",
      name: "Rival",
      host: "rival.example",
      sections: [
        { id: "src-1", heading: "Hero", purpose: "Introduce the offer", order: 0, sourceText: "Intro.", textKind: "source", sourceUrl: "https://rival.example", cids: [] },
        { id: "src-2", heading: "Process", purpose: "Explain the process", order: 1, sourceText: "How it works for clients.", textKind: "source", sourceUrl: "https://rival.example", cids: [] },
      ],
    },
    complete: async () => {
      calls += 1;
      if (calls === 1) {
        return { raw: JSON.stringify({ meta: { title: "Click Trends", description: "Ads." }, sections: [{ competitorSectionId: "src-1", heading: "Google Ads help", paragraphs: ["Click Trends manages Google Ads for independent Australian firms."] }] }), model: "mock" };
      }
      return { raw: "{\"meta\":{\"title\":\"Click", model: "mock" };
    },
  });
  const hero = result.canonical.sections.find((section) => section.competitorSectionId === "src-1");
  assert.match(hero?.paragraphs.join(" ") || "", /Google Ads/);
  const second = result.canonical.sections.find((section) => section.competitorSectionId === "src-2");
  assert.equal(second?.paragraphs.some((paragraph) => /Click/.test(paragraph) && /truncated/i.test(paragraph)), false);
});

test("merging sections keeps component ids instead of matching by heading", () => {
  const inventory = inventoryFromBlocks({
    sourceUrl: "https://rival.example",
    finalUrl: "https://rival.example",
    blocks: [
      { tag: "h2", text: "Services" },
      { tag: "p", text: "Search management for the whole account and the landing pages." },
      { tag: "h2", text: "Services" },
      { tag: "p", text: "A second services block about reporting and weekly changes." },
    ],
  });
  const merged = mergeInventorySections(inventory, inventory.sections[0].id, inventory.sections[1].id);
  assert.equal(merged.sections.length, 1);
  assert.equal(merged.sections[0].id, inventory.sections[0].id);
  assert.equal(merged.sections[0].components.some((component) => component.id.startsWith(inventory.sections[1].id)), true);
});

