import assert from "node:assert/strict";
import { test } from "node:test";
import { logoStatus } from "../src/lib/pipeline/design/constructPage";
import { holdAssets } from "../src/lib/pipeline/unified/generateBlueprint";
import { buildDesignSystem } from "../src/lib/pipeline/unified/designSystem";
import { renderForReview } from "../src/lib/pipeline/unified/visualReview";

const base = {
  finalUrl: "https://clicktrends.com.au",
  faviconUrl: null,
  ogImageUrl: null,
  navLinks: [],
  footerLinks: [],
  socialLinks: [],
  emails: [],
  phones: [],
};

test("a store screenshot marked as the logo loses to the theme logo named after the business", () => {
  const status = logoStatus({
    ...base,
    siteName: "Click Trends",
    logoUrl: "https://clicktrends.com.au/wp-content/uploads/2025/05/image-1-2.png",
    images: [
      { src: "https://clicktrends.com.au/wp-content/uploads/2025/05/image-1-2.png", alt: "Mobile-friendly Magento store preview", kind: "logo" },
      { src: "https://clicktrends.com.au/wp-content/themes/aimo/assets/img/logo.png", alt: "Click Trends", kind: "logo" },
    ],
  });
  assert.equal(status.url, "https://clicktrends.com.au/wp-content/themes/aimo/assets/img/logo.png");
});

test("a screenshot is never used as the logo, even when it is the only candidate", () => {
  const status = logoStatus({
    ...base,
    siteName: "Click Trends",
    logoUrl: "https://clicktrends.com.au/wp-content/uploads/2025/05/image-1-2.png",
    images: [{ src: "https://clicktrends.com.au/wp-content/uploads/2025/05/image-1-2.png", alt: "Mobile-friendly Magento store preview", kind: "logo" }],
  });
  assert.equal(status.url, null);
});

test("embedded images are held out of a rewrite and put back", () => {
  const uri = `data:image/png;base64,${"A".repeat(5000)}`;
  const html = `<section data-section-id="sec-2"><img data-adrival-slot="img-sec-2" src="${uri}"><p>Hi</p></section>`;
  const held = holdAssets(html);
  assert.equal(held.count, 1);
  assert.ok(held.html.length < 200, "the base64 is not sent to the model");
  assert.equal(held.restore(held.html), html);
});

test("card grids cap their columns and never shrink below a readable width", () => {
  const design = buildDesignSystem({ shape: null, colors: { primary: "#FF602F", secondary: "#360F03", accent: "#FF602F", background: "#FFFFFF", text: "#000000" }, brandDesign: null, formStyle: null });
  assert.match(design.css, /\.adr-grid--4\{grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,max\(210px/);
  assert.match(design.css, /\.adr-grid>\*\{min-width:0\}/);
});

test("with the page stylesheet, four cards beside a heading fold into readable columns", { timeout: 60_000 }, async () => {
  const design = buildDesignSystem({ shape: null, colors: { primary: "#FF602F", secondary: "#360F03", accent: "#FF602F", background: "#FFFFFF", text: "#000000" }, brandDesign: null, formStyle: null });
  const card = (t: string) => `<div class="adr-card"><h3>${t}</h3><p>Funnels and pages tested continuously, so improvements compound instead of stalling after launch.</p></div>`;
  const html = `<!DOCTYPE html><html><head><style>${design.css}</style></head><body><main>
    <section class="adr-section" data-section-id="sec-2"><div class="adr-container"><div class="adr-split"><div><h2>One system covers search, ads, web and conversion.</h2><p>Click Trends runs every channel from a single system.</p></div>
    <div class="adr-grid adr-grid--4">${card("SEO")}${card("Paid ads")}${card("Web development")}${card("Conversion optimisation")}</div></div></div></section>
  </main></body></html>`;
  const rendered = await renderForReview(html);
  assert.deepEqual(rendered.lint.get("sec-2"), [], (rendered.lint.get("sec-2") || []).join(" "));
});

test("the browser review measures squeezed cards and mixed alignment", { timeout: 60_000 }, async () => {
  const card = (t: string) => `<div class="adr-card"><h3>${t}</h3><p>Rankings and organic traffic built on ongoing technical and content work, not a one-off audit.</p></div>`;
  const html = `<!DOCTYPE html><html><head><style>
    body{margin:0;font:16px/1.5 sans-serif}
    .adr-container{width:1200px;margin:0 auto}
    .adr-split{display:grid;grid-template-columns:1fr 1fr;gap:40px}
    .adr-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:24px}
    .c{text-align:center}
  </style></head><body>
  <header class="adr-header"><a class="adr-brand" href="#">Brand</a></header>
  <main>
    <section data-section-id="sec-2"><div class="adr-container adr-split"><div><h2>One system covers search, ads, web and conversion.</h2></div>
      <div class="adr-grid">${card("SEO")}${card("Paid ads")}${card("Web development")}${card("Conversion optimisation")}</div></div></section>
    <section data-section-id="sec-3"><div class="adr-container"><h2 class="c">A centred heading</h2><p>But the paragraph under it is left aligned and runs across the whole container width.</p></div></section>
  </main>
  <footer class="adr-footer">Footer</footer></body></html>`;
  const rendered = await renderForReview(html);
  assert.deepEqual(rendered.order, ["header", "sec-2", "sec-3", "footer"]);
  const sec2 = (rendered.lint.get("sec-2") || []).join(" ");
  assert.match(sec2, /narrow column|under 150px/);
  assert.match((rendered.lint.get("sec-3") || []).join(" "), /mixing centred and left-aligned/);
  assert.ok(rendered.crops.get("sec-2"), "each part is cropped for the reviewer");
});
