import assert from "node:assert/strict";
import test from "node:test";
import { applyVisionGroups, inventoryFromAnalysisSummaries, inventoryFromBlocks, mergeInventorySections } from "../src/lib/pipeline/content/inventory";
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

