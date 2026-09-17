import { looksLikeSlogan } from "./slogan";
import type { ClientEvidenceRecord, CompetitorReference, CompetitorSectionRef } from "./model";

export const PROMPT_VERSION = 3;

const STOP = new Set([
  "the", "and", "for", "with", "your", "our", "you", "get", "book", "free", "today", "call",
  "now", "click", "here", "started", "learn", "more", "a", "an", "to", "of", "in", "on",
  "we", "us", "this", "that", "about", "who", "are", "is", "from", "that", "will", "can",
  "not", "just", "only", "their", "they", "our", "all", "new", "best", "how", "what",
]);

export interface CommercialTerms {
  price: string | null;
  currency: string | null;
  discount: string | null;
  introductoryPeriod: string | null;
  eligibility: string | null;
  deadline: string | null;
  guarantee: string | null;
  contractTerms: string | null;
  included: string[];
  excluded: string[];
}

export interface PageIntent {
  version: number;
  promptVersion: number;
  primaryService: string;
  subtype: string | null;
  problem: string | null;
  audience: string | null;
  conversionGoal: string | null;
  offerConcept: string;
  offerDeliverables: string[];
  terms: CommercialTerms;
  terminology: string[];
  sectionSequence: Array<{ id: string; purpose: string; heading: string }>;
  confidence: "high" | "medium" | "low";
  ambiguous: boolean;
  options: string[];
  sourceRefs: string[];
  multiService: boolean;
  offerMode: "existing" | "proposed";
  confirmedTerms: string[];
  clientMatch: "yes" | "limited" | "no";
  usingSummaryOnly: boolean;
}

export function isPurposeSummary(text: string): boolean {
  return /^(encourages|promotes|presents|shows|introduces|explains|describes|builds|persuades|highlights)\b/i.test(text.trim());
}

export function isExtractedSource(section: { textKind?: string; sourceText?: string } | null | undefined): boolean {
  if (!section || section.textKind !== "source") return false;
  const text = (section.sourceText || "").trim();
  if (!text || isPurposeSummary(text)) return false;
  return true;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$%\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word));
}

const PURPOSE_PHRASE = /^(problem|solution|features|agitation|additional services|how it works|call to action|hero|faqs?|problem agitation|solution features)$/i;

function isPurposePhrase(phrase: string): boolean {
  return PURPOSE_PHRASE.test(phrase.trim()) || /^(problem|solution|agitation|features)\b/i.test(phrase.trim());
}

function phrases(text: string): string[] {
  const words = tokens(text);
  const found: string[] = [];
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index + size <= words.length; index += 1) {
      found.push(words.slice(index, index + size).join(" "));
    }
  }
  return found;
}

function usableText(section: CompetitorSectionRef): string {
  if (section.textKind === "summary" || isPurposeSummary(section.sourceText)) return section.heading;
  const components = (section.components || [])
    .filter((component) => !isPurposeSummary(component.text))
    .map((component) => [component.text, ...component.items].join(" "))
    .join(" ");
  return `${section.heading} ${components || section.sourceText}`;
}

function emptyTerms(): CommercialTerms {
  return {
    price: null,
    currency: null,
    discount: null,
    introductoryPeriod: null,
    eligibility: null,
    deadline: null,
    guarantee: null,
    contractTerms: null,
    included: [],
    excluded: [],
  };
}

function readTerms(corpus: string): CommercialTerms {
  const terms = emptyTerms();
  const price = corpus.match(/([$£€])\s?(\d[\d,]*(?:\.\d{2})?)/);
  if (price) {
    terms.currency = price[1];
    terms.price = price[0];
  }
  const discount = corpus.match(/\b\d+%\s*(?:off|discount)/i);
  if (discount) terms.discount = discount[0];
  if (/\b(?:first|introductory)\s+(?:week|month|call)\b/i.test(corpus)) {
    terms.introductoryPeriod = corpus.match(/\b(?:first|introductory)\s+(?:week|month|call)\b/i)?.[0] || null;
  }
  if (/\bthis week only|today only|until [a-z0-9]+|ends [a-z0-9]+/i.test(corpus)) {
    terms.deadline = corpus.match(/\bthis week only|today only|until [a-z0-9]+|ends [a-z0-9]+/i)?.[0] || null;
  }
  if (/\bguarantee|money[- ]back|cancel anytime|no lock[- ]in\b/i.test(corpus)) {
    terms.guarantee = corpus.match(/\bguarantee|money[- ]back|cancel anytime|no lock[- ]in\b/i)?.[0] || null;
  }
  if (/\bno contract|month[- ]to[- ]month|cancel\b/i.test(corpus)) {
    terms.contractTerms = corpus.match(/\bno contract|month[- ]to[- ]month|cancellation[^.]{0,40}/i)?.[0] || null;
  }
  return terms;
}

function offerConcept(corpus: string, conversionGoal: string | null): string {
  if (/\bintroduc|package|starter\b/i.test(corpus)) return "introductory package";
  if (/\bfree\b.{0,24}\b(audit|assessment|consult|call|review)\b/i.test(corpus)) return "assessment, with any free claim unconfirmed until the client verifies it";
  if (/\bdiscount|%\s*off|first month\b/i.test(corpus)) return "discounted first period, without the competitor’s amount or deadline";
  if (/\bbundle|included\b/i.test(corpus)) return "product or service bundle";
  if (/\bguarantee\b/i.test(corpus)) return "performance promise, which must not transfer unless the client confirms the conditions";
  return conversionGoal ? `same conversion mechanism as “${conversionGoal}”` : "direct enquiry for the advertised service";
}

/** Infer what the competitor page is selling. Client homepage copy is not an input. */
export function inferPageIntent(competitor: CompetitorReference): PageIntent {
  const rendered = competitor.sections.filter((section) => section.textKind === "source" && !isPurposeSummary(section.sourceText));
  const usingSummaryOnly = rendered.length === 0;
  const source = rendered.length ? rendered : competitor.sections;
  const scores = new Map<string, number>();
  for (const section of source) {
    const headingBoost = section.order === 0 ? 4 : 2;
    for (const phrase of phrases(section.heading)) {
      if (isPurposePhrase(phrase)) continue;
      scores.set(phrase, (scores.get(phrase) || 0) + headingBoost);
    }
    if (section.textKind === "summary" || isPurposeSummary(section.sourceText)) continue;
    for (const phrase of phrases(usableText(section))) {
      scores.set(phrase, (scores.get(phrase) || 0) + 1);
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const headingPhrases = source
    .map((section) => phrases(section.heading)[0])
    .filter((phrase): phrase is string => Boolean(phrase) && !isPurposePhrase(phrase));
  const distinct = [...new Set(headingPhrases)].filter((phrase, _index, all) =>
    !all.some((other) => other !== phrase && other.includes(phrase)),
  );
  const rankedServices = ranked.filter(([phrase]) => !isPurposePhrase(phrase));
  const top = usingSummaryOnly ? "" : rankedServices[0]?.[0] || headingPhrases[0] || "";
  const second = rankedServices.find(([phrase]) => top && !sharesToken(phrase, top));
  const closeSecond = Boolean(second && rankedServices[0] && second[1] >= rankedServices[0][1] * 0.8);
  const multiService = !usingSummaryOnly && distinct.length >= 3 && distinct.every((phrase) => (scores.get(phrase) || 0) > 0);
  const ambiguous = usingSummaryOnly || !top || (!multiService && closeSecond);
  const primaryService = !top ? "" : multiService ? distinct.slice(0, 4).join(", ") : top;
  const corpus = source.map((section) => usableText(section)).join("\n");
  const cta = [...source].reverse().find((section) => /book|get started|enquiry|enquir|contact/i.test(`${section.heading} ${section.sourceText}`) && !isPurposePhrase(section.heading));
  const terminology = [...new Set(tokens(primaryService))];
  const terms = readTerms(corpus);
  return {
    version: 1,
    promptVersion: PROMPT_VERSION,
    primaryService,
    subtype: multiService ? null : ranked.find(([phrase]) => phrase !== primaryService && phrase.includes(tokens(primaryService)[0] || "___"))?.[0] || null,
    problem: null,
    audience: null,
    conversionGoal: cta?.heading || null,
    offerConcept: offerConcept(corpus, cta?.heading || null),
    offerDeliverables: [],
    terms,
    terminology,
    sectionSequence: competitor.sections.map((section) => ({
      id: section.id,
      purpose: section.purpose,
      heading: section.heading,
    })),
    confidence: usingSummaryOnly || ambiguous ? "low" : multiService ? "medium" : "high",
    ambiguous,
    options: ambiguous && second ? [top, second[0]] : [],
    sourceRefs: source.map((section) => section.id),
    multiService,
    offerMode: "proposed",
    confirmedTerms: [],
    clientMatch: "limited",
    usingSummaryOnly,
  };
}

function sharesToken(left: string, right: string): boolean {
  const other = new Set(tokens(right));
  return tokens(left).some((token) => other.has(token));
}

export function serviceTokens(intent: PageIntent): string[] {
  return intent.terminology.filter((token) => token.length > 2);
}

export function factMatchesService(value: string, intent: PageIntent): boolean {
  const haystack = value.toLowerCase();
  const needed = serviceTokens(intent);
  if (needed.length === 0) return false;
  if (intent.multiService) return needed.some((token) => haystack.includes(token));
  const hits = needed.filter((token) => haystack.includes(token));
  if (needed.length === 1) return hits.length === 1;
  return hits.includes(needed[0]) && hits.length >= 2;
}

export function assessClientMatch(evidence: ClientEvidenceRecord, intent: PageIntent): PageIntent["clientMatch"] {
  const serviceFacts = evidence.facts.filter((fact) =>
    fact.category === "service" || fact.category === "process" || fact.category === "offer",
  );
  const hits = serviceFacts.filter((fact) => factMatchesService(`${fact.value} ${fact.service || ""}`, intent));
  if (hits.length === 0) return "no";
  if (hits.some((fact) => fact.value.length > 80)) return "yes";
  return "limited";
}

export function withClientMatch(intent: PageIntent, evidence: ClientEvidenceRecord): PageIntent {
  const clientMatch = assessClientMatch(evidence, intent);
  const confirmed = evidence.facts
    .filter((fact) =>
      (fact.category === "offer" || fact.category === "price" || fact.category === "guarantee")
      && factMatchesService(`${fact.value} ${fact.excerpt}`, intent),
    )
    .map((fact) => fact.value);
  return {
    ...intent,
    clientMatch,
    offerMode: confirmed.length ? "existing" : "proposed",
    confirmedTerms: confirmed,
  };
}

/** Homepage slogans that do not mention the page service must not drive section copy. */
export function factsForDrafting(evidence: ClientEvidenceRecord, intent: PageIntent): ClientEvidenceRecord["facts"] {
  return evidence.facts.filter((fact) => {
    if (fact.category === "location") return false;
    if (looksLikeSlogan(fact.value)) return false;
    if (fact.category === "identity" || fact.category === "contact" || fact.category === "cta") {
      return true;
    }
    if (fact.category === "customer" || fact.category === "media" || fact.category === "testimonial" || fact.category === "case_study" || fact.category === "result" || fact.category === "certification") {
      return !fact.service || factMatchesService(`${fact.value} ${fact.service}`, intent) || fact.category === "media";
    }
    if (intent.clientMatch === "no" && (fact.category === "service" || fact.category === "process" || fact.category === "positioning")) {
      return false;
    }
    return factMatchesService(`${fact.value} ${fact.service || ""} ${fact.excerpt}`, intent);
  });
}

export function unrelatedClientTopics(evidence: ClientEvidenceRecord, intent: PageIntent, competitor: CompetitorReference): string[] {
  const corpus = competitor.sections.map((section) => `${section.heading} ${section.sourceText}`).join(" ").toLowerCase();
  const found = new Set<string>();
  for (const fact of evidence.facts) {
    if (fact.category !== "service" && fact.category !== "positioning") continue;
    for (const phrase of phrases(fact.value)) {
      if (factMatchesService(phrase, intent)) continue;
      if (corpus.includes(phrase)) continue;
      if (phrase.split(" ").length < 2) continue;
      found.add(phrase);
    }
  }
  return [...found].slice(0, 8);
}

export function reviseIntent(
  intent: PageIntent,
  edit: { primaryService?: string; offerConcept?: string; confirmedTerms?: string[] },
): PageIntent {
  const primaryService = edit.primaryService?.trim() || intent.primaryService;
  const confirmedTerms = edit.confirmedTerms ?? intent.confirmedTerms;
  return {
    ...intent,
    version: intent.version + 1,
    primaryService,
    terminology: tokens(primaryService),
    offerConcept: edit.offerConcept?.trim() || intent.offerConcept,
    confirmedTerms,
    offerMode: confirmedTerms.length ? "existing" : "proposed",
    ambiguous: false,
    options: [],
  };
}

export function draftIsCurrent(pack: { intent?: PageIntent | null; legacy?: boolean }): boolean {
  return Boolean(pack.intent && pack.intent.promptVersion === PROMPT_VERSION && pack.intent.primaryService && !pack.legacy);
}
