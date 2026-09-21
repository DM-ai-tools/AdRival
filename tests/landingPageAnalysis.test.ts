import assert from "node:assert/strict";
import { test } from "node:test";
import { inventoryFromLandingOutline, hasUsableCompetitorReference } from "../src/lib/pipeline/content/inventory";
import { looksLikeThinShell } from "../src/lib/pipeline/htmlFetch";
import {
  demashHeadline,
  ensureArchitectureSections,
  extractPageOutline,
  looksLikeMashedHeadline,
  pickBestHeadline,
} from "../src/lib/pipeline/landingPageAnalysis";

test("detects mashed brand+product title strings", () => {
  assert.equal(
    looksLikeMashedHeadline(
      "Billy Polsons Campaign Brain Actual Intelligence X AI Turbocharged",
    ),
    true,
  );
  assert.equal(
    looksLikeMashedHeadline("Your Google Ads agency is about to absolutely HATE this."),
    false,
  );
});

test("demashHeadline prefers promise fragments over brand stacks", () => {
  const out = demashHeadline(
    "Billy Polson | Campaign Brain | Your Google Ads agency is about to absolutely HATE this.",
  );
  assert.match(out, /HATE this/i);
});

test("pickBestHeadline rejects LLM mash and prefers real H1", () => {
  const outline = extractPageOutline(
    `<!doctype html><html><head>
      <title>Billy Polsons Campaign Brain Actual Intelligence X AI Turbocharged</title>
      <meta property="og:title" content="Billy Polsons Campaign Brain Actual Intelligence X AI Turbocharged"/>
    </head><body>
      <h1>Your Google Ads agency is about to absolutely HATE this.</h1>
      <h2>How Campaign Brain works</h2>
      <p>AI manages Google Ads 24/7 with 20 years of experience baked in.</p>
      <h2>Proof from real accounts</h2>
      <p>Millions in ad spend managed for small businesses.</p>
      <h2>FAQ</h2>
      <p>Common questions answered here.</p>
      <a href="/book">Book a free call</a>
    </body></html>`,
    null,
  );
  assert.ok(outline.headingOutline.length >= 3);
  const headline = pickBestHeadline(
    "Billy Polsons Campaign Brain Actual Intelligence X AI Turbocharged",
    outline,
    "Ignored ad creative",
  );
  assert.match(headline || "", /HATE this/i);
  assert.equal(
    /Campaign Brain Actual Intelligence/i.test(headline || ""),
    false,
  );
});

test("ensureArchitectureSections expands beyond Hero from heading outline", () => {
  const outline = extractPageOutline(
    `<html><body>
      <h1>Stop wasting ad spend</h1>
      <h2>The problem</h2><p>Agencies are slow and expensive for small teams.</p>
      <h2>Features</h2><p>AI optimizes bids around the clock.</p>
      <h2>Social proof</h2><p>Trusted by growing brands.</p>
      <h2>FAQ</h2><p>How onboarding works.</p>
      <a href="#">Get started free</a>
    </body></html>`,
    null,
  );
  const sections = ensureArchitectureSections(
    [{ name: "Hero", purpose: "Intro", summary: "Only hero", keyElements: [] }],
    outline,
  );
  assert.ok(sections.length >= 4, `expected >=4 sections, got ${sections.length}`);
  assert.equal(sections[0].name, "Hero");
});

test("thin SPA shells are detected so rendered fetch can run", () => {
  const shell = `<!doctype html><html><body><div id="__next"></div><script src="/app.js"></script></body></html>`;
  assert.equal(looksLikeThinShell(shell), true);
  const rich = `<!doctype html><html><body>
    <h1>Grow with better ads</h1><p>${"copy ".repeat(80)}</p>
    <h2>Features</h2><p>${"more ".repeat(40)}</p>
    <h2>Pricing</h2><p>${"plans ".repeat(40)}</p>
  </body></html>`;
  assert.equal(looksLikeThinShell(rich), false);
});

test("offer analysis architecture is usable when browser capture has no body text", () => {
  const inventory = inventoryFromLandingOutline({
    sourceUrl: "https://rival.example/offer",
    finalUrl: "https://rival.example/offer",
    heroCandidates: ["Your Google Ads agency is about to absolutely HATE this."],
    headings: [
      { level: 1, text: "Your Google Ads agency is about to absolutely HATE this.", snippet: "" },
    ],
    architecture: [
      { name: "Hero", purpose: "Introduce the product", summary: "AI-driven Google Ads management that runs 24/7.", keyElements: ["Hero headline"] },
      { name: "Features", purpose: "Explain the system", summary: "Trained with 20 years of Google Ads experience and more efficient than agencies.", keyElements: [] },
      { name: "Proof", purpose: "Build trust", summary: "Millions in ad spend managed for small businesses.", keyElements: [] },
      { name: "FAQ", purpose: "Answer objections", summary: "Common questions about onboarding and pricing.", keyElements: [] },
    ],
  });
  assert.ok(inventory.sections.length >= 4);
  assert.equal(hasUsableCompetitorReference(inventory), true);
  assert.match(inventory.sections[0].sourceHeading || "", /HATE this/i);
  assert.equal(inventory.sections[1].purpose, "Explain the system");
});

test("unified brief pins competitor campaignOffer over client homepage offers", async () => {
  const { buildUnifiedBrief } = await import("../src/lib/pipeline/unified/brief");
  const inventory = inventoryFromLandingOutline({
    sourceUrl: "https://rival.example",
    finalUrl: "https://rival.example",
    architecture: [
      { name: "Hero", purpose: "Hook", summary: "Ads management pitch", keyElements: ["CTA"] },
      { name: "Services", purpose: "Explain", summary: "Google Ads management", keyElements: [] },
    ],
    campaignOffer: {
      headline: "Book a strategy call",
      primaryOffer: "Google Ads management for ecommerce brands",
      cta: "Book your strategy call",
      uniqueValueProps: ["Hands-on Google Ads management"],
    },
  });
  assert.match(inventory.sections[0].components.find((c) => c.kind === "cta")?.text || "", /strategy call/i);
  assert.match(inventory.sections[0].purpose, /Google Ads management/i);

  const brief = buildUnifiedBrief({
    competitorUrl: "https://rival.example",
    competitorName: "Rival",
    clientUrl: "https://client.example",
    clientName: "Client",
    keyword: "google ads",
    inventory,
    layout: null,
    evidence: {
      businessUrl: "https://client.example",
      pages: [],
      facts: [
        {
          id: "f1",
          category: "offer",
          value: "Free growth audit for SEO clients",
          status: "stated_on_site",
          sourceUrl: "https://client.example",
          excerpt: "Free growth audit",
          retrievedAt: new Date().toISOString(),
        },
      ],
      contacts: { emails: [], phones: [], addresses: [] },
      gaps: [],
      capturedAt: new Date().toISOString(),
    } as never,
    colors: { primary: "#000", secondary: "#111", accent: "#222", background: "#fff", text: "#000" },
    assets: null,
    design: null,
    profile: null,
    imageBudget: 2,
    tileBase64: [],
    compact: true,
    campaignOffer: {
      headline: "Book a strategy call",
      primaryOffer: "Google Ads management for ecommerce brands",
      cta: "Book your strategy call",
      uniqueValueProps: ["Hands-on Google Ads management"],
    },
  });
  assert.match(brief.text, /campaignOffer/);
  assert.match(brief.text, /Book your strategy call/);
  assert.match(brief.text, /Google Ads management/);
  assert.match(brief.text, /MUST follow campaignOffer|MANDATORY campaign focus/i);
  assert.doesNotMatch(brief.text, /FREE GROWTH AUDIT/);
});

test("compact unified brief stays bounded for faster generation", async () => {
  const { buildUnifiedBrief } = await import("../src/lib/pipeline/unified/brief");
  const inventory = inventoryFromLandingOutline({
    sourceUrl: "https://rival.example",
    finalUrl: "https://rival.example",
    architecture: Array.from({ length: 12 }, (_, i) => ({
      name: `Section ${i + 1}`,
      purpose: "Purpose",
      summary: "Summary text ".repeat(20),
      keyElements: ["a", "b", "c"],
    })),
  });
  const brief = buildUnifiedBrief({
    competitorUrl: "https://rival.example",
    competitorName: "Rival",
    clientUrl: "https://client.example",
    clientName: "Client",
    keyword: "ads",
    inventory,
    layout: null,
    evidence: {
      businessUrl: "https://client.example",
      pages: [],
      facts: [],
      contacts: { emails: [], phones: [], addresses: [] },
      gaps: [],
      capturedAt: new Date().toISOString(),
    } as never,
    colors: { primary: "#000", secondary: "#111", accent: "#222", background: "#fff", text: "#000" },
    assets: null,
    design: null,
    profile: null,
    imageBudget: 2,
    tileBase64: [],
    compact: true,
  });
  assert.equal(brief.compact, true);
  assert.ok(brief.sectionCount <= 8);
  assert.ok(brief.text.length < 25_000);
  assert.equal(brief.imageTiles.length, 0);
});
