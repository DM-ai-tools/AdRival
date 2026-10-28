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
/**
 * A version's own business profile (recreateOnly.businessProfile: scraped
 * brand assets, design and contact details) is for the server's builds only;
 * every response that sends a competitor record drops it here.
 */
export function withoutVersionProfile<T extends { recreateOnly?: CompetitorRecord["recreateOnly"] }>(competitor: T): T {
  if (!competitor.recreateOnly || !("businessProfile" in competitor.recreateOnly)) return competitor;
  const { businessProfile: _dropped, ...recreateOnly } = competitor.recreateOnly;
  void _dropped;
  return { ...competitor, recreateOnly };
}

export function competitorForList<T extends CompetitorRecord>(competitor: T): T {
  competitor = withoutVersionProfile(competitor);
  if (!competitor.recreatedPage) return competitor;
  const summary: Record<string, unknown> = { ...competitor.recreatedPage };
  delete summary.contentPack;
  delete summary.contentDraft;
  delete summary.designMd;
  // A caller holding a full (legacy) page must not send its content either.
  for (const key of RECREATED_PAGE_HEAVY_KEYS) delete summary[key];
  return { ...competitor, recreatedPage: summary as T["recreatedPage"] };
}
