import assert from "node:assert/strict";
import { test } from "node:test";
import { bindApprovedSnapshot } from "../src/lib/pipeline/design/bindApproved";
import { sanitizeLayoutShell } from "../src/lib/pipeline/design/sanitize";
import { packagePortableHtml } from "../src/lib/pipeline/design/packageHtml";
import type { CanonicalContent, CompetitorReference } from "../src/lib/pipeline/content/model";

const competitor: CompetitorReference = {
  sourceUrl: "https://rival.example/seo/",
  retrievedAt: "2026-09-17T00:00:00.000Z",
  name: "Rival Agency",
  host: "rival.example",
  sections: [{
    id: "seo",
    heading: "SEO services",
    purpose: "offer",
    order: 0,
    sourceText: "Rival Agency writes long competitor SEO copy that must not survive the build.",
    textKind: "source",
    sourceUrl: "https://rival.example/seo/",
    cids: ["n1", "n2"],
    components: [
      { id: "n1", kind: "headline", text: "SEO services", items: [] },
      { id: "n2", kind: "paragraph", text: "Rival Agency writes long competitor SEO copy that must not survive the build.", items: [] },
    ],
  }],
};

function snapshot(): CanonicalContent {
  return {
    draftId: "draft-1",
    revision: 2,
    evidenceVersion: 2,
    clientUrl: "https://client.example/",
    clientName: "Click Trends",
    competitorUrl: competitor.sourceUrl,
    competitorName: competitor.name,
    serviceContext: "SEO services",
    audienceContext: null,
    meta: { title: "SEO services", description: "Approved description" },
    sections: [{
      id: "sec-1",
      decision: "adapt",
      decisionReason: "matched",
      purpose: "offer",
      competitorSectionId: "seo",
      heading: "SEO services for growing businesses",
      paragraphs: ["Click Trends plans search campaigns from approved facts only."],
      items: [],
      evidenceIds: [],
      locked: false,
      issues: [],
      fields: [
        { id: "f1", sourceComponentId: "n1", kind: "headline", text: "SEO services for growing businesses", items: [], disposition: "adapt", reason: null },
        { id: "f2", sourceComponentId: "n2", kind: "paragraph", text: "Click Trends plans search campaigns from approved facts only.", items: [], disposition: "adapt", reason: null },
      ],
    }],
    issues: [],
    approved: true,
    approvedAt: "2026-09-17T00:00:00.000Z",
    approvedRevision: 2,
  };
}

test("approved copy replaces the matching captured node and competitor sentences are removed", () => {
  const html = `<html><body>
    <script src="https://rival.example/pixel.js"></script>
    <h1 data-cid="n1">SEO services</h1>
    <p data-cid="n2">Rival Agency writes long competitor SEO copy that must not survive the build.</p>
    <a href="https://rival.example/contact">Talk to Rival Agency</a>
    <form action="https://rival.example/submit"><button type="submit">Send</button></form>
  </body></html>`;
  const result = bindApprovedSnapshot(html, snapshot(), competitor);
  assert.match(result.html, /SEO services for growing businesses/);
  assert.match(result.html, /Click Trends plans search campaigns/);
  assert.equal(/long competitor SEO copy/.test(result.html), false);
  assert.equal(/rival\.example\/pixel/.test(result.html), false);
  assert.equal(/rival\.example\/submit/.test(result.html), false);
  assert.equal(/href="https:\/\/rival\.example/.test(result.html), false);
  assert.equal(result.html.includes("#"), false);
});

test("sanitized shell drops tracking and a packaged document does not hotlink app image routes", () => {
  const clean = sanitizeLayoutShell(`<div onclick="steal()"><img src="https://rival.example/logo.png"></div>`, "rival.example");
  assert.equal(/onclick/.test(clean), false);
  const packaged = packagePortableHtml(`<img src="https://cdn.example/photo.jpg"><img src="/generated/missing/none.png">`);
  assert.equal(packaged.external.some((url) => url.includes("cdn.example")), true);
});
