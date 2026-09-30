import assert from "node:assert/strict";
import { test } from "node:test";
import { imageSizeFor } from "../src/lib/openai/images";
import { buildImagePrompt, colourName, imageContextFromProfile, readSlotSurroundings } from "../src/lib/pipeline/unified/imagePrompt";
import { applyImageSlotsToHtml } from "../src/lib/pipeline/unified/contract";

test("image sizes follow GPT Image 2's rules for every slot shape", () => {
  for (const aspect of ["1920:1280", "2048:880", "1280:1920", "1920:1920", "16:9", "9:1", "1:9", null]) {
    const { width, height } = imageSizeFor(aspect);
    assert.equal(width % 16, 0, `${aspect} width`);
    assert.equal(height % 16, 0, `${aspect} height`);
    assert.ok(Math.max(width, height) <= 3840);
    assert.ok(Math.max(width, height) / Math.min(width, height) <= 3.01, `${aspect} ratio`);
    const px = width * height;
    assert.ok(px >= 655_360 && px <= 8_294_400, `${aspect} pixels ${px}`);
  }
  const wide = imageSizeFor("1920:1280");
  assert.ok(Math.abs(wide.width / wide.height - 1.5) < 0.03);
});

test("the prompt carries the scene, the section, the business and what to avoid", () => {
  const html = `<main><section class="adr-section" data-section-id="sec-1"><div class="adr-split"><div><h1>Emergency plumbing in Ballarat</h1><p>Fast help for burst pipes, day or night.</p></div><div class="adr-media"><img data-adrival-slot="img-sec-1" src="x"></div></div></section></main>`;
  const around = readSlotSurroundings(html).get("img-sec-1");
  assert.equal(around?.heading, "Emergency plumbing in Ballarat");
  assert.equal(around?.isHero, true);
  const context = imageContextFromProfile(
    { businessName: "Northside Plumbing", industry: "Plumbing", offerings: ["blocked drains", "hot water"], locations: [{ label: "HQ", city: "Ballarat", region: "VIC", isPrimary: true }] },
    { colors: { primary: "#1E40AF", accent: "#F59E0B" } },
  );
  const prompt = buildImagePrompt({ scene: "A plumber fixing a kitchen sink pipe", purpose: "Hero image", aspect: "1920:1280", context, surroundings: around });
  assert.match(prompt, /A plumber fixing a kitchen sink pipe/);
  assert.match(prompt, /plumbing business called Northside Plumbing/);
  assert.match(prompt, /Ballarat, VIC/);
  assert.match(prompt, /never write these words.*emergency plumbing in ballarat/);
  assert.doesNotMatch(prompt, /"Emergency plumbing in Ballarat"/);
  assert.match(prompt, /Screens, documents and whiteboards are blank/);
  assert.match(prompt, /landscape frame/);
  assert.match(prompt, /Do not include: any text/);
  assert.doesNotMatch(prompt, /#[0-9a-f]{6}/i, "no hex codes the model could paint as text");
  assert.match(prompt, /blue/);
});

test("colour names read like a person would say them", () => {
  assert.equal(colourName("#A4D36B"), "lime green");
  assert.equal(colourName("#072032"), "deep sky blue");
  assert.equal(colourName("#FFFFFF"), "white");
  assert.equal(colourName("nope"), null);
});

test("images are embedded whatever order the tag's attributes are in", () => {
  const html = `<img src="data:old1" alt="" data-adrival-slot="a"><img data-adrival-slot="b" alt="x"><img data-adrival-slot="c" src="old3">`;
  const out = applyImageSlotsToHtml(html, new Map([["a", "data:new1"], ["b", "data:new2"], ["c", "data:new3"]]));
  assert.equal((out.match(/\ssrc=/g) || []).length, 3, "one src per image");
  assert.match(out, /src="data:new1" alt="" data-adrival-slot="a"/);
  assert.match(out, /<img src="data:new2"|<img data-adrival-gen-id="b" src="data:new2"/);
  assert.match(out, /data-adrival-slot="c" src="data:new3"/);
  assert.doesNotMatch(out, /old1|old3/);
});

test("card images know their own card and their siblings", () => {
  const card = (i: number, title: string, body: string) =>
    `<div class="adr-card"><div class="adr-media"><img data-adrival-slot="c${i}" src="x"></div><span class="adr-eyebrow">Label</span><h3>${title}</h3><p>${body}</p></div>`;
  const html = `<main><section data-section-id="sec-1"><h1>Hero</h1></section><section class="adr-section" data-section-id="sec-10"><div class="adr-container"><h2>Every campaign is run by a specialist</h2><p>Intro.</p><div class="adr-grid adr-grid--3">${card(1, "SEO and organic growth", "Technical audits.")}${card(2, "Google and Meta ads", "Campaign structure.")}${card(3, "Content marketing", "Website copy.")}</div></div></section></main>`;
  const map = readSlotSurroundings(html);
  assert.equal(map.get("c2")?.cardHeading, "Google and Meta ads");
  assert.equal(map.get("c2")?.cardText, "Campaign structure.");
  assert.equal(map.get("c2")?.heading, "Every campaign is run by a specialist");
  assert.equal(map.get("c1")?.groupSize, 3);
  assert.equal(map.get("c1")?.group, map.get("c3")?.group);
  const prompt = buildImagePrompt({ scene: "A megaphone and a target on a plinth", medium: "3d-render", aspect: "4:3", context: { colors: { primary: "#A4D36B" } }, surroundings: map.get("c2") });
  assert.match(prompt, /^A 3D render for the website/);
  assert.match(prompt, /it illustrates google and meta ads: campaign structure/);
  assert.match(prompt, /Clean modern 3D render/);
  assert.match(prompt, /row of cards with matching images/);
  assert.doesNotMatch(prompt, /Setting:/, "no people/place setting line for a 3D render");
});
