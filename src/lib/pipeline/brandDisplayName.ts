/**
 * Resolve a display brand name that must never collapse to the competitor name.
 */
export function brandNameFromUrl(businessUrl: string): string {
  try {
    const host = new URL(
      /^https?:\/\//i.test(businessUrl) ? businessUrl : `https://${businessUrl}`,
    ).hostname.replace(/^www\./i, "");
    const label = (host.split(".")[0] || host).trim();
    if (!label) return "Your Brand";
    // Common compound hosts → readable title case words
    const spaced = label
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // trafficradius → Traffic Radius (split known marketing suffixes lightly)
    const softened = spaced.replace(
      /^(.*)(radius|digital|media|agency|marketing|ads|group)$/i,
      (_, a, b) => `${a} ${b}`.trim(),
    );
    return softened
      .split(" ")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  } catch {
    return "Your Brand";
  }
}

/** Prefer brand token from SEO titles like "Services | Traffic Radius". */
function cleanSiteName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("|")) {
    const parts = trimmed
      .split("|")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      // Last segment is usually the brand
      const last = parts[parts.length - 1];
      if (last.length >= 2 && last.length <= 48) return last;
    }
  }
  // "Traffic Radius - Digital Marketing" → "Traffic Radius"
  const dash = trimmed.split(/\s[-–—]\s/)[0]?.trim();
  if (dash && dash.length >= 2 && dash.length < trimmed.length && dash.length <= 48) {
    return dash;
  }
  return trimmed;
}

export function resolveBrandDisplayName(input: {
  businessUrl: string;
  siteName?: string | null;
  profileName?: string | null;
  /** Competitor / lookup query — never use as the brand name */
  competitorName?: string | null;
}): string {
  const competitor = (input.competitorName || "").trim().toLowerCase();
  const candidates = [
    input.siteName,
    input.profileName,
    brandNameFromUrl(input.businessUrl),
  ];
  for (const raw of candidates) {
    const name = cleanSiteName(raw || "");
    if (!name) continue;
    // Never use the competitor / lookup query as the brand name
    if (competitor && name.toLowerCase() === competitor) continue;
    return name;
  }
  return brandNameFromUrl(input.businessUrl) || "Your Brand";
}
