import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnifiedResponse, placeholderDataUri, applyImageSlotsToHtml } from "../src/lib/pipeline/unified/contract";
import { initialStages, markStage, pctFromStages } from "../src/lib/pipeline/unified/stages";
import { injectIdentityLogo, validateAndPackageUnifiedPage } from "../src/lib/pipeline/unified/validate";
import { isUnifiedRunActive } from "../src/lib/pipeline/unified/run";
import { logoStatus } from "../src/lib/pipeline/design/constructPage";
import { packagePortableHtml } from "../src/lib/pipeline/design/packageHtml";
import type { RecreatedLandingPage } from "../src/lib/types";

test("unified stages never report 100% before ready", () => {
  let stages = initialStages();
  stages = markStage(stages, "creating_page", "indeterminate");
  const mid = pctFromStages(stages);
  assert.ok(mid > 0 && mid < 100);
  stages = markStage(stages, "ready", "done");
  // ready alone does not force 100 in pctFromStages; persist does at phase ready
  assert.ok(pctFromStages(stages) < 100 || stages.every((stage) => stage.status === "done"));
});

test("unified response rejects incomplete HTML", () => {
  assert.throws(() => parseUnifiedResponse('{"html":"<div>nope</div>","imageSlots":[]}'), /complete HTML/);
});

test("unified response accepts a full document and skips factual image slots", () => {
  const parsed = parseUnifiedResponse(JSON.stringify({
    html: "<!DOCTYPE html><html><head><style>.x{}</style></head><body><header></header><main><section><img data-adrival-slot=\"img-1\" src=\"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7\"></section></main><footer></footer></body></html>",
    imageSlots: [
      { id: "img-1", sectionId: "s1", purpose: "hero", prompt: "A calm office desk with soft daylight and empty space for a headline.", aspectRatio: "1920:1088", alt: "Office", kind: "illustrative", priority: 1 },
      { id: "img-2", sectionId: "s2", purpose: "team", prompt: "portrait of Jane", kind: "factual", priority: 2 },
    ],
    warnings: [],
    unresolvedRequirements: [],
  }));
  assert.equal(parsed.imageSlots.length, 1);
  assert.equal(parsed.imageSlots[0].id, "img-1");
});

test("placeholders preserve layout without showing provider prompts", () => {
  const src = placeholderDataUri({ id: "img-1", purpose: "hero band", width: 800, height: 500 });
  assert.match(src, /^data:image\/svg\+xml;base64,/);
  assert.equal(src.includes("A calm office"), false);
  const html = applyImageSlotsToHtml(
    '<img data-adrival-slot="img-1" src="about:blank" alt="">',
    new Map([["img-1", src]]),
  );
  assert.match(html, /data-adrival-slot="img-1"/);
  assert.match(html, /data-adrival-gen-id="img-1"/);
  assert.match(html, /data:image\/svg\+xml/);
});

test("validation packages the preview artifact", () => {
  const result = validateAndPackageUnifiedPage({
    html: "<!DOCTYPE html><html><head><style>body{margin:0}</style></head><body><header><img data-logo-role=\"company\" src=\"data:image/png;base64,aa\"></header><main><section><a href=\"https://client.example/contact\">Contact</a></section></main><footer></footer></body></html>",
    clientHost: "client.example",
    competitorHost: "rival.example",
    logoRequired: true,
    expectedSections: 4,
  });
  assert.equal(result.ok, true);
  assert.match(result.html, /<!DOCTYPE html>/i);
});

test("validation blocks competitor domain leakage", () => {
  const result = validateAndPackageUnifiedPage({
    html: "<!DOCTYPE html><html><head><style></style></head><body><header></header><main><section><a href=\"https://rival.example/x\">x</a></section></main><footer></footer></body></html>",
    clientHost: "client.example",
    competitorHost: "rival.example",
    logoRequired: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join(" "), /Competitor domain/);
});

test("preview and download packaging stay identical for embedded assets", () => {
  const source =
    "<!DOCTYPE html><html><head><style>body{margin:0}</style></head><body><img src=\"data:image/png;base64,abc\" alt=\"x\"></body></html>";
  const first = packagePortableHtml(source).html;
  const second = packagePortableHtml(first).html;
  assert.equal(first, second);
});

test("duplicate in-flight unified jobs are treated as active", () => {
  const page = {
    status: "design_pending",
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    businessUrl: "https://client.example",
    keyword: "test",
    sourceCompetitorName: "Rival",
    sourceAnalyzedUrl: "https://rival.example",
    brandColors: {
      primary: "#000",
      secondary: "#111",
      accent: "#222",
      background: "#fff",
      text: "#000",
    },
    pipelineVersion: "unified-1",
  } as RecreatedLandingPage;
  assert.equal(isUnifiedRunActive(page), true);
  assert.equal(
    isUnifiedRunActive({
      ...page,
      status: "completed",
    }),
    false,
  );
});

test("customer-looking logos are not preferred as company identity", () => {
  const status = logoStatus({
    logoUrl: null,
    faviconUrl: null,
    siteName: "Acme",
    images: [
      { src: "https://cdn.example/client-logo-handshake.png", alt: "partner handshake", kind: "logo" },
      { src: "https://cdn.example/logo.svg", alt: "Acme", kind: "logo" },
    ],
    navLinks: [],
    footerLinks: [],
    ctaLinks: [],
    socialLinks: [],
    emails: [],
    phones: [],
  } as never);
  assert.equal(status.url, "https://cdn.example/logo.svg");
});

test("injectIdentityLogo embeds company logo with containment", () => {
  const html = injectIdentityLogo(
    "<!DOCTYPE html><html><body><header><a class=\"adr-brand\" href=\"#\"></a></header><footer></footer></body></html>",
    "data:image/png;base64,COMPANY",
    "Traffic Radius",
    "https://client.example",
  );
  assert.match(html, /data-logo-role="company"/);
  assert.match(html, /data:image\/png;base64,COMPANY/);
  assert.match(html, /object-fit:\s*contain/i);
});
