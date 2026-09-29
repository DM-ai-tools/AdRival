import type { CompetitorRecord } from "./types";

/**
 * Competitor as sent to list and polling responses. A recreated page carries
 * the full HTML (with embedded images), the competitor page archive and the
 * content pack, which together run to megabytes per competitor. Those views
 * only need the recreation status and progress; the recreate page loads the
 * full record from /api/competitors/recreate-page.
 */
export function competitorForList<T extends CompetitorRecord>(competitor: T): T {
  if (!competitor.recreatedPage) return competitor;
  const summary = { ...competitor.recreatedPage };
  delete summary.html;
  delete summary.sourceArchive;
  delete summary.contentPack;
  delete summary.contentDraft;
  delete summary.designMd;
  return { ...competitor, recreatedPage: summary };
}
