import type {
  LandingContentBlock,
  LandingContentDocSection,
  LandingContentDocument,
} from "../types";

/**
 * Build a coherent full-page document from CID blocks when the Claude
 * document path was unavailable (OpenAI slot fallback) or for older drafts.
 */
export function synthesizeDocumentFromBlocks(
  blocks: LandingContentBlock[],
  opts?: {
    pageType?: string | null;
    tone?: string | null;
    competitorUrl?: string | null;
  },
): LandingContentDocument {
  const metaTitle =
    blocks.find((b) => b.role === "meta_title" || b.id === "meta-title")
      ?.text || "";
  const metaDescription =
    blocks.find(
      (b) => b.role === "meta_description" || b.id === "meta-description",
    )?.text || "";

  type Acc = {
    index: number;
    name: string;
    items: LandingContentBlock[];
  };
  const groups = new Map<string, Acc>();
  for (const b of blocks) {
    if (
      b.role === "meta_title" ||
      b.role === "meta_description" ||
      b.id === "meta-title" ||
      b.id === "meta-description"
    ) {
      continue;
    }
    const key = `${b.sectionIndex}::${b.sectionName}`;
    const row = groups.get(key) || {
      index: b.sectionIndex,
      name: b.sectionName || "Section",
      items: [],
    };
    row.items.push(b);
    groups.set(key, row);
  }

  const sections: LandingContentDocSection[] = [...groups.values()]
    .sort((a, b) => a.index - b.index)
    .map((g, i) => {
      const faqs: NonNullable<LandingContentDocSection["faqs"]> = [];
      const links: NonNullable<LandingContentDocSection["links"]> = [];
      const bodyParts: string[] = [];
      const qByIdx = new Map<string, string>();

      for (const item of g.items) {
        const role = (item.role || "").toLowerCase();
        if (role === "faq_question" || role === "faq_q") {
          qByIdx.set(item.id, item.text);
          continue;
        }
        if (role === "faq_answer" || role === "faq_a") {
          const q =
            [...qByIdx.values()].pop() ||
            g.items.find((x) => x.role === "faq_question")?.text ||
            "Question";
          faqs.push({
            question: q,
            answer: item.text,
            aBlockId: item.id,
          });
          continue;
        }
        if (
          role === "nav" ||
          role === "footer_link" ||
          role === "social" ||
          role === "internal_link" ||
          role === "link"
        ) {
          links.push({
            label: item.text,
            href: item.href || "#",
            role: item.role,
          });
          continue;
        }
        if (item.text.trim()) bodyParts.push(item.text.trim());
      }

      for (const [qid, q] of qByIdx) {
        if (faqs.some((f) => f.qBlockId === qid || f.question === q)) continue;
        faqs.push({ question: q, answer: "", qBlockId: qid });
      }

      const nameLower = g.name.toLowerCase();
      let kind: LandingContentDocSection["kind"] = "body";
      if (faqs.length) kind = "faq";
      else if (links.length && bodyParts.length === 0) kind = "links";
      else if (/hero|banner|above/.test(nameLower)) kind = "hero";
      else if (/testimonial|review/.test(nameLower)) kind = "testimonials";
      else if (/cta|call to action/.test(nameLower)) kind = "cta";
      else if (/feature|benefit|service/.test(nameLower)) kind = "features";

      return {
        id: `sec-${i}-${g.index}`,
        kind,
        title: g.name,
        body: bodyParts.join("\n\n"),
        faqs: faqs.length ? faqs : undefined,
        links: links.length ? links : undefined,
        blockIds: g.items.map((x) => x.id),
      };
    })
    .filter(
      (s) =>
        s.body.trim() ||
        (s.faqs && s.faqs.length) ||
        (s.links && s.links.length),
    );

  return {
    pageType: opts?.pageType || null,
    tone: opts?.tone || null,
    summary: "Full page content assembled for review.",
    meta:
      metaTitle || metaDescription
        ? { title: metaTitle, description: metaDescription }
        : null,
    sections,
    competitorUrl: opts?.competitorUrl || null,
  };
}
