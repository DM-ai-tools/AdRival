import assert from "node:assert/strict";
import { test } from "node:test";
import { captureSite, contrastRatio, recentlyChecked } from "../src/lib/pipeline/unified/brandColorCheck";

test("the site's real colours are measured by role", { timeout: 90_000 }, async () => {
  const html = `<!doctype html><html><head><style>
    body{margin:0;background:#ffffff;color:#1f2937;font:16px sans-serif}
    header{background:#360f03;color:#fff;padding:20px}
    .btn{display:inline-block;background:#ff602f;color:#fff;padding:14px 28px;border-radius:30px}
    h1,h2{color:#111827}
    footer{background:#360f03;color:#fff;padding:60px}
    section{padding:80px 20px}
  </style></head><body>
  <header><a href="#">Click Trends</a></header>
  <section><h1>Digital growth marketing</h1><p>Paid search and SEO for Melbourne businesses.</p><a class="btn" href="#">Get a free audit</a></section>
  <section><h2>Services</h2><p>Google Ads, Meta Ads, SEO.</p><button class="btn">Talk to us</button></section>
  <footer>Footer</footer></body></html>`;
  const site = await captureSite(`data:text/html,${encodeURIComponent(html)}`);
  const has = (role: string, hex: string) => site.swatches.some((s) => s.role === role && s.hex === hex);
  assert.ok(has("button-background", "#FF602F"), JSON.stringify(site.swatches));
  assert.ok(has("header-background", "#360F03"));
  assert.ok(has("footer-background", "#360F03"));
  assert.ok(has("page-background", "#FFFFFF"));
  assert.ok(has("heading-text", "#111827"));
  assert.ok(site.images.length >= 1, "the page is screenshotted for the review");
});

test("a palette checked recently on the same site is not checked again", () => {
  const colors = { primary: "#FF602F", secondary: "#360F03", accent: "#FF602F", background: "#FFFFFF", text: "#000000" };
  assert.equal(recentlyChecked(colors, "https://clicktrends.com.au"), false, "never checked");
  const checked = { ...colors, source: "firecrawl-branding+visual-check", checkedAt: new Date().toISOString(), checkedUrl: "https://www.clicktrends.com.au/" };
  assert.equal(recentlyChecked(checked, "https://clicktrends.com.au/services"), true);
  assert.equal(recentlyChecked(checked, "https://othersite.com"), false, "a different website is checked");
  const old = { ...checked, checkedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() };
  assert.equal(recentlyChecked(old, "https://clicktrends.com.au"), false, "old checks are redone");
});

test("contrast ratio matches the WCAG formula", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#FFFFFF")), 21);
  assert.ok(contrastRatio("#FF602F", "#FFFFFF") < 4.5);
});
