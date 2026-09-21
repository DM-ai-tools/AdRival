import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { constructLandingPage, isStaleDesignWrite, verifiedCompanyLogo } from "../src/lib/pipeline/design/constructPage";
import type { PageLayoutEvidence, SectionArchitecture } from "../src/lib/pipeline/design/layoutEvidence";
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
  sourceUrl: "https://rival.example/seo/",
  retrievedAt: "2026-09-17T00:00:00.000Z",
  name: "Rival Agency",
  host: "rival.example",
  sections: [],
};

function snapshot(): CanonicalContent {
  return {
    draftId: "draft-1",
    revision: 3,
    evidenceVersion: 2,
    clientUrl: "https://client.example/",
    clientName: "Northwind Studio",
    competitorUrl: competitor.sourceUrl,
    competitorName: competitor.name,
    serviceContext: "brand design",
    audienceContext: null,
    meta: { title: "Brand design", description: "Approved description" },
    sections: [
      {
        id: "hero",
        decision: "adapt",
        decisionReason: "matched",
        purpose: "Introduce the service",
        competitorSectionId: "src-hero",
        heading: "Brand design for growing teams",
        paragraphs: ["Brand design for growing teams is also mentioned in the body, which must stay a paragraph."],
        items: [{ id: "cta-1", kind: "cta", label: "Book a consult", detail: null, href: "https://client.example/contact", evidenceIds: [] }],
        evidenceIds: [],
        locked: false,
        issues: [],
        fields: [
          { id: "hero-h", sourceComponentId: "n1", kind: "headline", text: "Brand design for growing teams", items: [], disposition: "adapt", reason: null },
          { id: "hero-p", sourceComponentId: "n2", kind: "paragraph", text: "Brand design for growing teams is also mentioned in the body, which must stay a paragraph.", items: [], disposition: "adapt", reason: null },
        ],
      },
      {
        id: "faqs",
        decision: "adapt",
        decisionReason: "matched",
        purpose: "Answer questions",
        competitorSectionId: "src-faq",
        heading: "Questions",
        paragraphs: [],
        items: [
          { id: "q1", kind: "faq", label: "How long does a project take?", detail: "Most brand projects take six weeks.", evidenceIds: [] },
          { id: "q2", kind: "faq", label: "Do you work with one office?", detail: "The studio works with clients remotely.", evidenceIds: [] },
        ],
        evidenceIds: [],
        locked: false,
        issues: [],
      },
      {
        id: "services",
        decision: "adapt",
        decisionReason: "matched",
        purpose: "Show services",
        competitorSectionId: "src-cards",
        heading: "Services",
        paragraphs: [],
        items: [],
        evidenceIds: [],
        locked: false,
        issues: [],
        fields: [
          { id: "card-a", sourceComponentId: "c1", kind: "card", text: "Identity systems", items: ["A named identity offer."], disposition: "adapt", reason: null },
          { id: "card-b", sourceComponentId: "c2", kind: "card", text: "Campaign sites", items: ["A separate campaign offer."], disposition: "adapt", reason: null },
        ],
      },
    ],
    issues: [],
    approved: true,
    approvedAt: "2026-09-17T00:00:00.000Z",
    approvedRevision: 3,
  };
}

function measured(id: string, composition: SectionArchitecture["composition"], extra: Partial<SectionArchitecture> = {}): SectionArchitecture {
  return {
    id,
    order: 0,
    source: "desktop DOM measurement",
    bounds: { x: 0, y: 0, width: 1440, height: 640 },
    cropRef: `${id}.jpg`,
    composition,
    compositionConfidence: "observed",
    fullWidth: false,
    containerWidth: composition === "stack" ? 720 : 1120,
    align: "start",
    gap: composition === "repeated" ? 16 : 40,
    paddingY: 64,
    columns: composition === "columns"
      ? [
          { id: `${id}-copy`, fraction: 0.55, role: "content", componentIds: [], confidence: "observed" },
          { id: `${id}-media`, fraction: 0.45, role: "media", componentIds: [], confidence: "observed" },
        ]
      : [],
    repeated: composition === "repeated"
      ? { kind: "cards", columns: 3, gap: 16, bordered: true, radius: 0, confidence: "observed" }
      : null,
    media: composition === "columns"
      ? { position: "right", aspect: 1.33, focal: "center", classification: "generate", confidence: "observed" }
      : { position: "none", aspect: null, focal: "unknown", classification: "none", confidence: "observed" },
    headingAlign: "start",
    textMeasure: 620,
    backgroundRole: "page",
    separator: composition === "repeated" ? "border" : "whitespace",
    radius: null,
    interactions: id.includes("faq") ? [{ kind: "accordion", confidence: "observed", evidence: "details elements" }] : [],
    responsive: { stacks: true, source: "mobile viewport" },
    ...extra,
  };
}

function layoutEvidence(): PageLayoutEvidence {
  return {
    version: 1,
    captureId: "fixture",
    sourceUrl: competitor.sourceUrl,
    viewport: { name: "desktop", width: 1440, height: 900 },
    header: { arrangement: "split", confidence: "observed", source: "header" },
    footer: { arrangement: "split", groups: 2, confidence: "observed" },
    sections: [
      measured("src-hero", "columns"),
      measured("src-faq", "stack"),
      measured("src-cards", "repeated"),
    ],
    incomplete: false,
    gaps: [],
  };
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("headings, paragraphs, FAQs, and cards stay in their own elements", async () => {
  const calls: string[] = [];
  const page = await constructLandingPage({
    snapshot: snapshot(),
    competitor,
    layoutEvidence: layoutEvidence(),
    colors,
    competitorId: "job-1",
    keyword: "brand design",
    hasImageKey: () => true,
    generateImage: async (slot) => {
      calls.push(slot.imageId);
      return { buffer: png, taskId: `task-${slot.imageId}` };
    },
  });
  assert.equal(page.blockers.length, 0, page.blockers.join("\n"));
  assert.match(page.html, /<h1 [^>]*data-field-id="hero-h"/);
  assert.match(page.html, /<p [^>]*data-field-id="hero-p"/);
  assert.equal(page.html.includes("**"), false);
  assert.equal(page.html.includes("rival.example"), false);
  assert.match(page.html, /<summary>How long does a project take\?<\/summary><p data-role="faq-answer">Most brand projects take six weeks\./);
  assert.match(page.html, /<summary>Do you work with one office\?<\/summary>/);
  assert.match(page.html, /data-field-id="card-a"/);
  assert.match(page.html, /data-field-id="card-b"/);
  assert.equal(calls.includes("img-hero"), true);
  assert.match(page.html, /data-adrival-gen-id="img-hero"/);
  assert.match(page.html, /data:image\/png;base64/);
  assert.equal(page.images.find((image) => image.id === "img-hero")?.slotState, "ready");
  assert.equal(page.images.find((image) => image.id === "img-hero")?.provider, "runway");
  assert.equal(page.images.find((image) => image.id === "img-hero")?.model, "gpt_image_2");
  assert.equal(stripDraftBanner(page.html), page.html);
  assert.equal(page.html.includes("adrival-draft-banner"), false);
  assert.match(page.html, /@media \(max-width:900px\)/);
  assert.match(page.html, /@media \(max-width:700px\)/);
  assert.equal(/overflow\s*:\s*hidden/i.test(page.html), false);
});

test("insufficient image credits block export and do not render a prompt placeholder", async () => {
  let calls = 0;
  const page = await constructLandingPage({
    snapshot: snapshot(),
    competitor,
    layoutEvidence: layoutEvidence(),
    colors,
    competitorId: "job-1",
    keyword: "brand design",
    hasImageKey: () => true,
    generateImage: async () => {
      calls += 1;
      throw new Error("Image generation is unavailable because the image account has no remaining credits.");
    },
  });
  assert.equal(calls, 1);
  assert.equal(page.blockers.some((item) => /credits/i.test(item)), true);
  assert.equal(page.html.includes("data-image-state=\"placeholder\""), false);
  assert.equal(page.html.includes("Illustration for"), false);
  assert.equal(page.html.includes("unsplash"), false);
  assert.equal(page.images.find((image) => image.id === "img-hero")?.slotState, "failed");
});

test("design construction measures competitor architecture and does not clone its HTML", () => {
  const source = fs.readFileSync("src/lib/pipeline/recreateLandingPage.ts", "utf8");
  const start = source.indexOf("export async function buildRecreationDesign");
  const end = source.indexOf("export async function regenerateGeneratedImageForRecreation");
  const body = source.slice(start, end);
  assert.equal(body.includes("recreateFromArchive"), false);
  assert.equal(body.includes("cloneAndAdaptLandingPage"), false);
  assert.match(body, /constructLandingPage/);
  assert.match(body, /captureLayoutEvidence/);
  assert.match(body, /browserValidate:\s*true/);
});

test("a failed image job stays unresolved and is not replaced with a scraped photo", async () => {
  const page = await constructLandingPage({
    snapshot: snapshot(),
    competitor,
    layoutEvidence: layoutEvidence(),
    colors,
    competitorId: "job-1",
    keyword: "brand design",
    hasImageKey: () => true,
    generateImage: async () => {
      throw new Error("provider rejected the image request");
    },
  });
  assert.equal(page.blockers.some((item) => /provider rejected/.test(item)), true);
  assert.equal(page.html.includes("unsplash"), false);
  assert.equal(page.html.includes("data-adrival-gen-id=\"img-hero\""), false);
});

test("header and footer use only the verified company logo", async () => {
  const logo = `data:image/png;base64,${png.toString("base64")}`;
  const page = await constructLandingPage({
    snapshot: snapshot(),
    competitor,
    layoutEvidence: layoutEvidence(),
    colors,
    competitorId: "job-1",
    keyword: "brand design",
    hasImageKey: () => true,
    generateImage: async () => ({ buffer: png, taskId: "task-logo" }),
    assets: {
      finalUrl: "https://client.example/",
      siteName: "Northwind Studio",
      logoUrl: logo,
      faviconUrl: "https://client.example/favicon.ico",
      ogImageUrl: "https://client.example/og.jpg",
      navLinks: [{ label: "Work", href: "https://client.example/work" }],
      footerLinks: [{ label: "Privacy", href: "https://client.example/privacy" }],
      socialLinks: [],
      images: [{ src: "https://client.example/customer-logo.png", kind: "content" }],
      emails: [],
      phones: [],
    },
  });
  assert.equal(page.blockers.length, 0, page.blockers.join("\n"));
  assert.equal(page.html.split('data-logo-role="company"').length - 1, 2);
  assert.equal(page.html.includes("customer-logo.png"), false);
  assert.equal(page.html.includes("favicon.ico"), false);
  assert.match(page.html, /aria-label="Primary"[\s\S]*Work/);
  assert.match(page.html, /aria-label="Footer"[\s\S]*Privacy/);
  assert.equal(page.html.includes(">Work</a><a href=\"https://client.example/privacy\""), false);
});

test("an older build token must not overwrite a newer one", () => {
  assert.equal(isStaleDesignWrite("newer", "older"), true);
  assert.equal(isStaleDesignWrite("same", "same"), false);
  assert.equal(isStaleDesignWrite(null, "first"), false);
});

test("missing image credentials block completion and do not invent a photo", async () => {
  const page = await constructLandingPage({
    snapshot: snapshot(),
    competitor,
    layoutEvidence: layoutEvidence(),
    colors,
    competitorId: "job-1",
    keyword: "brand design",
    hasImageKey: () => false,
  });
  assert.equal(page.blockers.some((item) => /not configured/.test(item)), true);
  assert.equal(page.html.includes("unsplash"), false);
});

test("a verified logo is not the first random site image, and a favicon is rejected", () => {
  assert.equal(verifiedCompanyLogo({
    finalUrl: "https://client.example/",
    siteName: "Northwind",
    logoUrl: "https://client.example/favicon.ico",
    faviconUrl: "https://client.example/favicon.ico",
    ogImageUrl: null,
    navLinks: [],
    footerLinks: [],
    socialLinks: [],
    images: [{ src: "https://client.example/team.jpg", kind: "hero" }],
    emails: [],
    phones: [],
  }), null);
});

test("cached generated assets are reused without another generation call", async () => {
  let calls = 0;
  const first = await constructLandingPage({
    snapshot: snapshot(),
    competitor,
    layoutEvidence: layoutEvidence(),
    colors,
    competitorId: "job-1",
    keyword: "brand design",
    hasImageKey: () => true,
    generateImage: async () => {
      calls += 1;
      return { buffer: png, taskId: "task-1" };
    },
  });
  const second = await constructLandingPage({
    snapshot: snapshot(),
    competitor,
    layoutEvidence: layoutEvidence(),
    colors,
    competitorId: "job-1",
    keyword: "brand design",
    hasImageKey: () => true,
    previousImages: first.images.map((image) => ({ ...image, publicUrl: `data:image/png;base64,${png.toString("base64")}` })),
    generateImage: async () => {
      calls += 1;
      return { buffer: png, taskId: "task-2" };
    },
  });
  assert.equal(second.blockers.length, 0, second.blockers.join("\n"));
  assert.equal(calls, first.images.length);
  assert.equal(second.html, first.html);
});

test("new design builds do not call the archive replacement path", () => {
  const source = fs.readFileSync("src/lib/pipeline/recreateLandingPage.ts", "utf8");
  const start = source.indexOf("export async function buildRecreationDesign");
  const end = source.indexOf("export async function regenerateGeneratedImageForRecreation");
  const body = source.slice(start, end);
  assert.equal(body.includes("recreateFromArchive"), false);
  assert.equal(body.includes("cloneAndAdaptLandingPage"), false);
  assert.match(body, /constructLandingPage/);
});
