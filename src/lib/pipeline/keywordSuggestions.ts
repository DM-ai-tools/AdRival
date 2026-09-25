import type {
  BusinessCategory,
  BusinessLocation,
  BusinessProfile,
  SearchGeoMode,
  ServiceDelivery,
} from "../types";

/**
 * Build geo-aware competitor search keywords from a selected category + locations.
 */
export function buildKeywordsForCategory(input: {
  category: BusinessCategory;
  profile: BusinessProfile;
  geoMode: SearchGeoMode;
}): string[] {
  const label = input.category.label.trim();
  if (!label) return [];

  const delivery: ServiceDelivery =
    input.profile.serviceDelivery ||
    (input.profile.businessModel === "ecommerce" ? "n_a" : "onsite");
  const locations = input.profile.locations || [];
  const primary =
    locations.find((l) => l.isPrimary) || locations[0] || null;

  const out: string[] = [];
  const push = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) {
      out.push(t);
    }
  };

  push(label);

  const localPlaces = (locs: BusinessLocation[]) => {
    for (const loc of locs.slice(0, 4)) {
      if (loc.suburb) push(`${label} ${loc.suburb}`);
      if (loc.city) push(`${label} ${loc.city}`);
      if (loc.suburb && loc.city && loc.suburb !== loc.city) {
        push(`${label} ${loc.suburb} ${loc.city}`);
      }
    }
  };

  if (delivery === "n_a" || input.profile.businessModel === "ecommerce") {
    // Product category terms; only add city when local geo mode
    if (input.geoMode === "company_locations" && primary?.city) {
      push(`${label} ${primary.city}`);
    }
    push(`${label} online`);
    push(`buy ${label}`);
  } else if (delivery === "onsite") {
    if (input.geoMode === "countrywide") {
      push(`${label} near me`);
      if (primary?.city) push(`${label} ${primary.city}`);
    } else {
      localPlaces(locations.length ? locations : primary ? [primary] : []);
      push(`${label} near me`);
    }
  } else {
    // offsite / mixed — city/region service area, not every suburb of rivals
    if (input.geoMode === "countrywide") {
      push(`${label} near me`);
      if (primary?.city) push(`${label} ${primary.city}`);
      if (primary?.region) push(`${label} ${primary.region}`);
    } else {
      for (const loc of (locations.length ? locations : primary ? [primary] : []).slice(
        0,
        4,
      )) {
        if (loc.city) push(`${label} ${loc.city}`);
        if (loc.region) push(`${label} ${loc.region}`);
      }
      push(`${label} near me`);
      push(`mobile ${label}`);
    }
  }

  // Seed a few profile keywords that mention this category
  for (const kw of input.profile.competitorKeywords || []) {
    if (kw.toLowerCase().includes(label.toLowerCase().slice(0, 8))) {
      push(kw);
    }
  }

  return out.slice(0, 12);
}

/** Detect if user keywords already name a known city/suburb from the profile. */
export function detectKeywordLocation(
  keywords: string[],
  locations: BusinessLocation[] | null | undefined,
): string | null {
  if (!keywords.length || !locations?.length) return null;
  const blob = keywords.join(" ").toLowerCase();
  for (const loc of locations) {
    const suburb = loc.suburb?.toLowerCase();
    const city = loc.city.toLowerCase();
    if (suburb && suburb.length >= 3 && blob.includes(suburb)) {
      return loc.suburb!;
    }
    if (city.length >= 3 && blob.includes(city)) {
      return loc.city;
    }
  }
  return null;
}

function realPlaces(locations: BusinessLocation[]): BusinessLocation[] {
  return locations.filter((loc) => {
    const city = (loc.city || "").trim();
    return city.length >= 3 && !/^[A-Za-z]{2}$/.test(city);
  });
}

function placeToken(loc: BusinessLocation): string {
  const city = (loc.city || "").trim();
  if (city.length >= 3 && !/^[A-Za-z]{2}$/.test(city)) return city;
  const suburb = (loc.suburb || "").trim();
  if (suburb.length >= 3) return suburb;
  return "";
}

/**
 * A short query list that covers each company city once.
 * The bare service keyword is last so one city cannot use the whole budget.
 */
export function compactGeoSearchQueries(input: {
  keywords: string[];
  locations: BusinessLocation[];
  categoryLabel?: string | null;
  maxQueries?: number;
}): string[] {
  const max = input.maxQueries ?? 6;
  const keywords = Array.from(
    new Set(
      input.keywords
        .map((kw) => kw.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  );
  const places: string[] = [];
  for (const loc of input.locations) {
    const place = placeToken(loc);
    if (!place) continue;
    if (places.some((existing) => existing.toLowerCase() === place.toLowerCase())) {
      continue;
    }
    places.push(place);
    if (places.length >= 4) break;
  }
  const mentions = (text: string, place: string) =>
    text.toLowerCase().includes(place.toLowerCase());
  const anchor =
    keywords.find((kw) => !places.some((place) => mentions(kw, place))) ||
    input.categoryLabel?.trim() ||
    keywords[0] ||
    "";
  const out: string[] = [];
  const push = (value: string) => {
    const text = value.replace(/\s+/g, " ").trim();
    if (!text || out.length >= max) return;
    if (out.some((existing) => existing.toLowerCase() === text.toLowerCase())) return;
    out.push(text);
  };
  for (const place of places) {
    const existing = keywords
      .filter((kw) => mentions(kw, place))
      .sort((a, b) => a.length - b.length)[0];
    push(existing || (anchor ? `${anchor} ${place}` : place));
  }
  if (anchor) push(anchor);
  if (!out.length) {
    for (const kw of keywords.slice(0, 4)) push(kw);
  }
  return out;
}

/**
 * Resolve effective geo mode + target locations for a search run.
 * Company-locations mode keeps every real branch. A countrywide search
 * narrows only when the keywords themselves name one company place.
 */
export function resolveSearchGeoContext(input: {
  keywords: string[];
  profile: BusinessProfile | null;
  geoMode: SearchGeoMode;
}): {
  geoMode: SearchGeoMode;
  keywordLocation: string | null;
  targetLocations: BusinessLocation[];
} {
  const locations = realPlaces(input.profile?.locations || []);

  if (input.geoMode === "company_locations") {
    return {
      geoMode: "company_locations",
      keywordLocation: null,
      targetLocations: locations,
    };
  }

  const keywordLocation = detectKeywordLocation(input.keywords, locations);

  if (keywordLocation) {
    const matched = locations.filter((l) => {
      const hay = `${l.suburb || ""} ${l.city}`.toLowerCase();
      return hay.includes(keywordLocation.toLowerCase());
    });
    return {
      geoMode: "keyword_location",
      keywordLocation,
      targetLocations:
        matched.length > 0
          ? matched
          : [
              {
                label: keywordLocation,
                city: keywordLocation,
                suburb: null,
                region: null,
                countryCode: input.profile?.primaryMarketCountry || null,
                isPrimary: true,
              },
            ],
    };
  }

  return {
    geoMode: "countrywide",
    keywordLocation: null,
    targetLocations: [],
  };
}
