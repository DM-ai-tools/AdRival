/**
 * An absolute link for an outside page. Ad libraries often give a bare
 * domain ("pushmobility.com.au"); used as an href it would open as a page of
 * this app, so it gets https:// in front. Internal paths ("/recreate/…") and
 * links that already have a scheme are returned as they are.
 */
export function externalUrl(url: string | null | undefined): string | undefined {
  const value = (url || "").trim();
  if (!value) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]|$)/i.test(value)) return `https://${value}`;
  return value;
}
