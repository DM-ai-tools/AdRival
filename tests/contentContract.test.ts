import assert from "node:assert/strict";
import test from "node:test";
import { assembleDraft, draftFromProviderOutput, type DraftModelResult } from "../src/lib/pipeline/content/generate";
import { planSections } from "../src/lib/pipeline/content/plan";
import {
  acceptProposal,
  approveSnapshot,
  confirmClaim,
  ContentRevisionError,
  proposeSection,
  saveCanonical,
} from "../src/lib/pipeline/content/revisions";
import {
  assertDesignFeedbackIsLayoutOnly,
  auditBuiltHtml,
  requireApprovedSnapshot,
} from "../src/lib/pipeline/content/designGate";
import {
  assertCanDraft,
  clearEvidenceCache,
  researchClientSite,
  selectResearchUrls,
} from "../src/lib/pipeline/content/research";
import { recreationActionPermission } from "../src/lib/pipeline/content/permissions";
import { evidenceCacheKey, type ClientEvidenceRecord, type CompetitorReference, type ContentPack } from "../src/lib/pipeline/content/model";
import { applyValidation } from "../src/lib/pipeline/content/validate";

function fact(partial: Partial<ClientEvidenceRecord["facts"][number]> & { id: string; category: ClientEvidenceRecord["facts"][number]["category"]; value: string }): ClientEvidenceRecord["facts"][number] {
  return {
    sourceUrl: "https://client.example/services",
    excerpt: partial.value,
    retrievedAt: "2026-09-16T00:00:00.000Z",
    status: "stated_on_site",
    ...partial,
  };
}

function evidence(facts: ClientEvidenceRecord["facts"]): ClientEvidenceRecord {
  return {
    version: 1,
    ownerUserId: "owner-a",
    spaceId: "space-a",
    enteredUrl: "https://client.example/services",
    canonicalUrl: "https://client.example/services",
    pageKind: "service",
    businessName: "Northwind Studio",
    facts,
    pagesRead: [{ url: "https://client.example/services", title: "Services", ok: true }],
    unavailable: [],
    retrievedAt: "2026-09-16T00:00:00.000Z",
    incomplete: false,
    missingEssential: [],
  };
}

function rival(): CompetitorReference {
  return {
    sourceUrl: "https://rival.example/offer",
    retrievedAt: "2026-09-16T00:00:00.000Z",
    name: "Rival Labs",
    host: "rival.example",
    sections: [
      { id: "src-offer", heading: "$99 launch offer", purpose: "Present the commercial offer", order: 0, sourceText: "Get the Rival Labs activation call for $99 this week only.", textKind: "source", sourceUrl: "https://rival.example/offer", cids: ["c1"] },
      { id: "src-media", heading: "As seen in", purpose: "Show press logos", order: 1, sourceText: "As seen in Forbes and TechCrunch.", textKind: "source", sourceUrl: "https://rival.example/offer", cids: ["c2"] },
      { id: "src-quotes", heading: "Testimonials", purpose: "Show customer quotes", order: 2, sourceText: "Jane from Acme says Rival Labs changed everything.", textKind: "source", sourceUrl: "https://rival.example/offer", cids: ["c3"] },
      { id: "src-proof", heading: "Results", purpose: "Show a customer result", order: 3, sourceText: "Google Partner teams delivered 300% more leads.", textKind: "source", sourceUrl: "https://rival.example/offer", cids: ["c4"] },
    ],
  };
}

function packFrom(docFacts: ClientEvidenceRecord, docRival = rival(), model: DraftModelResult = { meta: { title: "Northwind Studio", description: "Web design for local businesses." }, sections: [] }): ContentPack {
  const canonical = assembleDraft({
    evidence: docFacts,
    competitor: docRival,
    modelName: model === undefined ? "test" : "test-model",
    modelResult: model,
  });
  return {
    evidence: docFacts,
    competitor: docRival,
    canonical,
    approvedSnapshot: null,
    proposal: null,
    previous: null,
    legacy: false,
  };
}

const baseFacts = [
  fact({ id: "ev-name", category: "identity", value: "Northwind Studio" }),
  fact({ id: "ev-service", category: "service", value: "Northwind Studio designs websites for independent shops." }),
  fact({ id: "ev-contact", category: "contact", value: "hello@client.example" }),
];

test("competitor $99 offer is not copied into client copy", () => {
  const pack = packFrom(evidence(baseFacts), rival(), {
    meta: { title: "Northwind Studio", description: "Website design." },
    sections: [{ competitorSectionId: "src-offer", heading: "Launch for $99", paragraphs: ["Start for $99 this week."], evidenceIds: [] }],
  });
  const text = JSON.stringify(pack.canonical.sections);
  assert.equal(text.includes("$99"), false);
});

test("customer logos are not treated as press mentions", () => {
  const facts = [...baseFacts, fact({ id: "ev-customer", category: "customer", value: "Corner Cafe", excerpt: "Our customers include Corner Cafe." })];
  const plans = planSections(rival(), evidence(facts));
  const media = plans.find((plan) => plan.competitorSectionId === "src-media");
  assert.equal(media?.decision, "omit");
  assert.match(media?.reason || "", /not client press/i);
});

test("missing testimonials are omitted instead of invented", () => {
  const plans = planSections(rival(), evidence(baseFacts));
  assert.equal(plans.find((plan) => plan.competitorSectionId === "src-quotes")?.decision, "omit");
  const pack = packFrom(evidence(baseFacts), rival(), {
    meta: { title: "Northwind Studio", description: "Design." },
    sections: [{ competitorSectionId: "src-quotes", heading: "Clients love us", paragraphs: ["Five stars from Jane."], items: [{ id: "q1", kind: "testimonial", label: "Jane", detail: "Amazing", evidenceIds: [] }] }],
  });
  const quotes = pack.canonical.sections.find((section) => section.competitorSectionId === "src-quotes");
  assert.equal(quotes?.decision, "omit");
  assert.equal(quotes?.items.length, 0);
  assert.equal(JSON.stringify(quotes).includes("Jane"), false);
});

test("Google Partner and competitor results do not transfer", () => {
  const pack = packFrom(evidence(baseFacts), rival(), {
    meta: { title: "Northwind Studio", description: "Design." },
    sections: [{ competitorSectionId: "src-proof", heading: "Proof", paragraphs: ["We are a Google Partner with 300% more leads."], evidenceIds: [] }],
  });
  const text = JSON.stringify(pack.canonical.sections.find((section) => section.competitorSectionId === "src-proof"));
  assert.equal(/google partner/i.test(text), false);
});

test("an expired promotion is not presented as current", () => {
  const facts = [...baseFacts, fact({ id: "ev-old", category: "offer", value: "$50 off", qualifiers: "expired or no longer current", excerpt: "The $50 off offer ended last month." })];
  const pack = packFrom(evidence(facts), rival(), {
    meta: { title: "Northwind Studio", description: "Design." },
    sections: [{ competitorSectionId: "src-offer", heading: "Current offer", paragraphs: ["Use $50 off today."], evidenceIds: ["ev-old"] }],
  });
  const offer = pack.canonical.sections.find((section) => section.competitorSectionId === "src-offer");
  assert.equal((offer?.paragraphs.join(" ") || "").includes("$50"), false);
});

test("failed client research does not substitute competitor facts", async () => {
  clearEvidenceCache();
  const record = await researchClientSite({
    enteredUrl: "https://missing.example",
    ownerUserId: "owner-a",
    spaceId: "space-a",
  }, {
    map: async () => ["https://rival.example/secret"],
    scrape: async () => { throw new Error("blocked"); },
  });
  assert.equal(record.facts.some((item) => item.value.includes("Rival")), false);
  assert.throws(() => assertCanDraft(record), /Competitor facts were not used/);
});

test("a manually added unsupported claim stays flagged until confirmed", () => {
  const pack = packFrom(evidence(baseFacts));
  const next: ContentPack["canonical"] = {
    ...pack.canonical,
    sections: pack.canonical.sections.map((section) =>
      section.decision === "omit" ? section : { ...section, paragraphs: ["We guarantee a free audit for every customer."] },
    ),
  };
  const saved = saveCanonical(pack, next, pack.canonical.revision);
  assert.ok(saved.canonical.issues.some((item) => item.severity === "critical"));
  const confirmed = confirmClaim(saved, { sectionId: saved.canonical.sections[0].id, value: "We guarantee a free audit for every customer.", confirmedBy: "owner-a" });
  const factRow = confirmed.evidence.facts.find((item) => item.status === "user_confirmed");
  assert.equal(factRow?.confirmedBy, "owner-a");
  assert.notEqual(factRow?.status, "stated_on_site");
});

test("section regeneration is a proposal and locked sections stay put", () => {
  const pack = packFrom(evidence(baseFacts));
  const first = pack.canonical.sections[0];
  const locked = pack.canonical.sections[1];
  const edited = saveCanonical(pack, {
    ...pack.canonical,
    sections: pack.canonical.sections.map((section) => section.id === locked.id ? { ...section, locked: true, heading: "Keep me" } : section),
  }, pack.canonical.revision);
  const proposed = proposeSection(edited, {
    sectionId: first.id,
    basedOnRevision: edited.canonical.revision,
    section: { ...first, heading: "New heading", paragraphs: ["Updated service copy."] },
  });
  assert.equal(proposed.canonical.sections.find((section) => section.id === locked.id)?.heading, "Keep me");
  assert.notEqual(proposed.canonical.sections.find((section) => section.id === first.id)?.heading, "New heading");
  const accepted = acceptProposal(proposed);
  assert.equal(accepted.canonical.sections.find((section) => section.id === first.id)?.heading, "New heading");
  assert.equal(accepted.canonical.sections.find((section) => section.id === locked.id)?.heading, "Keep me");
});

test("saved edits are the approval snapshot", () => {
  const pack = packFrom(evidence(baseFacts));
  const target = pack.canonical.sections.find((section) => section.decision !== "omit")!;
  const saved = saveCanonical(pack, {
    ...pack.canonical,
    sections: pack.canonical.sections.map((section) => section.id === target.id ? { ...section, heading: "Saved heading" } : section),
  }, pack.canonical.revision);
  const approved = approveSnapshot(saved, saved.canonical.revision);
  assert.equal(approved.approvedSnapshot?.sections.find((section) => section.id === target.id)?.heading, "Saved heading");
  assert.equal(approved.approvedSnapshot?.revision, saved.canonical.revision);
});

test("stale saves and late proposals cannot overwrite a newer revision", () => {
  const pack = packFrom(evidence(baseFacts));
  const saved = saveCanonical(pack, pack.canonical, pack.canonical.revision);
  assert.throws(() => saveCanonical(saved, pack.canonical, pack.canonical.revision), ContentRevisionError);
  assert.throws(
    () => proposeSection(saved, { sectionId: saved.canonical.sections[0].id, basedOnRevision: pack.canonical.revision, section: saved.canonical.sections[0] }),
    ContentRevisionError,
  );
});

test("primary and fallback model output use the same validator", () => {
  const raw = JSON.stringify({
    meta: { title: "Northwind Studio", description: "Design." },
    sections: [{ competitorSectionId: "src-offer", heading: "Only $99", paragraphs: ["Book an activation call."], evidenceIds: [] }],
  });
  const claude = draftFromProviderOutput({ raw, evidence: evidence(baseFacts), competitor: rival(), modelName: "claude" });
  const openAi = draftFromProviderOutput({ raw, evidence: evidence(baseFacts), competitor: rival(), modelName: "gpt-4.1" });
  assert.deepEqual(
    claude.sections.map((section) => section.paragraphs.join(" ")),
    openAi.sections.map((section) => section.paragraphs.join(" ")),
  );
  const visible = (doc: { sections: { heading: string; paragraphs: string[] }[] }) =>
    doc.sections.map((section) => `${section.heading} ${section.paragraphs.join(" ")}`).join("\n");
  assert.equal(visible(claude).includes("$99"), false);
  assert.equal(visible(openAi).includes("activation call"), false);
});

test("design feedback cannot change approved copy and missing mappings block the build", () => {
  const pack = packFrom(evidence(baseFacts));
  const snapshot = {
    ...pack.canonical,
    approved: true,
    approvedAt: "2026-09-16T00:00:00.000Z",
    approvedRevision: pack.canonical.revision,
    issues: [],
    sections: pack.canonical.sections.map((section) =>
      section.decision === "needs_input" ? { ...section, decision: "omit" as const, paragraphs: [] } : section,
    ),
  };
  assert.throws(() => assertDesignFeedbackIsLayoutOnly("keep the competitor guarantee"), /content review/);
  requireApprovedSnapshot(snapshot);
  const html = `<html><body><h2>Rival Labs secret offer</h2><p>${rival().sections[0].sourceText}</p></body></html>`;
  const errors = auditBuiltHtml(html, snapshot, rival());
  assert.ok(errors.some((item) => /missing|survived|Competitor name/i.test(item)));
});

test("search and lookup URLs stay on the client host and in the owner cache", () => {
  const searchUrls = selectResearchUrls(["https://client.example/", "https://rival.example/offer"], "https://client.example/services", 4);
  const lookupUrls = selectResearchUrls(["https://client.example/about", "https://ads.google.com"], "https://client.example/services", 4);
  assert.ok(searchUrls.every((url) => url.includes("client.example")));
  assert.ok(lookupUrls.every((url) => url.includes("client.example")));
  const a = evidenceCacheKey({ ownerUserId: "owner-a", spaceId: "space-a", canonicalUrl: "https://client.example/services" });
  const b = evidenceCacheKey({ ownerUserId: "owner-b", spaceId: "space-a", canonicalUrl: "https://client.example/services" });
  assert.notEqual(a, b);
});

test("viewer mutations are not edit or run actions of a different class", () => {
  assert.equal(recreationActionPermission("save_content"), "edit");
  assert.equal(recreationActionPermission("approve_content"), "edit");
  assert.equal(recreationActionPermission("generate_content"), "run");
  assert.equal(recreationActionPermission("build_design"), "run");
  const sharedName = applyValidation(
    {
      ...packFrom(evidence([fact({ id: "ev-name", category: "identity", value: "Northwind Studio" }), fact({ id: "ev-service", category: "service", value: "Design" })])).canonical,
      clientName: "Northwind Studio",
      competitorName: "Northwind Studio",
    },
    evidence([fact({ id: "ev-name", category: "identity", value: "Northwind Studio" }), fact({ id: "ev-service", category: "service", value: "Design" })]),
    { ...rival(), name: "Northwind Studio" },
  );
  assert.equal(sharedName.issues.some((item) => /Competitor name/.test(item.message)), false);
});

test("model copy in a body field is kept, and blank sections are filled from client evidence", () => {
  const raw = JSON.stringify({
    meta: { title: "Northwind Studio" },
    sections: [{ competitorSectionId: "src-offer", heading: "Services", body: "Northwind Studio designs websites for independent shops." }],
  });
  const draft = draftFromProviderOutput({
    raw,
    evidence: evidence(baseFacts),
    competitor: rival(),
    modelName: "claude",
  });
  const offer = draft.sections.find((section) => section.competitorSectionId === "src-offer");
  assert.match(offer?.paragraphs.join(" ") || "", /Northwind Studio designs websites/);
  assert.equal(draft.sections.some((section) => section.competitorSectionId !== "src-offer" && /Northwind Studio designs websites/.test(section.paragraphs.join(" "))), false);
});

test("a model response without a page title does not crash regeneration", () => {
  const raw = JSON.stringify({
    meta: { description: "Website design for independent shops." },
    sections: [{ competitorSectionId: "src-offer", heading: "How we work", paragraphs: ["Northwind Studio designs websites for independent shops."], evidenceIds: ["ev-service"] }],
  });
  const draft = draftFromProviderOutput({
    raw,
    evidence: evidence(baseFacts),
    competitor: rival(),
    modelName: "claude",
  });
  assert.equal(draft.meta.title, "Northwind Studio");
  assert.equal(typeof draft.meta.description, "string");
});

test("an email line is not placed in a specialization section", async () => {
  clearEvidenceCache();
  const record = await researchClientSite({
    enteredUrl: "https://client.example/services",
    ownerUserId: "owner-email",
    spaceId: "space-a",
  }, {
    scrape: async () => ({
      markdown: "# Click Trends\n\n- [info@clicktrends.com.au](mailto:info@clicktrends.com.au)\n\n## Specialisations\n\nClick Trends manages Google Ads for home service businesses and professional firms across Australia.\n",
      title: "Click Trends",
      links: [],
    }),
  });
  assert.equal(record.facts.some((fact) => fact.category === "service" && /mailto:|info@/i.test(fact.value)), false);
  assert.ok(record.facts.some((fact) => fact.category === "audience" || fact.category === "service"));
  const draft = assembleDraft({
    evidence: record,
    competitor: {
      ...rival(),
      sections: [{ id: "src-special", heading: "Specialization", purpose: "Explain the industries served", order: 0, sourceText: "Google Ad Specialists list of industries", textKind: "source", sourceUrl: "https://rival.example", cids: [] }],
    },
    modelName: "test",
    modelResult: {
      meta: { title: "Click Trends", description: "Google Ads management." },
      sections: [{ competitorSectionId: "src-special", heading: "Who we help", paragraphs: ["[info@clicktrends.com.au](mailto:info@clicktrends.com.au)"], evidenceIds: [] }],
    },
  });
  const copy = draft.sections.map((section) => section.paragraphs.join(" ")).join("\n");
  assert.equal(/mailto:|info@/i.test(copy), false);
  assert.match(copy, /home service businesses/);
});

test("legacy drafts cannot be approved as if they were evidence-checked", () => {
  const pack = packFrom(evidence(baseFacts));
  assert.throws(() => approveSnapshot({ ...pack, legacy: true }, pack.canonical.revision), ContentRevisionError);
});
