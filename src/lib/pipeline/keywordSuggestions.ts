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

/**
 * Resolve effective geo mode + target locations for a search run.
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
  const locations = input.profile?.locations || [];
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

  if (input.geoMode === "company_locations") {
    return {
      geoMode: "company_locations",
      keywordLocation: null,
      targetLocations: locations.length
        ? locations
        : input.profile?.primaryMarketCountry
          ? [
              {
                label: input.profile.primaryMarketCountry,
                city: input.profile.primaryMarketCountry,
                suburb: null,
                region: null,
                countryCode: input.profile.primaryMarketCountry,
                isPrimary: true,
              },
            ]
          : [],
    };
  }

  return {
    geoMode: "countrywide",
    keywordLocation: null,
    targetLocations: [],
  };
}
