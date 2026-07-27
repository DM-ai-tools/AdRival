import { z } from "zod";
import {
  getOpenRouterClient,
  OPENROUTER_PERPLEXITY_MODEL,
} from "./client";
import type { BusinessProfile } from "../types";

const profileSchema = z.object({
  businessName: z.string(),
  industry: z.string(),
  subIndustry: z.string().optional().nullable(),
  description: z.string(),
  offerings: z.array(z.string()).optional().default([]),
  targetAudience: z.string().optional().nullable(),
  competitorKeywords: z.array(z.string()).min(1),
  positioningSummary: z.string(),
});

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Business URL is required");
  const withProto = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const u = new URL(withProto);
  if (!u.hostname.includes(".")) {
    throw new Error("Enter a valid business website URL");
  }
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

/**
 * Use Perplexity Sonar (via OpenRouter) to research a business URL and
 * extract industry + competitor-search keywords.
 */
export async function analyzeBusinessUrl(
  urlInput: string,
): Promise<BusinessProfile> {
  const url = normalizeUrl(urlInput);
  const client = getOpenRouterClient();

  const completion = await client.chat.completions.create({
    model: OPENROUTER_PERPLEXITY_MODEL,
    temperature: 0.2,
    // OpenRouter defaults can request huge max_tokens and 402 if credits are low
    max_tokens: 2048,
    messages: [
      {
        role: "system",
        content: `You are a competitive-intelligence analyst. Research the given business website using live web knowledge.
Return ONLY a single JSON object (no markdown) with this shape:
{
  "businessName": string,
  "industry": string,
  "subIndustry": string|null,
  "description": string (2-4 sentences),
  "offerings": string[] (products/services),
  "targetAudience": string|null,
  "competitorKeywords": string[] (6-12 Ad Library / ads search keywords that would surface DIRECT competitors in the same industry — not marketing agencies unless the business IS an agency),
  "positioningSummary": string (one sentence: who they compete with and on what)
}
Rules:
- Identify the real industry (e.g. dental clinic, ecommerce fashion, B2B SaaS HR, restaurant franchise) — do NOT force "marketing agency" unless that is actually their business.
- competitorKeywords should be what rivals would bid on or advertise with (brand-adjacent category terms, product categories, local service terms).
- Prefer concrete commercial keywords over vague ones.`,
      },
      {
        role: "user",
        content: `Analyze this business website and return the JSON profile:\n${url}`,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content?.trim();
  if (!content) throw new Error("Empty response from OpenRouter / Perplexity");

  // Sonar sometimes wraps JSON in markdown fences or adds citations text
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Could not parse business profile JSON from model response");
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("Invalid JSON in business profile response");
  }

  const parsed = profileSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    throw new Error(`Business profile schema mismatch: ${parsed.error.message}`);
  }

  const data = parsed.data;
  return {
    url,
    businessName: data.businessName.trim(),
    industry: data.industry.trim(),
    subIndustry: data.subIndustry?.trim() || null,
    description: data.description.trim(),
    offerings: (data.offerings || []).map((s) => s.trim()).filter(Boolean),
    targetAudience: data.targetAudience?.trim() || null,
    competitorKeywords: Array.from(
      new Set(
        data.competitorKeywords.map((s) => s.trim()).filter(Boolean),
      ),
    ).slice(0, 12),
    positioningSummary: data.positioningSummary.trim(),
    analyzedAt: new Date().toISOString(),
  };
}
