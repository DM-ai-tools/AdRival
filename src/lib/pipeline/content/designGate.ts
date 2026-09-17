import * as cheerio from "cheerio";
import type { CanonicalContent, CompetitorReference, ContentSection } from "./model";

const COPY_CHANGE =
  /\b(headline|price|testimonial|quote|guarantee|discount|cta|call to action|offer|claim|slogan)\b/i;

export function assertDesignFeedbackIsLayoutOnly(feedback: string): void {
  const text = feedback.trim();
  if (!text) return;
  if (COPY_CHANGE.test(text) || /keep the competitor/i.test(text)) {
    throw new Error(
      "Design feedback cannot change headlines, prices, testimonials, claims, or calls to action. Make that edit in content review and approve it again.",
    );
  }
}

export function approvedSections(snapshot: CanonicalContent): ContentSection[] {
  return snapshot.sections.filter((section) => section.decision !== "omit");
}

export function omissionMappings(snapshot: CanonicalContent): ContentSection[] {
  return snapshot.sections.filter(
    (section) => section.decision === "omit" && section.competitorSectionId,
  );
}

/**
 * Required approved headings must be present. Competitor-only phrases must not
 * remain in visible text, links, or alt text. Coverage percentage is not a pass.
 */
export function auditBuiltHtml(
  html: string,
  snapshot: CanonicalContent,
  competitor: CompetitorReference,
): string[] {
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const errors: string[] = [];
  for (const section of approvedSections(snapshot)) {
    const candidates = [section.heading, ...section.paragraphs, ...(section.fields || []).map((field) => field.text)]
      .map((text) => text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim().toLowerCase())
      .filter((text) => text.length >= 12);
    const present = candidates.some((text) => visible.includes(text.slice(0, Math.min(40, text.length))));
    if (candidates.length && !present) {
      errors.push(
        `Approved section “${section.heading.slice(0, 80)}” is missing from the built page. The design was not allowed to keep competitor text in its place.`,
      );
    }
  }
  const client = snapshot.clientName.trim().toLowerCase();
  const rival = competitor.name.trim().toLowerCase();
  if (rival.length > 2 && rival !== client && visible.includes(rival)) {
    errors.push(`Competitor name “${competitor.name}” is still visible in the built page.`);
  }
  const host = competitor.host.toLowerCase();
  if (host && html.toLowerCase().includes(host)) {
    errors.push(`Competitor domain ${host} is still in a link, image, or metadata field.`);
  }
  for (const section of competitor.sections) {
    const snippet = section.sourceText.replace(/\s+/g, " ").trim();
    if (snippet.length >= 40 && visible.includes(snippet.toLowerCase().slice(0, 40))) {
      const approved = visibleCopy(snapshot).includes(snippet.toLowerCase().slice(0, 40));
      if (!approved) {
        errors.push(
          `Competitor source text from “${section.heading}” survived in the built page.`,
        );
      }
    }
  }
  const omitted = snapshot.sections.filter((section) => section.decision === "omit");
  for (const section of omitted) {
    if (!section.decisionReason.trim()) {
      errors.push(`Omitted section ${section.id} has no removal reason.`);
    }
  }
  return errors;
}

function visibleCopy(snapshot: CanonicalContent): string {
  return snapshot.sections
    .flatMap((section) => [section.heading, ...section.paragraphs, ...section.items.map((item) => item.label)])
    .join(" ")
    .toLowerCase();
}

/**
 * Make the approved document visible and strip known competitor source phrases.
 * This does not restyle the page. If required copy still cannot be represented,
 * the caller must abort and keep the previous design.
 */
export function enforceApprovedCopy(html: string, snapshot: CanonicalContent, competitor: CompetitorReference): string {
  let next = html;
  const rival = competitor.name.trim();
  const client = snapshot.clientName.trim();
  if (rival.length > 2 && rival.toLowerCase() !== client.toLowerCase()) {
    next = next.replace(new RegExp(rival.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), client);
  }
  if (competitor.host) {
    next = next.replace(new RegExp(competitor.host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "");
  }
  for (const section of competitor.sections) {
    const snippet = section.sourceText.replace(/\s+/g, " ").trim();
    if (snippet.length >= 40) {
      next = next.replace(snippet, "");
    }
  }
  const body = approvedSections(snapshot)
    .map((section) => {
      const items = section.items
        .map((item) => `<li>${escapeHtml(item.label)}${item.detail ? ` — ${escapeHtml(item.detail)}` : ""}</li>`)
        .join("");
      return `<section data-approved-section="${escapeHtml(section.id)}"><h2>${escapeHtml(section.heading)}</h2>${section.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("")}${items ? `<ul>${items}</ul>` : ""}</section>`;
    })
    .join("");
  const article = `<article data-approved-content="true">${body}</article>`;
  if (/<\/body>/i.test(next)) return next.replace(/<\/body>/i, `${article}</body>`);
  return next + article;
}

/** Drop long competitor-only text that the layout paste left in unmapped nodes. */
export function blankUnmappedCompetitorText(
  html: string,
  snapshot: CanonicalContent,
  competitor: CompetitorReference,
): string {
  const approved = visibleCopy(snapshot);
  const $ = cheerio.load(html);
  $("[data-cid]").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length < 40) return;
    if (approved.includes(text.toLowerCase())) return;
    const rival = text.toLowerCase();
    const fromCompetitor =
      competitor.sections.some((section) => section.sourceText.toLowerCase().includes(rival.slice(0, 40))) ||
      (competitor.name.length > 2 && rival.includes(competitor.name.toLowerCase()));
    if (fromCompetitor) $(el).text("");
  });
  $("script[type='application/ld+json']").each((_, el) => {
    const raw = $(el).text();
    if (competitor.host && raw.toLowerCase().includes(competitor.host)) $(el).text("{}");
  });
  return $.html();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function requireApprovedSnapshot(snapshot: CanonicalContent | null | undefined): CanonicalContent {
  if (!snapshot?.approved || snapshot.approvedRevision == null) {
    throw new Error(
      "Approve the latest content revision before building a design. Older drafts are not treated as approved.",
    );
  }
  if (snapshot.issues.some((item) => item.severity === "critical")) {
    throw new Error("The approved snapshot still has critical issues. It cannot be built.");
  }
  return snapshot;
}
