import { test } from "node:test";
import assert from "node:assert/strict";
import { chromeProblems } from "../src/lib/pipeline/unified/fidelity";
import { classifySection, type BlueprintSection, type CompetitorBlueprint } from "../src/lib/pipeline/unified/blueprint";
import { planImageSlots } from "../src/lib/pipeline/unified/generateBlueprint";

// The House of Smile Design page: centred logo, address left, phone button right, no footer.
const blueprint = {
  header: {
    bounds: { x: 0, y: 0, width: 1280, height: 98 },
    nav: [],
    cta: null,
    dark: false,
    tinted: true,
    sticky: false,
    logoPosition: "center",
    items: [
      { text: "200-202 Pakenham St, Echuca", side: "left", kind: "address", button: false },
      { text: "(03) 5481 1666", side: "right", kind: "phone", button: true },
    ],
    crop: null,
  },
  footer: null,
} as unknown as CompetitorBlueprint;

test("a left logo, missing contact items and an added footer are all flagged", () => {
  const found = chromeProblems(blueprint, {
    logoCenter: 0.15,
    headerItems: 1,
    headerText: "Request your consultation",
    headerTel: false,
    headerMail: false,
    footerHeight: 418,
  });
  assert.equal(found.header.length, 3);
  assert.match(found.header[0], /centred/);
  assert.match(found.header.join(" "), /address on the left/);
  assert.match(found.header.join(" "), /phone on the right as a button/);
  assert.match(found.footer[0], /no footer/);
});

test("a header that mirrors the competitor passes", () => {
  const found = chromeProblems(blueprint, {
    logoCenter: 0.5,
    headerItems: 2,
    headerText: "2 Deveney Street, Pakenham VIC 3810 (03) 5940 1110",
    headerTel: true,
    headerMail: false,
    footerHeight: 54,
  });
  assert.deepEqual(found, { header: [], footer: [] });
});

const section = (over: Partial<BlueprintSection>): BlueprintSection =>
  ({
    id: "sec-2",
    order: 1,
    bounds: { x: 0, y: 900, width: 1280, height: 150 },
    heading: "20+",
    blocks: [
      { role: "p", text: "Local family run clinic" },
      { role: "p", text: "5 star Google reviews" },
      { role: "stat", text: "20+" },
    ],
    wordCount: 19,
    layout: { columns: 4, cards: 4, card: null },
    media: { images: 1, logos: 1, video: false, position: "none", largest: null },
    background: { kind: "color", color: null, image: null },
    align: "left",
    paddingTop: null,
    containerWidth: null,
    hasFormControls: false,
    faq: false,
    kind: "content",
    formId: null,
    crop: null,
    ...over,
  }) as BlueprintSection;

test("a short row of badges mentioning reviews is a trust strip, not testimonials", () => {
  assert.equal(classifySection(section({}), false), "stats");
});

test("a band whose photo is a CSS background still gets an image slot", () => {
  const hero = section({
    id: "sec-1",
    order: 0,
    kind: "hero",
    media: { images: 2, logos: 2, video: false, position: "background", largest: null },
    background: { kind: "image", color: null, image: null },
  });
  const slots = planImageSlots([hero], 6);
  assert.deepEqual(slots.map((s) => s.sectionId), ["sec-1"]);
});
