import { isCreditError } from "../accounting/errors";

/**
 * Search queries for a run: every keyword is expanded at the same time, then
 * the lists are interleaved (1st query of each keyword, then 2nd, …) so the
 * cap keeps some queries for every keyword instead of only the first one.
 * A keyword whose expansion fails is searched as typed.
 */
export async function searchQueriesForKeywords(
  keywords: string[],
  expand: (keyword: string) => Promise<string[]>,
  max: number,
): Promise<string[]> {
  const settled = await Promise.allSettled(keywords.map((kw) => expand(kw)));
  const lists = settled.map((r, i) => {
    if (r.status === "rejected") {
      if (isCreditError(r.reason)) throw r.reason;
      return [keywords[i]];
    }
    const list = r.value.map((q) => q.trim()).filter(Boolean);
    // Keep the typed keyword in the list; expansions choose where it goes.
    return list.some((q) => q.toLowerCase() === keywords[i].toLowerCase())
      ? list
      : [...list, keywords[i]];
  });
  const out: string[] = [];
  const seen = new Set<string>();
  for (let round = 0; out.length < max && lists.some((l) => round < l.length); round += 1) {
    for (const list of lists) {
      const q = list[round];
      if (!q || seen.has(q.toLowerCase())) continue;
      seen.add(q.toLowerCase());
      out.push(q);
      if (out.length >= max) break;
    }
  }
  return out;
}
