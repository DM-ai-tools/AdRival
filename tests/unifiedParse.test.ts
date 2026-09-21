import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnifiedResponse } from "../src/lib/pipeline/unified/contract";

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
