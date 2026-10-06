import { z } from "zod";
import { getOpenRouterClient, OPENROUTER_PERPLEXITY_MODEL } from "./client";
import { isCreditError } from "../accounting/errors";
import type { BusinessLocation, BusinessProfile } from "../types";

const areaSchema = z.object({
  primaryLocation: z
    .object({
      suburb: z.string().optional().nullable(),
      city: z.string().optional().nullable(),
      region: z.string().optional().nullable(),
      countryCode: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
  recommendedGeoScope: z.enum(["local", "countrywide"]),
  geoScopeReason: z.string().optional().nullable(),
  radiusKm: z.number().optional().nullable(),
  nearbyAreas: z.array(z.string()).optional().default([]),
  widerRadiusKm: z.number().optional().nullable(),
  widerAreas: z.array(z.string()).optional().default([]),
  outerRadiusKm: z.number().optional().nullable(),
  outerAreas: z.array(z.string()).optional().default([]),
  metro: z.string().optional().nullable(),
  region: z.string().optional().nullable(),
  searchTerms: z.array(z.string()).optional().default([]),
});

/** Without an AI answer: businesses customers visit or that visit customers compete locally. */
export function fallbackGeoScope(profile: BusinessProfile): {
  scope: "local" | "countrywide";
  reason: string;
} {
  if (profile.businessModel === "ecommerce" || profile.serviceDelivery === "n_a") {
    return { scope: "countrywide", reason: "Sells online, so customers can buy from anywhere in the country." };
  }
  if (profile.serviceDelivery === "onsite" || profile.serviceDelivery === "offsite") {
    return { scope: "local", reason: "Customers use a provider close to where they live or work." };
  }
  return { scope: "countrywide", reason: "Serves customers beyond one city." };
}

function cleanList(values: string[], exclude: string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set(exclude.map((v) => v.trim().toLowerCase()).filter(Boolean));
  for (const raw of values) {
    const v = raw.replace(/\s+/g, " ").trim();
    const key = v.toLowerCase();
    if (v.length < 3 || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Works out where the business is, whether its competitors are local or
 * national, and the search rings around it. Fills the profile's location
 * when the main analysis found none.
 */
export async function analyzeServiceArea(profile: BusinessProfile): Promise<BusinessProfile> {
  const fallback = fallbackGeoScope(profile);
  const known = (profile.locations || [])
    .slice(0, 4)
    .map((l) => [l.suburb, l.city, l.region, l.countryCode].filter(Boolean).join(", "));

  let parsed: z.infer<typeof areaSchema> | null = null;
  try {
    const client = getOpenRouterClient();
    const completion = await client.chat.completions.create({
      model: OPENROUTER_PERPLEXITY_MODEL,
      temperature: 0.1,
      max_tokens: 1400,
      messages: [
        {
          role: "system",
          content: `You decide where a business's competitors are, for a competitor ad search. Use live web knowledge (the website, Google Business listing, contact page).
Return ONLY one JSON object (no markdown):
{
  "primaryLocation": { "suburb": string|null, "city": string|null, "region": string|null (state/province), "countryCode": string|null (ISO-2) } | null,
  "recommendedGeoScope": "local"|"countrywide",
  "geoScopeReason": string (one short sentence a marketer understands),
  "radiusKm": number (how far a typical customer travels to / is served from this business),
  "nearbyAreas": string[] (6-12 real suburbs/towns inside radiusKm, nearest first, excluding the business's own suburb),
  "widerRadiusKm": number,
  "widerAreas": string[] (8-14 real suburbs/towns/cities between radiusKm and widerRadiusKm, nearest first),
  "outerRadiusKm": number (roughly 2x widerRadiusKm),
  "outerAreas": string[] (8-14 of the larger suburbs/towns/cities between widerRadiusKm and outerRadiusKm, nearest first),
  "metro": string|null (the city or metro area the business sits in),
  "region": string|null (state/province),
  "searchTerms": string[] (2-4 short phrases, 1-3 words, that local rivals put in their ads and customers type with a suburb, e.g. "dentist", "dental clinic" — not long category names)
}
Rules:
- "local" when customers pick a provider near them: clinics (dental, medical, physio, vet), salons, gyms, restaurants, trades (plumbers, electricians, builders), real estate, local law/accounting firms, schools, car dealers, venues.
- "countrywide" for ecommerce, SaaS, online services, national brands, and businesses that serve clients remotely.
- radiusKm by how far customers really travel: dentist/GP/salon/cafe 3-8 km in a big city, 10-25 km in a regional town; trades 15-40 km; specialist clinics, venues, car dealers 20-60 km.
- widerRadiusKm is roughly 2-4x radiusKm.
- Areas must be real places near the business. Use names people search with (e.g. "Richmond", not "Richmond VIC 3121").
- Always fill primaryLocation, nearbyAreas and widerAreas when the business has a physical location, even when recommending countrywide.`,
        },
        {
          role: "user",
          content: `Business: ${profile.businessName}
Website: ${profile.url}
Industry: ${profile.industry}${profile.subIndustry ? ` / ${profile.subIndustry}` : ""}
Offerings: ${(profile.offerings || []).slice(0, 8).join(", ") || "n/a"}
Service delivery: ${profile.serviceDelivery || "unknown"}
Locations found so far: ${known.join(" | ") || "none"}`,
        },
      ],
    });
    const content = completion.choices[0]?.message?.content?.trim() || "";
    const json = content.match(/\{[\s\S]*\}/);
    if (json) {
      const result = areaSchema.safeParse(JSON.parse(json[0]));
      if (result.success) parsed = result.data;
    }
  } catch (err) {
    if (isCreditError(err)) throw err;
    console.warn("[serviceArea] analysis failed; using defaults", (err as Error).message);
  }

  const next: BusinessProfile = { ...profile };
  const locations: BusinessLocation[] = [...(profile.locations || [])];
  const primaryFound = parsed?.primaryLocation;
  if (!locations.length && primaryFound?.city?.trim()) {
    const suburb = primaryFound.suburb?.trim() || null;
    const city = primaryFound.city.trim();
    const region = primaryFound.region?.trim() || null;
    locations.push({
      label: [suburb, city, region].filter(Boolean).join(", "),
      city,
      suburb: suburb && suburb.toLowerCase() !== city.toLowerCase() ? suburb : null,
      region,
      countryCode: primaryFound.countryCode?.trim().toUpperCase() || null,
      isPrimary: true,
    });
    next.locations = locations;
    if (!next.primaryMarketCountry && locations[0].countryCode) {
      next.primaryMarketCountry = locations[0].countryCode;
    }
  }

  const primary = locations.find((l) => l.isPrimary) || locations[0] || null;
  next.recommendedGeoScope = parsed?.recommendedGeoScope || fallback.scope;
  next.geoScopeReason = parsed?.geoScopeReason?.trim() || fallback.reason;

  if (parsed && primary) {
    const own = [primary.suburb || "", primary.city];
    const nearbyAreas = cleanList(parsed.nearbyAreas || [], own, 12);
    const widerAreas = cleanList(parsed.widerAreas || [], [...own, ...nearbyAreas], 14);
    const outerAreas = cleanList(
      parsed.outerAreas || [],
      [...own, ...nearbyAreas, ...widerAreas],
      14,
    );
    const radiusKm = Math.min(Math.max(Math.round(parsed.radiusKm || 10), 1), 200);
    next.serviceArea = {
      radiusKm,
      nearbyAreas,
      widerRadiusKm: Math.max(
        radiusKm,
        Math.min(Math.round(parsed.widerRadiusKm || radiusKm * 3), 500),
      ),
      widerAreas,
      outerRadiusKm: outerAreas.length
        ? Math.min(Math.round(parsed.outerRadiusKm || (parsed.widerRadiusKm || radiusKm * 3) * 2), 800)
        : null,
      outerAreas,
      metro: parsed.metro?.trim() || primary.city || null,
      region: parsed.region?.trim() || primary.region || null,
      searchTerms: cleanList(parsed.searchTerms || [], [], 4).filter(
        (t) => t.split(/\s+/).length <= 3,
      ),
    };
  } else if (primary) {
    next.serviceArea = {
      radiusKm: 10,
      nearbyAreas: [],
      widerRadiusKm: 30,
      widerAreas: [],
      metro: primary.city || null,
      region: primary.region || null,
    };
  }
  return next;
}
