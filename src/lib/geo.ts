/** Geography options for competitor ad search (platform APIs use country/region codes). */

export interface GeoOption {
  code: string;
  label: string;
  /** Platforms that support this code */
  platforms: Array<"meta" | "google" | "linkedin">;
}

export const GEO_OPTIONS: GeoOption[] = [
  { code: "US", label: "United States", platforms: ["meta", "google", "linkedin"] },
  { code: "AU", label: "Australia", platforms: ["meta", "google", "linkedin"] },
  { code: "GB", label: "United Kingdom", platforms: ["meta", "google", "linkedin"] },
  { code: "CA", label: "Canada", platforms: ["meta", "google", "linkedin"] },
  { code: "IN", label: "India", platforms: ["meta", "google", "linkedin"] },
  { code: "DE", label: "Germany", platforms: ["meta", "google", "linkedin"] },
  { code: "SG", label: "Singapore", platforms: ["meta", "google", "linkedin"] },
  { code: "NZ", label: "New Zealand", platforms: ["meta", "google", "linkedin"] },
  { code: "AE", label: "United Arab Emirates", platforms: ["meta", "google", "linkedin"] },
  { code: "all", label: "All regions (Google/YouTube)", platforms: ["google"] },
];

export function geosForPlatform(
  platform: "facebook" | "instagram" | "google" | "youtube" | "linkedin",
): GeoOption[] {
  if (platform === "facebook" || platform === "instagram") {
    return GEO_OPTIONS.filter((g) => g.platforms.includes("meta"));
  }
  if (platform === "google" || platform === "youtube") {
    return GEO_OPTIONS.filter((g) => g.platforms.includes("google"));
  }
  return GEO_OPTIONS.filter((g) => g.platforms.includes("linkedin"));
}

export function defaultGeoForPlatform(
  platform: "facebook" | "instagram" | "google" | "youtube" | "linkedin",
): string {
  if (platform === "google" || platform === "youtube") return "all";
  return "US";
}

/** Normalize UI geo into Meta Ad Library country list */
export function metaCountriesFromGeo(geo: string): string[] {
  if (!geo || geo === "all") return ["US", "AU"];
  return [geo.toUpperCase()];
}

/** Google Transparency region */
export function googleRegionFromGeo(geo: string): string {
  if (!geo || geo === "all") return "all";
  return geo.toUpperCase();
}

/** LinkedIn Ad Library countries param */
export function linkedInCountriesFromGeo(geo: string): string {
  if (!geo || geo === "all") return "US,AU";
  return geo.toUpperCase();
}
