import assert from "node:assert/strict";
import { test } from "node:test";
import { inventoryFromLandingOutline, hasUsableCompetitorReference } from "../src/lib/pipeline/content/inventory";
import { looksLikeThinShell } from "../src/lib/pipeline/htmlFetch";
import {
  demashHeadline,
  ensureArchitectureSections,
  groundArchitectureSections,
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

test("page architecture keeps only sections the page really has (House of Smile Design)", () => {
  // Visible text of thehouseofsmiledesign.com.au/campaign/smile-transformation/
  const visible = `[H2] Build your confidence with the smile of your dreams
Invisalign & veneers – discreet, natural solutions for a straighter, brighter smile.
Smile transformations – personalised treatments designed just for you.
Advanced technology & expertise – a dental experience like no other, right here in Echuca.
FIRST NAME*
LAST NAME *
PHONE NO.*
EMAIL *
SELECT SERVICE OF INTERESTInvisalign OrthodonticsVeneersDental ImplantSleep DentistryGeneralOther
Local family run clinic
5 star Google reviews

[H2] 20+
20+ years of experience
Digital Smile Design (DSD) provider`;
  const section = (name: string, keyElements: string[], evidence?: string) => ({
    name,
    purpose: "",
    summary: "",
    keyElements,
    evidence: evidence ?? null,
  });
  const kept = groundArchitectureSections(
    [
      section("Hero", ["Lead form"], "Build your confidence with the smile of your dreams"),
      section("Trust badges", ["5 star Google reviews"], "Local family run clinic 5 star Google reviews"),
      section("Experience", ["20+ years"], "20+ years of experience Digital Smile Design (DSD) provider"),
      // Invented by the old prompt: none of these are on the page.
      section("The Anatomy of a Perfect Smile", [], "Explanation of smile design principles and the anatomy of a perfect smile"),
      section("Smile Transformation Gallery", ["Before/after photo gallery", "Patient case highlights", "Treatment type labels"]),
      section("Patient Testimonials", ["Google review ratings", "Patient quotes", "Star rating display"]),
      section("Final Call-to-Action / Booking", ["Repeated contact/booking form", "Encouraging closing headline"]),
    ],
    visible,
  );
  assert.deepEqual(
    kept.map((s) => s.name),
    ["Hero", "Trust badges", "Experience"],
  );
});

test("structured data is kept out of the visible page text", () => {
  const outline = extractPageOutline(
    `<html><head><title>Smile</title><script type="application/ld+json">{"@type":"ImageObject","name":"The Anatomy of perfect smile"}</script></head>
    <body><h2>Build your confidence</h2><p>Invisalign and veneers.</p></body></html>`,
    null,
  );
  assert.match(outline.bodyText || "", /Build your confidence/);
  assert.doesNotMatch(outline.bodyText || "", /Anatomy/);
});
