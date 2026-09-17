import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assignCollectionIds, duplicateEvidenceIds, looksLikeSlogan, repairCollidingEvidence } from "../src/lib/pipeline/content/evidenceIds";
import { factsForDrafting, inferPageIntent } from "../src/lib/pipeline/content/pageIntent";
import { resolveBusinessIdentity } from "../src/lib/pipeline/content/research";
import { hasUsableRenderedSource, inventoryFromAnalysisSummaries } from "../src/lib/pipeline/content/inventory";
import type { ClientEvidenceRecord, CompetitorReference, EvidenceFact } from "../src/lib/pipeline/content/model";

function fact(partial: Partial<EvidenceFact> & Pick<EvidenceFact, "id" | "value">): EvidenceFact {
  return {
    category: "service",
    sourceUrl: "https://clicktrends.com.au/",
    excerpt: partial.value,
    retrievedAt: "2026-09-17T00:00:00.000Z",
    status: "stated_on_site",
    ...partial,
  };
}

describe("pipeline repair", () => {
  it("gives two batches that both emitted ev-5 distinct persistent ids", () => {
    const batchA = [fact({ id: "ev-5", value: "Google Ads management", category: "service" })];
    const batchB = [fact({ id: "ev-5", value: "SEO retainers for local businesses", category: "service", sourceUrl: "https://clicktrends.com.au/seo" })];
    const assigned = assignCollectionIds([...batchA, ...batchB], { ownerUserId: "owner", spaceId: "space" });
    assert.equal(duplicateEvidenceIds(assigned).length, 0);
    assert.notEqual(assigned[0].id, assigned[1].id);
    assert.equal(assigned[0].value, "Google Ads management");
    assert.equal(assigned[1].value, "SEO retainers for local businesses");
  });

  it("does not guess which record an old shared ev-5 meant", () => {
    const repaired = repairCollidingEvidence(
      [
        fact({ id: "ev-5", value: "first fact" }),
        fact({ id: "ev-5", value: "second fact" }),
      ],
      { ownerUserId: "owner", spaceId: null },
    );
    assert.deepEqual(repaired.ambiguousIds, ["ev-5"]);
    assert.equal(repaired.facts.some((item) => item.id === "ev-5"), false);
    assert.equal(duplicateEvidenceIds(repaired.facts).length, 0);
  });

  it("does not treat section-purpose labels as the service", () => {
    const competitor: CompetitorReference = {
      sourceUrl: "https://www.edgeonline.com.au/seo/",
      retrievedAt: "2026-09-17T00:00:00.000Z",
      name: "Edge Online",
      host: "edgeonline.com.au",
      sections: [
        { id: "s1", heading: "Problem agitation", purpose: "problem", order: 0, sourceText: "Encourages action.", textKind: "summary", sourceUrl: "https://www.edgeonline.com.au/seo/", cids: [] },
        { id: "s2", heading: "Solution features", purpose: "solution", order: 1, sourceText: "Presents features.", textKind: "summary", sourceUrl: "https://www.edgeonline.com.au/seo/", cids: [] },
        { id: "s3", heading: "Additional services", purpose: "services", order: 2, sourceText: "Lists services.", textKind: "summary", sourceUrl: "https://www.edgeonline.com.au/seo/", cids: [] },
      ],
    };
    const intent = inferPageIntent(competitor);
    assert.equal(intent.primaryService, "");
    assert.equal(intent.usingSummaryOnly, true);
    assert.equal(hasUsableRenderedSource(inventoryFromAnalysisSummaries({
      sourceUrl: competitor.sourceUrl,
      sections: competitor.sections.map((section) => ({ name: section.heading, purpose: section.purpose })),
    })), false);
  });

  it("keeps a rendered SEO page on SEO, not a client city or slogan", () => {
    const competitor: CompetitorReference = {
      sourceUrl: "https://www.edgeonline.com.au/seo/",
      retrievedAt: "2026-09-17T00:00:00.000Z",
      name: "Edge Online",
      host: "edgeonline.com.au",
      sections: [{
        id: "seo",
        heading: "SEO services",
        purpose: "offer",
        order: 0,
        sourceText: "Search engine optimisation services for businesses that want more qualified enquiries from organic search.",
        textKind: "source",
        sourceUrl: "https://www.edgeonline.com.au/seo/",
        cids: ["n1"],
      }],
    };
    const intent = inferPageIntent(competitor);
    assert.match(intent.primaryService, /seo/i);
    assert.equal(/geelong|20\d{2}|problem agitation/i.test(intent.primaryService), false);
    const evidence = {
      businessName: null,
      facts: [
        fact({ id: "slogan", value: "Supercharge Your Growth", category: "positioning" }),
        fact({ id: "name", value: "Click Trends", category: "identity" }),
        fact({ id: "city", value: "Geelong", category: "location" }),
      ],
    } as ClientEvidenceRecord;
    assert.equal(looksLikeSlogan("Supercharge Your Growth"), true);
    assert.equal(resolveBusinessIdentity(evidence.facts, "https://clicktrends.com.au/")?.value, "Click Trends");
    assert.equal(factsForDrafting(evidence, intent).some((item) => item.value === "Geelong"), false);
  });
});
