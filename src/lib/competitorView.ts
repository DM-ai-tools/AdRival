import { RECREATED_PAGE_HEAVY_KEYS, type CompetitorRecord } from "./types";

/**
 * Competitor as sent to list and polling responses. The page HTML, its Undo
 * copy, the competitor page archive and generated images live apart from the
 * competitor (recreated_pages) and are never on the record; "has a page" is the
 * light marker (`recreatedPage.hasPage`). The content pack, draft and design
 * notes are still on the record and can be large, so they are dropped here too.
 * Those views only need the recreation status and progress; the recreate page
 * loads the full page from /api/competitors/recreate-page.
 */
export function competitorForList<T extends CompetitorRecord>(competitor: T): T {
  if (!competitor.recreatedPage) return competitor;
  const summary: Record<string, unknown> = { ...competitor.recreatedPage };
  delete summary.contentPack;
  delete summary.contentDraft;
  delete summary.designMd;
  // A caller holding a full (legacy) page must not send its content either.
  for (const key of RECREATED_PAGE_HEAVY_KEYS) delete summary[key];
  return { ...competitor, recreatedPage: summary as T["recreatedPage"] };
}
