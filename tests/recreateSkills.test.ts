import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv } from "../src/lib/pipeline/skills/csv";
import { designPlaybook, repairGuide, styleGuide } from "../src/lib/pipeline/skills/playbook";
import { industryBrief, matchIndustry } from "../src/lib/pipeline/skills/industry";
import { applyDesignFixes, runDesignCheck } from "../src/lib/pipeline/skills/designAudit";
import { designSystemToDesignMd } from "../src/lib/pipeline/skills/designMd";
import { buildDesignSystem } from "../src/lib/pipeline/unified/designSystem";
import type { BrandColors } from "../src/lib/types";

const colors = { primary: "#A4D36B", secondary: "#072032", accent: "#A4D36B", background: "#F9FBFF", text: "#000000" } as BrandColors;

function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test("CSV parsing keeps quoted commas, quotes and newlines", () => {
  const rows = parseCsv('No,Name,Notes\n1,"Plumber, Electrician","Say ""hi""\nthere"\n2,Dentist,\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Name, "Plumber, Electrician");
  assert.equal(rows[0].Notes, 'Say "hi"\nthere');
  assert.equal(rows[1].Notes, "");
});

test("the playbook loads the fixed rules, and style rules only for a chosen style", () => {
  const playbook = designPlaybook();
  assert.match(playbook, /DESIGN PLAYBOOK/);
  assert.match(playbook, /competitor's layout/i);
  assert.match(playbook, /em dashes/i);
  assert.equal(styleGuide("brand"), null);
  assert.match(styleGuide("minimal") || "", /Minimal/);
  assert.match(styleGuide("brutalist") || "", /brutalist/i);
  assert.match(repairGuide(), /do not redesign/i);
});

test("industry lookup finds the client's industry and stays silent when unsure", () => {
  const plumber = matchIndustry({ industry: "Plumbing", offerings: ["blocked drains", "hot water systems"], keyword: "emergency plumber" });
  assert.ok(plumber);
  assert.match(plumber.productType, /Plumber/);
  assert.ok(plumber.fonts?.heading);
  assert.match(plumber.palette?.primary || "", /^#[0-9A-F]{6}$/i);
  assert.equal(industryBrief(plumber)?.industry, plumber.productType);
  // No good match: no guide rather than a wrong one.
  assert.equal(matchIndustry({ industry: "Accounting", offerings: ["tax returns"], keyword: "accountant" }), null);
});

test("fonts: the brand's own win; the industry pairing fills in when the brand has none", () => {
  const withIndustry = buildDesignSystem({ shape: null, colors, industryFonts: { heading: "Lexend", body: "Source Sans 3" } });
  assert.deepEqual(withIndustry.families, { heading: "Lexend", body: "Source Sans 3" });
  const withBrand = buildDesignSystem({
    shape: null,
    colors,
    brandDesign: { fonts: ["Montserrat"] } as never,
    industryFonts: { heading: "Lexend", body: "Source Sans 3" },
  });
  assert.equal(withBrand.families.heading, "Montserrat");
  assert.equal(withBrand.families.body, "Montserrat");
});

test("style directions change the surfaces, not the brand colours", () => {
  const brand = buildDesignSystem({ shape: null, colors });
  const brutal = buildDesignSystem({ shape: null, colors, style: "brutalist" });
  const soft = buildDesignSystem({ shape: null, colors, style: "soft" });
  const minimal = buildDesignSystem({ shape: null, colors, style: "minimal" });
  assert.equal(brutal.tokens["--radius-btn"], "0px");
  assert.equal(brutal.tokens["--radius-card"], "0px");
  assert.equal(brutal.tokens["--shadow-card"], "none");
  assert.equal(soft.tokens["--radius-btn"], "999px");
  assert.equal(minimal.tokens["--shadow-card"], "none");
  assert.match(brutal.css, /style: bold \/ brutalist/);
  for (const ds of [brutal, soft, minimal]) assert.equal(ds.tokens["--primary"], brand.tokens["--primary"]);
});

test("highlights on dark bands meet WCAG AA, and dark bands get their own readable tokens", () => {
  const ds = buildDesignSystem({ shape: null, colors });
  const onDark = ds.tokens["--accent-on-dark"];
  assert.ok(contrast(onDark, ds.tokens["--bg-dark"]) >= 4.5, `${onDark} on ${ds.tokens["--bg-dark"]}`);
  assert.match(ds.css, /\.adr-section--dark,\.adr-header--dark,\.adr-footer--dark\{--text-safe:var\(--accent-on-dark\)/);
  assert.match(ds.css, /prefers-reduced-motion:reduce/);
  assert.match(ds.css, /:focus-visible\{outline:3px/);
});

test("automatic fixes follow the web interface guidelines without touching scripts", () => {
  const html = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"><style>.x{transition: all .3s ease}</style></head><body>
<main><section data-section-id="sec-1"><h1>Fast plumbing — done right</h1><p>Open 7–5 daily... call us</p><img src="a.jpg"></section>
<section data-section-id="sec-2"><img src="b.jpg" alt="Van"><a href="https://x.test" target="_blank">Site</a>
<form><label for="e">Email</label><input id="e" name="email" type="email"><input name="phone" type="tel" aria-label="Phone"></form></section></main>
<script>var s = "keep — this...";</script></body></html>`;
  const { html: out, fixed } = applyDesignFixes(html);
  assert.match(out, /Fast plumbing, done right/);
  assert.match(out, /Open 7-5 daily… call us/);
  assert.match(out, /keep — this\.\.\./, "script text is left alone");
  assert.match(out, /content="width=device-width, initial-scale=1"/);
  assert.match(out, /autocomplete="email"/);
  assert.match(out, /autocomplete="tel"/);
  assert.match(out, /spellcheck="false"/);
  assert.match(out, /<img src="a.jpg" alt=""/);
  assert.match(out, /alt="Van" loading="lazy"/);
  assert.match(out, /rel="noopener"/);
  assert.doesNotMatch(out, /transition:\s*all/);
  assert.ok(fixed.length >= 5);
});

test("the design check ties findings to sections and leaves brand choices as report-only", async () => {
  const ds = buildDesignSystem({ shape: null, colors });
  const html = `<!DOCTYPE html><html><head><style>${ds.css}
[data-section-id="sec-2"] h2{background:linear-gradient(90deg,#8b5cf6,#06b6d4);-webkit-background-clip:text;background-clip:text;color:transparent}</style></head><body>
<main><section class="adr-section" data-section-id="sec-1"><div class="adr-container"><h1>Plumbing in Ballarat</h1><p>Call us any time for blocked drains and hot water.</p></div></section>
<section class="adr-section" data-section-id="sec-2"><div class="adr-container"><h2>Why locals choose us</h2><form><input name="suburb" type="text"></form></div></section></main></body></html>`;
  const check = await runDesignCheck(html);
  const label = check.findings.find((f) => f.rule === "missing-label");
  assert.ok(label, "unlabelled field is reported");
  assert.equal(label.sectionId, "sec-2");
  assert.ok((check.repairable["sec-2"] || []).length >= 1);
  if (check.engine === "impeccable") {
    assert.ok(check.findings.some((f) => f.rule === "gradient-text" && f.sectionId === "sec-2"), "engine finding is tied to its section");
    // Brand-level findings (e.g. the font) are never sent for a rewrite.
    for (const f of check.findings.filter((x) => x.action === "report")) assert.equal(f.sectionId, null);
  }
});

test("the DESIGN.md style file follows the awesome-design-md layout", () => {
  const ds = buildDesignSystem({ shape: null, colors, style: "minimal" });
  const md = designSystemToDesignMd({ design: ds, clientName: "Northside Plumbing", clientUrl: "https://northside.test", competitorName: "Rival Co", industry: "Home Services" });
  for (const heading of ["## Overview", "## Colors", "## Typography", "## Layout", "## Elevation", "## Components", "## Responsive Behavior"]) {
    assert.ok(md.includes(heading), heading);
  }
  assert.ok(md.includes(ds.tokens["--primary"]));
  assert.match(md, /Style direction: Minimal/);
});
