/**
 * Canonical content contract. Review UI and design paste are derived from this
 * model. Competitor source text is stored separately and never treated as fact.
 */

export const EVIDENCE_VERSION = 2;
export const DEFAULT_PAGE_BUDGET = 8;

export type EvidenceCategory =
  | "identity"
  | "service"
  | "audience"
  | "location"
  | "positioning"
  | "process"
  | "price"
  | "offer"
  | "guarantee"
  | "customer"
  | "media"
  | "certification"
  | "partnership"
  | "testimonial"
  | "case_study"
  | "result"
  | "contact"
  | "cta";

export type EvidenceStatus = "stated_on_site" | "user_confirmed" | "uncertain";

export type AdaptationDecision = "adapt" | "replace" | "omit" | "needs_input";

export type IssueSeverity = "critical" | "warning";

export interface EvidenceFact {
  id: string;
  category: EvidenceCategory;
  value: string;
  sourceUrl: string;
  excerpt: string;
  retrievedAt: string;
  service?: string | null;
  /** How closely this fact matches the competitor page being recreated. */
  serviceRelevance?: "exact" | "related" | "general" | "unrelated";
  location?: string | null;
  qualifiers?: string | null;
  status: EvidenceStatus;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
}

export interface ResearchPage {
  url: string;
  title: string | null;
  ok: boolean;
  error?: string | null;
}

export interface ClientEvidenceRecord {
  version: number;
  ownerUserId: string;
  spaceId: string | null;
  enteredUrl: string;
  canonicalUrl: string;
  pageKind: "homepage" | "service" | "other";
  businessName: string | null;
  /** Headline rejected as a name, such as a slogan. Never used as the client identity. */
  slogan?: string | null;
  identityStatus?: "confirmed" | "inferred" | "needs_confirmation";
  facts: EvidenceFact[];
  pagesRead: ResearchPage[];
  unavailable: string[];
  retrievedAt: string;
  incomplete: boolean;
  missingEssential: string[];
  /** Untrusted page text used only as source material for drafting. */
  pageExcerpts?: Array<{ url: string; text: string }>;
}

export interface CompetitorSectionRef {
  id: string;
  heading: string;
  purpose: string;
  order: number;
  /** Labeled source text. Never treated as a client fact. */
  sourceText: string;
  textKind: "source" | "summary";
  sourceUrl: string;
  cids: string[];
  components?: Array<{ id: string; kind: string; text: string; items: string[] }>;
}

export interface CompetitorReference {
  sourceUrl: string;
  retrievedAt: string;
  name: string;
  host: string;
  sections: CompetitorSectionRef[];
}

export interface StructuredItem {
  id: string;
  kind:
    | "customer"
    | "media"
    | "faq"
    | "cta"
    | "offer"
    | "testimonial"
    | "guarantee"
    | "link"
    | "result";
  label: string;
  detail?: string | null;
  href?: string | null;
  evidenceIds: string[];
}

export interface ValidationIssue {
  id: string;
  severity: IssueSeverity;
  sectionId: string | null;
  field: string;
  message: string;
  remedy: string;
}

export interface DraftField {
  id: string;
  sourceComponentId: string;
  kind: string;
  text: string;
  items: string[];
  disposition: AdaptationDecision;
  reason: string | null;
}

export interface ContentSection {
  id: string;
  decision: AdaptationDecision;
  decisionReason: string;
  purpose: string;
  competitorSectionId: string | null;
  heading: string;
  paragraphs: string[];
  items: StructuredItem[];
  evidenceIds: string[];
  locked: boolean;
  issues: ValidationIssue[];
  /** One entry per competitor component. Completeness is by field, not by a single body string. */
  fields?: DraftField[];
}

export interface CanonicalContent {
  draftId: string;
  revision: number;
  evidenceVersion: number;
  clientUrl: string;
  clientName: string;
  competitorUrl: string;
  competitorName: string;
  serviceContext: string | null;
  audienceContext: string | null;
  meta: { title: string; description: string };
  sections: ContentSection[];
  issues: ValidationIssue[];
  approved: boolean;
  approvedAt: string | null;
  approvedRevision: number | null;
}

export interface SectionProposal {
  sectionId: string;
  section: ContentSection;
  basedOnRevision: number;
}

export interface ContentPack {
  evidence: ClientEvidenceRecord;
  competitor: CompetitorReference;
  canonical: CanonicalContent;
  /** Immutable copy created by Approve content. Design builds load this, not the live draft. */
  approvedSnapshot: CanonicalContent | null;
  /** Proposed section rewrite. Does not replace the section until accepted. */
  proposal: SectionProposal | null;
  /** Revision immediately before the last save, so one undo does not call a model. */
  previous: CanonicalContent | null;
  /** Rendered-page inventory when capture succeeded. Summary inventories are labeled as such. */
  inventory?: import("./inventory").PageInventory | null;
  /** Locked competitor-page brief. Homepage positioning cannot replace it. */
  intent?: import("./pageIntent").PageIntent | null;
  /** True when this draft was written before the current service brief. */
  intentOutdated?: boolean;
  /** Older drafts created before this contract. They cannot be built until regenerated. */
  legacy: boolean;
}

export function evidenceCacheKey(input: {
  ownerUserId: string;
  spaceId?: string | null;
  canonicalUrl: string;
  focus?: string | null;
}): string {
  return `${input.ownerUserId}:${input.spaceId || "none"}:${input.canonicalUrl}:${input.focus || "general"}:v${EVIDENCE_VERSION}`;
}
