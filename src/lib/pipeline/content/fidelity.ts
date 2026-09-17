import type {
  CanonicalContent,
  ClientEvidenceRecord,
  CompetitorReference,
  ContentSection,
  ValidationIssue,
} from "./model";
import { factMatchesService, isPurposeSummary, unrelatedClientTopics, type PageIntent } from "./pageIntent";

function issue(sectionId: string | null, field: string, message: string, remedy: string): ValidationIssue {
  return {
    id: `${sectionId || "page"}:${field}:${message.slice(0, 40)}`,
    severity: "critical",
    sectionId,
    field,
    message,
    remedy,
  };
}

function salesSections(doc: CanonicalContent): ContentSection[] {
  return doc.sections.filter((section) => section.decision !== "omit");
}

function textOf(section: ContentSection): string {
  return [section.heading, ...section.paragraphs, ...(section.fields || []).map((field) => field.text)].join(" ");
}

function isCore(section: ContentSection, index: number, total: number): boolean {
  return index === 0 || index === total - 1 || /cta|hero|benefit|faq|offer/i.test(section.purpose);
}

/**
 * A factually supported draft can still sell the wrong service.
 * These checks are independent of evidence stripping.
 */
export function fidelityIssues(
  doc: CanonicalContent,
  evidence: ClientEvidenceRecord,
  competitor: CompetitorReference,
  intent: PageIntent,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const included = salesSections(doc);
  if (!intent.primaryService.trim() || intent.usingSummaryOnly) {
    issues.push(issue(
      null,
      "source",
      "Page intent was inferred without rendered competitor copy.",
      "Recapture the competitor page before treating this draft as complete.",
    ));
  }
  if (intent.ambiguous) {
    issues.push(issue(
      null,
      "intent",
      `The competitor service is ambiguous: ${intent.options.join(" or ")}.`,
      "Choose the service in the brief. Do not fall back to the client homepage.",
    ));
  }
  if (intent.clientMatch === "no") {
    issues.push(issue(
      included[0]?.id || null,
      "service-match",
      `The client site does not establish “${intent.primaryService}”.`,
      "Confirm the service or add the missing information. Do not switch the page to another client service.",
    ));
  }
  const suppressed = unrelatedClientTopics(evidence, intent, competitor);
  included.forEach((section, index) => {
    if (!isCore(section, index, included.length)) return;
    const copy = textOf(section);
    const onService = factMatchesService(copy, intent) || intent.terminology.some((token) => copy.toLowerCase().includes(token));
    if (!onService && section.decision !== "needs_input") {
      issues.push(issue(
        section.id,
        "service-fidelity",
        `This section does not sell “${intent.primaryService}”.`,
        "Rewrite it for that service. Do not reuse unrelated homepage positioning.",
      ));
    }
    const drift = suppressed.filter((phrase) => copy.toLowerCase().includes(phrase));
    if (drift.length && !onService) {
      issues.push(issue(
        section.id,
        "topic-drift",
        `This section promotes other services (${drift.slice(0, 3).join(", ")}) instead of “${intent.primaryService}”.`,
        "Keep those services out of this sales section.",
      ));
    }
  });
  const commercial = included.map((section) => textOf(section)).join("\n");
  const sourceCorpus = competitor.sections.map((section) => `${section.heading} ${section.sourceText}`).join(" ").toLowerCase();
  for (const fact of evidence.facts.filter((item) => item.category === "location")) {
    const place = fact.value.trim();
    if (place.length < 3) continue;
    if (commercial.toLowerCase().includes(place.toLowerCase()) && !sourceCorpus.includes(place.toLowerCase())) {
      issues.push(issue(null, "geography", `“${place}” is a client-page location, not the competitor page’s targeting.`, "Remove it unless the user approved that location in the brief."));
    }
  }
  for (const year of commercial.match(/\b20\d{2}\b/g) || []) {
    if (!sourceCorpus.includes(year) && !intent.confirmedTerms.some((term) => term.includes(year))) {
      issues.push(issue(null, "year", `The year ${year} is not in the competitor source or a confirmed term.`, "Remove the year unless there is an explicit reason to keep it."));
    }
  }
  if (evidence.slogan && evidence.businessName && commercial.includes(evidence.slogan) && !commercial.includes(evidence.businessName)) {
    issues.push(issue(null, "identity", "The draft uses the slogan where the business name should appear.", "Use the confirmed business name. Keep the slogan only if it is labeled as a slogan."));
  }
  const competitorPrice = intent.terms.price;
  if (competitorPrice && commercial.includes(competitorPrice) && !intent.confirmedTerms.some((term) => term.includes(competitorPrice))) {
    issues.push(issue(null, "offer-terms", `Competitor price ${competitorPrice} is in client copy.`, "Remove it unless the client confirmed that exact term."));
  }
  if (/\bfree\b/i.test(commercial) && intent.offerMode === "proposed" && !intent.confirmedTerms.some((term) => /free/i.test(term)) && !evidence.facts.some((fact) => /free/i.test(fact.value) && factMatchesService(fact.value, intent))) {
    issues.push(issue(null, "offer-terms", "“Free” is used, but the client has not confirmed a free offer.", "Remove the free claim or confirm it. The offer concept can stay without that word."));
  }
  for (const section of competitor.sections) {
    const snippet = section.sourceText.replace(/\s+/g, " ").trim();
    if (section.textKind !== "source" || isPurposeSummary(snippet) || snippet.length < 40) continue;
    const phrase = snippet.toLowerCase().slice(0, 48);
    if (commercial.toLowerCase().includes(phrase)) {
      issues.push(issue(null, "originality", "Client copy repeats a run of competitor wording.", "Rewrite it. Ordinary service terms may stay."));
    }
  }
  return issues;
}
