/** Client-safe. Do not import Node built-ins here; the review page bundles this module. */
export function looksLikeSlogan(value: string): boolean {
  const text = value.trim();
  if (/^(your|get|grow|boost|supercharge|unlock|transform|scale)\b/i.test(text)) return true;
  if (/\byour (growth|business|brand|results|leads)\b/i.test(text)) return true;
  if (/[!]$/.test(text) && text.split(/\s+/).length <= 8) return true;
  return false;
}
