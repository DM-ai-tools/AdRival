import OpenAI from "openai";
import { getOpenAiContentModel } from "./contentDraft";

/**
 * Optional design-feedback pass: tweak already-pasted approved strings.
 * Does NOT invent a new pack — only changes copy the feedback requires.
 */
export async function applyDesignFeedbackToReplacements(input: {
  replacements: Map<string, string>;
  userFeedback: string;
  brandName: string;
  keyword: string;
  competitorName: string;
}): Promise<Map<string, string>> {
  const feedback = input.userFeedback.trim().slice(0, 4000);
  if (!feedback) return input.replacements;
  if (!process.env.OPENAI_API_KEY) return input.replacements;

  const entries = [...input.replacements.entries()].filter(
    ([, text]) => text.trim().length >= 2,
  );
  if (!entries.length) return input.replacements;

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = getOpenAiContentModel();
  const out = new Map(input.replacements);

  // Batch so we don't blow context; feedback applies across batches
  for (let i = 0; i < entries.length; i += 40) {
    const batch = entries.slice(i, i + 40).map(([id, text]) => ({ id, text }));
    try {
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.3,
        max_tokens: 8000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You revise landing-page copy that was ALREADY approved by the user.
Return ONLY JSON: { "changes": [ { "id": "n0", "newText": "..." } ] }

Hard rules:
1) Only include ids that MUST change to satisfy designFeedback. Leave everything else out.
2) newText must stay faithful to the original string's meaning — edit for tone/emphasis/CTA wording the feedback asks for.
3) Do not invent new offers, prices, guarantees, or licence numbers.
4) Never mention competitor "${input.competitorName}".
5) Keep brand "${input.brandName}" and keyword "${input.keyword}" where they already appear.
6) Keep similar length (±30%). Prefer minimal edits.`,
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                designFeedback: feedback,
                brand: input.brandName,
                keyword: input.keyword,
                strings: batch,
              },
              null,
              2,
            ),
          },
        ],
      });
      const raw = completion.choices[0]?.message?.content;
      if (!raw) continue;
      const parsed = JSON.parse(raw) as {
        changes?: Array<{ id?: string; newText?: string }>;
      };
      const allowed = new Set(batch.map((b) => b.id));
      for (const row of parsed.changes || []) {
        if (!row.id || !allowed.has(row.id) || !row.newText?.trim()) continue;
        out.set(row.id, row.newText.replace(/\s+/g, " ").trim());
      }
    } catch (err) {
      console.warn("[design-feedback] batch failed", i, err);
    }
  }

  return out;
}
