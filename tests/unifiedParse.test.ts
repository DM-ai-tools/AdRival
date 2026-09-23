import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseUnifiedResponse,
  parseSpinePass,
  parseHeroPass,
  parseBodyBatch,
  assembleUnifiedHtml,
} from "../src/lib/pipeline/unified/contract";

const SAMPLE_HTML = `<!DOCTYPE html><html><head><style>:root{--c:#000}</style><title>T</title></head><body><h1>Hi</h1></body></html>`;

test("parseUnifiedResponse accepts valid JSON", () => {
  const raw = JSON.stringify({
    html: SAMPLE_HTML,
    imageSlots: [],
    warnings: [],
    unresolvedRequirements: [],
  });
  const parsed = parseUnifiedResponse(raw);
  assert.match(parsed.html, /<\/html>/i);
});

test("parseUnifiedResponse recovers HTML from broken JSON wrapper", () => {
  const broken = `{"html": ${JSON.stringify(SAMPLE_HTML)}, "imageSlots": [`;
  const parsed = parseUnifiedResponse(broken);
  assert.match(parsed.html, /<h1>Hi<\/h1>/);
  assert.ok(parsed.warnings.some((w) => /Recovered/i.test(w)));
});

test("parseUnifiedResponse recovers raw HTML document", () => {
  const parsed = parseUnifiedResponse(`Here you go:\n${SAMPLE_HTML}\nThanks`);
  assert.match(parsed.html, /<!DOCTYPE html>/i);
});

test("parseSpinePass extracts :root css and shell with adr-sections", () => {
  const raw = JSON.stringify({
    css: ":root{--primary:#123;--bg-page:#fff}",
    shellHtml:
      '<!DOCTYPE html><html><head></head><body><header></header><main id="adr-sections"></main><footer></footer></body></html>',
  });
  const spine = parseSpinePass(raw);
  assert.match(spine.css, /:root/);
  assert.match(spine.shellHtml, /id="adr-sections"/);
});

test("parseSpinePass injects adr-sections when missing", () => {
  const raw = JSON.stringify({
    css: ":root{--primary:#123}",
    shellHtml: "<!DOCTYPE html><html><body><header></header></body></html>",
  });
  const spine = parseSpinePass(raw);
  assert.match(spine.shellHtml, /id="adr-sections"/);
});

test("parseHeroPass requires header and hero section", () => {
  const raw = JSON.stringify({
    headerHtml: '<header><img data-logo-role="company" src="x"></header>',
    heroHtml: '<section data-section-id="hero"><h1>Offer</h1></section>',
    title: "Brand",
    imageSlots: [
      {
        id: "img-1",
        sectionId: "hero",
        purpose: "hero",
        prompt: "Soft daylight dental clinic interior with empty wall space.",
        aspectRatio: "1920:1088",
        alt: "Clinic",
        kind: "illustrative",
        priority: 1,
      },
    ],
  });
  const hero = parseHeroPass(raw);
  assert.match(hero.headerHtml, /<header/i);
  assert.match(hero.heroHtml, /data-section-id="hero"/);
  assert.equal(hero.imageSlots.length, 1);
});

test("parseBodyBatch returns section fragments", () => {
  const raw = JSON.stringify({
    sections: [
      {
        id: "proof",
        heading: "Trusted care",
        html: '<section data-section-id="proof"><h2>Trusted</h2></section>',
        imageSlots: [],
      },
      {
        id: "cta",
        html: '<section data-section-id="cta"><a href="/book">Book</a></section>',
        imageSlots: [],
      },
    ],
  });
  const batch = parseBodyBatch(raw);
  assert.equal(batch.sections.length, 2);
  assert.equal(batch.sections[0].id, "proof");
});

test("assembleUnifiedHtml stitches spine hero and body", () => {
  const assembled = assembleUnifiedHtml({
    spine: {
      css: ":root{--primary:#0a0;--bg-page:#fff}",
      shellHtml:
        '<!DOCTYPE html><html><head><title>Old</title></head><body><header>placeholder</header><main id="adr-sections"></main><footer></footer></body></html>',
    },
    hero: {
      headerHtml: '<header><img data-logo-role="company" src="logo"></header>',
      heroHtml: '<section data-section-id="hero"><h1>Compassionate care</h1></section>',
      footerHtml: "<footer>Contact</footer>",
      title: "Client Dental",
      description: "Book a visit",
      imageSlots: [
        {
          id: "img-1",
          sectionId: "hero",
          purpose: "hero",
          prompt: "Bright clinic waiting room with soft daylight and calm tones.",
          aspectRatio: "1920:1088",
          alt: "Clinic",
          kind: "illustrative",
          priority: 1,
        },
      ],
      warnings: [],
      unresolvedRequirements: [],
    },
    bodySections: [
      {
        id: "services",
        heading: "Services",
        purpose: "features",
        html: '<section data-section-id="services"><h2>Services</h2></section>',
        imageSlots: [],
      },
    ],
    imageBudget: 2,
  });
  assert.match(assembled.html, /:root\{--primary/);
  assert.match(assembled.html, /data-logo-role="company"/);
  assert.match(assembled.html, /Compassionate care/);
  assert.match(assembled.html, /data-section-id="services"/);
  assert.match(assembled.html, /<title>Client Dental<\/title>/);
  assert.match(assembled.html, /Contact/);
  assert.equal(assembled.imageSlots.length, 1);
  assert.ok(assembled.sections && assembled.sections.length >= 2);
});

test("leanAssetSrc strips data URIs that would inflate Claude input tokens", async () => {
  const { leanAssetSrc, buildDeterministicSpine } = await import(
    "../src/lib/pipeline/unified/brief"
  );
  const huge = `data:image/png;base64,${"A".repeat(200_000)}`;
  assert.equal(leanAssetSrc(huge, "identity"), "{{ADRIVAL_IDENTITY_LOGO}}");
  const spine = buildDeterministicSpine({
    text: JSON.stringify({
      brandBrief: {
        name: "Acme",
        palette: { primary: "#111", secondary: "#222", accent: "#333", background: "#fff", text: "#000" },
      },
    }),
    imageTiles: [],
    sectionCount: 0,
    assetCount: 0,
    compact: false,
  });
  assert.match(spine.css, /:root/);
  assert.match(spine.shellHtml, /id="adr-sections"/);
  assert.match(spine.css, /#111/);
});
