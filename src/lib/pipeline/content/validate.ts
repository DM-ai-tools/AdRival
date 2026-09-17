import type {
  CanonicalContent,
  ClientEvidenceRecord,
  CompetitorReference,
  ContentSection,
  EvidenceFact,
  ValidationIssue,
} from "./model";

function norm(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function lower(value: string): string {
  return norm(value).toLowerCase();
}

function visibleCopy(section: ContentSection): string {
  const bits = [
    section.heading,
    ...section.paragraphs,
    ...section.items.flatMap((item) => [item.label, item.detail || "", item.href || ""]),
  ];
  return bits.filter(Boolean).join("\n");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function factsOf(
  evidence: ClientEvidenceRecord,
  category: EvidenceFact["category"],
): EvidenceFact[] {
  return evidence.facts.filter((fact) => fact.category === category);
}

function cited(section: ContentSection, evidence: ClientEvidenceRecord): EvidenceFact[] {
  const ids = new Set([
    ...section.evidenceIds,
    ...section.items.flatMap((item) => item.evidenceIds),
  ]);
  return evidence.facts.filter((fact) => ids.has(fact.id));
}

function mentions(haystack: string, needle: string): boolean {
  const n = lower(needle);
  if (n.length < 3) return false;
  return lower(haystack).includes(n);
}

function issue(
  sectionId: string | null,
  field: string,
  message: string,
  remedy: string,
  severity: ValidationIssue["severity"] = "critical",
): ValidationIssue {
  const slug = `${sectionId || "page"}:${field}:${lower(message).slice(0, 48)}`;
  return { id: slug, severity, sectionId, field, message, remedy };
}

const CLAIM_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\$\s?\d[\d,]*(?:\.\d+)?/g, label: "price" },
  { re: /(?:£|€)\s?\d[\d,]*/g, label: "price" },
  { re: /\b\d+%\s*(?:off|discount)/gi, label: "discount" },
  { re: /\bfree\s+(?:consult(?:ation)?|audit|trial|demo)\b/gi, label: "free offer" },
  { re: /\b(?:activation call|book a call)\b/gi, label: "invented CTA" },
  { re: /\bgoogle partner\b/gi, label: "credential" },
  { re: /\b\d+\+?\s+years\b/gi, label: "years of experience" },
  { re: /\b\d[\d,]*\+?\s+(?:customers|clients|businesses)\b/gi, label: "customer count" },
];

function clientSupports(text: string, evidence: ClientEvidenceRecord): boolean {
  const needle = lower(text);
  return evidence.facts.some((fact) => {
    const value = lower(fact.value);
    return value.includes(needle) || needle.includes(value);
  });
}

export function validateSection(
  section: ContentSection,
  evidence: ClientEvidenceRecord,
  competitor: CompetitorReference,
): ValidationIssue[] {
  if (section.decision === "omit") return [];
  const issues: ValidationIssue[] = [];
  const copy = visibleCopy(section);
  const clientName = evidence.businessName || "";
  const competitorName = competitor.name.trim();
  if (
    competitorName.length > 2 &&
    lower(competitorName) !== lower(clientName) &&
    mentions(copy, competitorName)
  ) {
    issues.push(
      issue(
        section.id,
        "body",
        `Competitor name “${competitorName}” appears in client copy.`,
        "Remove the competitor name. Write about the client only.",
      ),
    );
  }
  const competitorHost = competitor.host;
  if (competitorHost && mentions(copy, competitorHost)) {
    issues.push(
      issue(
        section.id,
        "links",
        "A competitor domain is linked or named in this section.",
        "Replace it with a destination from the client website.",
      ),
    );
  }

  if (section.decision === "needs_input" && copy.trim()) {
    issues.push(
      issue(
        section.id,
        "section",
        "This section still needs client information before it can be published.",
        "Add the missing fact, or omit the section.",
      ),
    );
  }

  const citedFacts = cited(section, evidence);
  const hasUserConfirm = citedFacts.some((fact) => fact.status === "user_confirmed");
  const factual =
    section.items.length > 0 ||
    /\$|£|€|%|guarantee|partner|testimonial|years|customers/i.test(copy);

  if (factual && citedFacts.length === 0 && !hasUserConfirm && section.paragraphs.join(" ").length > 40) {
    issues.push(
      issue(
        section.id,
        "evidence",
        "Factual copy is not tied to client website evidence or an explicit confirmation.",
        "Attach a client source, confirm the claim, or delete it.",
      ),
    );
  }

  for (const item of section.items) {
    if (item.kind === "testimonial" && factsOf(evidence, "testimonial").length === 0 && item.evidenceIds.length === 0) {
      issues.push(
        issue(
          section.id,
          "testimonial",
          "A quotation is present, but the client site has no testimonial evidence.",
          "Remove the quote. Do not invent a customer name, rating, or wording.",
        ),
      );
    }
    if (item.kind === "media" && factsOf(evidence, "media").length === 0) {
      issues.push(
        issue(
          section.id,
          "media",
          "A media mention is shown without a press or “as seen in” source.",
          "Use only documented media mentions. Customer or tool logos are not press.",
        ),
      );
    }
    if (item.kind === "customer" && factsOf(evidence, "customer").length === 0 && item.evidenceIds.length === 0) {
      issues.push(
        issue(
          section.id,
          "customers",
          "A customer is named without evidence of a customer relationship.",
          "Remove the name, or attach the page that says they are a customer.",
        ),
      );
    }
  }

  for (const pattern of CLAIM_PATTERNS) {
    pattern.re.lastIndex = 0;
    const hits = copy.match(pattern.re) || [];
    for (const hit of hits) {
      if (!clientSupports(hit, evidence)) {
        issues.push(
          issue(
            section.id,
            pattern.label,
            `“${hit}” is not in the client evidence record.`,
            "Remove it, or confirm it with a source. Competitor offers do not transfer.",
          ),
        );
      }
    }
  }

  for (const fact of factsOf(evidence, "offer")) {
    if (/expir|ended|no longer|past promotion/i.test(fact.qualifiers || fact.value)) {
      if (mentions(copy, fact.value)) {
        issues.push(
          issue(
            section.id,
            "offer",
            `“${fact.value}” is marked expired or no longer current.`,
            "Do not present it as a live offer. Use a neutral enquiry instead.",
          ),
        );
      }
    }
  }

  for (const id of section.evidenceIds) {
    if (!evidence.facts.some((fact) => fact.id === id)) {
      issues.push(
        issue(
          section.id,
          "evidence",
          `Evidence reference ${id} does not exist in this client record.`,
          "Remove the broken reference or attach a fact from this client’s research.",
        ),
      );
    }
  }
  for (const source of competitor.sections) {
    const words = lower(source.sourceText).split(" ").filter((word) => word.length > 2);
    for (let i = 0; i + 12 <= words.length; i++) {
      const phrase = words.slice(i, i + 12).join(" ");
      if (phrase.length > 40 && lower(copy).includes(phrase)) {
        issues.push(
          issue(
            section.id,
            "originality",
            "This section repeats a long run of competitor wording.",
            "Rewrite it from the client’s facts. Do not paraphrase the competitor claim into the client’s voice.",
          ),
        );
        break;
      }
    }
  }

  for (const field of section.fields || []) {
    if (field.disposition === "omit") continue;
      const empty = !field.text.trim() && field.items.length === 0;
      if (empty) {
        issues.push(
          issue(
            section.id,
            field.id,
            `“${field.kind}” has no content. A generation miss is not an intentional omission.`,
            field.reason || "Regenerate this component or record an omission with a reason.",
          ),
        );
    }
  }

  return issues;
}

function stripUnsupportedCopy(
  section: ContentSection,
  evidence: ClientEvidenceRecord,
  competitor: CompetitorReference,
): { section: ContentSection; notes: ValidationIssue[] } {
  if (section.decision === "omit" || section.locked) {
    return { section, notes: [] };
  }
  const notes: ValidationIssue[] = [];
  const drop = (why: string) => {
    notes.push(
      issue(
        section.id,
        "removed",
        why,
        "It was kept out of the page copy. Supply client evidence, confirm it, or leave it out. Saving is not confirmation.",
      ),
    );
  };
  const keepSentence = (sentence: string) => {
    const rival = competitor.name.trim();
    if (rival.length > 2 && lower(rival) !== lower(evidence.businessName || "") && mentions(sentence, rival)) {
      drop(`Removed competitor name “${rival}” from page copy.`);
      return false;
    }
    if (competitor.host && mentions(sentence, competitor.host)) {
      drop("Removed a competitor domain from page copy.");
      return false;
    }
    for (const pattern of CLAIM_PATTERNS) {
      pattern.re.lastIndex = 0;
      const hits = sentence.match(pattern.re) || [];
      for (const hit of hits) {
        if (!clientSupports(hit, evidence)) {
          drop(`Removed unsupported ${pattern.label} “${hit}” from page copy.`);
          return false;
        }
      }
    }
    for (const fact of factsOf(evidence, "offer")) {
      if (/expir|ended|no longer/i.test(fact.qualifiers || "") && mentions(sentence, fact.value)) {
        drop(`Removed expired offer “${fact.value}” from page copy.`);
        return false;
      }
    }
    return true;
  };
  const heading = keepSentence(section.heading) ? section.heading : "";
  const paragraphs = section.paragraphs
    .map((paragraph) =>
      (paragraph.match(/[^.!?]+[.!?]?/g) || [paragraph])
        .map((part) => part.trim())
        .filter((part) => part && keepSentence(part))
        .join(" ")
        .trim(),
    )
    .filter(Boolean);
  const items = section.items.filter((item) => {
    const unsupportedKind =
      (item.kind === "testimonial" && factsOf(evidence, "testimonial").length === 0 && item.evidenceIds.length === 0) ||
      (item.kind === "media" && factsOf(evidence, "media").length === 0 && item.evidenceIds.length === 0) ||
      (item.kind === "customer" && factsOf(evidence, "customer").length === 0 && item.evidenceIds.length === 0);
    if (unsupportedKind) {
      drop(`Removed unsupported ${item.kind} “${item.label}” from page copy.`);
      return false;
    }
    return keepSentence(`${item.label} ${item.detail || ""}`);
  });
  return { section: { ...section, heading, paragraphs, items }, notes };
}

export function validateCanonical(
  doc: CanonicalContent,
  evidence: ClientEvidenceRecord,
  competitor: CompetitorReference,
): ValidationIssue[] {
  const issues = doc.sections.flatMap((section) =>
    validateSection(section, evidence, competitor),
  );
  if (!doc.meta?.title?.trim()) {
    issues.push(
      issue("meta", "title", "Page title is empty.", "Write a title from the client’s service.", "warning"),
    );
  }
  const included = doc.sections.filter((section) => section.decision !== "omit");
  if (included.length === 0) {
    issues.push(
      issue(null, "sections", "No client sections remain.", "Adapt or replace at least one supported section."),
    );
  }
  return issues;
}

export function hasCriticalIssues(issues: ValidationIssue[]): boolean {
  return issues.some((item) => item.severity === "critical");
}

export function sanitizeGeneratedCopy(
  doc: CanonicalContent,
  evidence: ClientEvidenceRecord,
  competitor: CompetitorReference,
): CanonicalContent {
  const sections = doc.sections.map((section) => {
    const stripped = stripUnsupportedCopy(section, evidence, competitor);
    return stripped.section;
  });
  const validated = applyValidation({ ...doc, sections }, evidence, competitor);
  const notes = doc.sections.flatMap(
    (section) => stripUnsupportedCopy(section, evidence, competitor).notes,
  );
  return {
    ...validated,
    issues: [...notes, ...validated.issues],
    approved: false,
  };
}

export function applyValidation(
  doc: CanonicalContent,
  evidence: ClientEvidenceRecord,
  competitor: CompetitorReference,
): CanonicalContent {
  const sections = doc.sections.map((section) => ({
    ...section,
    issues: validateSection(section, evidence, competitor),
  }));
  const issues = [
    ...sections.flatMap((section) => section.issues),
    ...validateCanonical({ ...doc, sections, issues: [] }, evidence, competitor).filter(
      (item) => item.sectionId === "meta" || item.sectionId == null,
    ),
  ];
  return { ...doc, sections, issues };
}
