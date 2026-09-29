import assert from "node:assert/strict";
import { test } from "node:test";
import type { BlueprintForm, BlueprintSection, DesignShape } from "../src/lib/pipeline/unified/blueprint";

const colors = { primary: "#E4007C", secondary: "#1B1033", accent: "#7C3AED", background: "#FFFFFF", text: "#111827" };

const shape: DesignShape = {
  h1: { size: 72, weight: 800, lineHeight: 1, letterSpacing: -0.025, transform: "none", family: "Inter" },
  h2: { size: 48, weight: 800, lineHeight: 1, letterSpacing: -0.025, transform: "none", family: "Inter" },
  h3: { size: 20, weight: 700, lineHeight: 1.4, letterSpacing: 0, transform: "none", family: "Inter" },
  body: { size: 16, weight: 400, lineHeight: 1.56, letterSpacing: 0, transform: "uppercase", family: "Inter" },
  eyebrow: { size: 12, weight: 600, letterSpacing: 2.2, pill: true },
  button: { radius: 9999, paddingY: 16, paddingX: 32, weight: 600, size: 16, transform: "none", letterSpacing: 0, shadow: true, height: 56 },
  sectionPadding: 110,
  container: 1152,
  cardRadius: 16,
  cardShadow: true,
  cardBorder: false,
  darkBands: 0,
  gradientBands: 2,
  pageBackground: "rgb(255, 255, 255)",
};

const multiStep: BlueprintForm = {
  id: "form-1",
  sectionId: "sec-7",
  hidden: false,
  provider: null,
  booking: false,
  fields: [
    { label: "First Name", name: "firstName", type: "text", required: true },
    { label: "Email", name: "email", type: "email", required: true },
    { label: "Yearly Business Revenue", name: "revenue", type: "select", required: true, options: ["Under $500k", "$500k–$2M", "$2M+"] },
  ],
  submitLabel: "Book Your Session",
  layout: "two-column",
  heading: null,
  intro: null,
  steps: [
    { title: "Your details", fields: ["firstName", "email"] },
    { title: "Your business", fields: ["revenue"] },
    { title: "Your challenge", fields: [] },
  ],
  mode: "multi-step",
  partialSteps: true,
  nextLabel: "Next",
  consent: false,
  style: { inputRadius: 12, inputHeight: 48, inputBorder: "box", inputFilled: false, buttonRadius: 999, buttonFullWidth: true, perRow: 2, labels: "above", panel: null },
};

test("the design system carries the competitor's shape in the client's colours", async () => {
  const { buildDesignSystem } = await import("../src/lib/pipeline/unified/designSystem");
  const ds = buildDesignSystem({ shape, colors, brandDesign: { fonts: ["Poppins"] }, formStyle: multiStep.style });
  assert.equal(ds.tokens["--radius-btn"], "999px", "pill buttons like the competitor");
  assert.equal(ds.tokens["--radius-card"], "16px");
  assert.match(ds.tokens["--h1"], /72px\)$/, "desktop h1 reaches the competitor's size");
  assert.equal(ds.tokens["--primary"], "#E4007C", "client colour, not competitor");
  assert.match(ds.tokens["--font-heading"], /Poppins/, "client font");
  assert.ok(ds.fontLinks[0].includes("family=Poppins"), "font is actually loaded");
  assert.ok(!/text-transform:uppercase/.test(ds.css.match(/body\{[^}]*\}/)![0]), "body copy never uppercased");
  assert.ok(ds.css.includes(".adr-form-grid{display:grid;grid-template-columns:repeat(2"), "form grid follows the competitor's two per row");
  assert.ok(ds.vocabulary.includes("data-adrival-form"));
});

test("section CSS is scoped to its section and cannot restyle the page", async () => {
  const { sanitizeFragment } = await import("../src/lib/pipeline/unified/fragmentCss");
  const out = sanitizeFragment(
    `<section data-section-id="sec-3"><style>:root{--primary:#f00} body{background:red} .grid{display:grid;font-family:Comic Sans;gap:30px} @media (max-width:600px){.grid{display:block}}</style><div class="grid"><h2>Built for growth.<br>Scale with confidence.</h2></div><form><input name="x"></form><script>alert(1)</script></section>`,
    "sec-3",
  );
  assert.ok(!out.css.includes(":root") && !out.css.includes("body"), out.css);
  assert.match(out.css, /\[data-section-id="sec-3"\] \.grid\{display:grid;gap:30px\}/);
  assert.match(out.css, /@media \(max-width:600px\)\{\[data-section-id="sec-3"\] \.grid/);
  assert.ok(!/font-family/.test(out.css));
  assert.ok(!out.html.includes("<script") && !out.html.includes("<form"));
  assert.ok(out.html.includes("data-adrival-form"), "a model-written form becomes the form slot");
  assert.ok(out.html.includes("growth. <br>Scale"), "sentences joined by <br> keep a space");
});

test("the lead form keeps the competitor's fields, options and steps", async () => {
  const { buildLeadFormHtml } = await import("../src/lib/pipeline/unified/leadForm");
  const { html, notes } = buildLeadFormHtml(multiStep, {
    submitLabel: "Book my strategy session",
    stepFields: { "Your challenge": [{ label: "Biggest marketing challenge", name: "challenge", type: "textarea", required: false }] },
  });
  assert.equal((html.match(/<fieldset class="adr-form-step"/g) || []).length, 3);
  assert.ok(html.includes("<option>$500k–$2M</option>"), "real dropdown options");
  assert.ok(html.includes(">Book my strategy session<"));
  assert.ok(html.includes('data-endpoint=""'), "marked where to connect a CRM");
  assert.ok(notes.some((n) => /Your challenge/.test(n)), "proposed step fields are disclosed");
});

test("the multi-step form validates each step and shows the thank-you message", async () => {
  const { buildLeadFormHtml, LEAD_FORM_SCRIPT } = await import("../src/lib/pipeline/unified/leadForm");
  const { launchChromium } = await import("../src/lib/pipeline/content/playwrightRuntime");
  const { html } = buildLeadFormHtml(multiStep, { stepFields: { "Your challenge": [{ label: "Challenge", name: "challenge", type: "textarea", required: false }] } });
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>${html}${LEAD_FORM_SCRIPT}</body></html>`);
    await page.click("[data-form-next]");
    assert.equal(await page.isVisible('[data-step="2"]'), false, "cannot skip required fields");
    await page.fill('input[name="firstname"]', "Ada");
    await page.fill('input[name="email"]', "ada@example.com");
    await page.click("[data-form-next]");
    assert.equal(await page.isVisible('[data-step="2"]'), true);
    await page.selectOption('select[name="revenue"]', { index: 1 });
    await page.click("[data-form-next]");
    await page.click('button[type="submit"]');
    assert.equal(await page.isVisible(".adr-form-success"), true);
  } finally {
    await browser.close();
  }
});

test("images are planned where the competitor shows photos, hero first, capped", async () => {
  const { planImageSlots } = await import("../src/lib/pipeline/unified/generateBlueprint");
  const section = (id: string, kind: BlueprintSection["kind"], images: number, logos = 0, w = 600): BlueprintSection => ({
    id, order: Number(id.split("-")[1]) - 1, bounds: { x: 0, y: 0, width: 1280, height: 600 }, heading: null, blocks: [], wordCount: 80,
    layout: { columns: 1, cards: 0, card: null }, media: { images, logos, video: false, position: images ? "right" : "none", largest: images ? { width: w, height: 400 } : null },
    background: { kind: "page", color: null, image: null }, align: "left", paddingTop: 80, containerWidth: 1100, hasFormControls: false, faq: false, kind, formId: null, crop: null,
  });
  const slots = planImageSlots([section("sec-1", "hero", 1), section("sec-2", "logos", 6, 6), section("sec-3", "content", 1, 0, 900), section("sec-4", "content", 0)], 2);
  assert.deepEqual(slots.map((s) => s.sectionId), ["sec-1", "sec-3"]);
});

test("content checks catch repetition, copied sentences and a lost section", async () => {
  const { repeatedPhrases, copiedSentences, replaceSection } = await import("../src/lib/pipeline/unified/fidelity");
  const text = "Growth backed by data every month. Campaigns backed by data every week. Reports backed by data every day. Strategy backed by data every quarter.";
  assert.ok(repeatedPhrases(text).some((p) => p.includes("backed by data every")));
  const copied = copiedSentences(
    "They get a strategic partner who knows how to brief them and manage them well.",
    ["They get a strategic partner who knows how to brief them, manage them, and get the best out of them."],
  );
  assert.equal(copied.length, 1);
  const page = `<main><section data-section-id="sec-1"><section>inner</section></section><section data-section-id="sec-2">b</section></main>`;
  assert.equal(replaceSection(page, "sec-1", `<section data-section-id="sec-1">new</section>`), `<main><section data-section-id="sec-1">new</section><section data-section-id="sec-2">b</section></main>`);
});

test("the competitor's CTA wording is replaced with the client's label, and the form survives rewrites", async () => {
  const { swapCtaLabels, holdForm } = await import("../src/lib/pipeline/unified/generateBlueprint");
  const html = `<a class="adr-btn" href="#f">Book Your 1:1 Growth Session →</a><a href="#x">See our work</a><button type="submit">Book your 1:1 growth session</button>`;
  const out = swapCtaLabels(html, ["Book Your 1:1 Growth Session"], "Get my Google Ads plan");
  assert.equal((out.match(/Get my Google Ads plan/g) || []).length, 2);
  assert.ok(out.includes("Get my Google Ads plan →"), "keeps the arrow");
  assert.ok(out.includes("See our work"), "other links untouched");

  const section = `<section data-section-id="sec-7"><h2>Talk to us</h2><div class="adr-form-panel"><form id="adr-lead-form"><input name="a"></form></div></section>`;
  const held = holdForm(section);
  assert.ok(!held.html.includes("<form"), "the form is out while the section is rewritten");
  const restored = held.restore(held.html.replace("Talk to us", "Let's talk"));
  assert.ok(restored.includes(`<form id="adr-lead-form">`) && restored.includes("Let's talk"));
});

test("client facts are shared out so sections do not repeat the same evidence", async () => {
  const { partitionFacts } = await import("../src/lib/pipeline/unified/generateBlueprint");
  const facts = Array.from({ length: 14 }, (_, i) => i);
  const parts = partitionFacts(facts, 3, 2);
  assert.deepEqual(parts[0].slice(0, 2), [0, 1], "a few core facts everywhere");
  const rest = parts.map((p) => p.slice(2));
  assert.equal(new Set(rest.flat()).size, 12, "every other fact used exactly once");
});
