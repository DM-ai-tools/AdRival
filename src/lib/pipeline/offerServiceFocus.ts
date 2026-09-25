/**
 * Keeps offer-dashboard analysis on the service named in the search keywords.
 * "Rank on Google" must not pull in Google Ads, and a Google Ads offer must
 * not appear on an SEO search.
 */

const SERVICE_FAMILIES: Array<{ id: string; re: RegExp }> = [
  {
    id: "google_ads",
    re: /\b(google ads|adwords|ppc|paid search|paid ads|search ads)\b/i,
  },
  {
    id: "social_ads",
    re: /\b(facebook ads|meta ads|instagram ads|tiktok ads|social ads|social media marketing)\b/i,
  },
  {
    id: "seo",
    re: /\b(seo|search engine optimi[sz]ation|organic search|organic ranking|local seo)\b/i,
  },
  {
    id: "web",
    re: /\b(web design|website design|web development|website development)\b/i,
  },
  {
    id: "email",
    re: /\b(email marketing|newsletter marketing)\b/i,
  },
  {
    id: "dental",
    re: /\b(dental|invisalign|orthodont)\b/i,
  },
  {
    id: "car_finance",
    re: /\b(car loan|vehicle finance|auto loan)\b/i,
  },
  {
    id: "home_loans",
    re: /\b(home loan|mortgage|refinanc)\b/i,
  },
  {
    id: "business_finance",
    re: /\b(business loan|commercial loan|equipment finance)\b/i,
  },
];

/** Tokens that show up in many services and must not keep an unrelated offer. */
const TOKEN_STOP = new Set([
  "service",
  "services",
  "google",
  "agency",
  "marketing",
  "digital",
  "online",
  "business",
  "company",
  "strategy",
  "call",
  "free",
  "best",
  "local",
  "professional",
  "management",
  "your",
  "with",
  "from",
  "that",
  "this",
  "and",
  "the",
  "for",
  "ads",
  "advertising",
  "more",
  "get",
]);

export type ServiceFocus = {
  families: string[];
  tokens: string[];
};

export function familiesInText(text: string): string[] {
  return SERVICE_FAMILIES.filter((family) => family.re.test(text)).map(
    (family) => family.id,
  );
}

/** Service the user asked for, from keywords and the selected category only. */
export function searchedServiceFocus(
  keywords: string[],
  category?: string | null,
): ServiceFocus {
  const blob = [...keywords, category || ""].join(" ");
  const families = familiesInText(blob);
  const tokens = Array.from(
    new Set(
      blob
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3 && !TOKEN_STOP.has(token)),
    ),
  );
  return { families, tokens };
}

/**
 * requireMatch: the offer itself has to name the searched service or share a
 * keyword token. Used for ladders, creatives, and analyzed pages.
 * Without it, only a different named service is removed (raw ads).
 */
export function offerFitsSearchedService(
  text: string,
  focus: ServiceFocus,
  options?: { requireMatch?: boolean },
): boolean {
  if (!focus.families.length && !focus.tokens.length) return true;
  const found = familiesInText(text);
  const targetHit = found.some((family) => focus.families.includes(family));
  const otherService = found.some((family) => !focus.families.includes(family));
  if (focus.families.length) {
    if (targetHit) return true;
    if (otherService) return false;
  }
  if (!options?.requireMatch) return true;
  if (!focus.tokens.length) return !otherService;
  const hay = text.toLowerCase();
  return focus.tokens.some((token) => hay.includes(token));
}
