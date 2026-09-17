export type RelationshipKind =
  | "identity"
  | "customer"
  | "media"
  | "partnership"
  | "platform"
  | "location"
  | "testimonial"
  | "case_study"
  | "service"
  | "offer"
  | "unknown";

const PLACES = /^(melbourne|sydney|brisbane|perth|adelaide|canberra|hobart|darwin|auckland|london|toronto|chicago)$/i;
const PLATFORMS = /^(woocommerce|shopify|wordpress|facebook|instagram|linkedin|tiktok|google|meta|youtube|x|twitter)$/i;

/**
 * A named string is not a media mention or customer unless the surrounding
 * sentence says so. Locations, platforms, and the client's own name never are.
 */
export function classifyRelationship(name: string, context: string, clientName?: string | null): RelationshipKind {
  const label = name.trim();
  const around = context.toLowerCase();
  if (!label) return "unknown";
  if (clientName && label.toLowerCase() === clientName.trim().toLowerCase()) return "identity";
  if (PLACES.test(label)) return "location";
  if (PLATFORMS.test(label)) return "platform";
  if (/as seen in|featured in|press coverage|appeared in/i.test(around) && !PLATFORMS.test(label)) return "media";
  if (/our clients|our customers|trusted by|clients include/i.test(around)) return "customer";
  if (/certified|accredited|partner of|google partner/i.test(around)) return "partnership";
  if (/testimonial|said|says/i.test(around)) return "testimonial";
  if (/\$|%|price|offer/i.test(around)) return "offer";
  if (/we (?:offer|provide|design|manage|build)/i.test(around)) return "service";
  return "unknown";
}

export function proofCategory(kind: RelationshipKind): "media" | "customer" | "certification" | "testimonial" | "location" | null {
  if (kind === "media") return "media";
  if (kind === "customer") return "customer";
  if (kind === "partnership") return "certification";
  if (kind === "testimonial") return "testimonial";
  if (kind === "location") return "location";
  return null;
}
