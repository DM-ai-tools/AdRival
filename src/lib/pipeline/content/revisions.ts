import type {
  CanonicalContent,
  ClientEvidenceRecord,
  CompetitorReference,
  ContentPack,
  ContentSection,
  SectionProposal,
} from "./model";
import { applyValidation } from "./validate";
import { fidelityIssues } from "./fidelity";
import type { PageIntent } from "./pageIntent";

export class ContentRevisionError extends Error {
  readonly code = "content_revision_conflict";
  constructor(message: string) {
    super(message);
    this.name = "ContentRevisionError";
  }
}

export function stampDraft(
  doc: CanonicalContent,
  evidence: ClientEvidenceRecord,
  competitor: CompetitorReference,
  intent?: PageIntent | null,
): CanonicalContent {
  const next = applyValidation(
    { ...doc, approved: false, approvedAt: null },
    evidence,
    competitor,
  );
  if (!intent) return next;
  const kept = next.issues.filter((item) => !/^(source|intent|service-match|service-fidelity|topic-drift|offer-terms)$/.test(item.field));
  return { ...next, issues: [...kept, ...fidelityIssues(next, evidence, competitor, intent)] };
}

export function saveCanonical(
  pack: ContentPack,
  next: CanonicalContent,
  expectedRevision: number,
): ContentPack {
  if (expectedRevision !== pack.canonical.revision) {
    throw new ContentRevisionError(
      "These edits are behind a newer revision. Reload before saving so newer work is not overwritten.",
    );
  }
  const locked = new Map(
    pack.canonical.sections.filter((section) => section.locked).map((section) => [section.id, section]),
  );
  const sections = next.sections.map((section) =>
    locked.has(section.id) ? locked.get(section.id)! : section,
  );
  const canonical = stampDraft(
    { ...next, sections, revision: pack.canonical.revision + 1, approved: false, approvedAt: null, approvedRevision: pack.canonical.approvedRevision },
    pack.evidence,
    pack.competitor,
    pack.intent,
  );
  return { ...pack, canonical, previous: pack.canonical, legacy: false };
}

export function proposeSection(
  pack: ContentPack,
  proposal: SectionProposal,
): ContentPack {
  if (proposal.basedOnRevision !== pack.canonical.revision) {
    throw new ContentRevisionError(
      "A newer edit landed while this section was regenerating. The proposal was not applied.",
    );
  }
  const current = pack.canonical.sections.find((section) => section.id === proposal.sectionId);
  if (current?.locked) {
    throw new ContentRevisionError("That section is locked. Unlock it before regenerating.");
  }
  return { ...pack, proposal };
}

export function acceptProposal(pack: ContentPack): ContentPack {
  const proposal = pack.proposal;
  if (!proposal) throw new ContentRevisionError("There is no proposed section to accept.");
  if (proposal.basedOnRevision !== pack.canonical.revision) {
    throw new ContentRevisionError("The proposal is stale. Regenerate it against the latest revision.");
  }
  const sections = pack.canonical.sections.map((section) =>
    section.id === proposal.sectionId ? proposal.section : section,
  );
  const canonical = stampDraft(
    { ...pack.canonical, sections, revision: pack.canonical.revision + 1 },
    pack.evidence,
    pack.competitor,
    pack.intent,
  );
  return { ...pack, canonical, proposal: null };
}

export function approveSnapshot(
  pack: ContentPack,
  expectedRevision: number,
): ContentPack {
  if (pack.legacy || !pack.canonical.draftId) {
    throw new ContentRevisionError(
      "This is a legacy draft. Regenerate content so it can be checked against client evidence.",
    );
  }
  if (expectedRevision !== pack.canonical.revision) {
    throw new ContentRevisionError("Approve the latest saved revision. Unsaved or newer edits are not included.");
  }
  if (pack.intent?.usingSummaryOnly || (pack.intent && !pack.intent.primaryService.trim())) {
    throw new ContentRevisionError("Approval is blocked because the competitor source or service brief is incomplete.");
  }
  if (pack.canonical.issues.some((item) => item.severity === "critical")) {
    throw new ContentRevisionError(
      "Approval is blocked until critical evidence issues are resolved. Saving is not confirmation.",
    );
  }
  const captureGaps = (pack.inventory?.gaps || []).filter((gap) =>
    /failed|challenge|not captured|unresolved|timed out|login/i.test(gap),
  );
  if (captureGaps.length > 0 && pack.inventory?.sections.every((section) => section.textKind !== "rendered")) {
    throw new ContentRevisionError(`Approval is blocked because capture is incomplete. ${captureGaps[0]}`);
  }
  if (pack.canonical.sections.some((section) => (section.fields || []).some((field) => field.disposition !== "omit" && !field.text.trim() && field.items.length === 0))) {
    throw new ContentRevisionError("Approval is blocked because a required component has no content. That is not an intentional omission.");
  }
  if (pack.evidence.missingEssential.length > 0) {
    throw new ContentRevisionError(
      `Missing client facts: ${pack.evidence.missingEssential.join(", ")}.`,
    );
  }
  const approvedAt = new Date().toISOString();
  const snapshot: CanonicalContent = {
    ...structuredClone(pack.canonical),
    approved: true,
    approvedAt,
    approvedRevision: pack.canonical.revision,
  };
  return {
    ...pack,
    canonical: {
      ...pack.canonical,
      approved: true,
      approvedAt,
      approvedRevision: pack.canonical.revision,
    },
    approvedSnapshot: snapshot,
  };
}

export function touchAfterApproval(pack: ContentPack, next: CanonicalContent, expectedRevision: number): ContentPack {
  const saved = saveCanonical(pack, next, expectedRevision);
  return {
    ...saved,
    canonical: {
      ...saved.canonical,
      approved: false,
      approvedAt: null,
    },
  };
}

export function sectionCopyChanged(before: ContentSection, after: ContentSection): boolean {
  return JSON.stringify({
    heading: before.heading,
    paragraphs: before.paragraphs,
    items: before.items,
  }) !== JSON.stringify({
    heading: after.heading,
    paragraphs: after.paragraphs,
    items: after.items,
  });
}

export function confirmClaim(
  pack: ContentPack,
  input: { sectionId: string; value: string; confirmedBy: string },
): ContentPack {
  const value = input.value.trim();
  if (!value) throw new ContentRevisionError("There is no claim to confirm.");
  const factId = `user-${pack.evidence.facts.length + 1}`;
  const evidence = {
    ...pack.evidence,
    facts: [
      ...pack.evidence.facts,
      {
        id: factId,
        category: "positioning" as const,
        value,
        sourceUrl: pack.evidence.canonicalUrl,
        excerpt: "Confirmed by the user. This is not website-verified.",
        retrievedAt: new Date().toISOString(),
        status: "user_confirmed" as const,
        confirmedBy: input.confirmedBy,
        confirmedAt: new Date().toISOString(),
        qualifiers: "User confirmation, not stated on the client website.",
      },
    ],
  };
  const sections = pack.canonical.sections.map((section) =>
    section.id === input.sectionId
      ? { ...section, evidenceIds: [...section.evidenceIds, factId] }
      : section,
  );
  const canonical = stampDraft(
    { ...pack.canonical, sections, revision: pack.canonical.revision + 1, approved: false, approvedAt: null },
    evidence,
    pack.competitor,
    pack.intent,
  );
  return { ...pack, evidence, canonical, previous: pack.canonical };
}

export function undoCanonical(pack: ContentPack, expectedRevision: number): ContentPack {
  if (!pack.previous) throw new ContentRevisionError("There is no earlier revision to restore.");
  if (expectedRevision !== pack.canonical.revision) {
    throw new ContentRevisionError("Undo is behind a newer revision. Reload before undoing.");
  }
  const restored = stampDraft(
    { ...pack.previous, revision: pack.canonical.revision + 1, approved: false, approvedAt: null },
    pack.evidence,
    pack.competitor,
    pack.intent,
  );
  return { ...pack, canonical: restored, previous: pack.canonical };
}
