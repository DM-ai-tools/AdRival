import type { BusinessLocation, BusinessProfile } from "../types";

/**
 * One step of a city/suburb search. Rings run nearest first; a search moves
 * to the next ring only while it is short of competitors, and goes
 * country-wide after the last one.
 */
export type SearchRing = {
  level: number;
  /** Shown in progress, e.g. "within ~6 km of Richmond". */
  label: string;
  /** Places new to this ring (earlier rings still count as local). */
  places: BusinessLocation[];
};

function placeOf(
  name: string,
  countryCode: string | null,
  region: string | null = null,
): BusinessLocation {
  return {
    label: name,
    city: name,
    suburb: null,
    // Region is set only on the state ring: a region match counts the whole state.
    region,
    countryCode,
    isPrimary: false,
  };
}

/** Rings around the business: nearby areas, the wider area / metro, further towns, then the state. */
export function buildSearchRings(
  profile: BusinessProfile | null,
  baseTargets: BusinessLocation[],
): SearchRing[] {
  const area = profile?.serviceArea || null;
  const primary = baseTargets.find((l) => l.isPrimary) || baseTargets[0] || null;
  const countryCode = primary?.countryCode || profile?.primaryMarketCountry || null;
  const used = new Set<string>();
  const take = (names: Array<string | null | undefined>, region = false): BusinessLocation[] => {
    const out: BusinessLocation[] = [];
    for (const raw of names) {
      const name = (raw || "").replace(/\s+/g, " ").trim();
      if (name.length < 3 || /^[A-Za-z]{2}$/.test(name)) continue;
      const key = name.toLowerCase();
      if (used.has(key)) continue;
      used.add(key);
      out.push(placeOf(name, countryCode, region ? name : null));
    }
    return out;
  };

  const homeName = primary ? primary.suburb || primary.city : null;
  const ring0 = take([
    ...baseTargets.map((l) => l.suburb || l.city),
    ...(area?.nearbyAreas || []),
  ]);
  const ring1 = take([
    ...(area?.widerAreas || []),
    area?.metro,
    ...baseTargets.map((l) => l.city),
  ]);
  const ring2 = take(area?.outerAreas || []);
  const ring3 = take([area?.region || primary?.region], true);

  const rings: SearchRing[] = [];
  const push = (label: string, places: BusinessLocation[]) => {
    if (places.length) rings.push({ level: rings.length, label, places });
  };
  push(
    area?.radiusKm && homeName
      ? `within ~${area.radiusKm} km of ${homeName}`
      : `in ${ring0.slice(0, 3).map((p) => p.city).join(", ")}`,
    ring0,
  );
  push(
    area?.widerRadiusKm && homeName
      ? `within ~${area.widerRadiusKm} km of ${homeName}`
      : `around ${ring1.slice(0, 3).map((p) => p.city).join(", ")}`,
    ring1,
  );
  push(
    area?.outerRadiusKm && homeName
      ? `within ~${area.outerRadiusKm} km of ${homeName}`
      : `around ${ring2.slice(0, 3).map((p) => p.city).join(", ")}`,
    ring2,
  );
  push(`across ${ring3[0]?.city || "the region"}`, ring3);
  return rings;
}

/** Every place from the first ring up to and including `level`. */
export function placesUpToRing(rings: SearchRing[], level: number): BusinessLocation[] {
  return rings.filter((r) => r.level <= level).flatMap((r) => r.places);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The service part of the keywords, with place names and "near me" taken out. */
export function serviceAnchors(
  keywords: string[],
  placeNames: string[],
  categoryLabel?: string | null,
): string[] {
  const names = Array.from(
    new Set(placeNames.map((p) => p.trim()).filter((p) => p.length >= 3)),
  ).sort((a, b) => b.length - a.length);
  const out: string[] = [];
  const push = (value: string) => {
    const text = value.replace(/\s+/g, " ").trim();
    if (text.length < 3) return;
    if (out.some((x) => x.toLowerCase() === text.toLowerCase())) return;
    out.push(text);
  };
  for (const kw of keywords) {
    let text = kw.replace(/\bnear me\b/gi, " ");
    for (const name of names) {
      text = text.replace(new RegExp(`\\b${escapeRe(name)}\\b`, "gi"), " ");
    }
    push(text.replace(/\s+(in|at|near)\s*$/i, ""));
  }
  if (categoryLabel) push(categoryLabel);
  return out;
}

/**
 * Ad-library queries for one ring. The Ad Library does not filter by place,
 * so a query per suburb mostly repeats the same national ads. The first ring
 * searches the home suburb and the city; wider rings their few main places.
 * Advertisers found outside the current ring are held and taken once a
 * wider ring covers their address, without searching again.
 */
export function adLibraryRingQueries(input: {
  anchors: string[];
  rings: SearchRing[];
  level: number;
  metro?: string | null;
}): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    const text = value.replace(/\s+/g, " ").trim();
    if (!text || out.some((x) => x.toLowerCase() === text.toLowerCase())) return;
    out.push(text);
  };
  const [first, second] = input.anchors;
  const ring = input.rings.find((r) => r.level === input.level);
  if (!first || !ring) return out;
  if (input.level === 0) {
    const home = ring.places[0]?.city;
    const metro = (input.metro || "").trim();
    for (const anchor of [first, second].filter(Boolean) as string[]) {
      if (home) push(`${anchor} ${home}`);
      if (metro && metro.toLowerCase() !== (home || "").toLowerCase()) push(`${anchor} ${metro}`);
    }
    if (ring.places[1]) push(`${first} ${ring.places[1].city}`);
    return out.slice(0, 5);
  }
  for (const place of ring.places.slice(0, 3)) push(`${first} ${place.city}`);
  if (second && ring.places[0]) push(`${second} ${ring.places[0].city}`);
  return out.slice(0, 4);
}

/** Place-qualified queries for one ring: the main service in every place, a second service in the first few. */
export function ringSearchQueries(input: {
  anchors: string[];
  ring: SearchRing;
  maxQueries: number;
}): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    const text = value.replace(/\s+/g, " ").trim();
    if (!text || out.length >= input.maxQueries) return;
    if (out.some((x) => x.toLowerCase() === text.toLowerCase())) return;
    out.push(text);
  };
  const [first, second] = input.anchors;
  if (!first) return out;
  for (const place of input.ring.places) push(`${first} ${place.city}`);
  if (second) {
    for (const place of input.ring.places.slice(0, 3)) push(`${second} ${place.city}`);
  }
  return out;
}
