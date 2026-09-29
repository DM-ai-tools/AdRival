import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import type { CompetitorBlueprint } from "../src/lib/pipeline/unified/blueprint";

let browser: Browser | null = null;
let blueprint: CompetitorBlueprint;

before(async () => {
  const { launchChromium } = await import("../src/lib/pipeline/content/playwrightRuntime");
  const { captureBlueprintFromPage } = await import("../src/lib/pipeline/unified/blueprint");
  browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.setContent(readFileSync(path.join(process.cwd(), "tests", "fixtures", "blueprint-page.html"), "utf8"));
  blueprint = await captureBlueprintFromPage(page, "https://fixture.example/");
});
after(async () => {
  await browser?.close();
});

test("sections are the real page bands, not every heading", () => {
  const headings = blueprint.sections.map((s) => s.heading);
  assert.equal(blueprint.sections.length, 4, JSON.stringify(headings));
  assert.equal(headings[1], "What we take off your plate");
  assert.ok(!headings.includes("Paid search"), "a card title is not a section");
  assert.ok(!headings.includes("Hidden popup heading"), "hidden pop-ups are skipped");
  const cards = blueprint.sections[1];
  assert.equal(cards.layout.columns, 2);
  assert.equal(cards.layout.cards, 4);
  assert.ok(cards.blocks.some((b) => /Campaign builds/.test(b.text)), "card copy is kept");
});

test("sections know their kind, background and screenshot", () => {
  const [hero, , formSection, faq] = blueprint.sections;
  assert.equal(hero.kind, "hero");
  assert.equal(hero.background.kind, "dark");
  assert.equal(formSection.kind, "form");
  assert.equal(faq.kind, "faq");
  assert.ok(blueprint.sections.every((s) => s.crop && s.crop.length > 500), "every section has a crop");
});

test("forms keep real labels, drop spam traps and keep steps", () => {
  const hero = blueprint.forms.find((f) => f.sectionId === "sec-1");
  assert.ok(hero, "hero form found");
  assert.deepEqual(hero!.fields.map((f) => f.label), ["First name", "Email", "Website"]);
  assert.equal(hero!.submitLabel, "Get my audit");

  const multi = blueprint.forms.find((f) => f.sectionId === "sec-3");
  assert.ok(multi, "multi-step form found");
  assert.deepEqual(multi!.steps.map((s) => s.title), ["Your details", "Your business", "Your challenge"]);
  assert.equal(multi!.mode, "multi-step");
  assert.equal(hero!.mode, "single");
  const labels = multi!.fields.map((f) => f.label);
  assert.deepEqual(labels, ["Full name", "Work email", "Monthly revenue", "Main goal", "Anything else?"]);
  const goal = multi!.fields.find((f) => f.label === "Main goal")!;
  assert.equal(goal.type, "radio");
  assert.deepEqual(goal.options, ["More leads", "More online sales"]);
  assert.deepEqual(multi!.fields.find((f) => f.name === "revenue")!.options, ["Under $50k", "$50k–$250k", "$250k+"]);
  assert.equal(multi!.submitLabel, "Send my brief");
  assert.ok(!blueprint.forms.some((f) => f.fields.some((x) => /popup/.test(x.name))), "pop-up form is not used while visible forms exist");
});

test("design shape records the competitor's type, buttons and cards", () => {
  const shape = blueprint.shape;
  assert.equal(shape.h1?.size, 56);
  assert.equal(shape.h2?.size, 40);
  assert.ok((shape.button?.radius || 0) >= 100, "pill buttons");
  assert.equal(shape.cardRadius, 18);
  assert.equal(shape.cardShadow, true);
  assert.equal(blueprint.header?.nav.join(","), "Services,Work,Contact");
  assert.equal(blueprint.header?.cta, "Book a call");
  assert.equal(blueprint.footer?.columns, 3);
  assert.equal(blueprint.footer?.dark, true);
});

test("the blueprint feeds the existing inventory shape", async () => {
  const { inventoryFromBlueprint, primaryBlueprintForm } = await import("../src/lib/pipeline/unified/blueprint");
  const inventory = inventoryFromBlueprint(blueprint);
  assert.equal(inventory.sections.length, 4);
  assert.equal(inventory.sections.filter((s) => s.components.some((c) => c.kind === "form")).length, 2);
  assert.equal(primaryBlueprintForm(blueprint)?.sectionId, "sec-3", "the fullest form is the lead form");
});
