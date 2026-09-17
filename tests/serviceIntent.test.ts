import assert from "node:assert/strict";
import test from "node:test";
import { draftPrompt, writingBrief } from "../src/lib/pipeline/content/generate";
import { fidelityIssues } from "../src/lib/pipeline/content/fidelity";
import { inferPageIntent, isExtractedSource, isPurposeSummary, PROMPT_VERSION, withClientMatch } from "../src/lib/pipeline/content/pageIntent";
import { planSections } from "../src/lib/pipeline/content/plan";
import { selectResearchUrls } from "../src/lib/pipeline/content/research";
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

test("homepage positioning cannot override the competitor service in the brief", () => {
  const client = evidence([
    fact("ev-name", "identity", "Click Trends"),
    fact("ev-home", "service", "Click Trends is an AI-powered marketing agency covering SEO, Meta Ads, email, and web development."),
    fact("ev-ads", "service", "Click Trends manages Google Ads for independent Australian firms."),
  ]);
  const intent = withClientMatch(inferPageIntent(googleAds), client);
  const brief = JSON.stringify(writingBrief(client, intent));
  assert.match(brief, /google ads/i);
  assert.equal(/ai-powered marketing/i.test(brief), false);
  assert.equal(brief.includes("$99"), false);
  const prompt = draftPrompt({ evidence: client, competitor: googleAds, intent });
  assert.match(prompt, /Sell Google Ads/i);
  assert.equal(prompt.includes("Write original client copy from clientFacts only."), false);
});

test("research prefers a matching service page over the homepage", () => {
  const urls = selectResearchUrls(
    ["https://client.example/", "https://client.example/google-ads", "https://client.example/seo"],
    "https://client.example/",
    3,
    ["google", "ads"],
  );
  assert.equal(urls[0], "https://client.example/");
  assert.ok(urls.indexOf("https://client.example/google-ads") < urls.indexOf("https://client.example/seo"));
});

test("a homepage-style draft fails service fidelity and a focused draft does not invent the competitor price", () => {
  const client = evidence([
    fact("ev-name", "identity", "Click Trends"),
    fact("ev-home", "positioning", "AI-powered marketing for every channel."),
    fact("ev-ads", "service", "Click Trends manages Google Ads for independent Australian firms."),
  ]);
  const intent = withClientMatch(inferPageIntent(googleAds), client);
  const drifted = fidelityIssues({
    draftId: "d",
    revision: 1,
    evidenceVersion: 2,
    clientUrl: "https://client.example",
    clientName: "Click Trends",
    competitorUrl: googleAds.sourceUrl,
    competitorName: googleAds.name,
    serviceContext: intent.primaryService,
    audienceContext: null,
    meta: { title: "Click Trends", description: "" },
    sections: [
      draftSection("sec-1", "Supercharge your growth with AI-powered marketing", ["We cover SEO, Meta Ads, email, and web development."]),
      draftSection("sec-2", "Book your free AI marketing consultation", ["Talk to us about the whole marketing ecosystem."]),
    ],
    issues: [],
    approved: false,
    approvedAt: null,
    approvedRevision: null,
  }, client, googleAds, intent);
  assert.ok(drifted.some((item) => item.field === "service-fidelity" || item.field === "topic-drift"));
  const focused = fidelityIssues({
    draftId: "d",
    revision: 1,
    evidenceVersion: 2,
    clientUrl: "https://client.example",
    clientName: "Click Trends",
    competitorUrl: googleAds.sourceUrl,
    competitorName: googleAds.name,
    serviceContext: intent.primaryService,
    audienceContext: null,
    meta: { title: "Click Trends Google Ads", description: "" },
    sections: [
      draftSection("sec-1", "Google Ads management for independent firms", ["Click Trends manages Google Ads for independent Australian firms."]),
      draftSection("sec-2", "Book a Google Ads activation call", ["Start a Google Ads conversation. The activation price is $99 this week only."]),
    ],
    issues: [],
    approved: false,
    approvedAt: null,
    approvedRevision: null,
  }, client, googleAds, intent);
  assert.equal(focused.some((item) => item.field === "service-fidelity"), false);
  assert.ok(focused.some((item) => item.field === "offer-terms"));
});

test("a missing client service is flagged instead of switching topics", () => {
  const client = evidence([
    fact("ev-name", "identity", "Harbour Dental"),
    fact("ev-other", "service", "Harbour Dental provides teeth whitening and general checkups."),
  ], "Harbour Dental");
  const implants = inferPageIntent(competitor([
    section("src-1", "Dental implants", "Dental implants for missing teeth.", "Present implants", 0),
  ]));
  const intent = withClientMatch(implants, client);
  assert.equal(intent.clientMatch, "no");
  const plans = planSections(competitor([
    section("src-1", "Dental implants", "Dental implants for missing teeth.", "Present implants", 0),
  ]), client, intent);
  assert.equal(plans[0].decision, "needs_input");
  assert.match(plans[0].reason, /not switched/i);
});

test("a purpose summary is not labeled as extracted page text", () => {
  assert.equal(isPurposeSummary("Encourages visitors to book an activation call."), true);
  assert.equal(isExtractedSource({ textKind: "summary", sourceText: "Promotes a special offer to new visitors." }), false);
  assert.equal(isExtractedSource({ textKind: "source", sourceText: "Encourages visitors to book an activation call." }), false);
  assert.equal(isExtractedSource({ textKind: "source", sourceText: "Book a free activation call today." }), true);
});

test("section regeneration prompt keeps the locked service brief", () => {
  const client = evidence([fact("ev-ads", "service", "Click Trends manages Google Ads for independent Australian firms.")]);
  const intent = withClientMatch(inferPageIntent(googleAds), client);
  const prompt = draftPrompt({
    evidence: client,
    competitor: googleAds,
    intent,
    feedback: "Rewrite only competitor section src-2.",
  });
  assert.match(prompt, /google ads/i);
  assert.match(prompt, /src-2/);
  assert.equal(prompt.includes("untrustedSourceText"), false);
});
