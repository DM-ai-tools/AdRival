/**
 * Small pieces of screen state kept in the address bar, so a refresh, a
 * shared link or Back from a detail page reopens the same dashboard tab and
 * offer. Only the named parameters change; the rest of the address is kept.
 */

export function readUrlParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}

/** Set (or with null, remove) parameters without adding a Back entry. */
export function writeUrlParams(patch: Record<string, string | null | undefined>): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const next = params.toString();
  if (next === window.location.search.replace(/^\?/, "")) return;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${next ? `?${next}` : ""}`);
}

/** "Acme::offer-3" → { competitor: "Acme", id: "offer-3" }. */
export function parseOfferKey(value: string | null): { id: string; competitor: string } | null {
  if (!value) return null;
  // Offer ids can hold "::" themselves (split ladders), so the competitor is
  // everything before the first separator.
  const first = value.indexOf("::");
  if (first <= 0) return null;
  const competitor = value.slice(0, first);
  const id = value.slice(first + 2);
  return id ? { competitor, id } : null;
}

export function offerKey(sel: { id: string; competitor: string }): string {
  return `${sel.competitor}::${sel.id}`;
}
