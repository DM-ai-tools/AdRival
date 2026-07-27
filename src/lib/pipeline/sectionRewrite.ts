import * as cheerio from "cheerio";
import type { BusinessProfile } from "../types";
import {
  getAnthropicClient,
  getAnthropicModel,
} from "../anthropic/client";

export type PageSection = {
  id: string;
  heading: string | null;
  headingTag: string | null;
  paragraphs: string[];
  role: string;
};

function normalizeText(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Split the page into section chunks (heading + nearby paragraphs) for Claude rewrite.
 */
export function extractPageSections(html: string): PageSection[] {
  const $ = cheerio.load(html);
  const sections: PageSection[] = [];
  let i = 0;

  const blocks = $("h1, h2, h3, section, article").toArray();
  const seenHeadings = new Set<string>();

  for (const el of blocks) {
    const $el = $(el);
    const tag = ((el as { tagName?: string }).tagName || "").toLowerCase();

    let heading: string | null = null;
    let headingTag: string | null = null;
    let paragraphs: string[] = [];

    if (tag === "h1" || tag === "h2" || tag === "h3") {
      heading = normalizeText($el.text());
      headingTag = tag;
      if (!heading || heading.length < 3) continue;
      if (seenHeadings.has(heading.toLowerCase())) continue;
      seenHeadings.add(heading.toLowerCase());

      // Collect following siblings until next heading
      let sib = $el.next();
      let guard = 0;
      while (sib.length && guard < 12) {
        const st = (sib.get(0) as { tagName?: string } | undefined)?.tagName?.toLowerCase() || "";
        if (st === "h1" || st === "h2" || st === "h3") break;
        if (st === "p" || st === "li") {
          const t = normalizeText(sib.text());
          if (t.length >= 12) paragraphs.push(t);
        } else {
          sib.find("p, li").each((_, p) => {
            const t = normalizeText($(p).text());
            if (t.length >= 12) paragraphs.push(t);
          });
        }
        sib = sib.next();
        guard += 1;
      }
    } else {
      const h = $el.find("h1, h2, h3").first();
      heading = h.length ? normalizeText(h.text()) : null;
      headingTag = h.length
        ? ((h.get(0) as { tagName?: string }).tagName || "").toLowerCase()
        : null;
      if (heading) {
        if (seenHeadings.has(heading.toLowerCase())) continue;
        seenHeadings.add(heading.toLowerCase());
      }
      $el.find("p, li").each((_, p) => {
        const t = normalizeText($(p).text());
        if (t.length >= 12) paragraphs.push(t);
      });
      paragraphs = paragraphs.slice(0, 8);
    }

    paragraphs = [...new Set(paragraphs)].slice(0, 6);
    if (!heading && paragraphs.length === 0) continue;

    const roleHint = `${heading || ""} ${paragraphs[0] || ""}`.toLowerCase();
    let role = "content";
    if (/faq|question|answer/.test(roleHint)) role = "faq";
    else if (/testimonial|review|customer/.test(roleHint)) role = "social_proof";
    else if (/feature|benefit|why|how it works/.test(roleHint)) role = "features";
    else if (/contact|get started|apply|compare/.test(roleHint)) role = "cta";
    else if (headingTag === "h1" || i === 0) role = "hero";

    sections.push({
      id: `s${i++}`,
      heading,
      headingTag,
      paragraphs,
      role,
    });
    if (sections.length >= 18) break;
  }

  return sections;
}

/**
 * Rewrite each section's heading + paragraphs with Claude (original copy).
 */
export async function rewriteSectionsWithClaude(input: {
  sections: PageSection[];
  keyword: string;
  competitorName: string;
  brandName: string;
  businessUrl: string;
  profile: BusinessProfile | null;
  userFeedback?: string | null;
}): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!input.sections.length) return map;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required for section rewrite");
  }

  const client = getAnthropicClient();
  const model = getAnthropicModel();
  const feedback = input.userFeedback?.trim() || "";

  // Process in batches of 4 sections for quality
  for (let i = 0; i < input.sections.length; i += 4) {
    const batch = input.sections.slice(i, i + 4);
    const feedbackRule = feedback
      ? `
8) HIGHEST PRIORITY — honor this USER FEEDBACK (tone, offers, CTAs, what to stress or avoid):
"""
${feedback.slice(0, 2000)}
"""
`
      : "";

    const system = `You rewrite landing-page SECTIONS for a NEW brand. Layout/structure is borrowed; wording must be original.

Return ONLY JSON:
{
  "sections": [
    {
      "id": "s0",
      "heading": "new heading or null",
      "paragraphs": ["new p1", "new p2"]
    }
  ]
}

Hard rules:
1) Rewrite EVERY heading and paragraph — no light paraphrases. Target <35% word overlap with source.
2) Never mention competitor "${input.competitorName}" or their celebrities/mascots/phone numbers.
3) Use brand "${input.brandName}" and keyword "${input.keyword}" naturally in hero/CTA sections.
4) Keep roughly similar length so HTML layout holds.
5) Keep the same number of paragraphs (or one fewer if needed).
6) No fake endorsements or regulated guarantees.
7) English only.${feedbackRule}`;

    try {
      const completion = await client.messages.create({
        model,
        max_tokens: 4500,
        temperature: 0.75,
        system,
        messages: [
          {
            role: "user",
            content: JSON.stringify(
              {
                brand: {
                  name: input.brandName,
                  url: input.businessUrl,
                  industry: input.profile?.industry || null,
                  offerings: input.profile?.offerings || [],
                  audience: input.profile?.targetAudience || null,
                },
                keyword: input.keyword,
                userFeedback: feedback || null,
                sections: batch,
              },
              null,
              2,
            ),
          },
        ],
      });

      const content = completion.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;
      const parsed = JSON.parse(jsonMatch[0]) as {
        sections?: Array<{
          id?: string;
          heading?: string | null;
          paragraphs?: string[];
        }>;
      };

      for (const out of parsed.sections || []) {
        const src = batch.find((s) => s.id === out.id);
        if (!src) continue;
        if (src.heading && out.heading && out.heading.trim()) {
          map.set(src.heading, normalizeText(out.heading));
        }
        const paras = out.paragraphs || [];
        src.paragraphs.forEach((from, idx) => {
          const to = paras[idx];
          if (to && to.trim()) map.set(from, normalizeText(to));
        });
      }
    } catch (err) {
      console.error("[sections] Claude section rewrite failed", err);
    }
  }

  return map;
}
