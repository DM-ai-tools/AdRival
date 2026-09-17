import type {
  AdaptationDecision,
  ClientEvidenceRecord,
  CompetitorReference,
  CompetitorSectionRef,
  EvidenceCategory,
} from "./model";
import type { PageIntent } from "./pageIntent";

export interface SectionPlan {
  competitorSectionId: string | null;
  decision: AdaptationDecision;
  reason: string;
  purpose: string;
  headingHint: string;
  allowedCategories: EvidenceCategory[];
}

function blob(section: CompetitorSectionRef): string {
  return `${section.heading} ${section.purpose} ${section.sourceText}`.toLowerCase();
}

function has(evidence: ClientEvidenceRecord, category: EvidenceCategory): boolean {
  return evidence.facts.some((fact) => fact.category === category);
}

function classify(section: CompetitorSectionRef): string {
  const text = blob(section);
  if (/speciali|audience|industr|who we/.test(text)) return "audience";
  if (/as seen|press|featured in|media/.test(text)) return "media";
  if (/trusted by|our clients|customers include|logos/.test(text)) return "customers";
  if (/testimonial|review|what clients say|stars/.test(text)) return "testimonial";
  if (/case stud|results|%\s|roi/.test(text)) return "case_study";
  if (/\$\s?\d|discount|%\s*off|offer|limited time|guarantee/.test(text)) return "offer";
  if (/faq|question/.test(text)) return "faq";
  if (/about|team|our story/.test(text)) return "about";
  if (/contact|book|call|get started/.test(text)) return "cta";
  if (/how it works|process|our approach/.test(text)) return "process";
  return "service";
}

/**
 * Decide whether a competitor section's purpose can be kept.
 * A missing client fact never copies the competitor fact across.
 */
export function planSections(
  competitor: CompetitorReference,
  evidence: ClientEvidenceRecord,
  intent?: PageIntent | null,
): SectionPlan[] {
  const plans: SectionPlan[] = [];
  for (const section of competitor.sections) {
    const kind = classify(section);
    let decision: AdaptationDecision = "adapt";
    let reason = "The section purpose fits and the client site supports it.";
    let allowed: EvidenceCategory[] = ["service", "positioning", "process"];

    if (kind === "media") {
      allowed = ["media"];
      if (!has(evidence, "media")) {
        decision = "omit";
        reason = "Competitor media logos are not client press mentions. Customer or tool logos were not reused.";
      } else {
        reason = "Replaced with media mentions stated on the client site.";
        decision = "replace";
      }
    } else if (kind === "customers") {
      allowed = ["customer"];
      if (!has(evidence, "customer")) {
        decision = "omit";
        reason = "No client page establishes a customer relationship. Logos alone are not enough.";
      } else {
        decision = "replace";
        reason = "Limited to customers named as customers on the client site.";
      }
    } else if (kind === "testimonial") {
      allowed = ["testimonial"];
      if (!has(evidence, "testimonial")) {
        decision = "omit";
        reason = "The client site has no testimonial. None will be invented.";
      } else {
        decision = "adapt";
        reason = "Uses the client’s own testimonial wording only.";
      }
    } else if (kind === "case_study") {
      allowed = ["case_study", "result"];
      if (!has(evidence, "case_study") && !has(evidence, "result")) {
        decision = "omit";
        reason = "No client case study or result. The competitor’s numbers will not be transferred.";
      } else {
        decision = "replace";
        reason = "Uses the client case study and its actual figures only.";
      }
    } else if (kind === "offer") {
      allowed = ["offer", "price", "guarantee"];
      if (!has(evidence, "offer") && !has(evidence, "price") && !has(evidence, "guarantee")) {
        decision = "replace";
        reason = "No matching client offer. This becomes a neutral enquiry, not the competitor’s discount or guarantee.";
        allowed = ["cta", "contact"];
      } else {
        decision = "replace";
        reason = "Only the client’s documented offer, price, or guarantee — including its conditions.";
      }
    } else if (kind === "faq") {
      allowed = ["service", "process", "price", "offer", "contact"];
      decision = has(evidence, "service") ? "adapt" : "needs_input";
      reason = has(evidence, "service")
        ? "FAQ answers must come from client pages. Unknown answers are omitted."
        : "Not enough client service detail to answer the competitor’s questions.";
    } else if (kind === "about") {
      allowed = ["identity", "location", "audience"];
      if (!has(evidence, "identity")) {
        decision = "needs_input";
        reason = "Client identity was not found on the website.";
      }
    } else if (kind === "cta") {
      allowed = ["cta", "contact"];
      decision = has(evidence, "cta") || has(evidence, "contact") ? "adapt" : "needs_input";
      reason =
        decision === "adapt"
          ? "CTA uses a destination found on the client site."
          : "No client booking or contact destination was found. A new CTA was not invented.";
    } else if (kind === "process") {
      allowed = ["process", "service"];
      if (!has(evidence, "process") && !has(evidence, "service")) {
        decision = "omit";
        reason = "The competitor process is not supported by the client site.";
      } else if (!has(evidence, "process")) {
        decision = "replace";
        reason = "Replaced with the client’s supported service description. The competitor process was not copied.";
      }
    } else if (kind === "audience") {
      allowed = ["audience", "service", "positioning"];
      if (!has(evidence, "audience") && !has(evidence, "service")) {
        decision = "needs_input";
        reason = "The client site did not describe who this service is for.";
      } else {
        reason = "Written for the audiences named on the client site, not the competitor’s industry list.";
      }
    } else if (!has(evidence, "service") && !has(evidence, "positioning")) {
      decision = "needs_input";
      reason = "The client site did not describe this service, so the competitor section was not rewritten as fact.";
      allowed = ["service"];
    }

    if (intent && intent.clientMatch === "no" && !intent.multiService && kind !== "about") {
      decision = "needs_input";
      reason = `The client site does not establish “${intent.primaryService}”. This section was not switched to a different client service.`;
      allowed = ["identity", "contact"];
    }

    plans.push({
      competitorSectionId: section.id,
      decision,
      reason,
      purpose: section.purpose,
      headingHint: section.heading,
      allowedCategories: allowed,
    });
  }
  return plans;
}

/** Decide each competitor component separately. Missing proof is an omission, not a blank heading. */
export function componentPlans(
  section: CompetitorSectionRef,
  plan: SectionPlan,
  evidence: ClientEvidenceRecord,
): Array<{ id: string; disposition: AdaptationDecision; reason: string }> {
  const services = evidence.facts.filter((fact) => fact.category === "service" || fact.category === "process");
  let cardsUsed = 0;
  return (section.components || []).map((component) => {
    if (plan.decision === "omit") return { id: component.id, disposition: "omit", reason: plan.reason };
    if (component.kind === "card") {
      const fact = services[cardsUsed];
      cardsUsed += 1;
      if (!fact) {
        return {
          id: component.id,
          disposition: "omit",
          reason: "The client site supports fewer services than these competitor cards. No extra service was invented. The later layout must adapt.",
        };
      }
      return { id: component.id, disposition: "replace", reason: `Supported by ${fact.id}.` };
    }
    if ((component.kind === "proof" || component.kind === "image") && (plan.allowedCategories.includes("media") || plan.allowedCategories.includes("customer"))) {
      const supported = plan.allowedCategories.some((category) => has(evidence, category));
      if (!supported) {
        return {
          id: component.id,
          disposition: "omit",
          reason: "No verified media or customer relationship. A name, logo, or location was not used as proof.",
        };
      }
    }
    if (plan.decision === "needs_input") return { id: component.id, disposition: "needs_input", reason: plan.reason };
    return { id: component.id, disposition: plan.decision === "replace" ? "replace" : "adapt", reason: plan.reason };
  });
}
