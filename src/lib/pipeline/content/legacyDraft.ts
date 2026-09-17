import type { LandingContentBlock, LandingContentDocument, LandingContentDraft } from "../../types";
import type { CanonicalContent } from "./model";

/** Review displays and the layout paste read this. They do not invent a second copy. */
export function canonicalToDraft(canonical: CanonicalContent, model: string): LandingContentDraft {
  const included = canonical.sections.filter(
    (section) => section.decision !== "omit" && section.decision !== "needs_input",
  );
  const document: LandingContentDocument = {
    pageType: canonical.serviceContext,
    tone: null,
    summary: canonical.issues.some((item) => item.severity === "critical")
      ? "Draft has unresolved evidence issues. Do not treat generation as successful until they are cleared."
      : "Drafted from client evidence. Competitor sections supplied structure only.",
    meta: canonical.meta,
    sections: canonical.sections.map((section) => ({
      id: section.id,
      kind: section.decision,
      title: section.heading,
      body: section.paragraphs.join("\n\n"),
    })),
    competitorUrl: canonical.competitorUrl,
  };
  const blocks: LandingContentBlock[] = included.map((section, index) => ({
    id: section.id,
    sectionIndex: index,
    sectionName: section.heading || section.purpose,
    role: "body",
    label: section.purpose,
    text: [section.heading, ...section.paragraphs].filter(Boolean).join("\n\n"),
    originalText: null,
  }));
  return {
    status: canonical.approved ? "approved" : "ready",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model,
    pageType: canonical.serviceContext,
    differentiationSummary: document.summary,
    blocks,
    document,
    userFeedback: null,
    approvedAt: canonical.approvedAt,
    error: canonical.issues.some((item) => item.severity === "critical")
      ? `${canonical.issues.filter((item) => item.severity === "critical").length} critical evidence issue(s) must be resolved before approval.`
      : null,
  };
}
