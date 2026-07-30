import OpenAI from "openai";
import type { LandingContentDraft } from "../types";
import type { CidTextNode } from "./archive/rewriteTextByCid";
import { getOpenAiContentModel } from "./contentDraft";

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function widenBudget(node: CidTextNode): { minLen: number; maxLen: number } {
  const len = Math.max(node.text.length, 8);
  return {
    // Prefer filling to near-original density — avoid short stubs
    minLen: Math.max(4, Math.floor(len * 0.75)),
    maxLen: Math.max(len + 8, Math.ceil(len * 1.55)),
  };
}

function roleHint(role: string): string {
  const r = role.toLowerCase();
  if (r === "h1") return "primary headline";
  if (r === "h2") return "section heading";
  if (r.startsWith("h")) return "subheading";
  if (r === "button" || r === "a") return "CTA / link label";
  if (r === "li") return "bullet / list item";
  if (r === "p") return "body paragraph";
  return "UI text";
}

/**
 * Fit approved phase-1 content into EVERY stamped CID node via OpenAI.
 * Uses the approved pack as source material — never keeps competitor node.text.
 */
export async function fitApprovedContentToCids(input: {
  draft: LandingContentDraft;
  nodes: CidTextNode[];
  brandName: string;
  keyword: string;
  competitorName: string;
  industry?: string | null;
  /** Design-only feedback — adjust tone, emphasis, CTAs, layout-sensitive copy while staying on-pack */
  userFeedback?: string | null;
}): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const nodes = input.nodes.filter((n) => !n.inFooter);
  if (!nodes.length) return map;
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to fit approved content into the design");
  }

  const pack = input.draft.blocks
    .filter((b) => b.text?.trim())
    .map((b) => ({
      id: b.id,
      role: b.role,
      section: b.sectionName,
      label: b.label,
      text: b.text.trim(),
    }));

  if (pack.length < 2) {
    throw new Error("Approved content pack is empty — regenerate content first");
  }

  const designFeedback = input.userFeedback?.trim().slice(0, 4000) || "";
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = getOpenAiContentModel();

  const system = `You embed an APPROVED brand content pack into a landing-page design's text slots.

You receive:
1) approvedPack — the ONLY allowed messaging source (already reviewed by the user)
2) slots — every visible text node in the design (ids, role, competitorLength, minLen/maxLen)
3) designFeedback — optional user notes for this design pass (tone, emphasis, CTA wording, what to fix)

Return ONLY JSON:
{ "replacements": [ { "id": "n0", "newText": "..." }, ... ] }

Hard rules:
1) Rewrite EVERY slot id you are given. Do not skip any.
2) newText MUST be derived from approvedPack angles/claims — never copy or lightly paraphrase the competitor's original slot text (you are NOT shown competitor wording on purpose).
3) Never mention competitor "${input.competitorName}".
4) Use brand "${input.brandName}" and keyword "${input.keyword}" naturally where it fits.
5) LENGTH: newText length MUST be between minLen and maxLen for that slot. Prefer filling toward maxLen for body/paragraphs so the page stays as dense as the original design — do not write short stubs.
6) Match role: h1 = headline, h2/h3 = headings, button/a = short CTA, p = full paragraph, li = distinct bullet.
7) Each substantial newText (len≥24) must be unique across this response.
8) Do not invent regulated guarantees or licence numbers.
9) Expand approved pack ideas across many slots — one approved body may seed several related paragraphs with fresh wording.
10) If designFeedback is present, prioritize satisfying it while still staying within approvedPack facts/claims (rephrase/emphasize/reorder angles — do not invent off-pack offers).`;

  // Batch slots; include full pack each time for consistency
  for (let i = 0; i < nodes.length; i += 35) {
    const batch = nodes.slice(i, i + 35).map((n) => {
      const budget = widenBudget(n);
      return {
        id: n.id,
        role: n.role,
        roleHint: roleHint(n.role),
        competitorLength: n.text.length,
        minLen: budget.minLen,
        maxLen: budget.maxLen,
      };
    });

    const completion = await client.chat.completions.create({
      model,
      temperature: designFeedback ? 0.75 : 0.7,
      max_tokens: 12000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify(
            {
              brand: input.brandName,
              keyword: input.keyword,
              industry: input.industry || null,
              designFeedback: designFeedback || null,
              approvedPack: pack,
              slots: batch,
            },
            null,
            2,
          ),
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as {
        replacements?: Array<{ id?: string; newText?: string }>;
      };
      const byId = new Map(batch.map((b) => [b.id, b]));
      for (const row of parsed.replacements || []) {
        if (!row.id || !row.newText?.trim()) continue;
        const meta = byId.get(row.id);
        if (!meta) continue;
        let text = normalize(row.newText);
        if (text.length > meta.maxLen) {
          text = text.slice(0, meta.maxLen).replace(/\s+\S*$/, "").trim();
        }
        // If still too short, keep it anyway — apply step will force-write
        if (text.length >= 2) map.set(row.id, text);
      }
    } catch (err) {
      console.warn("[fit] failed to parse fit batch", i, err);
    }
  }

  // Ensure coverage: any missing slot gets a deterministic pack-based fill
  let packIdx = 0;
  const usablePack = pack.filter(
    (p) => !["meta_title", "meta_description", "nav", "footer_link", "social"].includes(p.role),
  );
  for (const node of nodes) {
    if (map.has(node.id)) continue;
    const budget = widenBudget(node);
    const seed =
      usablePack.find((p) => roleHint(node.role).includes(p.role) || p.role === node.role) ||
      usablePack[packIdx % Math.max(usablePack.length, 1)];
    packIdx += 1;
    if (!seed) continue;
    let text = seed.text;
    // Expand short seed toward min length by appending brand/keyword once
    if (text.length < budget.minLen) {
      const pad = ` ${input.brandName} helps with ${input.keyword}.`.trim();
      text = normalize(`${text} ${pad}`);
    }
    if (text.length > budget.maxLen) {
      text = text.slice(0, budget.maxLen).replace(/\s+\S*$/, "").trim();
    }
    if (text.length >= 2) map.set(node.id, text);
  }

  return map;
}
