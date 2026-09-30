/**
 * Where a detail page (a recreated page, an offer) sends the user back to.
 * The screen that links to it passes its own address as ?back=, so Back
 * returns to the same run and tab — also when it was opened from History.
 */

/** A same-site path, or null. Blocks "//evil.com" and full URLs. */
export function safeReturnPath(raw: string | null | undefined): string | null {
  const path = String(raw || "").trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
  return path;
}

/** The current page's address, for a link's ?back=. */
export function currentReturnPath(): string {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}`;
}

/** `href` with ?back= set to `back`. */
export function withReturn(href: string, back: string | null | undefined): string {
  const safe = safeReturnPath(back);
  if (!safe) return href;
  return `${href}${href.includes("?") ? "&" : "?"}back=${encodeURIComponent(safe)}`;
}

/** The ?back= of the current page, if it is safe. */
export function readReturnPath(): string | null {
  if (typeof window === "undefined") return null;
  return safeReturnPath(new URLSearchParams(window.location.search).get("back"));
}

/** The name of the screen a return path leads to, for a breadcrumb. */
export function returnLabel(path: string): string {
  const params = new URLSearchParams(path.split("?")[1] || "");
  const mode = params.get("mode");
  if (mode === "history") return "History";
  if (mode === "lookup") return "Competitor lookup";
  return "Keyword search";
}
