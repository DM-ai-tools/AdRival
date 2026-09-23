import { z } from "zod";
import {
  getOpenRouterClient,
  OPENROUTER_PERPLEXITY_MODEL,
} from "../openrouter/client";
import {
  getFacebookProfile,
  getLinkedInCompany,
} from "../sociavault/client";
import type {
  BusinessLocation,
  CompetitorLocationSource,
  CompetitorLocationStatus,
  SearchGeoMode,
} from "../types";

export type ResolvedCompetitorLocation = {
  locationLabel: string | null;
  locationCity: string | null;
  locationSuburb: string | null;
  locationCountry: string | null;
  locationStatus: CompetitorLocationStatus;
  locationSource: CompetitorLocationSource;
  /** high/medium/low when from Perplexity; null for cheap/SV */
  locationConfidence?: "high" | "medium" | "low" | null;
};

function normPlace(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function placesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 3 && b.includes(a)) return true;
  if (b.length >= 3 && a.includes(b)) return true;
  // token overlap (e.g. "ballarat central" vs "ballarat")
  const ta = new Set(a.split(" ").filter((t) => t.length >= 3));
  const tb = b.split(" ").filter((t) => t.length >= 3);
  for (const t of tb) {
    if (ta.has(t)) return true;
  }
  return false;
}

function targetHaystack(t: BusinessLocation): string {
  return normPlace(
    [t.suburb, t.city, t.region, t.label, t.countryCode].filter(Boolean).join(" "),
  );
}

function extractPlaceFields(data: Record<string, unknown> | null | undefined): {
  city: string | null;
  suburb: string | null;
  country: string | null;
  label: string | null;
} {
  if (!data) {
    return { city: null, suburb: null, country: null, label: null };
  }

  const asStr = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
    return null;
  };

  const nested =
    (data.address as Record<string, unknown> | undefined) ||
    (data.headquarters as Record<string, unknown> | undefined) ||
    (data.location as Record<string, unknown> | undefined) ||
    (data.companyLocation as Record<string, unknown> | undefined) ||
    null;

  const city =
    asStr(data.city) ||
    asStr(data.hqCity) ||
    asStr(nested?.city) ||
    asStr(nested?.locality) ||
    null;
  const suburb =
    asStr(data.suburb) ||
    asStr(data.neighborhood) ||
    asStr(nested?.suburb) ||
    asStr(nested?.neighborhood) ||
    null;
  const country =
    asStr(data.country) ||
    asStr(data.countryCode) ||
    asStr(nested?.country) ||
    asStr(nested?.countryCode) ||
    null;
  const label =
    asStr(data.address) ||
    asStr(data.headquarter) ||
    asStr(data.headquarters) ||
    asStr(nested?.full) ||
    asStr(nested?.line1) ||
    [suburb, city, country].filter(Boolean).join(", ") ||
    null;

  const single =
    asStr(data.location) ||
    asStr(data.pageLocation) ||
    asStr(data.areasServed);
  if (!city && single) {
    const parts = single.split(",").map((p) => p.trim()).filter(Boolean);
    return {
      city: parts[0] || single,
      suburb: parts.length > 2 ? parts[0] : null,
      country: parts.length > 1 ? parts[parts.length - 1] : country,
      label: single,
    };
  }

  return { city, suburb, country, label };
}

async function fromSociavault(input: {
  facebookUrl?: string | null;
  linkedinUrl?: string | null;
}): Promise<ResolvedCompetitorLocation | null> {
  if (input.linkedinUrl) {
    try {
      const li = await getLinkedInCompany(input.linkedinUrl);
      const extracted = extractPlaceFields(
        (li.data || null) as Record<string, unknown> | null,
      );
      if (extracted.city || extracted.label) {
        return {
          locationLabel: extracted.label,
          locationCity: extracted.city,
          locationSuburb: extracted.suburb,
          locationCountry: extracted.country,
          locationStatus: "unknown",
          locationSource: "sociavault",
          locationConfidence: "medium",
        };
      }
    } catch {
      // continue
    }
  }

  if (input.facebookUrl) {
    try {
      const fb = await getFacebookProfile(input.facebookUrl);
      const extracted = extractPlaceFields(
        (fb.data || null) as Record<string, unknown> | null,
      );
      if (extracted.city || extracted.label) {
        return {
          locationLabel: extracted.label,
          locationCity: extracted.city,
          locationSuburb: extracted.suburb,
          locationCountry: extracted.country,
          locationStatus: "unknown",
          locationSource: "sociavault",
          locationConfidence: "medium",
        };
      }
    } catch {
      // continue
    }
  }

  return null;
}

const locationLlmSchema = z.object({
  city: z.string().optional().nullable(),
  suburb: z.string().optional().nullable(),
  region: z.string().optional().nullable(),
  countryCode: z.string().optional().nullable(),
  label: z.string().optional().nullable(),
  confidence: z.enum(["high", "medium", "low"]).optional().nullable(),
});

async function fromPerplexity(input: {
  pageName: string;
  website?: string | null;
  linkedinUrl?: string | null;
  facebookUrl?: string | null;
}): Promise<ResolvedCompetitorLocation | null> {
  if (!process.env.OPENROUTER_API_KEY) return null;
  try {
    const client = getOpenRouterClient();
    const completion = await client.chat.completions.create({
      model: OPENROUTER_PERPLEXITY_MODEL,
      temperature: 0.1,
      max_tokens: 600,
      messages: [
        {
          role: "system",
          content: `Find the real-world business location (HQ or main trading suburb/city) for the company.
Return ONLY JSON: { "city": string|null, "suburb": string|null, "region": string|null, "countryCode": string|null, "label": string|null, "confidence": "high"|"medium"|"low" }
If unknown, null the fields and confidence "low". Do not invent.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            pageName: input.pageName,
            website: input.website || null,
            linkedinUrl: input.linkedinUrl || null,
            facebookUrl: input.facebookUrl || null,
          }),
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content || "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = locationLlmSchema.safeParse(JSON.parse(match[0]));
    if (!parsed.success) return null;
    const d = parsed.data;
    const city = d.city?.trim() || null;
    const suburb = d.suburb?.trim() || null;
    const country = d.countryCode?.trim().toUpperCase() || null;
    const label =
      d.label?.trim() ||
      [suburb, city, d.region, country].filter(Boolean).join(", ") ||
      null;
    if (!city && !label) return null;
    return {
      locationLabel: label,
      locationCity: city,
      locationSuburb: suburb,
      locationCountry: country,
      locationStatus: "unknown",
      locationSource: "perplexity",
      locationConfidence: d.confidence || "medium",
    };
  } catch (err) {
    console.warn("[competitorLocation] perplexity failed", err);
    return null;
  }
}

function applyTargetMatch(
  resolved: ResolvedCompetitorLocation,
  targets: BusinessLocation[],
  geoMode: SearchGeoMode,
): ResolvedCompetitorLocation {
  if (!targets.length || geoMode === "countrywide") {
    return {
      ...resolved,
      locationStatus: resolved.locationCity || resolved.locationLabel
        ? "matched"
        : "unknown",
    };
  }

  const city = normPlace(resolved.locationCity);
  const suburb = normPlace(resolved.locationSuburb);
  const label = normPlace(resolved.locationLabel);
  const regionBlob = `${suburb} ${city} ${label}`.trim();
  const resolvedCountry = normPlace(resolved.locationCountry);

  let matched = false;
  for (const t of targets) {
    const tCity = normPlace(t.city);
    const tSuburb = normPlace(t.suburb);
    const tRegion = normPlace(t.region);
    const tCountry = normPlace(t.countryCode);
    const hay = targetHaystack(t);

    if (
      (tSuburb &&
        (placesMatch(suburb, tSuburb) ||
          placesMatch(label, tSuburb) ||
          placesMatch(city, tSuburb) ||
          placesMatch(regionBlob, tSuburb))) ||
      (tCity &&
        (placesMatch(city, tCity) ||
          placesMatch(label, tCity) ||
          placesMatch(suburb, tCity) ||
          placesMatch(regionBlob, tCity))) ||
      (tRegion && placesMatch(regionBlob, tRegion)) ||
      (hay.length >= 4 && placesMatch(regionBlob, hay))
    ) {
      matched = true;
      break;
    }

    // Soft: same country only is not a city match — skip
    void tCountry;
    void resolvedCountry;
  }

  if (matched) {
    return { ...resolved, locationStatus: "matched" };
  }

  if (!city && !suburb && !label) {
    return { ...resolved, locationStatus: "unknown" };
  }

  return { ...resolved, locationStatus: "mismatch" };
}

/** Common metros used to spot clear geo mismatches from ad copy (no network). */
const COMMON_GEO_PLACES = [
  // Australia
  "sydney",
  "melbourne",
  "brisbane",
  "perth",
  "adelaide",
  "canberra",
  "hobart",
  "darwin",
  "gold coast",
  "newcastle",
  "wollongong",
  "geelong",
  "ballarat",
  "bendigo",
  "cairns",
  "townsville",
  "toowoomba",
  "sunshine coast",
  "central coast",
  "parramatta",
  "chatswood",
  // US (high-volume ad markets)
  "new york",
  "los angeles",
  "chicago",
  "houston",
  "phoenix",
  "philadelphia",
  "san antonio",
  "san diego",
  "dallas",
  "san jose",
  "austin",
  "jacksonville",
  "fort worth",
  "columbus",
  "charlotte",
  "san francisco",
  "indianapolis",
  "seattle",
  "denver",
  "washington",
  "boston",
  "nashville",
  "detroit",
  "portland",
  "las vegas",
  "miami",
  "atlanta",
  "minneapolis",
];

/**
 * Zero-network geo hint from page name / ad copy / landing host.
 * Marks mismatch when copy clearly names another metro outside the target set.
 */
export function cheapLocationFromText(input: {
  pageName?: string | null;
  adText?: string | null;
  landingUrl?: string | null;
  targets: BusinessLocation[];
  geoMode: SearchGeoMode;
}): ResolvedCompetitorLocation {
  if (!input.targets.length || input.geoMode === "countrywide") {
    return {
      locationLabel: null,
      locationCity: null,
      locationSuburb: null,
      locationCountry: null,
      locationStatus: "unknown",
      locationSource: "none",
      locationConfidence: "low",
    };
  }

  const blob = normPlace(
    [input.pageName, input.adText, input.landingUrl].filter(Boolean).join(" "),
  );

  for (const t of input.targets) {
    const tSuburb = normPlace(t.suburb);
    const tCity = normPlace(t.city);
    const tRegion = normPlace(t.region);
    if (tSuburb && tSuburb.length >= 3 && blob.includes(tSuburb)) {
      return {
        locationLabel: t.label || t.suburb || t.city,
        locationCity: t.city,
        locationSuburb: t.suburb || null,
        locationCountry: t.countryCode || null,
        locationStatus: "matched",
        locationSource: "none",
        locationConfidence: "medium",
      };
    }
    if (tCity && tCity.length >= 3 && blob.includes(tCity)) {
      return {
        locationLabel: t.label || t.city,
        locationCity: t.city,
        locationSuburb: t.suburb || null,
        locationCountry: t.countryCode || null,
        locationStatus: "matched",
        locationSource: "none",
        locationConfidence: "medium",
      };
    }
    if (tRegion && tRegion.length >= 4 && blob.includes(tRegion)) {
      return {
        locationLabel: t.label || t.region || t.city,
        locationCity: t.city,
        locationSuburb: t.suburb || null,
        locationCountry: t.countryCode || null,
        locationStatus: "matched",
        locationSource: "none",
        locationConfidence: "low",
      };
    }
  }

  const targetTokens = new Set(
    input.targets
      .flatMap((t) => [normPlace(t.city), normPlace(t.suburb), normPlace(t.region)])
      .filter((x) => x.length >= 3),
  );

  for (const place of COMMON_GEO_PLACES) {
    if (place.length < 4) continue;
    if (!blob.includes(place)) continue;
    // Skip if this place is (or contains) a target
    let isTarget = false;
    for (const tok of targetTokens) {
      if (placesMatch(place, tok)) {
        isTarget = true;
        break;
      }
    }
    if (isTarget) continue;
    return {
      locationLabel: place,
      locationCity: place,
      locationSuburb: null,
      locationCountry: null,
      locationStatus: "mismatch",
      locationSource: "none",
      locationConfidence: "medium",
    };
  }

  return {
    locationLabel: null,
    locationCity: null,
    locationSuburb: null,
    locationCountry: null,
    locationStatus: "unknown",
    locationSource: "none",
    locationConfidence: "low",
  };
}

/** Sort key: matched > unknown > mismatch */
export function locationRankScore(
  status?: CompetitorLocationStatus | null,
): number {
  if (status === "matched") return 3;
  if (status === "unknown" || !status) return 2;
  if (status === "mismatch") return 1;
  return 0;
}

/**
 * Resolve competitor location: Sociavault → Perplexity → unknown flag.
 * Always soft-accepts — location is a ranking/label signal, never a hard gate.
 */
/**
 * Deep location (SociaVault / Perplexity) for a search competitor.
 * Intended for offer / page analysis — not keyword search accept.
 */
export async function enrichCompetitorDeepLocation(input: {
  competitorId: string;
  pageName: string;
  website?: string | null;
  facebookUrl?: string | null;
  linkedinUrl?: string | null;
  geoMode?: SearchGeoMode | null;
  targetLocations?: BusinessLocation[] | null;
  provisional?: ResolvedCompetitorLocation | null;
}): Promise<ResolvedCompetitorLocation | null> {
  try {
    const { updateCompetitor } = await import("../db");
    const result = await resolveAndMatchCompetitorLocation({
      pageName: input.pageName,
      website: input.website,
      facebookUrl: input.facebookUrl,
      linkedinUrl: input.linkedinUrl,
      geoMode: input.geoMode || "countrywide",
      targetLocations: input.targetLocations || [],
      provisional: input.provisional || null,
      skipPerplexityIfResolved:
        input.provisional?.locationStatus === "matched",
    });
    const loc = result.location;
    updateCompetitor(input.competitorId, {
      locationLabel: loc.locationLabel,
      locationCity: loc.locationCity,
      locationSuburb: loc.locationSuburb,
      locationCountry: loc.locationCountry,
      locationStatus: loc.locationStatus,
      locationSource: loc.locationSource,
    });
    return loc;
  } catch (err) {
    console.warn("[location] deep enrich failed", err);
    return null;
  }
}

/**
 * Fast address enrich during Find competitors — SociaVault only (Facebook address /
 * LinkedIn HQ). No Perplexity. Updates the competitor row when an address is found.
 */
export async function enrichCompetitorSociavaultAddress(input: {
  competitorId: string;
  facebookUrl?: string | null;
  linkedinUrl?: string | null;
  geoMode?: SearchGeoMode | null;
  targetLocations?: BusinessLocation[] | null;
}): Promise<ResolvedCompetitorLocation | null> {
  try {
    const sv = await fromSociavault({
      facebookUrl: input.facebookUrl,
      linkedinUrl: input.linkedinUrl,
    });
    if (!sv || (!sv.locationLabel && !sv.locationCity)) return null;

    const matched = applyTargetMatch(
      sv,
      input.targetLocations || [],
      input.geoMode || "countrywide",
    );
    const { updateCompetitor } = await import("../db");
    updateCompetitor(input.competitorId, {
      locationLabel: matched.locationLabel,
      locationCity: matched.locationCity,
      locationSuburb: matched.locationSuburb,
      locationCountry: matched.locationCountry,
      locationStatus: matched.locationStatus,
      locationSource: "sociavault",
    });
    return matched;
  } catch (err) {
    console.warn("[location] Sociavault address enrich failed", err);
    return null;
  }
}

export async function resolveAndMatchCompetitorLocation(input: {
  pageName: string;
  website?: string | null;
  facebookUrl?: string | null;
  linkedinUrl?: string | null;
  geoMode: SearchGeoMode;
  targetLocations: BusinessLocation[];
  /** Skip Perplexity when cheap match already succeeded */
  skipPerplexityIfResolved?: boolean;
  provisional?: ResolvedCompetitorLocation | null;
}): Promise<{
  location: ResolvedCompetitorLocation;
  /** Always true — kept for call-site compatibility */
  accept: boolean;
}> {
  if (
    input.provisional?.locationStatus === "matched" &&
    input.skipPerplexityIfResolved
  ) {
    return {
      location: applyTargetMatch(
        input.provisional,
        input.targetLocations,
        input.geoMode,
      ),
      accept: true,
    };
  }

  let resolved =
    (await fromSociavault({
      facebookUrl: input.facebookUrl,
      linkedinUrl: input.linkedinUrl,
    })) || null;

  if (!resolved) {
    resolved = await fromPerplexity({
      pageName: input.pageName,
      website: input.website,
      linkedinUrl: input.linkedinUrl,
      facebookUrl: input.facebookUrl,
    });
  }

  if (!resolved) {
    resolved = input.provisional || {
      locationLabel: null,
      locationCity: null,
      locationSuburb: null,
      locationCountry: null,
      locationStatus: "unknown",
      locationSource: "none",
      locationConfidence: "low",
    };
  }

  const matched = applyTargetMatch(
    resolved,
    input.targetLocations,
    input.geoMode,
  );

  return { location: matched, accept: true };
}

function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(
      /^www\./i,
      "",
    );
  } catch {
    return null;
  }
}

async function fromFirecrawlSearch(input: {
  pageName: string;
  website?: string | null;
  landingPageUrl?: string | null;
  domain?: string | null;
  countryHint?: string | null;
}): Promise<ResolvedCompetitorLocation | null> {
  const {
    firecrawlSearch,
    flattenFirecrawlSearchResults,
    hasFirecrawlKey,
  } = await import("../firecrawl/client");
  if (!hasFirecrawlKey()) return null;

  const domain =
    input.domain ||
    hostFromUrl(input.website) ||
    hostFromUrl(input.landingPageUrl);
  const queries = [
    input.landingPageUrl
      ? `what is the business address of ${input.landingPageUrl}`
      : null,
    domain ? `what is the address of ${domain}` : null,
    input.pageName
      ? `what is the business address of "${input.pageName}"${domain ? ` ${domain}` : ""}`
      : null,
    domain ? `"${input.pageName || domain}" headquarters address` : null,
  ].filter((q): q is string => Boolean(q));

  const snippets: string[] = [];
  for (const query of queries.slice(0, 3)) {
    try {
      const result = await firecrawlSearch(query, {
        limit: 5,
        country: input.countryHint || undefined,
      });
      for (const row of flattenFirecrawlSearchResults(result)) {
        const line = [row.title, row.description, row.url]
          .filter(Boolean)
          .join(" — ");
        if (line) snippets.push(line);
      }
      if (snippets.length >= 6) break;
    } catch (err) {
      console.warn("[location] Firecrawl search failed:", (err as Error).message);
    }
  }
  if (!snippets.length) return null;

  // Prefer LLM parse when available; else regex-ish first address-looking snippet
  if (process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY) {
    try {
      const {
        getOpenAICompatClient,
        resolveOpenAICompatModel,
      } = await import("../openrouter/openaiCompat");
      const client = getOpenAICompatClient();
      const completion = await client.chat.completions.create({
        model: resolveOpenAICompatModel("gpt-4o-mini"),
        temperature: 0.1,
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content: `Extract the company's real-world business address or HQ city from search snippets.
Return JSON only: {"label":"street or city string or null","city":"string or null","suburb":"string or null","country":"string or null","confidence":"high|medium|low"}.
If unknown, use nulls. Prefer a full street address when present.`,
          },
          {
            role: "user",
            content: JSON.stringify({
              company: input.pageName,
              domain,
              website: input.website,
              landingPageUrl: input.landingPageUrl,
              snippets: snippets.slice(0, 12),
            }),
          },
        ],
        response_format: { type: "json_object" },
      });
      const raw = completion.choices[0]?.message?.content || "{}";
      const parsed = JSON.parse(raw) as {
        label?: string | null;
        city?: string | null;
        suburb?: string | null;
        country?: string | null;
      };
      const label = (parsed.label || "").trim() || null;
      const city = (parsed.city || "").trim() || null;
      if (!label && !city) return null;
      return {
        locationLabel: label || city,
        locationCity: city || label,
        locationSuburb: (parsed.suburb || "").trim() || null,
        locationCountry: (parsed.country || "").trim() || null,
        locationStatus: "unknown",
        locationSource: "firecrawl",
        locationConfidence: "medium",
      };
    } catch (err) {
      console.warn("[location] Firecrawl address parse failed:", (err as Error).message);
    }
  }

  // Fallback: first snippet that looks like it contains a place
  const placeLike = snippets.find((s) =>
    /\b(street|st\.|road|rd\.|avenue|ave\.|suite|floor|city|headquarters|hq|australia|united states|, [A-Z]{2,3}\b)/i.test(
      s,
    ),
  );
  if (!placeLike) return null;
  return {
    locationLabel: placeLike.slice(0, 160),
    locationCity: null,
    locationSuburb: null,
    locationCountry: null,
    locationStatus: "unknown",
    locationSource: "firecrawl",
    locationConfidence: "low",
  };
}

/**
 * Redo location via Firecrawl web search (on-demand after Find competitors).
 * Queries address of landing URL / domain / company name, then updates the row.
 */
export async function enrichCompetitorFirecrawlLocation(input: {
  competitorId: string;
  pageName: string;
  website?: string | null;
  landingPageUrl?: string | null;
  domain?: string | null;
  countryHint?: string | null;
  geoMode?: SearchGeoMode | null;
  targetLocations?: BusinessLocation[] | null;
}): Promise<ResolvedCompetitorLocation | null> {
  try {
    const resolved = await fromFirecrawlSearch({
      pageName: input.pageName,
      website: input.website,
      landingPageUrl: input.landingPageUrl,
      domain: input.domain,
      countryHint: input.countryHint,
    });
    if (!resolved) return null;
    const matched = applyTargetMatch(
      resolved,
      input.targetLocations || [],
      input.geoMode || "countrywide",
    );
    // locationSource type may not include firecrawl yet — cast via update
    const { updateCompetitor } = await import("../db");
    updateCompetitor(input.competitorId, {
      locationLabel: matched.locationLabel,
      locationCity: matched.locationCity,
      locationSuburb: matched.locationSuburb,
      locationCountry: matched.locationCountry,
      locationStatus: matched.locationStatus,
      locationSource: "firecrawl" as CompetitorLocationSource,
    });
    return { ...matched, locationSource: "firecrawl" as CompetitorLocationSource };
  } catch (err) {
    console.warn("[location] Firecrawl enrich failed", err);
    return null;
  }
}

/** Batch Firecrawl location refresh for a search run. */
export async function enrichRunFirecrawlLocations(
  runId: string,
  options?: { onlyUnknown?: boolean },
): Promise<{ updated: number; skipped: number; failed: number }> {
  const { getCompetitorsByRun, getJob } = await import("../db");
  const job = getJob(runId);
  const competitors = getCompetitorsByRun(runId);
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  for (const c of competitors) {
    const hasLoc = Boolean(c.locationLabel || c.locationCity);
    if (options?.onlyUnknown !== false && hasLoc && c.locationStatus !== "unknown") {
      skipped += 1;
      continue;
    }
    const loc = await enrichCompetitorFirecrawlLocation({
      competitorId: c.id,
      pageName: c.pageName,
      website: c.brand?.website || null,
      landingPageUrl: c.sampleAd?.landingPageUrl || null,
      domain: c.sampleAd?.domain || null,
      countryHint: typeof c.country === "string" ? c.country : null,
      geoMode: job?.geoMode || "countrywide",
      targetLocations: job?.targetLocations || [],
    });
    if (loc?.locationLabel || loc?.locationCity) updated += 1;
    else failed += 1;
  }
  return { updated, skipped, failed };
}
