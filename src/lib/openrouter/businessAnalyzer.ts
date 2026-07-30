import { z } from "zod";
import {
  getOpenRouterClient,
  OPENROUTER_PERPLEXITY_MODEL,
} from "./client";
import type {
  BusinessCategory,
  BusinessLocation,
  BusinessModel,
  BusinessProfile,
  ServiceDelivery,
} from "../types";

const categorySchema = z.object({
  id: z.string().optional().nullable(),
  label: z.string(),
  type: z.enum(["service", "product"]).optional().nullable(),
});

const locationSchema = z.object({
  label: z.string().optional().nullable(),
  city: z.string(),
  suburb: z.string().optional().nullable(),
  region: z.string().optional().nullable(),
  countryCode: z.string().optional().nullable(),
  isPrimary: z.boolean().optional().nullable(),
});

const profileSchema = z.object({
  businessName: z.string(),
  industry: z.string(),
  subIndustry: z.string().optional().nullable(),
  description: z.string(),
  offerings: z.array(z.string()).optional().default([]),
  targetAudience: z.string().optional().nullable(),
  competitorKeywords: z.array(z.string()).min(1),
  positioningSummary: z.string(),
  businessModel: z
    .enum(["service", "ecommerce", "hybrid"])
    .optional()
    .nullable(),
  categories: z.array(categorySchema).optional().default([]),
  serviceDelivery: z
    .enum(["onsite", "offsite", "mixed", "n_a"])
    .optional()
    .nullable(),
  locations: z.array(locationSchema).optional().default([]),
  primaryMarketCountry: z.string().optional().nullable(),
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

function slugId(label: string, index: number): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || `cat-${index + 1}`;
}

function normalizeCategories(
  raw: z.infer<typeof categorySchema>[],
  offerings: string[],
  businessModel: BusinessModel | null,
): BusinessCategory[] {
  const defaultType: BusinessCategory["type"] =
    businessModel === "ecommerce" ? "product" : "service";
  const fromModel = raw
    .map((c, i) => {
      const label = (c.label || "").trim();
      if (!label) return null;
      return {
        id: (c.id || "").trim() || slugId(label, i),
        label,
        type: (c.type as BusinessCategory["type"]) || defaultType,
      } satisfies BusinessCategory;
    })
    .filter((c): c is BusinessCategory => Boolean(c));

  if (fromModel.length) return fromModel.slice(0, 16);

  return offerings
    .map((o, i) => {
      const label = o.trim();
      if (!label) return null;
      return {
        id: slugId(label, i),
        label,
        type: defaultType,
      } satisfies BusinessCategory;
    })
    .filter((c): c is BusinessCategory => Boolean(c))
    .slice(0, 16);
}

function normalizeLocations(
  raw: z.infer<typeof locationSchema>[],
): BusinessLocation[] {
  const out: BusinessLocation[] = [];
  for (const loc of raw) {
    const city = (loc.city || "").trim();
    if (!city) continue;
    const suburb = loc.suburb?.trim() || null;
    const region = loc.region?.trim() || null;
    const countryCode = loc.countryCode?.trim().toUpperCase() || null;
    const label =
      (loc.label || "").trim() ||
      [suburb, city, region].filter(Boolean).join(", ");
    out.push({
      label,
      city,
      suburb,
      region,
      countryCode,
      isPrimary: Boolean(loc.isPrimary),
    });
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * Use Perplexity Sonar (via OpenRouter) to research a business URL and
 * extract industry, categories, locations, delivery model, and keywords.
 */
export async function analyzeBusinessUrl(
  urlInput: string,
): Promise<BusinessProfile> {
  const url = normalizeUrl(urlInput);
  const client = getOpenRouterClient();

  const completion = await client.chat.completions.create({
    model: OPENROUTER_PERPLEXITY_MODEL,
    temperature: 0.2,
    max_tokens: 3200,
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
  "businessModel": "service"|"ecommerce"|"hybrid",
  "categories": [ { "id": string, "label": string, "type": "service"|"product" } ],
  "serviceDelivery": "onsite"|"offsite"|"mixed"|"n_a",
  "locations": [ { "label": string, "city": string, "suburb": string|null, "region": string|null, "countryCode": string|null, "isPrimary": boolean } ],
  "primaryMarketCountry": string|null (ISO-2 like AU, US),
  "competitorKeywords": string[] (6-12 Ad Library keywords for DIRECT competitors),
  "positioningSummary": string
}
Rules:
- businessModel: service clinics/trades/agencies; ecommerce for product stores; hybrid if both.
- categories: list distinct services OR product categories the business actually sells (not marketing jargon). Prefer 4–12 items.
- serviceDelivery:
  - onsite = customer visits their location (clinic, salon, restaurant, retail store)
  - offsite = provider comes to customer / mobile / remote delivery of a service
  - mixed = both
  - n_a = pure ecommerce with no local service visit
- locations: HQ + every branch/suburb you can verify. Include city and suburb when known. countryCode as ISO-2.
- competitorKeywords: what rivals advertise with — include local city/suburb terms when onsite/local; category terms for ecommerce. Not marketing agencies unless the business IS an agency.
- Identify the real industry — do NOT force "marketing agency" unless that is actually their business.`,
      },
      {
        role: "user",
        content: `Analyze this business website and return the JSON profile:\n${url}`,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content?.trim();
  if (!content) throw new Error("Empty response from OpenRouter / Perplexity");

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
  const businessModel = (data.businessModel || null) as BusinessModel | null;
  let serviceDelivery = (data.serviceDelivery || null) as ServiceDelivery | null;
  if (!serviceDelivery) {
    serviceDelivery =
      businessModel === "ecommerce"
        ? "n_a"
        : businessModel === "service"
          ? "onsite"
          : "mixed";
  }

  const offerings = (data.offerings || []).map((s) => s.trim()).filter(Boolean);
  const categories = normalizeCategories(
    data.categories || [],
    offerings,
    businessModel,
  );
  const locations = normalizeLocations(data.locations || []);
  if (locations.length && !locations.some((l) => l.isPrimary)) {
    locations[0].isPrimary = true;
  }

  const primaryMarketCountry =
    data.primaryMarketCountry?.trim().toUpperCase() ||
    locations.find((l) => l.isPrimary)?.countryCode ||
    locations[0]?.countryCode ||
    null;

  return {
    url,
    businessName: data.businessName.trim(),
    industry: data.industry.trim(),
    subIndustry: data.subIndustry?.trim() || null,
    description: data.description.trim(),
    offerings,
    targetAudience: data.targetAudience?.trim() || null,
    businessModel,
    categories,
    serviceDelivery,
    locations,
    primaryMarketCountry,
    competitorKeywords: Array.from(
      new Set(data.competitorKeywords.map((s) => s.trim()).filter(Boolean)),
    ).slice(0, 12),
    positioningSummary: data.positioningSummary.trim(),
    analyzedAt: new Date().toISOString(),
  };
}
