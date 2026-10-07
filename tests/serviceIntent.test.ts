import assert from "node:assert/strict";
import test from "node:test";
import { inferPageIntent, isExtractedSource, isPurposeSummary, PROMPT_VERSION, withClientMatch } from "../src/lib/pipeline/content/pageIntent";
import type { ClientEvidenceRecord, CompetitorReference, ContentSection } from "../src/lib/pipeline/content/model";

function competitor(sections: CompetitorReference["sections"], name = "Reference"): CompetitorReference {
  return {
    sourceUrl: "https://reference.example/offer",
    retrievedAt: "2026-09-17T00:00:00.000Z",
    name,
    host: "reference.example",
    sections,
  };
}

function section(id: string, heading: string, sourceText: string, purpose: string, order: number): CompetitorReference["sections"][number] {
  return {
    id,
    heading,
    purpose,
    order,
    sourceText,
    textKind: "source",
    sourceUrl: "https://reference.example/offer",
    cids: [],
  };
}

function evidence(facts: ClientEvidenceRecord["facts"], name = "Click Trends"): ClientEvidenceRecord {
  return {
    version: 2,
    ownerUserId: "owner-a",
    spaceId: "space-a",
    enteredUrl: "https://client.example",
    canonicalUrl: "https://client.example",
    pageKind: "homepage",
    businessName: name,
    facts,
    pagesRead: [],
    unavailable: [],
    retrievedAt: "2026-09-17T00:00:00.000Z",
    incomplete: false,
    missingEssential: [],
  };
}

function fact(id: string, category: ClientEvidenceRecord["facts"][number]["category"], value: string): ClientEvidenceRecord["facts"][number] {
  return {
    id,
    category,
    value,
    sourceUrl: "https://client.example",
    excerpt: value,
    retrievedAt: "2026-09-17T00:00:00.000Z",
    status: "stated_on_site",
  };
}

function draftSection(id: string, heading: string, paragraphs: string[]): ContentSection {
  return {
    id,
    decision: "adapt",
    decisionReason: "Supported.",
    purpose: id === "sec-2" ? "Final CTA" : "Sell the service",
    competitorSectionId: id,
    heading,
    paragraphs,
    items: [],
    evidenceIds: ["ev-service"],
    locked: false,
    issues: [],
  };
}

const googleAds = competitor([
  section("src-1", "Google Ads management", "A landing page for Google Ads management with an activation call.", "Present the service offer", 0),
  section("src-2", "Book a free activation call", "Book a free activation call today. First month $99 this week only.", "Close the Google Ads offer", 1),
]);

test("service intent comes from the competitor page, not a hardcoded industry", () => {
  const intent = inferPageIntent(googleAds);
  assert.match(intent.primaryService, /google ads/i);
  assert.equal(intent.promptVersion, PROMPT_VERSION);
  assert.equal(intent.terms.price, "$99");
  assert.equal(intent.offerMode, "proposed");
  const dental = inferPageIntent(competitor([
    section("src-1", "Dental implants", "A page about dental implants for missing teeth.", "Present the treatment", 0),
    section("src-2", "Book an implant consult", "Book an implant consult.", "Close the consult", 1),
  ], "Dental reference"));
  assert.match(dental.primaryService, /dental implants/i);
  const roof = inferPageIntent(competitor([
    section("src-1", "Roof restoration", "Roof restoration for leaking tiled roofs.", "Present restoration", 0),
  ], "Roof reference"));
  assert.match(roof.primaryService, /roof restoration/i);
});

test("a genuine multi-service page is not forced into one service", () => {
  const intent = inferPageIntent(competitor([
    section("src-1", "Plumbing repairs", "Plumbing repairs for burst pipes.", "Plumbing", 0),
    section("src-2", "Electrical rewiring", "Electrical rewiring for older homes.", "Electrical", 1),
    section("src-3", "Heating installation", "Heating installation for winter.", "Heating", 2),
  ]));
  assert.equal(intent.multiService, true);
  assert.match(intent.primaryService, /plumbing repairs/i);
  assert.match(intent.primaryService, /electrical rewiring/i);
});

test("a purpose summary is not labeled as extracted page text", () => {
  assert.equal(isPurposeSummary("Encourages visitors to book an activation call."), true);
  assert.equal(isExtractedSource({ textKind: "summary", sourceText: "Promotes a special offer to new visitors." }), false);
  assert.equal(isExtractedSource({ textKind: "source", sourceText: "Encourages visitors to book an activation call." }), false);
  assert.equal(isExtractedSource({ textKind: "source", sourceText: "Book a free activation call today." }), true);
});

